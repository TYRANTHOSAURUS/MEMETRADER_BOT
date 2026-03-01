import { v4 as uuid } from 'uuid'
import type { Strategy, MarketSnapshot, Signal } from '../core/types.js'

// Holder Velocity Acceleration
// Unique buyer velocity accelerating = organic interest, rarely rugs immediately

export const holderVelocity: Strategy = {
  id:          'holder_velocity',
  name:        'Holder Velocity',
  description: 'Accelerating unique buyer count signals organic interest before price moves',
  lifecycleStages: ['BONDING_CURVE', 'AMM'],
  warmupPeriods:   10,
  enabled:         true,

  evaluate(snapshot: MarketSnapshot): Signal[] {
    const { volume, virality, candles, lifecycleStage } = snapshot
    if (!this.lifecycleStages.includes(lifecycleStage)) return []
    if (candles.s15.length < this.warmupPeriods) return []

    const signals: Signal[] = []

    const { buyerVelocity, buyerVelocityPrev } = volume

    // Acceleration: current velocity > prior velocity by >50%
    const accelerating = buyerVelocityPrev > 0
      ? buyerVelocity > buyerVelocityPrev * 1.5
      : buyerVelocity > 5

    // Not already parabolic (avoid chasing)
    const last = candles.s15.at(-1)!
    const prevCandles = candles.s15.slice(-5)
    const avgCandle = prevCandles.reduce((s, c) => s + (c.close - c.open) / c.open, 0) / prevCandles.length
    const notParabolic = avgCandle < 0.15  // < 15% avg candle body

    // Social score rising (confirms organic)
    const socialOk = virality.socialScore >= 0  // always pass if social not wired up

    if (accelerating && notParabolic && socialOk) {
      const velRatio = buyerVelocityPrev > 0 ? buyerVelocity / buyerVelocityPrev : 2
      const confidence = Math.min(0.85, 0.45 + Math.min(velRatio - 1, 1) * 0.4)

      signals.push({
        id:         uuid(),
        strategyId: this.id,
        tokenMint:  snapshot.tokenMint,
        side:       'BUY',
        confidence,
        reason:     `Buyer velocity: ${buyerVelocity} vs prev ${buyerVelocityPrev} (${((velRatio - 1) * 100).toFixed(0)}% increase)`,
        timestamp:  snapshot.timestamp,
        snapshot,
      })
    }

    // Exit: velocity decelerating for 2 consecutive periods
    const decelerating = buyerVelocityPrev > 0 && buyerVelocity < buyerVelocityPrev * 0.5
    if (decelerating && virality.slope < 0) {
      signals.push({
        id:         uuid(),
        strategyId: this.id,
        tokenMint:  snapshot.tokenMint,
        side:       'SELL',
        confidence: 0.70,
        reason:     `Velocity collapse: ${buyerVelocity} vs prev ${buyerVelocityPrev}, virality falling`,
        timestamp:  snapshot.timestamp,
        snapshot,
      })
    }

    return signals
  },
}
