import type { MarketSnapshot } from '../core/types.js'
import { logger } from '../core/logger.js'

// Virality Engine — on-chain score + DexScreener social data
// Social scores refresh every 2 minutes per token (rate limit friendly)

interface ViralityScore {
  score:        number   // 0–100 composite
  slope:        number   // positive = accelerating
  socialScore:  number   // 0–100
  onChainScore: number   // 0–100
}

interface DexScreenerPair {
  priceUsd?:   string
  liquidity?:  { usd?: number }
  fdv?:        number
  txns?:       { h24?: { buys?: number; sells?: number } }
  volume?:     { h24?: number }
  info?:       {
    socials?: Array<{ type: string; url: string }>
    websites?: Array<{ url: string }>
  }
}

interface DexCacheEntry {
  socialScore: number
  fetchedAt:   number
}

// Cache: mint → social score
const dexCache      = new Map<string, DexCacheEntry>()
const fetchQueue:     string[] = []
let fetchTimer:      ReturnType<typeof setTimeout> | null = null
const FETCH_INTERVAL = 2_000     // 1 fetch per 2s (DexScreener free tier)
const CACHE_TTL      = 120_000   // re-fetch every 2 minutes
const QUEUE_CAP      = 50

// Snapshot of prior scores for slope calculation
const priorScores = new Map<string, { score: number; ts: number }>()

export function computeVirality(snapshot: MarketSnapshot): ViralityScore {
  const onChainScore = computeOnChainScore(snapshot)

  // Use cached DexScreener social score; queue a refresh if stale
  const cached = dexCache.get(snapshot.tokenMint)
  const socialScore = cached?.socialScore ?? 0

  if (!cached || Date.now() - cached.fetchedAt > CACHE_TTL) {
    queueDexFetch(snapshot.tokenMint)
  }

  const score = onChainScore * 0.7 + socialScore * 0.3

  // Slope: compare to score from 2 minutes ago
  const prior = priorScores.get(snapshot.tokenMint)
  let slope = 0
  if (prior) {
    const dt = (snapshot.timestamp - prior.ts) / 60_000  // minutes
    slope = dt > 0 ? (score - prior.score) / dt : 0
  }

  if (!prior || snapshot.timestamp - prior.ts > 30_000) {
    priorScores.set(snapshot.tokenMint, { score, ts: snapshot.timestamp })
  }

  return { score, slope, socialScore, onChainScore }
}

function computeOnChainScore(snapshot: MarketSnapshot): number {
  let score = 0

  // Buyer velocity acceleration (max 40 pts)
  const velSlope = snapshot.volume.buyerVelocityPrev > 0
    ? (snapshot.volume.buyerVelocity - snapshot.volume.buyerVelocityPrev) / snapshot.volume.buyerVelocityPrev
    : 0

  if (velSlope > 0.5)       score += 40
  else if (velSlope > 0.25) score += 30
  else if (velSlope > 0)    score += 15
  else if (velSlope < -0.5) score -= 20

  // Unique buyers in 5m (max 30 pts)
  const buyers = snapshot.volume.uniqueBuyers5m
  if (buyers > 100)      score += 30
  else if (buyers > 50)  score += 20
  else if (buyers > 20)  score += 10
  else if (buyers > 10)  score += 5

  // Holder growth rate (max 20 pts)
  const growth = snapshot.holderGrowthRate
  if (growth > 50)      score += 20
  else if (growth > 20) score += 12
  else if (growth > 5)  score += 5

  // Volume/mcap ratio (max 10 pts)
  const vmr = snapshot.volume.volumeToMcap
  if (vmr > 0.2)      score += 10
  else if (vmr > 0.1) score += 5

  return Math.max(0, Math.min(100, score))
}

// ─── DexScreener integration ─────────────────────────────────

function queueDexFetch(mint: string): void {
  if (fetchQueue.length >= QUEUE_CAP) return
  if (!fetchQueue.includes(mint)) fetchQueue.push(mint)
  scheduleDexFetch()
}

function scheduleDexFetch(): void {
  if (fetchTimer) return
  fetchTimer = setTimeout(processDexQueue, FETCH_INTERVAL)
}

function processDexQueue(): void {
  fetchTimer = null
  const mint = fetchQueue.shift()
  if (!mint) return
  fetchDexScreener(mint).catch(() => {}).finally(() => {
    if (fetchQueue.length > 0) scheduleDexFetch()
  })
}

async function fetchDexScreener(mint: string): Promise<void> {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
      headers: { 'User-Agent': 'memetrader-bot/0.1' },
    })
    if (!res.ok) return

    const data = await res.json() as { pairs?: DexScreenerPair[] }
    const pairs = data.pairs
    if (!pairs || pairs.length === 0) {
      dexCache.set(mint, { socialScore: 0, fetchedAt: Date.now() })
      return
    }

    // Use the most liquid pair
    const pair = pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0]

    let socialScore = 0

    // Social presence (max 60 pts)
    const socials = pair.info?.socials ?? []
    const hasTwitter  = socials.some(s => s.type === 'twitter')
    const hasTelegram = socials.some(s => s.type === 'telegram')
    const hasWebsite  = (pair.info?.websites ?? []).length > 0
    if (hasTwitter)  socialScore += 25
    if (hasTelegram) socialScore += 25
    if (hasWebsite)  socialScore += 10

    // Transaction activity (max 40 pts)
    const buys  = pair.txns?.h24?.buys  ?? 0
    const sells = pair.txns?.h24?.sells ?? 0
    const total = buys + sells
    if (total > 5000)      socialScore += 40
    else if (total > 1000) socialScore += 30
    else if (total > 200)  socialScore += 20
    else if (total > 50)   socialScore += 10

    socialScore = Math.min(100, socialScore)
    dexCache.set(mint, { socialScore, fetchedAt: Date.now() })
    logger.debug(`Virality: ${mint.slice(0, 8)} social=${socialScore} (tw=${hasTwitter} tg=${hasTelegram})`)
  } catch { /* best-effort */ }
}
