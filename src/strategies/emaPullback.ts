import { v4 as uuid } from 'uuid'
import type { Strategy, MarketSnapshot, Signal } from '../core/types.js'

// EMA Pullback — Trend continuation on AMM tokens
// Setup: EMA9 > EMA21, price pulls back to EMA9, bounce with volume
// Exit: EMA9 crosses below EMA21, or virality slope negative

export const emaPullback: Strategy = {
  id:          'ema_pullback',
  name:        'EMA Pullback',
  description: 'EMA9 > EMA21 trend, buy pullback to EMA9, bounce confirmed by volume',
  lifecycleStages: ['AMM'],
  warmupPeriods:   21,
  enabled:         true,

  evaluate(snapshot: MarketSnapshot): Signal[] {
    const { indicators, volume, virality, lifecycleStage } = snapshot
    if (!this.lifecycleStages.includes(lifecycleStage)) return []
    if (snapshot.candles.s15.length < this.warmupPeriods) return []

    const signals: Signal[] = []
    const candles = snapshot.candles.s15
    const last = candles.at(-1)
    const prev = candles.at(-2)
    if (!last || !prev) return []

    // ── BUY setup ──────────────────────────────────────────
    const trendUp    = indicators.ema9 > indicators.ema21
    const pullback   = last.low <= indicators.ema9 * 1.005  // price touched EMA9 zone
    const bouncing   = last.close > last.open               // current candle green
    const volDipped  = prev.volume < snapshot.candles.s15.slice(-10, -2)
                         .reduce((s, c) => s + c.volume, 0) / 8  // vol dipped on pullback
    const notOverextended = last.close < indicators.ema9 * 1.03

    if (trendUp && pullback && bouncing && volDipped && notOverextended) {
      const distance = Math.abs(last.close - indicators.ema21) / indicators.ema21
      const confidence = Math.min(0.9, 0.5 + distance * 5 + (virality.slope > 0 ? 0.1 : 0))

      signals.push({
        id:         uuid(),
        strategyId: this.id,
        tokenMint:  snapshot.tokenMint,
        side:       'BUY',
        confidence,
        reason:     `EMA9>${indicators.ema9.toFixed(8)} pullback, bounce vol expansion, trend strong`,
        timestamp:  snapshot.timestamp,
        snapshot,
      })
    }

    // ── SELL setup (exit signal for open positions) ────────
    const emaBreakdown  = indicators.ema9 < indicators.ema21
    const viralityDecay = virality.slope < -5
    const volumeCollapse = volume.buySellRatio < 0.35

    if (emaBreakdown || (viralityDecay && volumeCollapse)) {
      signals.push({
        id:         uuid(),
        strategyId: this.id,
        tokenMint:  snapshot.tokenMint,
        side:       'SELL',
        confidence: emaBreakdown ? 0.85 : 0.65,
        reason:     emaBreakdown ? 'EMA9 crossed below EMA21' : 'Virality decay + volume collapse',
        timestamp:  snapshot.timestamp,
        snapshot,
      })
    }

    return signals
  },
}
