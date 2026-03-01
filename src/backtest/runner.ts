// ============================================================
// Backtest Engine
//
// Replays stored swap events through the full strategy pipeline
// in an isolated context (no shared state with live trading).
//
// Architecture:
//   1. Load swap events from SQLite for time range
//   2. Build candles in-memory (isolated from live candle engine)
//   3. Compute indicators (pure functions, reused from indicatorEngine)
//   4. Run strategies at each swap event
//   5. Aggregate signals → intents (same aggregator logic)
//   6. Simulate fills (PaperExecutor logic, applied inline)
//   7. Compute per-strategy metrics
//   8. Return BacktestResult
//
// No live state is touched. Runs synchronously (fast).
// ============================================================

import { ema, vwap, rsi, swingHigh, swingLow, buyerVelocity } from '../market/indicatorEngine.js'
import { calculateFee } from '../market/feeTracker.js'
import { getStrategies } from '../strategies/index.js'
import { logger } from '../core/logger.js'
import { getSwapsByTimeRange } from '../storage/sqlite.js'
import { v4 as uuid } from 'uuid'
import type {
  SwapEvent, Candle, MarketSnapshot, Signal, OrderIntent,
  Fill, Position, Strategy, LifecycleStage,
  BacktestConfig, BacktestResult, StrategyMetrics,
} from '../core/types.js'

// ─── Types ───────────────────────────────────────────────────

interface BtCandle extends Candle {
  closed: boolean
}

interface BtTokenState {
  price:        number
  priceInSol:   number
  holderCount:  number
  growthRate:   number
  buyers5m:     Set<string>
  buyersPrev5m: Set<string>
  lastRotate:   number
  candles15s:   BtCandle[]
  candles1m:    BtCandle[]
  candles5m:    BtCandle[]
  openCandle:   { '15s'?: BtCandle; '1m'?: BtCandle; '5m'?: BtCandle }
}

interface BtPosition {
  id:             string
  tokenMint:      string
  strategyId:     string
  entryPriceInSol: number
  tokenAmount:    number
  solAmount:      number
  entryTs:        number
}

interface BtStratMetrics {
  strategyId:       string
  totalTrades:      number
  wins:             number
  losses:           number
  totalPnlSol:      number
  trades:           Array<{ pnlSol: number; holdMs: number }>
  peakPnl:          number
  maxDrawdown:      number
}

const TIMEFRAMES: Record<string, number> = {
  '15s': 15_000,
  '1m':  60_000,
  '5m':  300_000,
}

const SIMULATED_SLIPPAGE_BPS = 30
const DEV_WALLET_ID          = 'dev_wallet'
const MIN_CONFIDENCE         = 0.55
const DEDUP_WINDOW_MS        = 30_000

// ─── Main Entry ──────────────────────────────────────────────

