import { getCandleHistory } from './candleEngine.js'
import { ema, vwap, rsi, swingHigh, swingLow, buyerVelocity } from './indicatorEngine.js'
import { registry } from '../core/tokenRegistry.js'
import type { MarketSnapshot, Candle } from '../core/types.js'

// In-memory state per token (price, liquidity, holder data)
interface TokenState {
  price: number
  priceInSol: number
  liquidity: number
  marketCap: number
  holderCount: number
  holderGrowthRate: number
  mintRevoked: boolean
  freezeRevoked: boolean
  lpBurned: boolean
  devAddress: string
  devBought: boolean
  devSold: boolean
  devHoldingPct: number
  uniqueBuyers5m: Set<string>
  uniqueBuyersPrev5m: Set<string>
  lastRotate: number
}

const state = new Map<string, TokenState>()

export function updatePrice(mint: string, price: number, priceInSol: number): void {
  getOrCreate(mint).price = price
  getOrCreate(mint).priceInSol = priceInSol
}

export function updateLiquidity(mint: string, liquidity: number, mcap: number): void {
  const s = getOrCreate(mint)
  s.liquidity = liquidity
  s.marketCap = mcap
}

export function updateHolders(mint: string, count: number, growthRate: number): void {
  const s = getOrCreate(mint)
  s.holderCount = count
  s.holderGrowthRate = growthRate
}

export function updateSafety(mint: string, mintRevoked: boolean, freezeRevoked: boolean, lpBurned: boolean): void {
  const s = getOrCreate(mint)
  s.mintRevoked = mintRevoked
  s.freezeRevoked = freezeRevoked
  s.lpBurned = lpBurned
}

export function recordBuyer(mint: string, wallet: string): void {
  const s = getOrCreate(mint)
  const now = Date.now()

  // Rotate buyer windows every 1 minute
  if (now - s.lastRotate > 60_000) {
    s.uniqueBuyersPrev5m = s.uniqueBuyers5m
    s.uniqueBuyers5m = new Set()
    s.lastRotate = now
  }

  s.uniqueBuyers5m.add(wallet)
}

export function updateDevWallet(mint: string, address: string, bought: boolean, sold: boolean, holdingPct: number): void {
  const s = getOrCreate(mint)
  s.devAddress = address
  s.devBought = bought
  s.devSold = sold
  s.devHoldingPct = holdingPct
}

function getOrCreate(mint: string): TokenState {
  if (!state.has(mint)) {
    state.set(mint, {
      price: 0, priceInSol: 0, liquidity: 0, marketCap: 0,
      holderCount: 0, holderGrowthRate: 0,
      mintRevoked: false, freezeRevoked: false, lpBurned: false,
      devAddress: '', devBought: false, devSold: false, devHoldingPct: 0,
      uniqueBuyers5m: new Set(), uniqueBuyersPrev5m: new Set(),
      lastRotate: Date.now(),
    })
  }
  return state.get(mint)!
}

export function buildSnapshot(mint: string): MarketSnapshot | null {
  const meta = registry.get(mint)
  if (!meta) return null

  const s = getOrCreate(mint)
  const { s15, m1, m5 } = getCandleHistory(mint)

  if (s15.length < 5) return null // not enough data yet

  const now = Date.now()
  const velocity = buyerVelocity(s15)
  // Use last 5 × 1m candles = 5-minute window (not 5 × 5m = 25 min)
  const totalVol5m  = m1.slice(-5).reduce((acc, c) => acc + c.volume, 0)
  const buyVol5m    = m1.slice(-5).reduce((acc, c) => acc + c.buyVolume, 0)
  const sellVol5m   = m1.slice(-5).reduce((acc, c) => acc + c.sellVolume, 0)

  return {
    tokenMint:    mint,
    tokenName:    meta.name,
    tokenSymbol:  meta.symbol,
    tokenAge:     Math.floor((now - meta.createdAt) / 1000),
    lifecycleStage: meta.lifecycleStage,

    price:      s.price,
    priceInSol: s.priceInSol,
    liquidity:  s.liquidity,
    marketCap:  s.marketCap,

    candles: { s15, m1, m5 },

    indicators: {
      ema9:      ema(s15, 9),
      ema21:     ema(s15, 21),
      ema50:     ema(s15, 50),
      vwap:      vwap(s15),
      swingHigh: swingHigh(s15),
      swingLow:  swingLow(s15),
      rsi14:     rsi(s15, 14),
    },

    volume: {
      total5m:           totalVol5m,
      buyVolume5m:       buyVol5m,
      sellVolume5m:      sellVol5m,
      uniqueBuyers5m:    s.uniqueBuyers5m.size,
      buyerVelocity:     velocity.current,
      buyerVelocityPrev: velocity.previous,
      volumeToMcap:      s.marketCap > 0 ? totalVol5m / s.marketCap : 0,
      buySellRatio:      totalVol5m > 0 ? buyVol5m / totalVol5m : 0.5,
    },

    // Virality is populated by viralityEngine separately
    virality: { score: 0, slope: 0, socialScore: 0, onChainScore: 0 },

    safety: {
      riskScore:     0,
      flags:         [],
      mintRevoked:   s.mintRevoked,
      freezeRevoked: s.freezeRevoked,
      lpBurned:      s.lpBurned,
    },

    devWallet: {
      address:    s.devAddress,
      bought:     s.devBought,
      sold:       s.devSold,
      holdingPct: s.devHoldingPct,
    },

    holderCount:      s.holderCount,
    holderGrowthRate: s.holderGrowthRate,
    timestamp:        now,
  }
}

export function getAllMints(): string[] {
  return Array.from(state.keys())
}

/** Returns live price/liquidity/market state for a token (for HTTP API) */
export function getTokenState(mint: string): Record<string, unknown> | null {
  const s = state.get(mint)
  if (!s) return null
  const meta = registry.get(mint)
  return {
    price:         s.price,
    priceInSol:    s.priceInSol,
    liquidity:     s.liquidity,
    marketCap:     s.marketCap,
    holderCount:   s.holderCount,
    mintRevoked:   s.mintRevoked,
    freezeRevoked: s.freezeRevoked,
    lpBurned:      s.lpBurned,
    // Registry metadata (enriched async)
    imageUrl:  meta?.imageUrl  ?? null,
    website:   meta?.website   ?? null,
    twitter:   meta?.twitter   ?? null,
    telegram:  meta?.telegram  ?? null,
  }
}
