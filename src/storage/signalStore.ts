// ============================================================
// Signal Store + Outcome Tracker
//
// - Persists every Signal to SQLite with full reasoning + snapshot
// - Outcome Tracker: 5min, 15min, 30min after each signal,
//   records what price actually did. This is the primary tool
//   for figuring out which signal patterns actually work.
//
// Signal outcomes are independent of whether we actually traded —
// we measure signal accuracy even on vetoed or low-confidence signals.
// ============================================================

import { bus } from '../core/eventBus.js'
import { logger } from '../core/logger.js'
import {
  saveSignal,
  initSignalOutcome,
  updateSignalOutcome,
  getUnresolvedOutcomes,
} from './sqlite.js'
import type { Signal, SignalOutcome } from '../core/types.js'

// ─── In-memory price tracker for outcome resolution ──────────
// priceHistory[mint] = sorted array of { ts, priceInSol }
const priceHistory = new Map<string, Array<{ ts: number; priceInSol: number }>>()
// 10000 entries: at 10 tx/s (hot coin) ≈ 16 min; at 1 tx/s ≈ 2.8 h
const MAX_PRICE_HISTORY = 10_000

// ─── Pending outcomes waiting for price data ──────────────────
interface PendingOutcome {
  signalId:      string
  strategyId:    string
  tokenMint:     string
  side:          string
  signalTs:      number
  priceAtSignal: number
  priceAt30s:    number
  priceAt1m:     number
  priceAt5m:     number
  maxGainPct:    number
  maxLossPct:    number
  window30sDue:  number   // unix ms
  window1mDue:   number
  window5mDue:   number
  resolved:      boolean
}

const pendingOutcomes = new Map<string, PendingOutcome>()

// ─── Public: save a signal and start outcome tracking ─────────

export function recordSignal(signal: Signal): void {
  saveSignal(signal)

  const priceAtSignal = signal.snapshot.priceInSol

  // Init outcome row in DB
  initSignalOutcome(
    signal.id, signal.strategyId, signal.tokenMint,
    signal.side, signal.timestamp, priceAtSignal,
  )

  // Track in memory for price window resolution
  const outcome: PendingOutcome = {
    signalId:      signal.id,
    strategyId:    signal.strategyId,
    tokenMint:     signal.tokenMint,
    side:          signal.side,
    signalTs:      signal.timestamp,
    priceAtSignal,
    priceAt30s:    0,
    priceAt1m:     0,
    priceAt5m:     0,
    maxGainPct:    0,
    maxLossPct:    0,
    window30sDue:  signal.timestamp + 30_000,
    window1mDue:   signal.timestamp + 60_000,
    window5mDue:   signal.timestamp + 5 * 60_000,
    resolved:      false,
  }

  pendingOutcomes.set(signal.id, outcome)
}

// ─── Public: feed live prices for outcome resolution ─────────

export function updatePriceForOutcomes(mint: string, priceInSol: number): void {
  const now = Date.now()

  // Record price history
  let history = priceHistory.get(mint)
  if (!history) {
    history = []
    priceHistory.set(mint, history)
  }
  history.push({ ts: now, priceInSol })

  // Keep history bounded
  if (history.length > MAX_PRICE_HISTORY) {
    history.splice(0, history.length - MAX_PRICE_HISTORY)
  }

  // Resolve any pending outcomes for this mint
  for (const [id, outcome] of pendingOutcomes) {
    if (outcome.tokenMint !== mint || outcome.resolved) continue

    // Track running max gain/loss
    const changePct = ((priceInSol - outcome.priceAtSignal) / outcome.priceAtSignal) * 100
    if (changePct > outcome.maxGainPct) outcome.maxGainPct = changePct
    if (changePct < outcome.maxLossPct) outcome.maxLossPct = changePct

    // Fill price windows as they become due
    if (outcome.priceAt30s === 0 && now >= outcome.window30sDue) {
      outcome.priceAt30s = priceInSol
    }
    if (outcome.priceAt1m === 0 && now >= outcome.window1mDue) {
      outcome.priceAt1m = priceInSol
    }
    if (outcome.priceAt5m === 0 && now >= outcome.window5mDue) {
      outcome.priceAt5m = priceInSol
      outcome.resolved = true
    }

    // Flush to DB when any window has been filled
    if (outcome.priceAt30s > 0 || outcome.priceAt1m > 0 || outcome.priceAt5m > 0) {
      persistOutcome(outcome)
    }

    if (outcome.resolved) {
      pendingOutcomes.delete(id)
      logger.debug(
        `Outcome resolved: ${outcome.strategyId} ${outcome.side} ${outcome.tokenMint.slice(0, 8)} ` +
        `| maxGain: +${outcome.maxGainPct.toFixed(1)}% | maxLoss: ${outcome.maxLossPct.toFixed(1)}%`
      )
    }
  }
}

