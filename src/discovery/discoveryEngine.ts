// ============================================================
// Discovery Engine
// Self-discovers new Solana memecoin tokens.
//
// Real mode (Helius API key set):
//   Subscribes to PumpFun program via Helius enhanced WS.
//   Parses new token creation events + migration events.
//
// Mock mode (no API key):
//   Generates synthetic tokens at realistic intervals,
//   simulating the full lifecycle: bonding curve → AMM.
//
// Output: feeds token registry + emits token:discovered events.
// ============================================================

import { bus } from '../core/eventBus.js'
import { registry } from '../core/tokenRegistry.js'
import { logger } from '../core/logger.js'
import { upsertDiscoveredToken, getDiscoveredTokens } from '../storage/sqlite.js'
import type { DiscoveredToken, LifecycleStage, TokenMeta } from '../core/types.js'

// ─── State ───────────────────────────────────────────────────

const watchlist = new Map<string, DiscoveredToken>()
let discoveryRunning = false

// ─── Public API ──────────────────────────────────────────────

export function startDiscovery(heliusApiKey: string): void {
  if (discoveryRunning) return
  discoveryRunning = true

  // Restore watchlist from DB on startup
  const persisted = getDiscoveredTokens(true) as DiscoveredToken[]
  for (const t of persisted) {
    watchlist.set(t.mint, t)
  }
  logger.info(`Discovery: restored ${watchlist.size} tracked tokens from DB`)

  if (!heliusApiKey) {
    logger.warn('Discovery: no HELIUS_API_KEY — running mock discovery')
    startMockDiscovery()
    return
  }

  startHeliumDiscovery(heliusApiKey)
}

export function getWatchlist(): DiscoveredToken[] {
  return Array.from(watchlist.values()).filter(t => t.active)
}

export function getWatchlistAll(): DiscoveredToken[] {
  return Array.from(watchlist.values())
}

export function addTokenManually(mint: string, name: string, symbol: string, creator: string): DiscoveredToken {
  return addToWatchlist(mint, name, symbol, creator, 'manual', 'AMM')
}

export function recordSwapActivity(mint: string): void {
  const entry = watchlist.get(mint)
  if (entry) {
    entry.lastActivity = Date.now()
    entry.swapCount += 1
    // Prune check deferred to pruner interval
  }
}

export function markMigrated(mint: string): void {
  const entry = watchlist.get(mint)
  if (!entry) return
  entry.lifecycleStage = 'AMM'
  upsertDiscoveredToken(entry)
}

// ─── Internal: Helius Mode ────────────────────────────────────

function startHeliumDiscovery(apiKey: string): void {
  // In a full implementation:
  //   1. Subscribe to Helius enhanced WebSocket (account notifications for PumpFun program)
  //   2. Parse `create` instructions to get new mint + creator
  //   3. Fetch metadata via Helius getAsset API
  //   4. Call addToWatchlist()
  //
  // Also subscribe to migration events: when bonding curve threshold crossed,
  // Helius emits a migration transaction on the PumpFun AMM program.
  //
  // For now: log the intent. The scanner.ts handles the WebSocket connection;
  // this engine handles the business logic of what to do with discovered tokens.

  logger.info(`Discovery: Helius mode active (key: ${apiKey.slice(0, 6)}...)`)
  logger.info(`Discovery: real PumpFun token parsing active via scanner`)

  // Periodic prune: remove tokens inactive > 2h with < 20 swaps
  setInterval(pruneInactive, 10 * 60 * 1000)
}

// ─── Called by scanner when a real new PumpFun token is parsed ─

export function onNewTokenFromHelius(
  mint: string,
  name: string,
  symbol: string,
  creator: string,
  stage: LifecycleStage = 'BONDING_CURVE',
): DiscoveredToken {
  return addToWatchlist(mint, name, symbol, creator, 'helius', stage)
}

// ─── Internal: Mock Mode ──────────────────────────────────────