export async function runBacktest(config: BacktestConfig): Promise<BacktestResult> {
  const startRun = Date.now()

  logger.info(`Backtest: loading swaps ${new Date(config.startTs).toISOString()} → ${new Date(config.endTs).toISOString()}`)

  const rawSwaps = getSwapsByTimeRange(config.startTs, config.endTs) as Array<Record<string, unknown>>
  const swaps: SwapEvent[] = rawSwaps.map(r => ({
    mint:        r['mint'] as string,
    side:        r['side'] as 'buy' | 'sell',
    price:       r['price'] as number,
    priceInSol:  r['price_sol'] as number,
    tokenAmount: r['token_amt'] as number,
    solAmount:   r['sol_amt'] as number,
    wallet:      r['wallet'] as string,
    timestamp:   r['ts'] as number,
    signature:   r['signature'] as string,
    program:     r['program'] as SwapEvent['program'],
  }))

  if (swaps.length === 0) {
    logger.warn('Backtest: no swaps found for time range')
    return emptyResult(config, startRun)
  }

  logger.info(`Backtest: replaying ${swaps.length} swaps through ${config.strategyIds.length || 'all'} strategies`)

  // Isolated state
  const tokenStates = new Map<string, BtTokenState>()
  const positions   = new Map<string, BtPosition>()   // tokenMint → position
  const stratMetrics = new Map<string, BtStratMetrics>()
  const dedupMap    = new Map<string, number>()         // `mint:side` → last intent ts
  const fills: Fill[]   = []
  const signals: Signal[] = []
  let balance = config.initialBalanceSol

  // Get strategies to test
  const activeStrategies = getStrategies().filter(s =>
    config.strategyIds.length === 0 || config.strategyIds.includes(s.id)
  )

  for (const s of activeStrategies) {
    stratMetrics.set(s.id, { strategyId: s.id, totalTrades: 0, wins: 0, losses: 0, totalPnlSol: 0, trades: [], peakPnl: 0, maxDrawdown: 0 })
  }

  // Replay
  for (const swap of swaps) {
    const state = getOrCreateState(swap.mint, tokenStates)

    // Feed candle engine (isolated)
    ingestSwap(swap, state)

    // Update price
    state.price       = swap.price
    state.priceInSol  = swap.priceInSol
    if (swap.side === 'buy') state.buyers5m.add(swap.wallet)

    // Need minimum candle history
    if (state.candles15s.length < 10) continue

    // Build snapshot
    const snapshot = buildBtSnapshot(swap.mint, state, swap.timestamp)
    if (!snapshot) continue

    // Run strategies
    const batchSignals: Signal[] = []
    for (const strategy of activeStrategies) {
      if (!strategy.lifecycleStages.includes(snapshot.lifecycleStage)) continue
      try {
        const sigs = strategy.evaluate(snapshot)
        batchSignals.push(...sigs)
      } catch { /* ignore */ }
    }

    signals.push(...batchSignals)

    // Simple aggregation + execution
    const bySide = { BUY: [] as Signal[], SELL: [] as Signal[] }
    for (const sig of batchSignals) bySide[sig.side].push(sig)

    for (const side of ['BUY', 'SELL'] as const) {
      const group = bySide[side]
      if (group.length === 0) continue

      const key = `${swap.mint}:${side}`
      const lastTs = dedupMap.get(key) ?? 0
      if (swap.timestamp - lastTs < DEDUP_WINDOW_MS) continue

      const devSell = side === 'SELL' && group.find(s => s.strategyId === DEV_WALLET_ID)
      const mainSigs = group.filter(s => s.strategyId !== DEV_WALLET_ID)

      let confidence: number
      let strategyId: string

      if (devSell) {
        confidence = 1.0
        strategyId = DEV_WALLET_ID
      } else {
        if (mainSigs.length === 0) continue
        const base = mainSigs.reduce((s, sig) => s + sig.confidence, 0) / mainSigs.length
        const boost = group.find(s => s.strategyId === DEV_WALLET_ID && side === 'BUY') ? 0.1 : 0
        confidence = Math.min(0.95, base + boost)
        strategyId = mainSigs.map(s => s.strategyId).join('+')
      }

      if (confidence < MIN_CONFIDENCE) continue

      // Conflict check
      if (bySide.BUY.length > 0 && bySide.SELL.length > 0 && !devSell) continue

      dedupMap.set(key, swap.timestamp)

      // Execute
      if (side === 'BUY') {
        if (positions.has(swap.mint)) continue
        if (balance < config.initialBalanceSol * 0.05) continue

        const slipFactor = 1 + SIMULATED_SLIPPAGE_BPS / 10_000
        const fillPriceSol = swap.priceInSol * slipFactor
        const solAmount   = Math.min(0.5, balance * 0.1)
        const tokenAmount = solAmount / fillPriceSol
        const fee         = calculateFee({ solAmount, program: 'raydium', paper: true }).totalFeeSol

        const fill: Fill = {
          id:          uuid(),
          intentId:    uuid(),
          strategyId,
          tokenMint:   swap.mint,
          tokenName:   snapshot.tokenName,
          side:        'BUY',
          price:       swap.price * slipFactor,
          priceInSol:  fillPriceSol,
          tokenAmount,
          solAmount,
          fee,
          timestamp:   swap.timestamp,
          txSignature: `BT_${uuid().slice(0, 8)}`,
          paper:       true,
        }

        fills.push(fill)
        balance -= solAmount + fee

        positions.set(swap.mint, {
          id:             fill.id,
          tokenMint:      swap.mint,
          strategyId,
          entryPriceInSol: fillPriceSol,
          tokenAmount,
          solAmount,
          entryTs:        swap.timestamp,
        })

      } else {
        // SELL — close position if open
        const pos = positions.get(swap.mint)
        if (!pos) continue

        const slipFactor = 1 - SIMULATED_SLIPPAGE_BPS / 10_000
        const fillPriceSol = swap.priceInSol * slipFactor
        const solOut      = pos.tokenAmount * fillPriceSol
        const fee         = calculateFee({ solAmount: solOut, program: 'raydium', paper: true }).totalFeeSol
        const pnlSol      = solOut - pos.solAmount - fee

        const fill: Fill = {
          id:          uuid(),
          intentId:    uuid(),
          strategyId,
          tokenMint:   swap.mint,
          tokenName:   snapshot.tokenName,
          side:        'SELL',
          price:       swap.price * slipFactor,
          priceInSol:  fillPriceSol,
          tokenAmount: pos.tokenAmount,
          solAmount:   solOut,
          fee,
          timestamp:   swap.timestamp,
          txSignature: `BT_${uuid().slice(0, 8)}`,
          paper:       true,
        }

        fills.push(fill)
        balance += solOut - fee
        positions.delete(swap.mint)

        // Record metrics for each strategy involved
        const stratIds = pos.strategyId.split('+')
        for (const sid of stratIds) {
          const m = stratMetrics.get(sid)
          if (!m) continue

          m.totalTrades++
          m.totalPnlSol += pnlSol
          m.trades.push({ pnlSol, holdMs: swap.timestamp - pos.entryTs })
          if (pnlSol > 0) m.wins++ ; else m.losses++
          if (m.totalPnlSol > m.peakPnl) m.peakPnl = m.totalPnlSol
          const drawdown = m.totalPnlSol - m.peakPnl
          if (drawdown < m.maxDrawdown) m.maxDrawdown = drawdown
        }
      }
    }

    // Time stop: close positions open > 30 min
    for (const [mint, pos] of positions) {
      if (swap.timestamp - pos.entryTs > 30 * 60_000) {
        const currentPrice = tokenStates.get(mint)?.priceInSol ?? pos.entryPriceInSol
        const solOut       = pos.tokenAmount * currentPrice
        const fee          = calculateFee({ solAmount: solOut, program: 'raydium', paper: true }).totalFeeSol
        const pnlSol       = solOut - pos.solAmount - fee

        balance += solOut - fee
        positions.delete(mint)

        for (const sid of pos.strategyId.split('+')) {
          const m = stratMetrics.get(sid)
          if (!m) continue
          m.totalTrades++
          m.totalPnlSol += pnlSol
          m.trades.push({ pnlSol, holdMs: swap.timestamp - pos.entryTs })
          if (pnlSol > 0) m.wins++ ; else m.losses++
        }
      }
    }
  }

  // Build result
  const perStrategy: Record<string, StrategyMetrics> = {}
  for (const [id, m] of stratMetrics) {
    const winRate = m.totalTrades > 0 ? m.wins / m.totalTrades : 0
    perStrategy[id] = {
      strategyId:        id,
      totalTrades:       m.totalTrades,
      winningTrades:     m.wins,
      losingTrades:      m.losses,
      winRate,
      totalPnlSol:       m.totalPnlSol,
      avgPnlPerTrade:    m.totalTrades > 0 ? m.totalPnlSol / m.totalTrades : 0,
      avgHoldDurationMs: m.trades.length > 0
        ? m.trades.reduce((s, t) => s + t.holdMs, 0) / m.trades.length
        : 0,
      bestTradeSol:      m.trades.length > 0 ? Math.max(...m.trades.map(t => t.pnlSol)) : 0,
      worstTradeSol:     m.trades.length > 0 ? Math.min(...m.trades.map(t => t.pnlSol)) : 0,
      maxDrawdownSol:    m.maxDrawdown,
      sharpeRatio:       computeSharpe(m.trades.map(t => t.pnlSol)),
      autoDisabled:      false,
      lastUpdated:       Date.now(),
    }
  }

  const totalPnl = Object.values(perStrategy).reduce((s, m) => s + m.totalPnlSol, 0)
  const totalTrades = Object.values(perStrategy).reduce((s, m) => s + m.totalTrades, 0)
  const totalWins   = Object.values(perStrategy).reduce((s, m) => s + m.winningTrades, 0)

  const result: BacktestResult = {
    config,
    runAt:          Date.now(),
    durationMs:     Date.now() - startRun,
    swapsReplayed:  swaps.length,
    signalsEmitted: signals.length,
    tradesExecuted: fills.length,
    perStrategy,
    totalPnlSol:    totalPnl,
    winRate:        totalTrades > 0 ? totalWins / totalTrades : 0,
  }

  logger.info(
    `Backtest complete: ${swaps.length} swaps, ${signals.length} signals, ` +
    `${fills.length} fills, totalPnL: ${totalPnl > 0 ? '+' : ''}${totalPnl.toFixed(4)} SOL ` +
    `(${result.durationMs}ms)`
  )

  return result
}

