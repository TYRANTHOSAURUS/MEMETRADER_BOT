import { bus } from '../core/eventBus.js'
import { logger } from '../core/logger.js'
import type { Position, Fill, OrderIntent, PortfolioState, BotConfig } from '../core/types.js'
import { savePosition, closePosition as dbClosePosition } from '../storage/sqlite.js'

export class PortfolioManager {
  private positions = new Map<string, Position>()
  private startBalance: number
  private currentBalance: number
  private dayPnl = 0
  private totalPnl = 0
  private killed = false
  private config: BotConfig

  constructor(config: BotConfig, initialBalanceSol: number) {
    this.config = config
    this.startBalance = initialBalanceSol
    this.currentBalance = initialBalanceSol
  }

  canTrade(intent: OrderIntent): { ok: boolean; reason?: string } {
    if (this.killed) return { ok: false, reason: 'Kill switch active' }

    if (this.dayPnl <= -this.config.dailyLossLimitSol) {
      return { ok: false, reason: `Daily loss limit hit (${this.dayPnl.toFixed(4)} SOL)` }
    }

    if (intent.side === 'BUY') {
      if (this.positions.size >= this.config.maxOpenPositions) {
        return { ok: false, reason: `Max positions reached (${this.config.maxOpenPositions})` }
      }

      const tokenExposure = (this.getPosition(intent.tokenMint)?.solAmount ?? 0) + intent.sizeValue
      const exposurePct = (tokenExposure / this.currentBalance) * 100
      if (exposurePct > this.config.maxTokenExposurePct) {
        return { ok: false, reason: `Token exposure limit (${exposurePct.toFixed(1)}%)` }
      }

      if (intent.sizeValue > this.config.maxPositionSizeSol) {
        return { ok: false, reason: `Trade size exceeds max (${intent.sizeValue} SOL)` }
      }

      if (this.currentBalance - intent.sizeValue < 0.1) {
        return { ok: false, reason: 'Insufficient balance' }
      }
    }

    return { ok: true }
  }

  onFill(fill: Fill): void {
    if (fill.side === 'BUY') {
      const position: Position = {
        id:             fill.id,
        tokenMint:      fill.tokenMint,
        tokenName:      fill.tokenName,
        tokenSymbol:    '',
        strategyId:     fill.strategyId,
        entryPrice:     fill.price,
        entryPriceInSol: fill.priceInSol,
        tokenAmount:    fill.tokenAmount,
        solAmount:      fill.solAmount,
        entryTime:      fill.timestamp,
        currentPrice:   fill.price,
        unrealizedPnlSol: 0,
        unrealizedPnlPct: 0,
        paper:          fill.paper,
      }
      this.positions.set(fill.tokenMint, position)
      this.currentBalance -= fill.solAmount + fill.fee
      savePosition(position)
      bus.emit({ type: 'position:opened', data: position })
    } else {
      const position = this.positions.get(fill.tokenMint)
      if (position) {
        const pnlSol = (fill.priceInSol - position.entryPriceInSol) * position.tokenAmount - fill.fee
        const pnlPct = pnlSol / position.solAmount

        this.dayPnl   += pnlSol
        this.totalPnl += pnlSol
        this.currentBalance += fill.solAmount - fill.fee

        this.positions.delete(fill.tokenMint)
        dbClosePosition(position.id, fill.price, pnlSol)
        bus.emit({ type: 'position:closed', data: { position, pnlSol, pnlPct } })

        logger.trade(`Closed ${fill.tokenMint.slice(0, 8)} | P&L: ${pnlSol > 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL (${(pnlPct * 100).toFixed(1)}%)`)
      }
    }

    this.emitState()
  }

  updatePrices(prices: Map<string, number>): void {
    let changed = false
    for (const [mint, position] of this.positions) {
      const price = prices.get(mint)
      if (!price) continue

      const pnlSol = (price / position.entryPrice - 1) * position.solAmount
      const pnlPct = pnlSol / position.solAmount

      if (Math.abs(pnlSol - position.unrealizedPnlSol) > 0.0001) {
        position.currentPrice     = price
        position.unrealizedPnlSol = pnlSol
        position.unrealizedPnlPct = pnlPct
        bus.emit({ type: 'position:updated', data: { ...position } })
        changed = true
      }
    }
    if (changed) this.emitState()
  }

  /** Sync balance from on-chain (live mode) */
  setBalance(sol: number): void {
    this.currentBalance = sol
  }

  activateKillSwitch(reason: string): void {
    this.killed = true
    bus.emit({ type: 'kill_switch', data: { reason } })
    logger.error(`KILL SWITCH ACTIVATED: ${reason}`)
  }

  getPosition(mint: string): Position | undefined {
    return this.positions.get(mint)
  }

  getAllPositions(): Position[] {
    return Array.from(this.positions.values())
  }

  getState(): PortfolioState {
    return {
      totalBalanceSol:      this.currentBalance,
      availableBalanceSol:  this.currentBalance - this.openExposure(),
      openPositions:        this.getAllPositions(),
      dayPnlSol:            this.dayPnl,
      totalPnlSol:          this.totalPnl,
      openPositionCount:    this.positions.size,
      maxPositions:         this.config.maxOpenPositions,
      dailyLossLimitSol:    this.config.dailyLossLimitSol,
      killed:               this.killed,
    }
  }

  private openExposure(): number {
    return Array.from(this.positions.values()).reduce((s, p) => s + p.solAmount, 0)
  }

  private emitState(): void {
    bus.emit({ type: 'portfolio:updated', data: this.getState() })
  }
}
