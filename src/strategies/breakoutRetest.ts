import { v4 as uuid } from 'uuid'
import type { Strategy, MarketSnapshot, Signal } from '../core/types.js'

// Breakout → Retest
// Break above swing high with volume, retest holds, enter on confirmation

export const breakoutRetest: Strategy = {
  id:          'breakout_retest',
  name:        'Breakout Retest',
  description: 'Break above swing high with volume, wait for retest to hold, enter',
  lifecycleStages: ['AMM'],
  warmupPeriods:   15,
  enabled:         true,

  evaluate(snapshot: MarketSnapshot): Signal[] {
    const { indicators, volume, candles, lifecycleStage } = snapshot
    if (!this.lifecycleStages.includes(lifecycleStage)) return []
    if (candles.s15.length < this.warmupPeriods) return []

    const signals: Signal[] = []
    const s15 = candles.s15
    const last = s15.at(-1)
    const prev = s15.at(-2)
    if (!last || !prev) return []

    // Average volume over last 20 candles for comparison
    const avgVol = s15.slice(-20, -1).reduce((s, c) => s + c.volume, 0) / 19
    const volExpanded = last.volume > avgVol * 2

    // ── Detect fresh break ─────────────────────────────────
    const brokeOut = prev.close < indicators.swingHigh && last.close > indicators.swingHigh

    // ── Detect retest hold ─────────────────────────────────
    // Price came back to swing high zone and held (close above it)
    const retesting = last.low <= indicators.swingHigh * 1.01 && last.close > indicators.swingHigh * 0.99

    // ── BUY on breakout + volume ───────────────────────────
    if (brokeOut && volExpanded && volume.volumeToMcap > 0.05) {
      signals.push({
        id:         uuid(),
        strategyId: this.id,
        tokenMint:  snapshot.tokenMint,
        side:       'BUY',
        confidence: Math.min(0.85, 0.55 + (volume.volumeToMcap * 2)),
        reason:     `Break above swing high ${indicators.swingHigh.toFixed(8)}, vol ${(last.volume / avgVol).toFixed(1)}x avg`,
        timestamp:  snapshot.timestamp,
        snapshot,
      })
    }

    // ── BUY on retest hold (higher conviction) ─────────────
    if (!brokeOut && retesting && volume.buySellRatio > 0.6) {
      signals.push({
        id:         uuid(),
        strategyId: this.id,
        tokenMint:  snapshot.tokenMint,
        side:       'BUY',
        confidence: 0.8,
        reason:     `Retest of breakout level holding, buy pressure ${(volume.buySellRatio * 100).toFixed(0)}%`,
        timestamp:  snapshot.timestamp,
        snapshot,
      })
    }

    // ── SELL — structure break ─────────────────────────────
    const structureBreak = last.close < indicators.swingLow
    if (structureBreak) {
      signals.push({
        id:         uuid(),
        strategyId: this.id,
        tokenMint:  snapshot.tokenMint,
        side:       'SELL',
        confidence: 0.8,
        reason:     `Structure break below swing low ${indicators.swingLow.toFixed(8)}`,
        timestamp:  snapshot.timestamp,
        snapshot,
      })
    }

    return signals
  },
}
