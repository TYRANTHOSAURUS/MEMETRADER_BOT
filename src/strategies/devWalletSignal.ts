import { v4 as uuid } from 'uuid'
import type { Strategy, MarketSnapshot, Signal } from '../core/types.js'

// Dev Wallet Signal — confidence modifier + hard exit
// Does NOT generate standalone buy entries.
// - Dev buys post-launch → +0.1 confidence boost to aggregator
// - Dev sells any amount in first 30 min → hard SELL signal regardless of price action

export const devWalletSignal: Strategy = {
  id:          'dev_wallet',
  name:        'Dev Wallet Signal',
  description: 'Dev sell = hard exit. Dev buy = confidence modifier only.',
  lifecycleStages: ['BONDING_CURVE', 'AMM'],
  warmupPeriods:   1,
  enabled:         true,

  evaluate(snapshot: MarketSnapshot): Signal[] {
    const { devWallet, tokenAge } = snapshot
    const signals: Signal[] = []

    // Hard exit if dev sold in first 30 minutes — non-negotiable
    if (devWallet.sold && tokenAge < 1800) {
      signals.push({
        id:         uuid(),
        strategyId: this.id,
        tokenMint:  snapshot.tokenMint,
        side:       'SELL',
        confidence: 1.0,  // Maximum confidence — dev sell is always an exit
        reason:     `DEV SOLD within first ${Math.floor(tokenAge / 60)}m — hard exit`,
        timestamp:  snapshot.timestamp,
        snapshot,
      })
    }

    // Dev bought post-launch: emit low-confidence BUY to boost other strategy signals in aggregator
    // This is used as a confidence multiplier, not a standalone entry
    if (devWallet.bought && !devWallet.sold && tokenAge < 600) {
      signals.push({
        id:         uuid(),
        strategyId: this.id,
        tokenMint:  snapshot.tokenMint,
        side:       'BUY',
        confidence: 0.1,  // Low — treated as a modifier only by aggregator
        reason:     `Dev wallet bought post-launch (${devWallet.holdingPct.toFixed(1)}% hold)`,
        timestamp:  snapshot.timestamp,
        snapshot,
      })
    }

    return signals
  },
}
