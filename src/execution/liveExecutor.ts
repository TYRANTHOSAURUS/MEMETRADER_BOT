// ============================================================
// LiveExecutor — Real transactions via Jupiter API v6 + Jito
//
// Flow for BUY:
//   1. Get Jupiter quote: SOL → token
//   2. Get Jupiter swap transaction
//   3. Sign with wallet keypair
//   4. Submit via Jito bundle (MEV protection) with fallback to standard RPC
//   5. Confirm on-chain, return Fill
//
// Flow for SELL:
//   Same but token → SOL, using stored position token amount
// ============================================================

import { Connection, Keypair, VersionedTransaction, PublicKey,
         SystemProgram, TransactionMessage } from '@solana/web3.js'
import bs58 from 'bs58'
import { v4 as uuid } from 'uuid'
import { logger } from '../core/logger.js'
import type { Executor, OrderIntent, Fill, Position } from '../core/types.js'

const JUPITER_QUOTE_API = 'https://quote-api.jup.ag/v6'
const JITO_ENDPOINT     = 'https://mainnet.block-engine.jito.wtf/api/v1/bundles'
const SOL_MINT          = 'So11111111111111111111111111111111111111112'
const TOKEN_DECIMALS    = 6   // PumpFun/Raydium memecoins are always 6 decimals

// Jito tip accounts (mainnet) — one is randomly selected per bundle
const JITO_TIP_ACCOUNTS = [
  '96gYZGLnJYVFmbjzopVexburgtFovTsgyVGmoc2a2GU',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt13ib8T3s',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
]

interface JupiterQuote {
  inputMint:      string
  outputMint:     string
  inAmount:       string
  outAmount:      string
  priceImpactPct: string
  slippageBps:    number
  platformFee?:   { amount: string; feeBps: number }
  routePlan:      unknown[]
  otherAmountThreshold: string
}

export class LiveExecutor implements Executor {
  readonly mode = 'LIVE' as const

  private connection:     Connection
  private keypair:        Keypair
  private jitoTipLamports: number
  private positions       = new Map<string, Position>()
  private tokenPrices     = new Map<string, { price: number; priceInSol: number; name: string }>()

  constructor(config: { walletPrivateKey: string; jitoTipLamports: number; heliusRpcUrl: string }) {
    const decoded     = bs58.decode(config.walletPrivateKey)
    this.keypair      = Keypair.fromSecretKey(decoded)
    this.connection   = new Connection(config.heliusRpcUrl, 'confirmed')
    this.jitoTipLamports = config.jitoTipLamports
    logger.info(`LiveExecutor: wallet ${this.keypair.publicKey.toBase58().slice(0, 8)}...`)
  }

  /** Called on every swap:new to keep position prices current */
  updatePrice(mint: string, price: number, priceInSol: number, name: string): void {
    this.tokenPrices.set(mint, { price, priceInSol, name })
    const pos = this.positions.get(mint)
    if (!pos) return
    pos.currentPrice      = priceInSol
    const gain            = (priceInSol - pos.entryPriceInSol) * pos.tokenAmount
    pos.unrealizedPnlSol  = gain
    pos.unrealizedPnlPct  = pos.entryPriceInSol > 0
      ? (priceInSol - pos.entryPriceInSol) / pos.entryPriceInSol
      : 0
  }

  /** Get current on-chain SOL balance of the wallet */
  async getWalletBalanceSol(): Promise<number> {
    try {
      const lamports = await this.connection.getBalance(this.keypair.publicKey, 'confirmed')
      return lamports / 1e9
    } catch {
      return 0
    }
  }

