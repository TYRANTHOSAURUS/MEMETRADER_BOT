import { v4 as uuid } from 'uuid'
import { bus } from '../core/eventBus.js'
import { saveFill } from '../storage/sqlite.js'
import { calculateFee } from '../market/feeTracker.js'
import { logger } from '../core/logger.js'
import type { Executor, OrderIntent, Fill, Position } from '../core/types.js'

// Paper executor — identical interface to LiveExecutor, no real transactions
// Simulates realistic fills using Jupiter quote approximation (placeholder price ± slippage)

const SIMULATED_SLIPPAGE_BPS = 30  // 0.3% simulated slippage

export class PaperExecutor implements Executor {
  readonly mode = 'PAPER' as const
  private positions = new Map<string, Position>()
  private tokenPrices = new Map<string, { price: number; priceInSol: number; name: string }>()

  updatePrice(mint: string, price: number, priceInSol: number, name: string): void {
    this.tokenPrices.set(mint, { price, priceInSol, name })
  }

  async submit(intent: OrderIntent): Promise<Fill> {
    const tokenData = this.tokenPrices.get(intent.tokenMint)
    if (!tokenData) throw new Error(`No price data for ${intent.tokenMint}`)

    // Apply simulated slippage
    const slippageFactor = intent.side === 'BUY'
      ? 1 + SIMULATED_SLIPPAGE_BPS / 10_000
      : 1 - SIMULATED_SLIPPAGE_BPS / 10_000

    const fillPrice    = tokenData.price * slippageFactor
    const fillPriceSol = tokenData.priceInSol * slippageFactor

    const solAmount   = intent.sizeValue
    const tokenAmount = solAmount / fillPriceSol

    const fee = calculateFee({
      solAmount,
      program: 'raydium',
      paper:   true,
    }).totalFeeSol

    const fill: Fill = {
      id:          uuid(),
      intentId:    intent.id,
      strategyId:  intent.strategyId,
      tokenMint:   intent.tokenMint,
      tokenName:   tokenData.name,
      side:        intent.side,
      price:       fillPrice,
      priceInSol:  fillPriceSol,
      tokenAmount,
      solAmount,
      fee,
      timestamp:   Date.now(),
      txSignature: `PAPER_${uuid().slice(0, 8)}`,
      paper:       true,
    }

    saveFill(fill)
    bus.emit({ type: 'fill:confirmed', data: fill })
    logger.trade(`[PAPER] ${fill.side} ${fill.tokenName} | ${fill.solAmount.toFixed(4)} SOL @ ${fill.priceInSol.toFixed(10)} | fee: ${fill.fee.toFixed(6)} SOL`)

    return fill
  }

  async cancel(intentId: string): Promise<void> {
    // Paper mode: nothing to cancel on-chain
    logger.debug(`[PAPER] Cancelled intent ${intentId}`)
  }

  getPosition(tokenMint: string): Position | null {
    return this.positions.get(tokenMint) ?? null
  }

  getAllPositions(): Position[] {
    return Array.from(this.positions.values())
  }

  async closePosition(tokenMint: string, strategyId: string): Promise<Fill | null> {
    const position = this.positions.get(tokenMint)
    if (!position) return null

    const intent: OrderIntent = {
      id:               uuid(),
      strategyId,
      tokenMint,
      side:             'SELL',
      entryMode:        'NOW',
      sizeMode:         'FIXED',
      sizeValue:        position.solAmount,
      invalidationPrice: 0,
      maxSlippageBps:   100,
      expiresAt:        Date.now() + 30_000,
      confidence:       1,
      lifecycleStage:   'AMM',
      createdAt:        Date.now(),
    }

    return this.submit(intent)
  }
}
