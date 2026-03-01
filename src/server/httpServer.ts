import express from 'express'
import { logger } from '../core/logger.js'
import { getFills, getAllStrategyMetrics, getRecentLogs, getSignals, getDiscoveredTokens } from '../storage/sqlite.js'
import { registry } from '../core/tokenRegistry.js'
import { getAllMetrics } from '../risk/strategyMetrics.js'
import { enableStrategy, disableStrategy } from '../strategies/index.js'
import { getWatchlist } from '../discovery/discoveryEngine.js'
import { getSummary, getSignalQuality, getRecentSignals, getTokenSignalStats, getConfidenceCalibration, printSummaryReport } from '../analytics/analyticsEngine.js'
import { runBacktest } from '../backtest/runner.js'
import { formatBacktestReport } from '../backtest/report.js'
import { bus } from '../core/eventBus.js'
import { getTokenState } from '../market/stateStore.js'
import { getSolUsdPrice } from '../scan/scanner.js'

let portfolioRef: (() => object) | null = null

export function setPortfolioRef(fn: () => object): void {
  portfolioRef = fn
}

export function startHttpServer(port: number): void {
  const app = express()
  app.use(express.json())
  app.use((_req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*')
    res.header('Access-Control-Allow-Headers', 'Content-Type')
    res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
    next()
  })

  // ── Core status ──────────────────────────────────────────

  app.get('/api/status', (_req, res) => {
    res.json({
      ok: true,
      tokens: registry.count(),
      portfolio: portfolioRef?.() ?? {},
    })
  })

  app.get('/api/positions', (_req, res) => {
    res.json(portfolioRef?.() ?? { openPositions: [] })
  })

  app.get('/api/fills', (req, res) => {
    const strategyId = req.query['strategy'] as string | undefined
    const rows = getFills(strategyId) as Record<string, unknown>[]
    res.json(rows.map(r => ({
      id:         r.id,
      strategyId: r.strategy_id,
      tokenMint:  r.mint,
      tokenName:  r.token_name ?? r.mint,
      side:       r.side,
      price:      r.price,
      priceInSol: r.price_sol,
      solAmount:  r.sol_amt,
      fee:        r.fee,
      timestamp:  r.ts,
      paper:      r.paper === 1 || r.paper === true,
    })))
  })

  // ── Strategies ────────────────────────────────────────────

  app.get('/api/strategies', (_req, res) => {
    res.json(getAllMetrics())
  })

  app.post('/api/strategies/:id/enable', (req, res) => {
    const ok = enableStrategy(req.params.id)
    if (ok) bus.emit({ type: 'strategy:enabled', data: { strategyId: req.params.id } })
    res.json({ ok })
  })

  app.post('/api/strategies/:id/disable', (req, res) => {
    const ok = disableStrategy(req.params.id)
    if (ok) bus.emit({ type: 'strategy:disabled', data: { strategyId: req.params.id, reason: 'Manual disable via UI' } })
    res.json({ ok })
  })

  // ── Logs ──────────────────────────────────────────────────

  app.get('/api/logs', (req, res) => {
    const limit = Number(req.query['limit']) || 200
    const rows = getRecentLogs(limit) as Record<string, unknown>[]
    res.json(rows.map(r => ({
      id:        r.id,
      level:     r.level,
      message:   r.message,
      data:      r.data ? JSON.parse(r.data as string) : undefined,
      timestamp: r.ts,
    })))
  })

  // ── SOL price oracle ──────────────────────────────────────
  app.get('/api/sol-price', (_req, res) => {
    res.json({ price: getSolUsdPrice(), timestamp: Date.now() })
  })

  // ── Tokens / Watchlist ────────────────────────────────────

  app.get('/api/tokens', (_req, res) => {
    const tokens = registry.all().slice(0, 200).map(t => {
      const st = getTokenState(t.mint)
      return { ...t, ...st }
    })
    res.json(tokens)
  })

  // Token detail: metadata + live market state
  app.get('/api/tokens/:mint', (req, res) => {
    const meta  = registry.get(req.params.mint)
    const state = getTokenState(req.params.mint)
    if (!meta) { res.status(404).json({ error: 'Token not found' }); return }
    res.json({ ...meta, ...state })
  })

  // Self-discovered watchlist (tokens the bot found itself)
  app.get('/api/watchlist', (req, res) => {
    const all = req.query['all'] === 'true'
    const list = all ? getDiscoveredTokens(false) : getWatchlist()
    res.json(list)
  })

  // ── Signals ───────────────────────────────────────────────

  // GET /api/signals?strategy=ema_pullback&side=BUY&since=1710000000000&limit=200
  app.get('/api/signals', (req, res) => {
    const filter = {
      strategyId: req.query['strategy'] as string | undefined,
      tokenMint:  req.query['mint']     as string | undefined,
      side:       req.query['side']     as string | undefined,
      since:      req.query['since']    ? Number(req.query['since']) : undefined,
      limit:      req.query['limit']    ? Number(req.query['limit']) : 200,
    }
    res.json(getSignals(filter))
  })

  // ── Analytics ─────────────────────────────────────────────

  // Full analytics summary
  app.get('/api/analytics', (_req, res) => {
    res.json(getSummary())
  })

  // Signal quality per strategy (how accurate are signals, independent of trades)
  app.get('/api/analytics/signal-quality', (req, res) => {
    const strategyId = req.query['strategy'] as string | undefined
    res.json(getSignalQuality(strategyId))
  })

  // Recent signals with outcome data
  app.get('/api/analytics/recent-signals', (req, res) => {
    const limit      = Number(req.query['limit']) || 100
    const strategyId = req.query['strategy'] as string | undefined
    res.json(getRecentSignals(limit, strategyId))
  })

  // Per-token signal activity
  app.get('/api/analytics/tokens', (req, res) => {
    const limit = Number(req.query['limit']) || 50
    res.json(getTokenSignalStats(limit))
  })

  // Confidence calibration (is high-confidence more accurate?)
  app.get('/api/analytics/confidence', (_req, res) => {
    res.json(getConfidenceCalibration())
  })

  // Plain-text summary report (useful for terminal inspection)
  app.get('/api/analytics/report', (_req, res) => {
    res.type('text/plain').send(printSummaryReport())
  })

  // ── Backtest ──────────────────────────────────────────────

  // POST /api/backtest/run
  // Body: { startTs, endTs, strategyIds?, initialBalanceSol?, label? }
  app.post('/api/backtest/run', async (req, res) => {
    try {
      const body = req.body as {
        startTs?: number
        endTs?: number
        strategyIds?: string[]
        initialBalanceSol?: number
        label?: string
      }

      const now = Date.now()
      const btConfig = {
        startTs:           body.startTs           ?? now - 24 * 60 * 60_000,
        endTs:             body.endTs             ?? now,
        strategyIds:       body.strategyIds       ?? [],
        initialBalanceSol: body.initialBalanceSol ?? 10,
        label:             body.label,
      }

      const result = await runBacktest(btConfig)
      res.json(result)
    } catch (err) {
      logger.error(`Backtest API error: ${err}`)
      res.status(500).json({ error: String(err) })
    }
  })

  // Backtest with plain-text report output
  app.post('/api/backtest/report', async (req, res) => {
    try {
      const body = req.body as {
        startTs?: number
        endTs?: number
        strategyIds?: string[]
        initialBalanceSol?: number
      }
      const now = Date.now()
      const btConfig = {
        startTs:           body.startTs           ?? now - 24 * 60 * 60_000,
        endTs:             body.endTs             ?? now,
        strategyIds:       body.strategyIds       ?? [],
        initialBalanceSol: body.initialBalanceSol ?? 10,
      }
      const result = await runBacktest(btConfig)
      res.type('text/plain').send(formatBacktestReport(result))
    } catch (err) {
      res.status(500).json({ error: String(err) })
    }
  })

  app.listen(port, () => {
    logger.info(`HTTP API listening on http://localhost:${port}`)
  })
}
