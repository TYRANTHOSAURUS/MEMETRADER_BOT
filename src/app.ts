import 'dotenv/config'
import { config } from './core/config.js'
import { logger, setLogLevel } from './core/logger.js'
import { bus } from './core/eventBus.js'
import { initDb, saveSwap, saveFill } from './storage/sqlite.js'
import { ingestSwap } from './market/candleEngine.js'
import { buildSnapshot, updatePrice, recordBuyer } from './market/stateStore.js'
import { evaluate as safetyEvaluate } from './safety/safetyEngine.js'
import { computeVirality } from './virality/viralityEngine.js'
import { getStrategies, getAllStrategyIds } from './strategies/index.js'
import { processSignals } from './signalAggregator/aggregator.js'
import { PortfolioManager } from './risk/portfolioManager.js'
import { initMetrics, onBuyFill, onSellFill, getAllMetrics } from './risk/strategyMetrics.js'
import { PaperExecutor } from './execution/paperExecutor.js'
import { LiveExecutor } from './execution/liveExecutor.js'
import { startScanner } from './scan/scanner.js'
import { startWsServer } from './server/wsServer.js'
import { startHttpServer, setPortfolioRef } from './server/httpServer.js'
import { isScannerConnected } from './scan/scanner.js'
import { startDiscovery, recordSwapActivity, markMigrated } from './discovery/discoveryEngine.js'
import { recordSignal, updatePriceForOutcomes, restoreUnresolvedOutcomes, getPendingOutcomeCount } from './storage/signalStore.js'
import type { SwapEvent, SystemStatus } from './core/types.js'

const VERSION = '0.3.0'
const START_TIME = Date.now()

// Running counters for status broadcast
let totalSwapCount = 0
let signalsToday   = 0
let signalDayStart = new Date().setHours(0, 0, 0, 0)

