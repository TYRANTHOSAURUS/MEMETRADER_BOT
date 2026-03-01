import type { MarketSnapshot, SafetyResult } from '../core/types.js'

const MIN_LIQUIDITY_USD    = 5_000
const MAX_HOLDER_CONC_PCT  = 30       // single wallet max %
const MAX_SELL_PRESSURE    = 0.70     // sell vol % of total before veto
const MIN_TOKEN_AGE_SEC    = 120      // 2 minutes min age

export function evaluate(snapshot: MarketSnapshot, threshold: number): SafetyResult {
  const flags: string[] = []
  let score = 0

  // ── On-chain structure checks (highest weight) ─────────────

  if (!snapshot.safety.mintRevoked) {
    flags.push('MINT_NOT_REVOKED')
    score += 20
  }

  if (!snapshot.safety.freezeRevoked) {
    flags.push('FREEZE_NOT_REVOKED')
    score += 15
  }

  if (!snapshot.safety.lpBurned && snapshot.lifecycleStage === 'AMM') {
    flags.push('LP_NOT_BURNED')
    score += 20
  }

  // ── Dev wallet ────────────────────────────────────────────

  if (snapshot.devWallet.sold) {
    flags.push('DEV_SOLD')
    score += 30
  }

  if (snapshot.devWallet.holdingPct > MAX_HOLDER_CONC_PCT) {
    flags.push('DEV_HIGH_HOLDING')
    score += 15
  }

  // ── Liquidity ─────────────────────────────────────────────

  if (snapshot.liquidity < MIN_LIQUIDITY_USD) {
    flags.push('LOW_LIQUIDITY')
    score += 25
  } else if (snapshot.liquidity < MIN_LIQUIDITY_USD * 2) {
    flags.push('THIN_LIQUIDITY')
    score += 10
  }

  // ── Age ───────────────────────────────────────────────────

  if (snapshot.tokenAge < MIN_TOKEN_AGE_SEC) {
    flags.push('TOO_NEW')
    score += 20
  }

  // ── Sell pressure ─────────────────────────────────────────

  const sellPressure = 1 - snapshot.volume.buySellRatio
  if (sellPressure > MAX_SELL_PRESSURE) {
    flags.push('HIGH_SELL_PRESSURE')
    score += 20
  }

  // ── Buyer velocity collapse ───────────────────────────────

  if (
    snapshot.volume.buyerVelocityPrev > 5 &&
    snapshot.volume.buyerVelocity < snapshot.volume.buyerVelocityPrev * 0.3
  ) {
    flags.push('VELOCITY_COLLAPSE')
    score += 15
  }

  // ── Cap at 100 ────────────────────────────────────────────

  score = Math.min(score, 100)

  return {
    riskScore:     score,
    flags,
    mintRevoked:   snapshot.safety.mintRevoked,
    freezeRevoked: snapshot.safety.freezeRevoked,
    lpBurned:      snapshot.safety.lpBurned,
    vetoed:        score >= threshold,
  }
}