// ─── Isolated candle builder ──────────────────────────────────

function ingestSwap(swap: SwapEvent, state: BtTokenState): void {
  for (const [tf, ms] of Object.entries(TIMEFRAMES)) {
    const bucket  = Math.floor(swap.timestamp / ms) * ms
    const current = state.openCandle[tf as keyof typeof state.openCandle]

    if (!current || current.timestamp !== bucket) {
      // Close previous
      if (current) {
        current.closed = true
        const arr = state[`candles${tf.replace('s', 'S').replace('m', 'M')}` as keyof BtTokenState] as BtCandle[]
        arr.push(current)
        if (arr.length > 500) arr.splice(0, arr.length - 500)
      }

      // Open new
      const c: BtCandle = {
        open:      swap.price, high: swap.price, low: swap.price, close: swap.price,
        volume:    swap.price * swap.tokenAmount,
        buyVolume: swap.side === 'buy'  ? swap.price * swap.tokenAmount : 0,
        sellVolume:swap.side === 'sell' ? swap.price * swap.tokenAmount : 0,
        trades: 1, buyTrades: swap.side === 'buy' ? 1 : 0,
        timestamp: bucket, closed: false,
      }
      state.openCandle[tf as keyof typeof state.openCandle] = c

    } else {
      const vol = swap.price * swap.tokenAmount
      current.high        = Math.max(current.high, swap.price)
      current.low         = Math.min(current.low,  swap.price)
      current.close       = swap.price
      current.volume     += vol
      current.trades     += 1
      if (swap.side === 'buy') {
        current.buyVolume  += vol
        current.buyTrades  += 1
      } else {
        current.sellVolume += vol
      }
    }
  }

  // Rotate buyer windows
  if (swap.timestamp - state.lastRotate > 300_000) {
    state.buyersPrev5m = state.buyers5m
    state.buyers5m     = new Set()
    state.lastRotate   = swap.timestamp
  }
}

