// Uses Node.js 22+ built-in SQLite (no native compilation needed)
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'fs'
import { dirname } from 'path'
import type { Fill, Position, StrategyMetrics, LogEntry, Candle, SwapEvent, Signal, SignalOutcome, DiscoveredToken } from '../core/types.js'

let db: DatabaseSync

export function initDb(path: string): void {
  mkdirSync(dirname(path), { recursive: true })
  db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec('PRAGMA foreign_keys = ON')
  createSchema()
}

function createSchema(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS swap_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      mint        TEXT NOT NULL,
      side        TEXT NOT NULL,
      price       REAL NOT NULL,
      price_sol   REAL NOT NULL,
      token_amt   REAL NOT NULL,
      sol_amt     REAL NOT NULL,
      wallet      TEXT NOT NULL,
      ts          INTEGER NOT NULL,
      signature   TEXT UNIQUE NOT NULL,
      program     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_swaps_mint_ts ON swap_events(mint, ts);

    CREATE TABLE IF NOT EXISTS candles (
      mint        TEXT NOT NULL,
      timeframe   TEXT NOT NULL,
      ts          INTEGER NOT NULL,
      open        REAL NOT NULL,
      high        REAL NOT NULL,
      low         REAL NOT NULL,
      close       REAL NOT NULL,
      volume      REAL NOT NULL,
      buy_vol     REAL NOT NULL,
      sell_vol    REAL NOT NULL,
      trades      INTEGER NOT NULL,
      buy_trades  INTEGER NOT NULL,
      PRIMARY KEY (mint, timeframe, ts)
    );

    CREATE TABLE IF NOT EXISTS fills (
      id           TEXT PRIMARY KEY,
      intent_id    TEXT NOT NULL,
      strategy_id  TEXT NOT NULL,
      mint         TEXT NOT NULL,
      token_name   TEXT NOT NULL,
      side         TEXT NOT NULL,
      price        REAL NOT NULL,
      price_sol    REAL NOT NULL,
      token_amt    REAL NOT NULL,
      sol_amt      REAL NOT NULL,
      fee          REAL NOT NULL,
      ts           INTEGER NOT NULL,
      tx_sig       TEXT NOT NULL,
      paper        INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_fills_mint ON fills(mint);
    CREATE INDEX IF NOT EXISTS idx_fills_strategy ON fills(strategy_id);

    CREATE TABLE IF NOT EXISTS positions (
      id              TEXT PRIMARY KEY,
      mint            TEXT NOT NULL,
      token_name      TEXT NOT NULL,
      token_symbol    TEXT NOT NULL,
      strategy_id     TEXT NOT NULL,
      entry_price     REAL NOT NULL,
      entry_price_sol REAL NOT NULL,
      token_amt       REAL NOT NULL,
      sol_amt         REAL NOT NULL,
      entry_time      INTEGER NOT NULL,
      paper           INTEGER NOT NULL,
      open            INTEGER NOT NULL DEFAULT 1,
      close_price     REAL,
      close_time      INTEGER,
      pnl_sol         REAL
    );

    CREATE TABLE IF NOT EXISTS strategy_metrics (
      strategy_id       TEXT PRIMARY KEY,
      total_trades      INTEGER NOT NULL DEFAULT 0,
      winning_trades    INTEGER NOT NULL DEFAULT 0,
      losing_trades     INTEGER NOT NULL DEFAULT 0,
      total_pnl_sol     REAL NOT NULL DEFAULT 0,
      avg_hold_ms       REAL NOT NULL DEFAULT 0,
      best_trade_sol    REAL NOT NULL DEFAULT 0,
      worst_trade_sol   REAL NOT NULL DEFAULT 0,
      max_drawdown_sol  REAL NOT NULL DEFAULT 0,
      sharpe_ratio      REAL NOT NULL DEFAULT 0,
      auto_disabled     INTEGER NOT NULL DEFAULT 0,
      last_updated      INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS logs (
      id        TEXT PRIMARY KEY,
      level     TEXT NOT NULL,
      message   TEXT NOT NULL,
      data      TEXT,
      ts        INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs(ts);

    CREATE TABLE IF NOT EXISTS signals (
      id              TEXT PRIMARY KEY,
      strategy_id     TEXT NOT NULL,
      token_mint      TEXT NOT NULL,
      token_name      TEXT NOT NULL,
      token_symbol    TEXT NOT NULL,
      side            TEXT NOT NULL,
      confidence      REAL NOT NULL,
      reason          TEXT NOT NULL,
      lifecycle_stage TEXT NOT NULL,
      price_sol       REAL NOT NULL,
      virality_score  REAL NOT NULL,
      virality_slope  REAL NOT NULL,
      risk_score      REAL NOT NULL,
      flags           TEXT NOT NULL,
      snapshot        TEXT NOT NULL,
      ts              INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_signals_strategy  ON signals(strategy_id);
    CREATE INDEX IF NOT EXISTS idx_signals_mint      ON signals(token_mint);
    CREATE INDEX IF NOT EXISTS idx_signals_ts        ON signals(ts);

    CREATE TABLE IF NOT EXISTS signal_outcomes (
      signal_id             TEXT PRIMARY KEY,
      strategy_id           TEXT NOT NULL,
      token_mint            TEXT NOT NULL,
      side                  TEXT NOT NULL,
      signal_ts             INTEGER NOT NULL,
      price_at_signal       REAL NOT NULL,
      price_at_30s          REAL NOT NULL DEFAULT 0,
      price_at_1m           REAL NOT NULL DEFAULT 0,
      price_at_5m           REAL NOT NULL DEFAULT 0,
      max_gain_pct          REAL NOT NULL DEFAULT 0,
      max_loss_pct          REAL NOT NULL DEFAULT 0,
      dir_correct_30s       INTEGER NOT NULL DEFAULT 0,
      dir_correct_1m        INTEGER NOT NULL DEFAULT 0,
      dir_correct_5m        INTEGER NOT NULL DEFAULT 0,
      resolved              INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_outcomes_strategy ON signal_outcomes(strategy_id);

    CREATE TABLE IF NOT EXISTS discovered_tokens (
      mint            TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      symbol          TEXT NOT NULL,
      creator         TEXT NOT NULL,
      discovered_at   INTEGER NOT NULL,
      source          TEXT NOT NULL,
      lifecycle_stage TEXT NOT NULL,
      last_activity   INTEGER NOT NULL,
      swap_count      INTEGER NOT NULL DEFAULT 0,
      active          INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_discovered_active ON discovered_tokens(active, last_activity);
  `)
}

// ─── Swaps ───────────────────────────────────────────────────

export function saveSwap(e: SwapEvent): void {
  db.prepare(`
    INSERT OR IGNORE INTO swap_events
      (mint, side, price, price_sol, token_amt, sol_amt, wallet, ts, signature, program)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(e.mint, e.side, e.price, e.priceInSol, e.tokenAmount, e.solAmount, e.wallet, e.timestamp, e.signature, e.program)
}

// ─── Candles ─────────────────────────────────────────────────

export function saveCandle(mint: string, timeframe: string, c: Candle): void {
  db.prepare(`
    INSERT OR REPLACE INTO candles
      (mint, timeframe, ts, open, high, low, close, volume, buy_vol, sell_vol, trades, buy_trades)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(mint, timeframe, c.timestamp, c.open, c.high, c.low, c.close, c.volume, c.buyVolume, c.sellVolume, c.trades, c.buyTrades)
}

// ─── Fills ───────────────────────────────────────────────────

export function saveFill(f: Fill): void {
  db.prepare(`
    INSERT OR IGNORE INTO fills
      (id, intent_id, strategy_id, mint, token_name, side, price, price_sol, token_amt, sol_amt, fee, ts, tx_sig, paper)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(f.id, f.intentId, f.strategyId, f.tokenMint, f.tokenName, f.side, f.price, f.priceInSol, f.tokenAmount, f.solAmount, f.fee, f.timestamp, f.txSignature, f.paper ? 1 : 0)
}

export function getFills(strategyId?: string): unknown[] {
  if (strategyId) {
    return db.prepare(`SELECT * FROM fills WHERE strategy_id = ? ORDER BY ts DESC`).all(strategyId)
  }
  return db.prepare(`SELECT * FROM fills ORDER BY ts DESC LIMIT 500`).all()
}

// ─── Positions ───────────────────────────────────────────────

export function savePosition(p: Position): void {
  db.prepare(`
    INSERT OR REPLACE INTO positions
      (id, mint, token_name, token_symbol, strategy_id, entry_price, entry_price_sol, token_amt, sol_amt, entry_time, paper, open)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `).run(p.id, p.tokenMint, p.tokenName, p.tokenSymbol, p.strategyId, p.entryPrice, p.entryPriceInSol, p.tokenAmount, p.solAmount, p.entryTime, p.paper ? 1 : 0)
}

export function closePosition(id: string, closePrice: number, pnlSol: number): void {
  db.prepare(`
    UPDATE positions SET open = 0, close_price = ?, close_time = ?, pnl_sol = ? WHERE id = ?
  `).run(closePrice, Date.now(), pnlSol, id)
}

// ─── Strategy Metrics ─────────────────────────────────────────

export function upsertStrategyMetrics(m: StrategyMetrics): void {
  db.prepare(`
    INSERT OR REPLACE INTO strategy_metrics
      (strategy_id, total_trades, winning_trades, losing_trades, total_pnl_sol, avg_hold_ms, best_trade_sol, worst_trade_sol, max_drawdown_sol, sharpe_ratio, auto_disabled, last_updated)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(m.strategyId, m.totalTrades, m.winningTrades, m.losingTrades, m.totalPnlSol, m.avgHoldDurationMs, m.bestTradeSol, m.worstTradeSol, m.maxDrawdownSol, m.sharpeRatio, m.autoDisabled ? 1 : 0, m.lastUpdated)
}

export function getAllStrategyMetrics(): unknown[] {
  return db.prepare(`SELECT * FROM strategy_metrics`).all()
}

// ─── Logs ─────────────────────────────────────────────────────

export function saveLog(entry: LogEntry): void {
  db.prepare(`
    INSERT OR IGNORE INTO logs (id, level, message, data, ts)
    VALUES (?, ?, ?, ?, ?)
  `).run(entry.id, entry.level, entry.message, entry.data ? JSON.stringify(entry.data) : null, entry.timestamp)
}

export function getRecentLogs(limit = 200): unknown[] {
  return db.prepare(`SELECT * FROM logs ORDER BY ts DESC LIMIT ?`).all(limit)
}

// ─── Signals ──────────────────────────────────────────────────

export function saveSignal(s: Signal): void {
  const snap = s.snapshot
  db.prepare(`
    INSERT OR IGNORE INTO signals
      (id, strategy_id, token_mint, token_name, token_symbol, side, confidence, reason,
       lifecycle_stage, price_sol, virality_score, virality_slope, risk_score, flags, snapshot, ts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    s.id, s.strategyId, s.tokenMint, snap.tokenName, snap.tokenSymbol,
    s.side, s.confidence, s.reason,
    snap.lifecycleStage, snap.priceInSol,
    snap.virality.score, snap.virality.slope, snap.safety.riskScore,
    JSON.stringify(snap.safety.flags),
    JSON.stringify({
      price: snap.price, priceInSol: snap.priceInSol,
      marketCap: snap.marketCap, liquidity: snap.liquidity,
      volume: snap.volume, indicators: snap.indicators,
      virality: snap.virality, safety: snap.safety,
      holderCount: snap.holderCount, holderGrowthRate: snap.holderGrowthRate,
    }),
    s.timestamp,
  )
}

export interface SignalFilter {
  strategyId?: string
  tokenMint?: string
  side?: string
  since?: number
  limit?: number
}

export function getSignals(f: SignalFilter = {}): unknown[] {
  const clauses: string[] = []
  const params: (string | number)[] = []

  if (f.strategyId) { clauses.push('strategy_id = ?'); params.push(f.strategyId) }
  if (f.tokenMint)  { clauses.push('token_mint = ?');  params.push(f.tokenMint) }
  if (f.side)       { clauses.push('side = ?');        params.push(f.side) }
  if (f.since)      { clauses.push('ts >= ?');         params.push(f.since) }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  const limit = f.limit ?? 500
  return db.prepare(`SELECT * FROM signals ${where} ORDER BY ts DESC LIMIT ${limit}`).all(...params)
}

// ─── Signal Outcomes ──────────────────────────────────────────

export function initSignalOutcome(signalId: string, strategyId: string, tokenMint: string, side: string, signalTs: number, priceAtSignal: number): void {
  db.prepare(`
    INSERT OR IGNORE INTO signal_outcomes
      (signal_id, strategy_id, token_mint, side, signal_ts, price_at_signal)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(signalId, strategyId, tokenMint, side, signalTs, priceAtSignal)
}

export function updateSignalOutcome(o: SignalOutcome): void {
  db.prepare(`
    UPDATE signal_outcomes SET
      price_at_30s = ?, price_at_1m = ?, price_at_5m = ?,
      max_gain_pct = ?, max_loss_pct = ?,
      dir_correct_30s = ?, dir_correct_1m = ?, dir_correct_5m = ?,
      resolved = ?
    WHERE signal_id = ?
  `).run(
    o.priceAt30s, o.priceAt1m, o.priceAt5m,
    o.maxGainPct, o.maxLossPct,
    o.directionCorrect30s ? 1 : 0,
    o.directionCorrect1m  ? 1 : 0,
    o.directionCorrect5m  ? 1 : 0,
    o.resolved ? 1 : 0,
    o.signalId,
  )
}

export function getUnresolvedOutcomes(): unknown[] {
  return db.prepare(`SELECT * FROM signal_outcomes WHERE resolved = 0 ORDER BY signal_ts ASC LIMIT 1000`).all()
}

export function getOutcomeStats(strategyId?: string): unknown[] {
  const where = strategyId ? `WHERE strategy_id = ?` : ''
  const params = strategyId ? [strategyId] : []
  return db.prepare(`
    SELECT
      strategy_id,
      side,
      COUNT(*)                                               AS total,
      SUM(CASE WHEN resolved = 1 THEN 1 ELSE 0 END)         AS resolved_count,
      AVG(CASE WHEN resolved = 1 THEN dir_correct_30s END)  AS accuracy_30s,
      AVG(CASE WHEN resolved = 1 THEN dir_correct_1m END)   AS accuracy_1m,
      AVG(CASE WHEN resolved = 1 THEN dir_correct_5m END)   AS accuracy_5m,
      AVG(CASE WHEN resolved = 1 THEN max_gain_pct END)     AS avg_max_gain,
      AVG(CASE WHEN resolved = 1 THEN max_loss_pct END)     AS avg_max_loss
    FROM signal_outcomes ${where}
    GROUP BY strategy_id, side
    ORDER BY strategy_id, side
  `).all(...params)
}

// ─── Discovered Tokens ────────────────────────────────────────

export function upsertDiscoveredToken(t: DiscoveredToken): void {
  db.prepare(`
    INSERT INTO discovered_tokens
      (mint, name, symbol, creator, discovered_at, source, lifecycle_stage, last_activity, swap_count, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(mint) DO UPDATE SET
      lifecycle_stage = excluded.lifecycle_stage,
      last_activity   = excluded.last_activity,
      swap_count      = excluded.swap_count,
      active          = excluded.active
  `).run(
    t.mint, t.name, t.symbol, t.creator, t.discoveredAt, t.source,
    t.lifecycleStage, t.lastActivity, t.swapCount, t.active ? 1 : 0,
  )
}

export function getDiscoveredTokens(activeOnly = true): unknown[] {
  if (activeOnly) {
    return db.prepare(`SELECT * FROM discovered_tokens WHERE active = 1 ORDER BY last_activity DESC`).all()
  }
  return db.prepare(`SELECT * FROM discovered_tokens ORDER BY discovered_at DESC LIMIT 1000`).all()
}

export function getSwapsByTimeRange(startTs: number, endTs: number, mint?: string): unknown[] {
  if (mint) {
    return db.prepare(`SELECT * FROM swap_events WHERE ts >= ? AND ts <= ? AND mint = ? ORDER BY ts ASC`).all(startTs, endTs, mint)
  }
  return db.prepare(`SELECT * FROM swap_events WHERE ts >= ? AND ts <= ? ORDER BY ts ASC`).all(startTs, endTs)
}

export function getDb(): DatabaseSync {
  return db
}
