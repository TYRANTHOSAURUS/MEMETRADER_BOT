// ============================================================
// Backtest Report Formatter
// ============================================================

import type { BacktestResult } from '../core/types.js'

export function formatBacktestReport(result: BacktestResult): string {
  const { config, perStrategy, totalPnlSol } = result
  const startDate = new Date(config.startTs).toISOString().slice(0, 19).replace('T', ' ')
  const endDate   = new Date(config.endTs).toISOString().slice(0, 19).replace('T', ' ')

  const lines: string[] = [
    ``,
    `╔══════════════════════════════════════════════════════╗`,
    `║               BACKTEST REPORT                        ║`,
    `╚══════════════════════════════════════════════════════╝`,
    ``,
    `  Period:   ${startDate}  →  ${endDate}`,
    `  Balance:  ${config.initialBalanceSol} SOL initial`,
    `  Swaps:    ${result.swapsReplayed.toLocaleString()} replayed`,
    `  Signals:  ${result.signalsEmitted.toLocaleString()} emitted`,
    `  Trades:   ${result.tradesExecuted} executed`,
    `  Duration: ${result.durationMs}ms`,
    ``,
    `── Per-Strategy Results ──────────────────────────────────`,
    ``,
  ]

  const sorted = Object.values(perStrategy).sort((a, b) => b.totalPnlSol - a.totalPnlSol)

  for (const m of sorted) {
    const pnlSign  = m.totalPnlSol >= 0 ? '+' : ''
    const wr       = (m.winRate * 100).toFixed(0)
    const avgHoldMin = (m.avgHoldDurationMs / 60_000).toFixed(1)
    const disabled = m.autoDisabled ? ' [DISABLED]' : ''

    lines.push(
      `  ${m.strategyId.padEnd(24)}` +
      `trades: ${String(m.totalTrades).padStart(4)}  ` +
      `W/L: ${m.winningTrades}/${m.losingTrades}  ` +
      `WR: ${wr}%  ` +
      `PnL: ${pnlSign}${m.totalPnlSol.toFixed(4)} SOL${disabled}`
    )

    if (m.totalTrades > 0) {
      lines.push(
        `  ${''.padEnd(24)}` +
        `avg: ${pnlSign}${m.avgPnlPerTrade.toFixed(4)} SOL  ` +
        `best: +${m.bestTradeSol.toFixed(4)}  ` +
        `worst: ${m.worstTradeSol.toFixed(4)}  ` +
        `hold: ${avgHoldMin}m  ` +
        `sharpe: ${m.sharpeRatio.toFixed(2)}`
      )
    }
    lines.push(``)
  }

  const totalSign = totalPnlSol >= 0 ? '+' : ''
  lines.push(`── Summary ──────────────────────────────────────────────`)
  lines.push(`  Total PnL: ${totalSign}${totalPnlSol.toFixed(4)} SOL`)
  lines.push(`  Win Rate:  ${(result.winRate * 100).toFixed(1)}%`)
  lines.push(``)

  return lines.join('\n')
}
