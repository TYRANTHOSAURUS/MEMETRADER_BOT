// ============================================================
// Scanner — Helius WebSocket + Enhanced Transaction Parser
//
// Flow:
//   1. Subscribe to PumpFun program via Helius logsSubscribe WSS
//   2. On each log event, queue the signature
//   3. Flush queue → batch-fetch enhanced transactions (up to 100/call)
//   4. Parse each tx: SWAP → emit swap:new, new mint → discovery engine
//   5. Migration detection via source change (pumpfun → raydium on same mint)
//
// Helius free tier: ~10 req/s enhanced transactions, 100 sigs/batch
// We batch with a 250ms flush window to stay well within limits.
// ============================================================

import WebSocket from 'ws'
import { bus } from '../core/eventBus.js'
import { logger } from '../core/logger.js'
import { registry } from '../core/tokenRegistry.js'
import { onNewTokenFromHelius, recordSwapActivity } from '../discovery/discoveryEngine.js'
import { checkToken } from '../safety/rugDetector.js'
import { updateSafety, updateLiquidity } from '../market/stateStore.js'
import type { SwapEvent, TokenMeta } from '../core/types.js'

const PUMPFUN_PROGRAM  = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'
const ENHANCED_TX_URL  = 'https://api.helius.xyz/v0/transactions'
const JUPITER_PRICE_URL = 'https://price.jup.ag/v6/price?ids=So11111111111111111111111111111111111111112'
const WSOL_MINT         = 'So11111111111111111111111111111111111111112'

// Live SOL/USD price — refreshed every 60s from Jupiter price API
let SOL_USD = 155
let solPriceLastFetch = 0

export function getSolUsdPrice(): number { return SOL_USD }

async function refreshSolPrice(): Promise<void> {
  try {
    const res = await fetch(JUPITER_PRICE_URL)
    if (!res.ok) return
    const data = await res.json() as { data?: Record<string, { price: number }> }
    const price = data.data?.[WSOL_MINT]?.price
    if (price && price > 0) {
      SOL_USD = price
      logger.debug(`Scanner: SOL/USD updated → $${price.toFixed(2)}`)
    }
  } catch { /* best-effort */ }
}

// Start periodic refresh
function startSolPriceRefresh(): void {
  // Fetch immediately, then every 60s
  refreshSolPrice()
  setInterval(refreshSolPrice, 60_000)
}
const BATCH_SIZE       = 100   // Helius max per request

// Rate limiter — free tier: ~3 req/s to stay safe below 10 req/s limit
const MAX_RPS          = 3
const MIN_INTERVAL_MS  = Math.ceil(1000 / MAX_RPS)   // 333ms between calls

// Enrichment throttle — getAsset shares the same API key quota.
// One enrichment per 600ms (≤2/s), capped at 30 queued mints.
const ENRICH_INTERVAL_MS = 600
const ENRICH_QUEUE_CAP   = 30

let ws: WebSocket | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let flushTimer:     ReturnType<typeof setTimeout> | null = null
let enrichTimer:    ReturnType<typeof setTimeout> | null = null
let connected       = false
let apiKey          = ''
let backoffMs       = 0          // exponential backoff on 429
let lastFetchTs     = 0          // timestamp of last successful fetch call
let dropped         = 0          // sigs dropped due to rate limit
let firstRateLog    = true       // suppress repeated rate limit warnings

const sigQueue:    string[] = []
const enrichQueue: string[] = []   // mints awaiting getAsset enrichment

// ─── Public API ──────────────────────────────────────────────

export function startScanner(wssUrl: string): void {
  // Always start the SOL price oracle
  startSolPriceRefresh()

  if (!wssUrl) {
    logger.warn('HELIUS_WSS_URL not set — starting mock scanner')
    startMockScanner()
    return
  }

  // Extract API key from WSS URL for the REST calls
  const match = wssUrl.match(/api-key=([^&]+)/)
  if (match) apiKey = match[1]

  connect(wssUrl)
}

export function stopScanner(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer)
  if (flushTimer)     clearTimeout(flushTimer)
  if (enrichTimer)    clearTimeout(enrichTimer)
  if (ws) { ws.close(); ws = null }
  connected = false
}