  async submit(intent: OrderIntent): Promise<Fill> {
    const { tokenMint, side, maxSlippageBps } = intent

    logger.info(`LiveExecutor: submitting ${side} for ${tokenMint.slice(0, 8)}...`)

    // ── Determine swap direction & amount ─────────────────────
    const inputMint  = side === 'BUY' ? SOL_MINT : tokenMint
    const outputMint = side === 'BUY' ? tokenMint : SOL_MINT

    let rawAmount: number
    if (side === 'BUY') {
      // sizeValue = SOL to spend → convert to lamports
      rawAmount = Math.floor(intent.sizeValue * 1e9)
    } else {
      // SELL: sell entire position
      const pos = this.positions.get(tokenMint)
      if (!pos) throw new Error(`No position for ${tokenMint} — cannot SELL`)
      rawAmount = Math.floor(pos.tokenAmount * Math.pow(10, TOKEN_DECIMALS))
    }

    if (rawAmount <= 0) throw new Error(`Invalid amount: ${rawAmount}`)

    // ── Jupiter Quote ──────────────────────────────────────────
    const quote = await this.getQuote(inputMint, outputMint, rawAmount, maxSlippageBps)

    // ── Jupiter Swap Transaction ───────────────────────────────
    const swapTxBase64 = await this.getSwapTransaction(quote)

    // ── Decode, Sign, Submit ───────────────────────────────────
    const txBuffer = Buffer.from(swapTxBase64, 'base64')
    const tx       = VersionedTransaction.deserialize(txBuffer)
    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash('confirmed')
    tx.message.recentBlockhash = blockhash
    tx.sign([this.keypair])

    const txSignature = await this.submitBundle(tx, lastValidBlockHeight)

    // ── Parse fill from quote ──────────────────────────────────
    let solAmount:   number
    let tokenAmount: number
    let priceInSol:  number
    const tokenData = this.tokenPrices.get(tokenMint)
    const solUsd    = tokenData ? tokenData.price / (tokenData.priceInSol || 1) : 155

    if (side === 'BUY') {
      solAmount   = Number(quote.inAmount)  / 1e9
      tokenAmount = Number(quote.outAmount) / Math.pow(10, TOKEN_DECIMALS)
      priceInSol  = tokenAmount > 0 ? solAmount / tokenAmount : 0
    } else {
      tokenAmount = Number(quote.inAmount)  / Math.pow(10, TOKEN_DECIMALS)
      solAmount   = Number(quote.outAmount) / 1e9
      priceInSol  = tokenAmount > 0 ? solAmount / tokenAmount : 0
    }

    const fee = (this.jitoTipLamports / 1e9) + (solAmount * 0.0025) // tip + 0.25% DEX fee approx

    const fill: Fill = {
      id:          uuid(),
      intentId:    intent.id,
      strategyId:  intent.strategyId,
      tokenMint,
      tokenName:   tokenData?.name ?? tokenMint.slice(0, 8),
      side,
      price:       priceInSol * solUsd,
      priceInSol,
      tokenAmount,
      solAmount,
      fee,
      timestamp:   Date.now(),
      txSignature,
      paper:       false,
    }

    // ── Update position tracking ───────────────────────────────
    if (side === 'BUY') {
      const position: Position = {
        id:               uuid(),
        tokenMint,
        tokenName:        fill.tokenName,
        tokenSymbol:      tokenMint.slice(0, 4).toUpperCase(),
        strategyId:       intent.strategyId,
        entryPrice:       fill.price,
        entryPriceInSol:  fill.priceInSol,
        tokenAmount:      fill.tokenAmount,
        solAmount:        fill.solAmount,
        entryTime:        fill.timestamp,
        currentPrice:     fill.priceInSol,
        unrealizedPnlSol: 0,
        unrealizedPnlPct: 0,
        paper:            false,
      }
      this.positions.set(tokenMint, position)
    } else {
      this.positions.delete(tokenMint)
    }

    logger.trade(`[LIVE] ${fill.side} ${fill.tokenName} | ${fill.solAmount.toFixed(4)} SOL @ ${fill.priceInSol.toFixed(10)} | tx: ${txSignature.slice(0, 12)}...`)
    return fill
  }

  async cancel(_intentId: string): Promise<void> {
    // Jupiter swaps are atomic — nothing to cancel after submission
  }

  getPosition(tokenMint: string): Position | null {
    return this.positions.get(tokenMint) ?? null
  }

  getAllPositions(): Position[] {
    return [...this.positions.values()]
  }

  async closePosition(tokenMint: string, strategyId: string): Promise<Fill | null> {
    const pos = this.positions.get(tokenMint)
    if (!pos) return null

    const intent: OrderIntent = {
      id:               uuid(),
      strategyId,
      tokenMint,
      side:             'SELL',
      entryMode:        'NOW',
      sizeMode:         'FIXED',
      sizeValue:        pos.solAmount,   // used only for reference — actual amount from position
      invalidationPrice: 0,
      maxSlippageBps:   300,             // 3% emergency close slippage
      expiresAt:        Date.now() + 60_000,
      confidence:       1.0,
      lifecycleStage:   'AMM',
      createdAt:        Date.now(),
    }

    return this.submit(intent)
  }

