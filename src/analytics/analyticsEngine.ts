// ============================================================
// Analytics Engine
//
// Queries signals, outcomes, fills, and metrics to answer:
//   - Which strategies generate accurate signals?
//   - Which signal conditions actually precede profitable moves?
//   - How do strategies compare on signal quality vs trade quality?
//
// This is the primary tool for figuring out what works.
// All data is read-only queries against SQLite.
// ============================================================

import { getDb } from '../storage/sqlite.js'
import { getAllMetrics } from '../risk/strategyMetrics.js'
import type { StrategyMetrics } from '../core/types.js'

// ─── Types ───────────────────────────────────────────────────

export interface SignalQualityRow {
  strategyId:     string
  side:           string
  totalSignals:   number
  resolvedCount:  number
  accuracy30s:    number   // % correct at 30 sec
  accuracy1m:     number   // % correct at 1 min
  accuracy5m:     number   // % correct at 5 min
  avgMaxGain:     number   // avg max price gain in 5m window (%)
  avgMaxLoss:     number   // avg max price loss in 5m window (%)
  expectedValue:  number   // avg(maxGain) + avg(maxLoss) — raw EV proxy
}

export interface StrategyReport {
  strategyId:    string
  metrics:       StrategyMetrics
  signalQuality: SignalQualityRow[]
  recentSignals: RecentSignal[]
}

export interface RecentSignal {
  id:          string
  strategyId:  string
  tokenMint:   string
  tokenName:   string
  side:        string
  confidence:  number
  reason:      string
  timestamp:   number
  resolved:    boolean | null
  accuracy30s: boolean | null
  maxGain:     number | null
  maxLoss:     number | null
}

export interface AnalyticsSummary {
  generatedAt:    number
  strategies:     StrategyReport[]
  topByAccuracy:  SignalQualityRow[]
  topByEv:        SignalQualityRow[]
  recentActivity: RecentSignal[]
}

// ─── Public API ──────────────────────────────────────────────

export function getSignalQuality(strategyId?: string): SignalQualityRow[] {
  const db = getDb()

  const where = strategyId ? `WHERE so.strategy_id = ?` : ''
  const params = strategyId ? [strategyId] : []

  const rows = db.prepare(`
    SELECT
      so.strategy_id,
      so.side,
      COUNT(*)                                                      AS total_signals,
      SUM(CASE WHEN so.resolved = 1 THEN 1 ELSE 0 END)             AS resolved_count,
      ROUND(AVG(CASE WHEN so.resolved = 1 THEN so.dir_correct_30s ELSE NULL END) * 100, 1) AS accuracy_30s,
      ROUND(AVG(CASE WHEN so.resolved = 1 THEN so.dir_correct_1m  ELSE NULL END) * 100, 1) AS accuracy_1m,
      ROUND(AVG(CASE WHEN so.resolved = 1 THEN so.dir_correct_5m  ELSE NULL END) * 100, 1) AS accuracy_5m,
      ROUND(AVG(CASE WHEN so.resolved = 1 THEN so.max_gain_pct    ELSE NULL END), 2)        AS avg_max_gain,
      ROUND(AVG(CASE WHEN so.resolved = 1 THEN so.max_loss_pct    ELSE NULL END), 2)        AS avg_max_loss
    FROM signal_outcomes so
    ${where}
    GROUP BY so.strategy_id, so.side
    ORDER BY so.strategy_id, so.side
  `).all(...params) as Array<Record<string, unknown>>

  return rows.map(r => ({
    strategyId:    r['strategy_id'] as string,
    side:          r['side'] as string,
    totalSignals:  r['total_signals'] as number,
    resolvedCount: r['resolved_count'] as number,
    accuracy30s:   (r['accuracy_30s'] as number) ?? 0,
    accuracy1m:    (r['accuracy_1m']  as number) ?? 0,
    accuracy5m:    (r['accuracy_5m']  as number) ?? 0,
    avgMaxGain:    (r['avg_max_gain'] as number) ?? 0,
    avgMaxLoss:    (r['avg_max_loss'] as number) ?? 0,
    expectedValue: ((r['avg_max_gain'] as number) ?? 0) + ((r['avg_max_loss'] as number) ?? 0),
  }))
}