export function isScannerConnected(): boolean {
  return connected
}

// ─── WebSocket connection ─────────────────────────────────────

function connect(wssUrl: string): void {
  logger.info(`Scanner: connecting to Helius WSS`)
  ws = new WebSocket(wssUrl)

  ws.on('open', () => {
    connected = true
    bus.emit({ type: 'scanner:connected', data: { rpc: wssUrl } })
    logger.info('Scanner: connected')

    // Subscribe to PumpFun program logs
    ws!.send(JSON.stringify({
      jsonrpc: '2.0', id: 1,
      method:  'logsSubscribe',
      params:  [{ mentions: [PUMPFUN_PROGRAM] }, { commitment: 'confirmed' }],
    }))
  })

  ws.on('message', (data: WebSocket.Data) => {
    try {
      const msg = JSON.parse(data.toString())
      handleMessage(msg)
    } catch { /* ignore parse errors */ }
  })

  ws.on('close', () => {
    connected = false
    bus.emit({ type: 'scanner:disconnected', data: { reason: 'WebSocket closed' } })
    logger.warn('Scanner: disconnected — reconnecting in 5s')
    scheduleReconnect(wssUrl)
  })

  ws.on('error', (err: Error) => {
    logger.error(`Scanner WS error: ${err.message}`)
  })
}

function scheduleReconnect(wssUrl: string): void {
  if (reconnectTimer) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connect(wssUrl)
  }, 5_000)
}

// ─── Message handler → signature queue ───────────────────────

function handleMessage(msg: Record<string, unknown>): void {
  type Payload = { params?: { result?: { value?: { signature?: string } } } }
  const sig = (msg as Payload).params?.result?.value?.signature
  if (!sig) return

  // Hard cap the queue — free tier can't keep up with full PumpFun volume.
  // We sample at the rate limit; candles stay valid with a subset of ticks.
  if (sigQueue.length >= BATCH_SIZE * 2) {
    dropped++
    return
  }

  sigQueue.push(sig)
  scheduleFlush()
}

function scheduleFlush(): void {
  if (flushTimer) return
  const now     = Date.now()
  const elapsed = now - lastFetchTs
  const wait    = Math.max(0, MIN_INTERVAL_MS + backoffMs - elapsed)
  flushTimer = setTimeout(flushQueue, wait)
}

// ─── Rate-limited batch fetch + parse ────────────────────────