  // ─── Jupiter API ────────────────────────────────────────────

  private async getQuote(
    inputMint: string,
    outputMint: string,
    amount: number,
    slippageBps: number,
  ): Promise<JupiterQuote> {
    const params = new URLSearchParams({
      inputMint,
      outputMint,
      amount:              amount.toString(),
      slippageBps:         slippageBps.toString(),
      onlyDirectRoutes:    'false',
      asLegacyTransaction: 'false',
    })

    const res = await fetch(`${JUPITER_QUOTE_API}/quote?${params}`)
    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Jupiter quote failed ${res.status}: ${err.slice(0, 200)}`)
    }
    return res.json() as Promise<JupiterQuote>
  }

  private async getSwapTransaction(quote: JupiterQuote): Promise<string> {
    const body = {
      quoteResponse:              quote,
      userPublicKey:              this.keypair.publicKey.toBase58(),
      wrapAndUnwrapSol:           true,
      prioritizationFeeLamports:  'auto',
      dynamicComputeUnitLimit:    true,
    }

    const res = await fetch(`${JUPITER_QUOTE_API}/swap`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    })

    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Jupiter swap failed ${res.status}: ${err.slice(0, 200)}`)
    }

    const { swapTransaction } = await res.json() as { swapTransaction: string }
    return swapTransaction
  }

  // ─── Jito Bundle Submission ──────────────────────────────────

  private async submitBundle(tx: VersionedTransaction, lastValidBlockHeight: number): Promise<string> {
    // Build tip transaction (optional but improves landing rate)
    const tipAccount = new PublicKey(
      JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)]
    )

    try {
      const { blockhash } = await this.connection.getLatestBlockhash('confirmed')
      const tipInstruction = SystemProgram.transfer({
        fromPubkey: this.keypair.publicKey,
        toPubkey:   tipAccount,
        lamports:   this.jitoTipLamports,
      })
      const tipMsg = new TransactionMessage({
        payerKey:         this.keypair.publicKey,
        recentBlockhash:  blockhash,
        instructions:     [tipInstruction],
      }).compileToV0Message()
      const tipTx = new VersionedTransaction(tipMsg)
      tipTx.sign([this.keypair])

      // Encode both transactions as base58 for Jito
      const swapTxBase58 = bs58.encode(tx.serialize())
      const tipTxBase58  = bs58.encode(tipTx.serialize())

      const bundleRes = await fetch(JITO_ENDPOINT, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          jsonrpc: '2.0',
          id:      1,
          method:  'sendBundle',
          params:  [[swapTxBase58, tipTxBase58]],
        }),
      })

      if (bundleRes.ok) {
        const result = await bundleRes.json() as { result?: string; error?: { message: string } }
        if (!result.error) {
          logger.info(`LiveExecutor: Jito bundle submitted (id: ${result.result?.slice(0, 16)}...)`)
          // Extract tx signature from the signed transaction bytes
          const sig = bs58.encode(tx.signatures[0])
          await this.confirmTransaction(sig, lastValidBlockHeight)
          return sig
        }
        logger.warn(`Jito error: ${result.error.message} — falling back to RPC`)
      }
    } catch (err) {
      logger.warn(`Jito bundle failed: ${err} — falling back to RPC`)
    }

    // ── Fallback: standard RPC ───────────────────────────────
    logger.info('LiveExecutor: submitting via standard RPC')
    const sig = await this.connection.sendRawTransaction(tx.serialize(), {
      skipPreflight:       false,
      preflightCommitment: 'confirmed',
      maxRetries:          3,
    })
    await this.confirmTransaction(sig, lastValidBlockHeight)
    return sig
  }

  private async confirmTransaction(signature: string, lastValidBlockHeight: number): Promise<void> {
    const result = await this.connection.confirmTransaction(
      { signature, lastValidBlockHeight, blockhash: signature },
      'confirmed',
    )
    if (result.value.err) {
      throw new Error(`Transaction failed on-chain: ${JSON.stringify(result.value.err)}`)
    }
    logger.info(`LiveExecutor: confirmed ${signature.slice(0, 12)}...`)
  }
}