export function getRecentSignals(limit = 100, strategyId?: string): RecentSignal[] {
  const db = getDb()

  const stratFilter = strategyId ? `AND s.strategy_id = ?` : ''
  const params: (string | number)[] = strategyId ? [strategyId, limit] : [limit]

  const rows = db.prepare(`
    SELECT
      s.id, s.strategy_id, s.token_mint, s.token_name, s.side,
      s.confidence, s.reason, s.ts,
      so.resolved, so.dir_correct_30s, so.max_gain_pct, so.max_loss_pct
    FROM signals s
    LEFT JOIN signal_outcomes so ON s.id = so.signal_id
    WHERE 1=1 ${stratFilter}
    ORDER BY s.ts DESC
    LIMIT ?
  `).all(...params) as Array<Record<string, unknown>>

  return rows.map(r => ({
    id:          r['id'] as string,
    strategyId:  r['strategy_id'] as string,
    tokenMint:   r['token_mint'] as string,
    tokenName:   r['token_name'] as string,
    side:        r['side'] as string,
    confidence:  r['confidence'] as number,
    reason:      r['reason'] as string,
    timestamp:   r['ts'] as number,
    resolved:    r['resolved'] !== null ? Boolean(r['resolved']) : null,
    accuracy30s: r['dir_correct_30s'] !== null ? Boolean(r['dir_correct_30s']) : null,
    maxGain:     r['max_gain_pct'] as number | null,
    maxLoss:     r['max_loss_pct'] as number | null,
  }))
}

export function getStrategyReport(strategyId: string): StrategyReport {
  const metrics       = getAllMetrics().find(m => m.strategyId === strategyId) ?? nullMetrics(strategyId)
  const signalQuality = getSignalQuality(strategyId)
  const recentSignals = getRecentSignals(50, strategyId)

  return { strategyId, metrics, signalQuality, recentSignals }
}

export function getSummary(): AnalyticsSummary {
  const allMetrics    = getAllMetrics()
  const quality       = getSignalQuality()
  const recentSignals = getRecentSignals(50)

  const strategies: StrategyReport[] = allMetrics.map(m => ({
    strategyId:    m.strategyId,
    metrics:       m,
    signalQuality: quality.filter(q => q.strategyId === m.strategyId),
    recentSignals: recentSignals.filter(s => s.strategyId === m.strategyId).slice(0, 10),
  }))

  const resolved = quality.filter(q => q.resolvedCount > 0)

  return {
    generatedAt:   Date.now(),
    strategies,
    topByAccuracy: [...resolved].sort((a, b) => b.accuracy1m - a.accuracy1m).slice(0, 5),
    topByEv:       [...resolved].sort((a, b) => b.expectedValue - a.expectedValue).slice(0, 5),
    recentActivity: recentSignals.slice(0, 20),
  }
}

// ─── Token-level analytics ────────────────────────────────────

export interface TokenSignalStats {
  mint:         string
  name:         string
  totalSignals: number
  buySignals:   number
  sellSignals:  number
  avgConfidence: number
  lastSignalTs:  number
}

export function getTokenSignalStats(limit = 50): TokenSignalStats[] {
  const db = getDb()
  const rows = db.prepare(`
    SELECT
      token_mint, token_name,
      COUNT(*)                         AS total,
      SUM(CASE WHEN side='BUY'  THEN 1 ELSE 0 END) AS buys,
      SUM(CASE WHEN side='SELL' THEN 1 ELSE 0 END) AS sells,
      ROUND(AVG(confidence), 3)        AS avg_conf,
      MAX(ts)                          AS last_ts
    FROM signals
    GROUP BY token_mint
    ORDER BY last_ts DESC
    LIMIT ?
  `).all(limit) as Array<Record<string, unknown>>

  return rows.map(r => ({
    mint:          r['token_mint'] as string,
    name:          r['token_name'] as string,
    totalSignals:  r['total'] as number,
    buySignals:    r['buys'] as number,
    sellSignals:   r['sells'] as number,
    avgConfidence: r['avg_conf'] as number,
    lastSignalTs:  r['last_ts'] as number,
  }))
}

