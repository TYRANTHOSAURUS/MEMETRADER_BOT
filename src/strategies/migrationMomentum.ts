import { v4 as uuid } from 'uuid'
import type { Strategy, MarketSnapshot, Signal } from '../core/types.js'

// Migration Momentum — Buy the PumpFun → Raydium migration event
// Most bots ignore the first 10 minutes post-migration. This captures that window.

const recentMigrations = new Map<string, { ts: number; entrySignaled: boolean }>()

export const migrationMomentum: Strategy = {
  id:          'migration_momentum',
  name:        'Migration Momentum',
  description: 'Enter on the first strong candle post PumpFun→Raydium migration',
  lifecycleStages: ['AMM'],
  warmupPeriods:   3,
  enabled:         true,

  evaluate(snapshot: MarketSnapshot): Signal[] {
    const { lifecycleStage, candles, volume } = snapshot
    if (lifecycleStage !== 'AMM') return []
    if (candles.m1.length < 2) return []

    const signals: Signal[] = []
    const mint = snapshot.tokenMint

    // Only trade within first 10 minutes of AMM listing
    const age = snapshot.tokenAge
    if (age > 600) {
      recentMigrations.delete(mint)
      return []
    }

    const entry = recentMigrations.get(mint) ?? { ts: snapshot.timestamp, entrySignaled: false }
    if (!recentMigrations.has(mint)) recentMigrations.set(mint, entry)

    if (entry.entrySignaled) return []

    const last = candles.m1.at(-1)!
    const prev = candles.m1.at(-2)

    // Migration candle: green, with volume expansion, within first 3 minutes
    const migrationCandle = last.close > last.open
    const volExpansion    = prev ? last.volume > prev.volume * 1.5 : last.volume > 0
    const safetyOk        = snapshot.safety.mintRevoked && !snapshot.devWallet.sold
    const fresh           = age < 180  // first 3 minutes

    if (migrationCandle && volExpansion && safetyOk && fresh) {
      entry.entrySignaled = true
      signals.push({
        id:         uuid(),
        strategyId: this.id,
        tokenMint:  mint,
        side:       'BUY',
        confidence: 0.75,
        reason:     `Migration momentum — first ${age}s on AMM, green candle, vol expansion`,
        timestamp:  snapshot.timestamp,
        snapshot,
      })
    }

    // Exit: first bearish engulfing or 10min timeout
    if (entry.entrySignaled && last.close < last.open && prev && last.close < prev.open) {
      signals.push({
        id:         uuid(),
        strategyId: this.id,
        tokenMint:  mint,
        side:       'SELL',
        confidence: 0.8,
        reason:     'Bearish engulfing post-migration — exit',
        timestamp:  snapshot.timestamp,
        snapshot,
      })
    }

    return signals
  },
}
