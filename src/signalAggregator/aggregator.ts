import { v4 as uuid } from 'uuid'
import { bus } from '../core/eventBus.js'
import { logger } from '../core/logger.js'
import type { Signal, OrderIntent, MarketSnapshot, Strategy, LifecycleStage } from '../core/types.js'

const DEDUP_WINDOW_MS = 30_000      // ignore duplicate signals for same token within 30s
const MIN_CONFIDENCE  = 0.55        // minimum to generate an OrderIntent
const DEV_WALLET_ID   = 'dev_wallet'

interface PendingSignal {
  signals: Signal[]
  lastUpdated: number
}

const pending = new Map<string, PendingSignal>()

export function processSignals(
  signals: Signal[],
  snapshot: MarketSnapshot,
  config: { maxSlippageBps: number; maxPositionSizeSol: number; tradeTimeLimitMs: number }
): OrderIntent[] {
  if (signals.length === 0) return []

  const mint = snapshot.tokenMint
  const now  = Date.now()

  // Group by token
  const bySide = { BUY: [] as Signal[], SELL: [] as Signal[] }
  for (const s of signals) {
    bySide[s.side].push(s)
  }

  const intents: OrderIntent[] = []

  for (const side of ['BUY', 'SELL'] as const) {
    const group = bySide[side]
    if (group.length === 0) continue

    // Dedup: skip if we recently emitted an intent for this token+side
    const key = `${mint}:${side}`
    const last = pending.get(key)
    if (last && now - last.lastUpdated < DEDUP_WINDOW_MS) continue

    // SELL from dev_wallet is always priority regardless of confidence
    const devSell = group.find(s => s.strategyId === DEV_WALLET_ID && side === 'SELL')

    let confidence: number
    let strategyId: string
    let reason: string

    if (devSell) {
      confidence = 1.0
      strategyId = devSell.strategyId
      reason = devSell.reason
    } else {
      // Merge confidence from non-modifier strategies
      const mainSignals = group.filter(s => s.strategyId !== DEV_WALLET_ID)
      if (mainSignals.length === 0) continue

      // Base confidence: average of main signals
      const baseConf = mainSignals.reduce((s, sig) => s + sig.confidence, 0) / mainSignals.length

      // Boost from dev_wallet buy modifier (max +0.1)
      const devBoost = group.find(s => s.strategyId === DEV_WALLET_ID && side === 'BUY')
        ? 0.1 : 0

      confidence = Math.min(0.95, baseConf + devBoost)
      strategyId = mainSignals.map(s => s.strategyId).join('+')
      reason = mainSignals.map(s => s.reason).join(' | ')
    }

    if (confidence < MIN_CONFIDENCE) {
      logger.debug(`Aggregator: ${mint} ${side} confidence ${confidence.toFixed(2)} below threshold, skipping`)
      continue
    }

    // Conflicting signals: BUY and SELL in same batch — skip, wait for clarity
    if (bySide['BUY'].length > 0 && bySide['SELL'].length > 0 && !devSell) {
      logger.debug(`Aggregator: ${mint} conflicting BUY+SELL signals, holding off`)
      continue
    }

    const intent: OrderIntent = {
      id:               uuid(),
      strategyId,
      tokenMint:        mint,
      side,
      entryMode:        'NOW',
      sizeMode:         'FIXED',
      sizeValue:        config.maxPositionSizeSol,
      invalidationPrice: side === 'BUY'
        ? snapshot.indicators.swingLow * 0.98
        : snapshot.indicators.swingHigh * 1.02,
      maxSlippageBps:   config.maxSlippageBps,
      expiresAt:        now + config.tradeTimeLimitMs,
      confidence,
      lifecycleStage:   snapshot.lifecycleStage,
      createdAt:        now,
    }

    pending.set(key, { signals: group, lastUpdated: now })
    bus.emit({ type: 'intent:created', data: intent })
    intents.push(intent)
  }

  return intents
}