function buildBtSnapshot(mint: string, state: BtTokenState, ts: number): MarketSnapshot | null {
  const s15 = state.candles15s
  const m1  = state.candles1m
  const m5  = state.candles5m

  if (s15.length < 5) return null

  const totalVol5m = m5.slice(-5).reduce((acc, c) => acc + c.volume, 0)
  const buyVol5m   = m5.slice(-5).reduce((acc, c) => acc + c.buyVolume, 0)
  const sellVol5m  = m5.slice(-5).reduce((acc, c) => acc + c.sellVolume, 0)
  const velocity   = buyerVelocity(s15)

  return {
    tokenMint:     mint,
    tokenName:     `TOKEN_${mint.slice(0, 6)}`,
    tokenSymbol:   mint.slice(0, 4),
    tokenAge:      0,
    lifecycleStage: 'AMM',

    price:       state.price,
    priceInSol:  state.priceInSol,
    liquidity:   0,
    marketCap:   0,

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
      uniqueBuyers5m:    state.buyers5m.size,
      buyerVelocity:     velocity.current,
      buyerVelocityPrev: velocity.previous,
      volumeToMcap:      0,
      buySellRatio:      totalVol5m > 0 ? buyVol5m / totalVol5m : 0.5,
    },

    virality: { score: 0, slope: 0, socialScore: 0, onChainScore: 0 },
    safety:   { riskScore: 0, flags: [], mintRevoked: true, freezeRevoked: true, lpBurned: true },

    devWallet: { address: '', bought: false, sold: false, holdingPct: 0 },

    holderCount:      0,
    holderGrowthRate: 0,
    timestamp:        ts,
  }
}

function getOrCreateState(mint: string, map: Map<string, BtTokenState>): BtTokenState {
  if (!map.has(mint)) {
    map.set(mint, {
      price: 0, priceInSol: 0, holderCount: 0, growthRate: 0,
      buyers5m: new Set(), buyersPrev5m: new Set(), lastRotate: 0,
      candles15s: [], candles1m: [], candles5m: [],
      openCandle: {},
    })
  }
  return map.get(mint)!
}

function computeSharpe(pnls: number[]): number {
  if (pnls.length < 2) return 0
  const avg = pnls.reduce((s, p) => s + p, 0) / pnls.length
  const variance = pnls.reduce((s, p) => s + (p - avg) ** 2, 0) / pnls.length
  const std = Math.sqrt(variance)
  return std > 0 ? avg / std : 0
}

function emptyResult(config: BacktestConfig, startRun: number): BacktestResult {
  return {
    config, runAt: Date.now(), durationMs: Date.now() - startRun,
    swapsReplayed: 0, signalsEmitted: 0, tradesExecuted: 0,
    perStrategy: {}, totalPnlSol: 0, winRate: 0,
  }
}