// ─── Restore unresolved outcomes after restart ────────────────

export function restoreUnresolvedOutcomes(): void {
  const rows = getUnresolvedOutcomes() as Array<{
    signal_id: string; strategy_id: string; token_mint: string; side: string;
    signal_ts: number; price_at_signal: number;
    price_at_30s: number; price_at_1m: number; price_at_5m: number;
    max_gain_pct: number; max_loss_pct: number;
  }>

  let restored = 0
  const now = Date.now()

  for (const row of rows) {
    // Skip signals older than 6 minutes — their windows are long past
    if (now - row.signal_ts > 6 * 60_000) continue

    pendingOutcomes.set(row.signal_id, {
      signalId:      row.signal_id,
      strategyId:    row.strategy_id,
      tokenMint:     row.token_mint,
      side:          row.side,
      signalTs:      row.signal_ts,
      priceAtSignal: row.price_at_signal,
      priceAt30s:    row.price_at_30s,
      priceAt1m:     row.price_at_1m,
      priceAt5m:     row.price_at_5m,
      maxGainPct:    row.max_gain_pct,
      maxLossPct:    row.max_loss_pct,
      window30sDue:  row.signal_ts + 30_000,
      window1mDue:   row.signal_ts + 60_000,
      window5mDue:   row.signal_ts + 5 * 60_000,
      resolved:      false,
    })
    restored++
  }

  if (restored > 0) logger.info(`Signal outcomes: restored ${restored} unresolved windows`)
}

// ─── Helpers ─────────────────────────────────────────────────

function persistOutcome(o: PendingOutcome): void {
  const directionFactor = o.side === 'BUY' ? 1 : -1  // BUY = want price up, SELL = want price down

  const changePct30s = o.priceAt30s > 0 ? ((o.priceAt30s - o.priceAtSignal) / o.priceAtSignal) * 100 : null
  const changePct1m  = o.priceAt1m  > 0 ? ((o.priceAt1m  - o.priceAtSignal) / o.priceAtSignal) * 100 : null
  const changePct5m  = o.priceAt5m  > 0 ? ((o.priceAt5m  - o.priceAtSignal) / o.priceAtSignal) * 100 : null

  const outcome: SignalOutcome = {
    signalId:            o.signalId,
    strategyId:          o.strategyId,
    tokenMint:           o.tokenMint,
    side:                o.side as 'BUY' | 'SELL',
    signalTs:            o.signalTs,
    priceAtSignal:       o.priceAtSignal,
    priceAt30s:          o.priceAt30s,
    priceAt1m:           o.priceAt1m,
    priceAt5m:           o.priceAt5m,
    maxGainPct:          o.maxGainPct,
    maxLossPct:          o.maxLossPct,
    directionCorrect30s: changePct30s !== null ? (changePct30s * directionFactor > 0) : false,
    directionCorrect1m:  changePct1m  !== null ? (changePct1m  * directionFactor > 0) : false,
    directionCorrect5m:  changePct5m  !== null ? (changePct5m  * directionFactor > 0) : false,
    resolved:            o.resolved,
  }

  updateSignalOutcome(outcome)

  if (o.resolved) {
    bus.emit({ type: 'signal:outcome', data: outcome })
  }
}

export function getPendingOutcomeCount(): number {
  return pendingOutcomes.size
}
