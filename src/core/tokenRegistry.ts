import type { TokenMeta, LifecycleStage } from './types.js'
import { bus } from './eventBus.js'

interface TokenEntry extends TokenMeta {
  lastSeen: number
  swapCount: number
}

class TokenRegistry {
  private tokens = new Map<string, TokenEntry>()

  register(meta: TokenMeta): void {
    if (this.tokens.has(meta.mint)) {
      const entry = this.tokens.get(meta.mint)!
      entry.lastSeen = Date.now()
      entry.lifecycleStage = meta.lifecycleStage
      // Apply enriched fields if provided (enrichment runs after initial registration)
      if (meta.name && !meta.name.startsWith('TOKEN_')) entry.name = meta.name
      if (meta.symbol && meta.symbol.length > 1)        entry.symbol = meta.symbol
      if (meta.imageUrl)  entry.imageUrl  = meta.imageUrl
      if (meta.website)   entry.website   = meta.website
      if (meta.twitter)   entry.twitter   = meta.twitter
      if (meta.telegram)  entry.telegram  = meta.telegram
      return
    }
    this.tokens.set(meta.mint, { ...meta, lastSeen: Date.now(), swapCount: 0 })
    bus.emit({ type: 'token:new', data: meta })
  }

  get(mint: string): TokenEntry | undefined {
    return this.tokens.get(mint)
  }

  recordSwap(mint: string): void {
    const entry = this.tokens.get(mint)
    if (entry) {
      entry.swapCount++
      entry.lastSeen = Date.now()
    }
  }

  setLifecycle(mint: string, stage: LifecycleStage): void {
    const entry = this.tokens.get(mint)
    if (!entry) return

    const prev = entry.lifecycleStage
    entry.lifecycleStage = stage

    if (prev === 'BONDING_CURVE' && stage === 'AMM') {
      bus.emit({ type: 'token:migrated', data: { mint } })
    }
  }

  has(mint: string): boolean {
    return this.tokens.has(mint)
  }

  count(): number {
    return this.tokens.size
  }

  all(): TokenEntry[] {
    return Array.from(this.tokens.values())
  }

  // Prune tokens not seen for more than 2 hours
  prune(): void {
    const cutoff = Date.now() - 2 * 60 * 60 * 1000
    for (const [mint, entry] of this.tokens) {
      if (entry.lastSeen < cutoff && entry.swapCount < 10) {
        this.tokens.delete(mint)
      }
    }
  }
}

export const registry = new TokenRegistry()
