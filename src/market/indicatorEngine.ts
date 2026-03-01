import type { Candle } from '../core/types.js'

// ─── EMA ─────────────────────────────────────────────────────

export function ema(candles: Candle[], period: number): number {
  if (candles.length < period) return candles.at(-1)?.close ?? 0

  const k = 2 / (period + 1)
  let value = candles.slice(0, period).reduce((sum, c) => sum + c.close, 0) / period

  for (let i = period; i < candles.length; i++) {
    value = candles[i].close * k + value * (1 - k)
  }
  return value
}

export function emaArray(candles: Candle[], period: number): number[] {
  if (candles.length < period) return []

  const k = 2 / (period + 1)
  const result: number[] = []
  let value = candles.slice(0, period).reduce((sum, c) => sum + c.close, 0) / period
  result.push(value)

  for (let i = period; i < candles.length; i++) {
    value = candles[i].close * k + value * (1 - k)
    result.push(value)
  }
  return result
}

// ─── VWAP ─────────────────────────────────────────────────────

export function vwap(candles: Candle[]): number {
  let totalVolume = 0
  let totalPV = 0

  for (const c of candles) {
    const typicalPrice = (c.high + c.low + c.close) / 3
    totalPV += typicalPrice * c.volume
    totalVolume += c.volume
  }

  return totalVolume === 0 ? 0 : totalPV / totalVolume
}

// ─── RSI ──────────────────────────────────────────────────────

export function rsi(candles: Candle[], period = 14): number {
  if (candles.length < period + 1) return 50

  const changes = candles.slice(1).map((c, i) => c.close - candles[i].close)
  const recent = changes.slice(-period)

  let avgGain = 0
  let avgLoss = 0

  for (const change of recent) {
    if (change > 0) avgGain += change
    else avgLoss += Math.abs(change)
  }

  avgGain /= period
  avgLoss /= period

  if (avgLoss === 0) return 100
  const rs = avgGain / avgLoss
  return 100 - 100 / (1 + rs)
}

// ─── Swing Highs / Lows ───────────────────────────────────────

export function swingHigh(candles: Candle[], lookback = 10): number {
  const slice = candles.slice(-lookback)
  return Math.max(...slice.map(c => c.high))
}

export function swingLow(candles: Candle[], lookback = 10): number {
  const slice = candles.slice(-lookback)
  return Math.min(...slice.map(c => c.low))
}

// ─── Volume Metrics ───────────────────────────────────────────

export function volumeMetrics(candles: Candle[]): {
  totalVolume: number
  buyVolume: number
  sellVolume: number
  buySellRatio: number
} {
  const totalVolume  = candles.reduce((s, c) => s + c.volume, 0)
  const buyVolume    = candles.reduce((s, c) => s + c.buyVolume, 0)
  const sellVolume   = candles.reduce((s, c) => s + c.sellVolume, 0)
  const buySellRatio = totalVolume === 0 ? 0.5 : buyVolume / totalVolume

  return { totalVolume, buyVolume, sellVolume, buySellRatio }
}

// ─── Buyer Velocity (unique buyers per 30s window) ───────────
// Approximated from candle buy trade counts when wallet data isn't available

export function buyerVelocity(candles: Candle[], windowMs = 30_000, candlePeriodMs = 15_000): {
  current: number
  previous: number
  slope: number
} {
  const windowCandles = Math.ceil(windowMs / candlePeriodMs)
  const total = candles.length

  if (total < windowCandles * 2) {
    const cur = candles.slice(-windowCandles).reduce((s, c) => s + c.buyTrades, 0)
    return { current: cur, previous: cur, slope: 0 }
  }

  const current  = candles.slice(-windowCandles).reduce((s, c) => s + c.buyTrades, 0)
  const previous = candles.slice(-windowCandles * 2, -windowCandles).reduce((s, c) => s + c.buyTrades, 0)
  const slope    = previous === 0 ? 0 : (current - previous) / previous

  return { current, previous, slope }
}
