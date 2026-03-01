import { bus } from '../core/eventBus.js'
import { saveCandle } from '../storage/sqlite.js'
import type { SwapEvent, Candle } from '../core/types.js'

const TIMEFRAMES: Record<string, number> = {
  '15s': 15_000,
  '1m':  60_000,
  '5m':  300_000,
}

// candles[mint][timeframe]
const candles = new Map<string, Map<string, Candle[]>>()

// current open candle per mint/timeframe
const open = new Map<string, Map<string, Candle>>()

function getCandles(mint: string, tf: string): Candle[] {
  if (!candles.has(mint)) candles.set(mint, new Map())
  const tfMap = candles.get(mint)!
  if (!tfMap.has(tf)) tfMap.set(tf, [])
  return tfMap.get(tf)!
}

function getOpen(mint: string, tf: string): Candle | undefined {
  return open.get(mint)?.get(tf)
}

function setOpen(mint: string, tf: string, candle: Candle): void {
  if (!open.has(mint)) open.set(mint, new Map())
  open.get(mint)!.set(tf, candle)
}

function bucketStart(ts: number, intervalMs: number): number {
  return Math.floor(ts / intervalMs) * intervalMs
}

export function ingestSwap(event: SwapEvent): void {
  for (const [tf, ms] of Object.entries(TIMEFRAMES)) {
    const bucket = bucketStart(event.timestamp, ms)
    const current = getOpen(event.mint, tf)

    if (!current || current.timestamp !== bucket) {
      // Close previous candle
      if (current) {
        current.closed = true
        getCandles(event.mint, tf).push(current)
        // Keep last 500 candles per timeframe
        const arr = getCandles(event.mint, tf)
        if (arr.length > 500) arr.splice(0, arr.length - 500)
        saveCandle(event.mint, tf, current)
        bus.emit({ type: 'candle:closed', data: { mint: event.mint, timeframe: tf as '15s' | '1m' | '5m', candle: current } })
      }

      // Open new candle
      setOpen(event.mint, tf, {
        open:      event.price,
        high:      event.price,
        low:       event.price,
        close:     event.price,
        volume:    event.price * event.tokenAmount,
        buyVolume: event.side === 'buy'  ? event.price * event.tokenAmount : 0,
        sellVolume:event.side === 'sell' ? event.price * event.tokenAmount : 0,
        trades:    1,
        buyTrades: event.side === 'buy'  ? 1 : 0,
        timestamp: bucket,
        closed:    false,
      })
    } else {
      // Update current candle
      const vol = event.price * event.tokenAmount
      current.high       = Math.max(current.high, event.price)
      current.low        = Math.min(current.low, event.price)
      current.close      = event.price
      current.volume     += vol
      current.trades     += 1
      if (event.side === 'buy') {
        current.buyVolume  += vol
        current.buyTrades  += 1
      } else {
        current.sellVolume += vol
      }
    }
  }
}

export function getCandleHistory(mint: string): {
  s15: Candle[]
  m1:  Candle[]
  m5:  Candle[]
} {
  return {
    s15: getCandles(mint, '15s'),
    m1:  getCandles(mint, '1m'),
    m5:  getCandles(mint, '5m'),
  }
}

export function getTrackedMints(): string[] {
  return Array.from(candles.keys())
}
