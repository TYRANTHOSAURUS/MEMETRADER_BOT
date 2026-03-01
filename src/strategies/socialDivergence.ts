import { v4 as uuid } from 'uuid'
import type { Strategy, MarketSnapshot, Signal } from '../core/types.js'

// Social Spike → Price Divergence
// When social mentions spike but price hasn't moved yet, there's an early entry
// window before the crowd arrives on-chain.
// Requires socialScore to be wired up (Twitter/Telegram data). If socialScore
// is 0 across the board (stub), no signals are emitted.

// Per-token social baseline tracking
const socialBaselines = new Map<string, {
  score: number    // baseline social score (rolling min)
  peak: number     // highest social score seen
  peakTs: number   // timestamp of peak
  ts: number       // when baseline was recorded
}>()

const BASELINE_WINDOW_MS   = 5 * 60_000   // 5 minutes
const SOCIAL_SPIKE_RATIO   = 2.0          // social score must be 2x baseline
const MAX_PRICE_MOVE_PCT   = 0.15         // price must not have moved >15%
const ONCHAINSCORE_THRESH  = 40           // on-chain crowd not yet arrived (<40)
const MIN_SOCIAL_SCORE     = 5            // ignore if social score is near zero (not wired up)
const VIRALITY_PEAK_THRESH = 75           // above this + slope < 0 = peak passed
const SOCIAL_COLLAPSE_RATIO = 0.5        // exit if social drops >50% from peak

export const socialDivergence: Strategy = {
  id:          'social_divergence',
  name:        'Social Divergence',
  description: 'Social spike before price moves — enter the divergence, exit when on-chain catches up',
  lifecycleStages: ['BONDING_CURVE', 'AMM'],
  warmupPeriods:   5,
  enabled:         true,

  evaluate(snapshot: MarketSnapshot): Signal[] {
    const { virality, candles, lifecycleStage } = snapshot
    if (!this.lifecycleStages.includes(lifecycleStage)) return []
    if (candles.s15.length < this.warmupPeriods) return []

    // If social score is not wired up (all zeros), skip entirely
    if (virality.socialScore < MIN_SOCIAL_SCORE) return []

    const signals: Signal[] = []
    const mint = snapshot.tokenMint
    const now  = snapshot.timestamp

    // ── Baseline tracking ─────────────────────────────────────
    const prior = socialBaselines.get(mint)

    if (!prior || now - prior.ts > BASELINE_WINDOW_MS) {
      // Refresh baseline: use current score as new reference if enough time passed
      socialBaselines.set(mint, {
        score:  virality.socialScore,
        peak:   virality.socialScore,
        peakTs: now,
        ts:     now,
      })
      return []
    }

    // Track peak
    if (virality.socialScore > prior.peak) {
      prior.peak   = virality.socialScore
      prior.peakTs = now
    }

    // ── Entry logic ───────────────────────────────────────────
    const spikeRatio = prior.score > 0
      ? virality.socialScore / prior.score
      : 0

    const isSpiking     = spikeRatio >= SOCIAL_SPIKE_RATIO
    const onChainLagged = virality.onChainScore < ONCHAINSCORE_THRESH

    // Price change in last 5 minutes (using m1 candles)
    const m1 = candles.m1
    const priceMoveWindow = m1.slice(-5)
    const priceChangePct = priceMoveWindow.length >= 2
      ? Math.abs(priceMoveWindow.at(-1)!.close - priceMoveWindow[0].open) / priceMoveWindow[0].open
      : 0

    const priceDivergent = priceChangePct < MAX_PRICE_MOVE_PCT

    if (isSpiking && onChainLagged && priceDivergent) {
      const confidence = Math.min(0.80, 0.45 + Math.min(spikeRatio - SOCIAL_SPIKE_RATIO, 2) * 0.1 + (ONCHAINSCORE_THRESH - virality.onChainScore) / ONCHAINSCORE_THRESH * 0.15)

      signals.push({
        id:         uuid(),
        strategyId: this.id,
        tokenMint:  snapshot.tokenMint,
        side:       'BUY',
        confidence,
        reason:     `Social spike ${spikeRatio.toFixed(1)}x baseline (score ${virality.socialScore.toFixed(0)}), price only moved ${(priceChangePct * 100).toFixed(1)}%, on-chain lagging`,
        timestamp:  now,
        snapshot,
      })
    }

    // ── Exit logic ────────────────────────────────────────────

    // Exit 1: on-chain has caught up and virality is peaking/falling
    const onChainCaughtUp = virality.onChainScore >= VIRALITY_PEAK_THRESH
    const viralityPeaking  = virality.slope <= 0

    if (onChainCaughtUp && viralityPeaking) {
      signals.push({
        id:         uuid(),
        strategyId: this.id,
        tokenMint:  snapshot.tokenMint,
        side:       'SELL',
        confidence: 0.75,
        reason:     `On-chain caught up (${virality.onChainScore.toFixed(0)}), virality peak passed (slope ${virality.slope.toFixed(2)})`,
        timestamp:  now,
        snapshot,
      })
    }

    // Exit 2: social score collapsed from peak without price follow-through
    const socialCollapsed = prior.peak > 0 && virality.socialScore < prior.peak * SOCIAL_COLLAPSE_RATIO
    if (socialCollapsed && virality.onChainScore < 50) {
      signals.push({
        id:         uuid(),
        strategyId: this.id,
        tokenMint:  snapshot.tokenMint,
        side:       'SELL',
        confidence: 0.80,
        reason:     `Social collapsed to ${virality.socialScore.toFixed(0)} from peak ${prior.peak.toFixed(0)} without on-chain follow-through`,
        timestamp:  now,
        snapshot,
      })
    }

    return signals
  },
}