// ─── Confidence calibration ───────────────────────────────────
// "Is high-confidence actually more accurate?"

export interface ConfidenceBucket {
  bucket:     string    // e.g. "5/10", "8/10"
  count:      number
  accuracy1m: number
  avgMaxGain: number
}

export function getConfidenceCalibration(): ConfidenceBucket[] {
  const db = getDb()
  const rows = db.prepare(`
    SELECT
      CAST(ROUND(s.confidence * 10) AS TEXT) || '/10'      AS bucket,
      COUNT(*)                                              AS cnt,
      ROUND(AVG(so.dir_correct_1m) * 100, 1)               AS acc_1m,
      ROUND(AVG(so.max_gain_pct), 2)                       AS avg_gain
    FROM signals s
    JOIN signal_outcomes so ON s.id = so.signal_id
    WHERE so.resolved = 1
    GROUP BY bucket
    ORDER BY bucket
  `).all() as Array<Record<string, unknown>>

  return rows.map(r => ({
    bucket:      r['bucket'] as string,
    count:       r['cnt'] as number,
    accuracy1m:  (r['acc_1m'] as number) ?? 0,
    avgMaxGain:  (r['avg_gain'] as number) ?? 0,
  }))
}

// ─── Report printer (for CLI / API) ──────────────────────────

export function printSummaryReport(): string {
  const s = getSummary()
  const lines: string[] = [
    `\n═══════════════════════════════════════════════`,
    `  ANALYTICS REPORT — ${new Date(s.generatedAt).toISOString()}`,
    `═══════════════════════════════════════════════`,
    `\n── Strategy Performance (Trades) ───────────────`,
  ]

  for (const { strategyId, metrics } of s.strategies) {
    const q = s.strategies.find(r => r.strategyId === strategyId)?.signalQuality ?? []
    const buyQ  = q.find(r => r.side === 'BUY')
    const sellQ = q.find(r => r.side === 'SELL')
    lines.push(
      `  ${strategyId.padEnd(22)} ` +
      `trades:${metrics.totalTrades} ` +
      `winRate:${(metrics.winRate * 100).toFixed(0)}% ` +
      `pnl:${metrics.totalPnlSol > 0 ? '+' : ''}${metrics.totalPnlSol.toFixed(3)} SOL` +
      (metrics.autoDisabled ? ' [DISABLED]' : '')
    )
    if (buyQ && buyQ.resolvedCount > 0) {
      lines.push(
        `    BUY signals: ${buyQ.totalSignals} ` +
        `| acc@1m: ${buyQ.accuracy1m}% ` +
        `| maxGain: +${buyQ.avgMaxGain.toFixed(1)}% ` +
        `| maxLoss: ${buyQ.avgMaxLoss.toFixed(1)}%`
      )
    }
    if (sellQ && sellQ.resolvedCount > 0) {
      lines.push(
        `    SELL signals: ${sellQ.totalSignals} ` +
        `| acc@1m: ${sellQ.accuracy1m}%`
      )
    }
  }

  lines.push(`\n── Top Strategies by Signal Accuracy (1m) ─────`)
  for (const q of s.topByAccuracy) {
    lines.push(`  ${q.strategyId} ${q.side}: ${q.accuracy1m}% (n=${q.resolvedCount})`)
  }

  return lines.join('\n')
}

// ─── Helpers ─────────────────────────────────────────────────

function nullMetrics(strategyId: string): StrategyMetrics {
  return {
    strategyId, totalTrades: 0, winningTrades: 0, losingTrades: 0,
    winRate: 0, totalPnlSol: 0, avgPnlPerTrade: 0, avgHoldDurationMs: 0,
    bestTradeSol: 0, worstTradeSol: 0, maxDrawdownSol: 0,
    sharpeRatio: 0, autoDisabled: false, lastUpdated: 0,
  }
}