async function main(): Promise<void> {
  setLogLevel(config.logLevel)

  logger.info(`╔══════════════════════════════════╗`)
  logger.info(`║  MEMETRADER BOT v${VERSION}          ║`)
  logger.info(`║  Mode: ${config.mode.padEnd(26)}║`)
  logger.info(`╚══════════════════════════════════╝`)

  // ── Storage ──────────────────────────────────────────────
  initDb(config.dbPath)
  logger.info(`DB initialized: ${config.dbPath}`)

  // ── Restore unresolved signal outcomes from prior run ────
  restoreUnresolvedOutcomes()

  // ── Executor ──────────────────────────────────────────────
  type AnyExecutor = (PaperExecutor | LiveExecutor) & { updatePrice(mint: string, price: number, priceInSol: number, name: string): void }
  let executor: AnyExecutor
  let initialBalanceSol = 10.0

  if (config.mode === 'LIVE') {
    if (!config.walletPrivateKey) {
      logger.error('LIVE mode requires WALLET_PRIVATE_KEY in .env')
      process.exit(1)
    }
    const liveEx = new LiveExecutor({
      walletPrivateKey: config.walletPrivateKey,
      jitoTipLamports:  config.jitoTipLamports,
      heliusRpcUrl:     config.heliusRpcUrl,
    })
    // Fetch actual wallet balance for portfolio manager
    try {
      initialBalanceSol = await liveEx.getWalletBalanceSol()
      logger.info(`LiveExecutor: wallet balance = ${initialBalanceSol.toFixed(4)} SOL`)
    } catch (err) {
      logger.warn(`Could not fetch wallet balance: ${err} — defaulting to 0 SOL`)
      initialBalanceSol = 0
    }
    executor = liveEx as AnyExecutor
  } else {
    executor = new PaperExecutor() as AnyExecutor
  }

  // ── Portfolio Manager ─────────────────────────────────────
  const portfolio = new PortfolioManager(config, initialBalanceSol)
  setPortfolioRef(() => portfolio.getState())

  // ── Strategy Metrics ──────────────────────────────────────
  initMetrics(getAllStrategyIds())

  // ── Servers ───────────────────────────────────────────────
  startWsServer(config.wsPort)
  startHttpServer(config.httpPort)

  // ── Discovery Engine ──────────────────────────────────────
  startDiscovery(config.heliusApiKey)

  // ── Event Pipeline ────────────────────────────────────────

  bus.on('swap:new', async (swap: SwapEvent) => {
    totalSwapCount++

    // 1. Store raw swap (backtest replay data — never skip)
    saveSwap(swap)

    // 2. Update discovery engine activity tracker
    recordSwapActivity(swap.mint)

    // 3. Feed candle engine
    ingestSwap(swap)

    // 4. Update price state + outcome tracker
    updatePrice(swap.mint, swap.price, swap.priceInSol)
    executor.updatePrice(swap.mint, swap.price, swap.priceInSol, swap.mint.slice(0, 8))
    updatePriceForOutcomes(swap.mint, swap.priceInSol)
    if (swap.side === 'buy') recordBuyer(swap.mint, swap.wallet)

    // 5. Build market snapshot
    const snapshot = buildSnapshot(swap.mint)
    if (!snapshot) return

    // 6. Compute virality
    const virality = computeVirality(snapshot)
    snapshot.virality = virality

    // 7. Safety check
    const safety = safetyEvaluate(snapshot, config.safetyRiskThreshold)
    snapshot.safety.riskScore = safety.riskScore
    snapshot.safety.flags     = safety.flags

    if (safety.vetoed) {
      bus.emit({ type: 'safety:veto', data: {
        mint:      swap.mint,
        reason:    safety.flags[0] ?? 'Risk threshold exceeded',
        riskScore: safety.riskScore,
        flags:     safety.flags,
      }})
      return
    }

    // 8. Run strategies
    const strategies = getStrategies()
    const allSignals = strategies.flatMap(s => {
      if (!s.lifecycleStages.includes(snapshot.lifecycleStage)) return []
      try {
        return s.evaluate(snapshot)
      } catch (err) {
        logger.error(`Strategy ${s.id} threw: ${err}`)
        return []
      }
    })

    if (allSignals.length > 0) {
      allSignals.forEach(sig => {
        bus.emit({ type: 'signal:emitted', data: sig })
        recordSignal(sig)
        // Reset daily signal counter at midnight
        const dayStart = new Date().setHours(0, 0, 0, 0)
        if (dayStart > signalDayStart) { signalsToday = 0; signalDayStart = dayStart }
        signalsToday++
      })
    }

    // 9. Aggregate signals → intents
    const intents = processSignals(allSignals, snapshot, {
      maxSlippageBps:     config.safetyRiskThreshold,
      maxPositionSizeSol: config.maxPositionSizeSol,
      tradeTimeLimitMs:   config.tradeTimeLimitMs,
    })

    // 10. Risk check + execute
    for (const intent of intents) {
      const { ok, reason } = portfolio.canTrade(intent)
      if (!ok) {
        bus.emit({ type: 'intent:rejected', data: { intent, reason: reason! } })
        logger.debug(`Intent rejected: ${reason}`)
        continue
      }

      try {
        const fill = await executor.submit(intent)
        saveFill(fill)
        portfolio.onFill(fill)

        if (fill.side === 'BUY') {
          onBuyFill(fill)
          fill.strategyId.split('+').forEach(id => {
            getStrategies().find(s => s.id === id)?.onFill?.(fill)
          })
        } else {
          const pos = portfolio.getPosition(fill.tokenMint)
          const pnl = pos ? (fill.priceInSol - pos.entryPriceInSol) * pos.tokenAmount - fill.fee : 0
          onSellFill(fill, pnl)
        }
      } catch (err) {
        logger.error(`Execution failed: ${err}`)
      }
    }

    // 11. Update unrealized P&L
    const prices = new Map([[swap.mint, swap.price]])
    portfolio.updatePrices(prices)
  })

  // ── Handle migration events ───────────────────────────────
  bus.on('token:migrated', ({ mint }: { mint: string }) => {
    markMigrated(mint)
  })

  // ── Status broadcast (every 5s) ───────────────────────────
  setInterval(async () => {
    const state = portfolio.getState()
    // Refresh actual balance in live mode
    if (config.mode === 'LIVE' && 'getWalletBalanceSol' in executor) {
      const bal = await (executor as LiveExecutor).getWalletBalanceSol().catch(() => state.totalBalanceSol)
      if (bal > 0) portfolio.setBalance(bal)
    }
    const status: SystemStatus = {
      uptime:           Math.floor((Date.now() - START_TIME) / 1000),
      mode:             config.mode,
      balanceSol:       state.totalBalanceSol,
      tokensTracked:    0,
      openPositions:    state.openPositionCount,
      activeStrategies: getStrategies().length,
      totalTrades:      getAllMetrics().reduce((s, m) => s + m.totalTrades, 0),
      dayPnlSol:        state.dayPnlSol,
      scannerConnected: isScannerConnected(),
      version:          VERSION,
      swapsProcessed:   totalSwapCount,
      signalsToday,
    }
    bus.emit({ type: 'system:status', data: status })
  }, 5_000)

  // ── Outcome tracker stats (every 60s) ─────────────────────
  setInterval(() => {
    const pending = getPendingOutcomeCount()
    if (pending > 0) logger.debug(`Signal outcomes: ${pending} pending resolution`)
  }, 60_000)

  // ── Scanner ───────────────────────────────────────────────
  startScanner(config.heliusWssUrl)

  logger.info(`Bot started. WS: ws://localhost:${config.wsPort} | HTTP: http://localhost:${config.httpPort}`)
  logger.info(`UI: cd ui && npm run dev → http://localhost:3000`)
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