const MOCK_NAMES = [
  ['MOONCAT', 'MCAT'], ['PEPESOL', 'PSOL'], ['DOGEBRO', 'DBRO'],
  ['SHIBSOL', 'SHSOL'], ['WOJAKSOL', 'WJK'], ['FROGKING', 'FROG'],
  ['HAMSTER', 'HMST'], ['BONESOL', 'BONE'], ['COPETOKEN', 'COPE'],
  ['GIGABRAIN', 'GIGA'], ['RATSOL', 'RAT'], ['CATCOIN', 'CAT'],
  ['WIFHAT', 'WIF'], ['POPCAT', 'POP'], ['GOATSOL', 'GOAT'],
  ['BASED', 'BASE'], ['SEND', 'SEND'], ['BOME', 'BOME'],
  ['SMOG', 'SMOG'], ['PNUT', 'PNUT'], ['ACT', 'ACT'], ['MOODENG', 'MOOD'],
]

let mockTokenIdx = 0

function startMockDiscovery(): void {
  // Launch new token every 15–45 seconds (realistic PumpFun pace)
  const launchNext = (): void => {
    const delay = 15_000 + Math.random() * 30_000
    setTimeout(() => {
      spawnMockToken()
      launchNext()
    }, delay)
  }
  launchNext()

  // Lifecycle evolution: promote some bonding curve tokens to AMM
  setInterval(evolveMockLifecycles, 30_000)

  // Prune dead tokens periodically
  setInterval(pruneInactive, 5 * 60_000)
}

function spawnMockToken(): void {
  const [name, symbol] = MOCK_NAMES[mockTokenIdx % MOCK_NAMES.length]
  mockTokenIdx++

  const suffix   = Math.random().toString(36).slice(2, 6).toUpperCase()
  const fullName = `${name}${suffix}`
  const mint     = `MOCK${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 8).toUpperCase()}`
  const creator  = `creator_${Math.random().toString(36).slice(2, 10)}`

  addToWatchlist(mint, fullName, symbol, creator, 'mock', 'BONDING_CURVE')
}

function evolveMockLifecycles(): void {
  // ~30% of bonding curve tokens migrate to AMM (realistic survival rate)
  for (const token of watchlist.values()) {
    if (token.lifecycleStage !== 'BONDING_CURVE') continue
    if (Date.now() - token.discoveredAt < 120_000) continue  // must be > 2 min old

    if (Math.random() < 0.25) {
      token.lifecycleStage = 'AMM'
      registry.setLifecycle(token.mint, 'AMM')
      upsertDiscoveredToken(token)
      bus.emit({ type: 'token:migrated', data: { mint: token.mint } })
      logger.debug(`Discovery [mock]: ${token.symbol} migrated → AMM`)
    }
  }
}

// ─── Shared: add to watchlist + registry ─────────────────────

function addToWatchlist(
  mint: string, name: string, symbol: string, creator: string,
  source: DiscoveredToken['source'], stage: LifecycleStage,
): DiscoveredToken {
  if (watchlist.has(mint)) return watchlist.get(mint)!

  const token: DiscoveredToken = {
    mint,
    name,
    symbol,
    creator,
    discoveredAt:   Date.now(),
    source,
    lifecycleStage: stage,
    lastActivity:   Date.now(),
    swapCount:      0,
    active:         true,
  }

  watchlist.set(mint, token)
  upsertDiscoveredToken(token)

  // Register in token registry so candle engine + strategies can use it
  const meta: TokenMeta = {
    mint,
    name,
    symbol,
    uri: '',
    creator,
    createdAt: Date.now(),
    lifecycleStage: stage,
  }
  registry.register(meta)

  bus.emit({ type: 'token:discovered', data: token })
  logger.info(`Discovery [${source}]: new token ${symbol} (${name}) — stage: ${stage}`)

  return token
}

// ─── Pruner ───────────────────────────────────────────────────

function pruneInactive(): void {
  const cutoff     = Date.now() - 2 * 60 * 60_000   // 2 hours
  const minSwaps   = 20
  let pruned = 0

  for (const [mint, token] of watchlist) {
    if (token.lastActivity < cutoff && token.swapCount < minSwaps) {
      token.active = false
      upsertDiscoveredToken(token)
      watchlist.delete(mint)
      pruned++
    }
  }

  if (pruned > 0) logger.debug(`Discovery: pruned ${pruned} inactive tokens`)
}