async function flushQueue(): Promise<void> {
  flushTimer = null
  if (sigQueue.length === 0) return

  const batch = sigQueue.splice(0, BATCH_SIZE)
  lastFetchTs = Date.now()

  try {
    const res = await fetch(`${ENHANCED_TX_URL}?api-key=${apiKey}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ transactions: batch }),
    })

    if (res.status === 429) {
      // Back off exponentially: 1s → 2s → 4s → 8s → cap at 30s
      backoffMs = backoffMs === 0 ? 1_000 : Math.min(backoffMs * 2, 30_000)
      if (firstRateLog) {
        logger.warn(`Scanner: Helius rate limit hit — backing off ${backoffMs}ms. Sampling ~${MAX_RPS} req/s from high-volume stream.`)
        firstRateLog = false
      }
      // Re-queue the batch (prioritize these)
      sigQueue.unshift(...batch)
      if (sigQueue.length > BATCH_SIZE * 2) sigQueue.splice(BATCH_SIZE * 2)
      scheduleFlush()
      return
    }

    // Success — decay backoff
    if (backoffMs > 0) {
      backoffMs = Math.max(0, backoffMs / 2)
      if (backoffMs === 0) {
        firstRateLog = true
        logger.info('Scanner: rate limit cleared — resuming normal fetch rate')
      }
    }

    if (!res.ok) {
      logger.warn(`Scanner: Helius fetch ${res.status} — ${batch.length} sigs dropped`)
    } else {
      const txs = await res.json() as HeliusTx[]
      for (const tx of txs) {
        try { parseTx(tx) } catch (e) {
          logger.debug(`Scanner: parse error on ${tx.signature?.slice(0, 8)}: ${e}`)
        }
      }
    }
  } catch (e) {
    logger.error(`Scanner: fetch failed — ${e}`)
  }

  if (sigQueue.length > 0) scheduleFlush()
}

// ─── Helius enhanced transaction types ───────────────────────

interface HeliusTx {
  signature:      string
  type:           string        // SWAP, TRANSFER, CREATE, etc.
  source:         string        // PUMP_FUN, RAYDIUM, ORCA, JUPITER
  timestamp:      number        // unix seconds
  feePayer:       string
  fee:            number        // lamports
  tokenTransfers: TokenTransfer[]
  nativeTransfers: NativeTransfer[]
  events: {
    swap?: SwapEvent_H
  }
}

interface TokenTransfer {
  fromUserAccount: string
  toUserAccount:   string
  mint:            string
  tokenAmount:     number
}

interface NativeTransfer {
  fromUserAccount: string
  toUserAccount:   string
  amount:          number       // lamports
}

interface SwapEvent_H {
  nativeInput?:  { account: string; amount: string }
  nativeOutput?: { account: string; amount: string }
  tokenInputs:   TokenIO[]
  tokenOutputs:  TokenIO[]
}

interface TokenIO {
  userAccount:   string
  tokenAccount:  string
  mint:          string
  rawTokenAmount: { tokenAmount: string; decimals: number }
}

// ─── Transaction parser ───────────────────────────────────────

function parseTx(tx: HeliusTx): void {
  if (tx.type !== 'SWAP') return
  if (!tx.events?.swap)   return

  const swap    = tx.events.swap
  const wallet  = tx.feePayer
  const ts      = tx.timestamp * 1000   // convert to ms

  // Determine side + amounts
  // BUY:  nativeInput (SOL in) + tokenOutputs (tokens out)
  // SELL: tokenInputs (tokens in) + nativeOutput (SOL out)

  const isBuy  = !!swap.nativeInput  && swap.tokenOutputs.length > 0
  const isSell = !!swap.nativeOutput && swap.tokenInputs.length  > 0

  if (!isBuy && !isSell) return

  let mint:        string
  let tokenAmount: number
  let solAmount:   number

  if (isBuy) {
    const tokenOut = swap.tokenOutputs[0]
    if (!tokenOut) return
    mint        = tokenOut.mint
    tokenAmount = Number(tokenOut.rawTokenAmount.tokenAmount) /
                  Math.pow(10, tokenOut.rawTokenAmount.decimals)
    solAmount   = Number(swap.nativeInput!.amount) / 1e9
  } else {
    const tokenIn = swap.tokenInputs[0]
    if (!tokenIn) return
    mint        = tokenIn.mint
    tokenAmount = Number(tokenIn.rawTokenAmount.tokenAmount) /
                  Math.pow(10, tokenIn.rawTokenAmount.decimals)
    solAmount   = Number(swap.nativeOutput!.amount) / 1e9
  }

  if (tokenAmount <= 0 || solAmount <= 0) return

  const priceInSol = solAmount / tokenAmount
  const price      = priceInSol * SOL_USD

  // Auto-discover token if not seen before
  if (!registry.has(mint)) {
    discoverToken(mint, tx)
  }

  // Detect migration: token previously seen as pumpfun, now routing through raydium/orca
  if (registry.has(mint)) {
    const meta = registry.get(mint)
    if (meta?.lifecycleStage === 'BONDING_CURVE' &&
        (tx.source === 'RAYDIUM' || tx.source === 'ORCA' || tx.source === 'JUPITER')) {
      registry.setLifecycle(mint, 'AMM')
      bus.emit({ type: 'token:migrated', data: { mint } })
      logger.info(`Scanner: ${mint.slice(0, 8)} migrated → AMM (detected via ${tx.source})`)
    }
  }

  const swapProgram = sourceToProgram(tx.source)

  const event: SwapEvent = {
    mint,
    side:        isBuy ? 'buy' : 'sell',
    price,
    priceInSol,
    tokenAmount,
    solAmount,
    wallet,
    timestamp:   ts,
    signature:   tx.signature,
    program:     swapProgram,
  }

  // Estimate liquidity from swap size: solAmount is one side of the pool tick.
  // Multiply by 2 (two-sided AMM) × SOL_USD to get a USD floor estimate.
  // This is a rough lower-bound — real pools are much larger — but prevents
  // the LOW_LIQUIDITY flag from firing for every token we see trading.
  const estimatedLiquidityUsd = solAmount * 2 * SOL_USD * 10
  const estimatedMcap = estimatedLiquidityUsd * 5
  updateLiquidity(mint, estimatedLiquidityUsd, estimatedMcap)

  recordSwapActivity(mint)
  bus.emit({ type: 'swap:new', data: event })
}

function discoverToken(mint: string, tx: HeliusTx): void {
  // We don't have token name/symbol from a swap tx alone.
  // Register with a placeholder; the enrichment step (Helius getAsset)
  // will fill in the real name/symbol asynchronously via the enrichment queue.
  const stage = (tx.source === 'PUMP_FUN') ? 'BONDING_CURVE' : 'AMM'
  const placeholder = `TOKEN_${mint.slice(0, 6)}`

  onNewTokenFromHelius(mint, placeholder, mint.slice(0, 4).toUpperCase(), tx.feePayer, stage)
  logger.info(`Scanner: discovered ${mint.slice(0, 8)}... via first swap (${tx.source})`)

  // Run on-chain rug checks asynchronously so we don't block swap processing.
  // Uses the RPC URL extracted from the WSS URL (same API key).
  const rpcUrl = apiKey ? `https://mainnet.helius-rpc.com/?api-key=${apiKey}` : ''
  checkToken(mint, rpcUrl).then(checks => {
    updateSafety(mint, checks.mintRevoked, checks.freezeRevoked, checks.lpBurned)
    logger.debug(`Scanner: safety ${mint.slice(0, 8)} mint=${checks.mintRevoked} freeze=${checks.freezeRevoked}`)
  }).catch(() => { /* best-effort */ })

  // Queue enrichment — rate-limited to avoid hitting quota on burst token discovery
  queueEnrichment(mint)
}

// ─── Enrichment queue (rate-limited getAsset calls) ───────────
// Separate from the swap-fetch queue: both share the API key quota.
// Processed one-at-a-time at ENRICH_INTERVAL_MS intervals.

function queueEnrichment(mint: string): void {
  if (!apiKey) return
  if (enrichQueue.length >= ENRICH_QUEUE_CAP) return   // drop when overwhelmed
  if (!enrichQueue.includes(mint)) enrichQueue.push(mint)
  scheduleEnrich()
}

function scheduleEnrich(): void {
  if (enrichTimer) return
  enrichTimer = setTimeout(processEnrichQueue, ENRICH_INTERVAL_MS)
}

function processEnrichQueue(): void {
  enrichTimer = null
  const mint = enrichQueue.shift()
  if (!mint) return
  enrichTokenMeta(mint).catch(() => {}).finally(() => {
    if (enrichQueue.length > 0) scheduleEnrich()
  })
}

async function enrichTokenMeta(mint: string): Promise<void> {
  try {
    const res = await fetch(
      `https://mainnet.helius-rpc.com/?api-key=${apiKey}`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          jsonrpc: '2.0', id: 1,
          method:  'getAsset',
          params:  { id: mint },
        }),
      }
    )

    if (res.status === 429) {
      // Back off enrichment and re-queue this mint at the front
      enrichQueue.unshift(mint)
      const delay = 2_000
      enrichTimer = setTimeout(processEnrichQueue, delay)
      logger.warn(`Scanner: enrichment rate limited — backing off ${delay}ms`)
      return
    }

    if (!res.ok) return

    const { result } = await res.json() as { result?: {
      content?: { metadata?: { name?: string; symbol?: string } }
    }}
    if (!result) return

    const name   = result.content?.metadata?.name   ?? `TOKEN_${mint.slice(0, 6)}`
    const symbol = result.content?.metadata?.symbol ?? mint.slice(0, 4).toUpperCase()

    const existing = registry.get(mint)
    if (existing) {
      const meta: TokenMeta = {
        mint,
        name,
        symbol,
        uri:            '',
        creator:        existing.creator,
        createdAt:      existing.createdAt,
        lifecycleStage: existing.lifecycleStage,
      }
      registry.register(meta)
      logger.debug(`Scanner: enriched ${mint.slice(0, 8)} → ${symbol} (${name})`)
    }
  } catch { /* enrichment is best-effort */ }
}

