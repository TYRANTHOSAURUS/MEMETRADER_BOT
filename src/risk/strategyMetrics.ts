import { bus } from '../core/eventBus.js'
import { logger } from '../core/logger.js'
import { disableStrategy } from '../strategies/index.js'
import { upsertStrategyMetrics, getAllStrategyMetrics } from '../storage/sqlite.js'
import type { Fill, StrategyMetrics } from '../core/types.js'

// Tracks per-strategy performance. Auto-disables underperformers.

interface TradeRecord {
  strategyId:  string
  pnlSol:      number
  holdMs:      number
  entryTs:     number
}

const metrics   = new Map<string, StrategyMetrics>()
const openTrades = new Map<string, { strategyId: string; entryTs: number; solAmount: number }>()

const DRAWDOWN_LIMIT = 0.3   // 30% drawdown → auto-disable
const MIN_TRADES     = 5     // don't auto-disable until we have enough data

export function initMetrics(strategyIds: string[]): void {
  const persisted = getAllStrategyMetrics() as StrategyMetrics[]
  const byId = new Map(persisted.map(m => [m.strategyId, m]))

  for (const id of strategyIds) {
    metrics.set(id, byId.get(id) ?? defaultMetrics(id))
  }
}

export function onBuyFill(fill: Fill): void {
  openTrades.set(fill.tokenMint, {
    strategyId: fill.strategyId,
    entryTs:    fill.timestamp,
    solAmount:  fill.solAmount,
  })
}

export function onSellFill(fill: Fill, pnlSol: number): void {
  const open = openTrades.get(fill.tokenMint)
  if (!open) return

  openTrades.delete(fill.tokenMint)
  recordTrade(open.strategyId, pnlSol, fill.timestamp - open.entryTs)
}

function recordTrade(strategyId: string, pnlSol: number, holdMs: number): void {
  let m = metrics.get(strategyId) ?? defaultMetrics(strategyId)

  const won = pnlSol > 0
  m.totalTrades    += 1
  m.winningTrades  += won ? 1 : 0
  m.losingTrades   += won ? 0 : 1
  m.totalPnlSol    += pnlSol
  m.winRate         = m.winningTrades / m.totalTrades
  m.avgPnlPerTrade  = m.totalPnlSol / m.totalTrades
  m.avgHoldDurationMs = (m.avgHoldDurationMs * (m.totalTrades - 1) + holdMs) / m.totalTrades
  m.bestTradeSol    = Math.max(m.bestTradeSol, pnlSol)
  m.worstTradeSol   = Math.min(m.worstTradeSol, pnlSol)
  m.lastUpdated     = Date.now()

  // Track drawdown (simplified: peak - current total P&L)
  if (m.totalPnlSol < m.maxDrawdownSol) m.maxDrawdownSol = m.totalPnlSol

  metrics.set(strategyId, m)
  upsertStrategyMetrics(m)

  // Auto-disable check
  if (m.totalTrades >= MIN_TRADES && m.maxDrawdownSol < -DRAWDOWN_LIMIT) {
    const reason = `7d drawdown ${m.maxDrawdownSol.toFixed(4)} SOL exceeds limit`
    m.autoDisabled = true
    disableStrategy(strategyId)
    bus.emit({ type: 'strategy:disabled', data: { strategyId, reason } })
    logger.warn(`Strategy ${strategyId} auto-disabled: ${reason}`)
  }
}

export function getMetrics(strategyId: string): StrategyMetrics | undefined {
  return metrics.get(strategyId)
}

export function getAllMetrics(): StrategyMetrics[] {
  return Array.from(metrics.values())
}

function defaultMetrics(strategyId: string): StrategyMetrics {
  return {
    strategyId,
    totalTrades:      0,
    winningTrades:    0,
    losingTrades:     0,
    winRate:          0,
    totalPnlSol:      0,
    avgPnlPerTrade:   0,
    avgHoldDurationMs:0,
    bestTradeSol:     0,
    worstTradeSol:    0,
    maxDrawdownSol:   0,
    sharpeRatio:      0,
    autoDisabled:     false,
    lastUpdated:      Date.now(),
  }
}