function sourceToProgram(source: string): SwapEvent['program'] {
  switch (source) {
    case 'PUMP_FUN': return 'pumpfun'
    case 'RAYDIUM':  return 'raydium'
    case 'ORCA':     return 'orca'
    case 'JUPITER':  return 'jupiter'
    default:         return 'raydium'
  }
}

// ─── Mock Scanner (no API key) ────────────────────────────────

const mockPrices = new Map<string, {
  priceInSol: number
  phase: 'accumulation' | 'breakout' | 'distribution' | 'crash'
  phaseAge: number
}>()

import { getWatchlist } from '../discovery/discoveryEngine.js'

function startMockScanner(): void {
  connected = true
  bus.emit({ type: 'scanner:connected', data: { rpc: 'mock' } })
  logger.info('Scanner: mock mode — generating swaps for all discovered tokens')

  setInterval(emitMockSwaps, 500)
  setInterval(evolveMockPhases, 2 * 60_000)
}

function emitMockSwaps(): void {
  const tokens = registry.all()
  for (const token of tokens) {
    if (!mockPrices.has(token.mint)) {
      mockPrices.set(token.mint, {
        priceInSol: token.lifecycleStage === 'BONDING_CURVE'
          ? 0.000001 + Math.random() * 0.000005
          : 0.00001  + Math.random() * 0.0001,
        phase:    'accumulation',
        phaseAge: 0,
      })
    }

    const state = mockPrices.get(token.mint)!
    state.phaseAge++

    // On first tick, seed safety + liquidity so tokens aren't all vetoed in mock mode.
    // Use optimistic defaults: mint/freeze revoked, reasonable liquidity.
    if (state.phaseAge === 1) {
      updateSafety(token.mint, true, true, token.lifecycleStage === 'AMM')
      const mockLiquidity = 8_000 + Math.random() * 50_000
      updateLiquidity(token.mint, mockLiquidity, mockLiquidity * 5)
    }

    const drift = { accumulation: 0.01, breakout: 0.06, distribution: -0.02, crash: -0.12 }[state.phase]
    const noise = (Math.random() - 0.5) * 0.08
    state.priceInSol = Math.max(state.priceInSol * (1 + noise + drift * Math.random()), 0.0000001)

    const buyBias  = { accumulation: 0.55, breakout: 0.72, distribution: 0.42, crash: 0.22 }[state.phase]
    const swapCount = state.phase === 'breakout' ? Math.ceil(Math.random() * 3) : 1

    for (let i = 0; i < swapCount; i++) {
      const side      = Math.random() < buyBias ? 'buy' : 'sell'
      const solAmount = 0.01 + Math.random() * 0.05

      const swap: SwapEvent = {
        mint:        token.mint,
        side,
        price:       state.priceInSol * SOL_USD,
        priceInSol:  state.priceInSol,
        tokenAmount: solAmount / state.priceInSol,
        solAmount,
        wallet:      `mock_wallet_${Math.floor(Math.random() * 200)}`,
        timestamp:   Date.now(),
        signature:   `mock_${token.mint.slice(0, 4)}_${Date.now()}_${i}`,
        program:     token.lifecycleStage === 'BONDING_CURVE' ? 'pumpfun' : 'raydium',
      }

      recordSwapActivity(token.mint)
      bus.emit({ type: 'swap:new', data: swap })
    }
  }
}

function evolveMockPhases(): void {
  for (const [, state] of mockPrices) {
    const roll = Math.random()
    switch (state.phase) {
      case 'accumulation': if (roll < 0.30) state.phase = 'breakout';     else if (roll < 0.15) state.phase = 'crash'; break
      case 'breakout':     if (roll < 0.50) state.phase = 'distribution'; else if (roll < 0.70) state.phase = 'crash'; break
      case 'distribution': if (roll < 0.60) state.phase = 'crash';        else if (roll < 0.80) state.phase = 'accumulation'; break
      case 'crash':        if (roll < 0.10) state.phase = 'accumulation'; break
    }
    state.phaseAge = 0
  }
}
