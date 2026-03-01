// ============================================================
// MEMETRADER BOT — Core Types
// All engines communicate through these contracts only.
// No engine imports another engine's internals.
// ============================================================

export type LifecycleStage = 'BONDING_CURVE' | 'MIGRATING' | 'AMM'
export type Side = 'BUY' | 'SELL'
export type EntryMode = 'NOW' | 'RANGE'
export type SizeMode = 'FIXED' | 'PERCENT' | 'RISK_BASED'
export type ExecutorMode = 'PAPER' | 'LIVE'
export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'TRADE'

// ─── Raw Input ───────────────────────────────────────────────

export interface SwapEvent {
  mint: string
  side: 'buy' | 'sell'
  price: number          // price in USD
  priceInSol: number
  tokenAmount: number
  solAmount: number
  wallet: string
  timestamp: number      // unix ms
  signature: string
  program: 'pumpfun' | 'raydium' | 'orca' | 'jupiter'
}

// ─── Token ───────────────────────────────────────────────────

export interface TokenMeta {
  mint: string
  name: string
  symbol: string
  uri: string
  creator: string
  createdAt: number      // unix ms
  lifecycleStage: LifecycleStage
}

// ─── Candle ──────────────────────────────────────────────────

export interface Candle {
  open: number
  high: number
  low: number
  close: number
  volume: number         // USD
  buyVolume: number
  sellVolume: number
  trades: number
  buyTrades: number
  timestamp: number      // unix ms, start of period
  closed: boolean
}

// ─── Market Snapshot (read-only, passed to strategies) ───────

export interface MarketSnapshot {
  tokenMint: string
  tokenName: string
  tokenSymbol: string
  tokenAge: number             // seconds since launch
  lifecycleStage: LifecycleStage

  price: number                // USD
  priceInSol: number
  liquidity: number            // USD
  marketCap: number            // USD

  candles: {
    s15: Candle[]              // most recent last
    m1:  Candle[]
    m5:  Candle[]
  }

  indicators: {
    ema9:      number
    ema21:     number
    ema50:     number
    vwap:      number
    swingHigh: number
    swingLow:  number
    rsi14:     number
  }

  volume: {
    total5m:            number
    buyVolume5m:        number
    sellVolume5m:       number
    uniqueBuyers5m:     number
    buyerVelocity:      number   // unique buyers per 30s, current period
    buyerVelocityPrev:  number   // prior period for slope
    volumeToMcap:       number   // 5m vol / mcap ratio
    buySellRatio:       number   // 0–1, 1 = all buys
  }

  virality: {
    score:       number   // 0–100 composite
    slope:       number   // positive = rising
    socialScore: number   // 0–100
    onChainScore: number  // 0–100
  }

  safety: {
    riskScore:     number
    flags:         string[]
    mintRevoked:   boolean
    freezeRevoked: boolean
    lpBurned:      boolean
  }

  devWallet: {
    address:    string
    bought:     boolean   // bought post-launch?
    sold:       boolean   // sold any amount?
    holdingPct: number
  }

  holderCount:      number
  holderGrowthRate: number   // holders per minute

  timestamp: number
}

// ─── Signal (emitted by strategies) ─────────────────────────

export interface Signal {
  id: string
  strategyId: string
  tokenMint: string
  side: Side
  confidence: number     // 0–1
  reason: string
  timestamp: number
  snapshot: MarketSnapshot
}

// ─── Order Intent (emitted by Signal Aggregator) ─────────────

export interface OrderIntent {
  id: string
  strategyId: string
  tokenMint: string
  side: Side
  entryMode: EntryMode
  priceMin?: number
  priceMax?: number
  sizeMode: SizeMode
  sizeValue: number
  invalidationPrice: number
  maxSlippageBps: number
  expiresAt: number
  confidence: number
  lifecycleStage: LifecycleStage
  createdAt: number
}

// ─── Fill (execution result) ─────────────────────────────────

export interface Fill {
  id: string
  intentId: string
  strategyId: string
  tokenMint: string
  tokenName: string
  side: Side
  price: number
  priceInSol: number
  tokenAmount: number
  solAmount: number
  fee: number            // total fee in SOL
  timestamp: number
  txSignature: string
  paper: boolean
}

// ─── Position ────────────────────────────────────────────────

export interface Position {
  id: string
  tokenMint: string
  tokenName: string
  tokenSymbol: string
  strategyId: string
  entryPrice: number
  entryPriceInSol: number
  tokenAmount: number
  solAmount: number
  entryTime: number
  currentPrice: number
  unrealizedPnlSol: number
  unrealizedPnlPct: number
  paper: boolean
}

// ─── Strategy Interface ──────────────────────────────────────

export interface Strategy {
  id: string
  name: string
  description: string
  lifecycleStages: LifecycleStage[]
  warmupPeriods: number
  enabled: boolean
  evaluate(snapshot: MarketSnapshot): Signal[]
  onFill?(fill: Fill): void
}

// ─── Executor Interface ──────────────────────────────────────

export interface Executor {
  mode: ExecutorMode
  submit(intent: OrderIntent): Promise<Fill>
  cancel(intentId: string): Promise<void>
  getPosition(tokenMint: string): Position | null
  getAllPositions(): Position[]
  closePosition(tokenMint: string, strategyId: string): Promise<Fill | null>
}

// ─── Safety ──────────────────────────────────────────────────

export interface SafetyResult {
  riskScore: number
  flags: string[]
  mintRevoked: boolean
  freezeRevoked: boolean
  lpBurned: boolean
  vetoed: boolean
}

// ─── Strategy Metrics ────────────────────────────────────────

export interface StrategyMetrics {
  strategyId: string
  totalTrades: number
  winningTrades: number
  losingTrades: number
  winRate: number
  totalPnlSol: number
  avgPnlPerTrade: number
  avgHoldDurationMs: number
  bestTradeSol: number
  worstTradeSol: number
  maxDrawdownSol: number
  sharpeRatio: number
  autoDisabled: boolean
  lastUpdated: number
}

// ─── Portfolio ───────────────────────────────────────────────

export interface PortfolioState {
  totalBalanceSol: number
  availableBalanceSol: number
  openPositions: Position[]
  dayPnlSol: number
  totalPnlSol: number
  openPositionCount: number
  maxPositions: number
  dailyLossLimitSol: number
  killed: boolean
}

// ─── Bot Events (typed event bus) ────────────────────────────

export type BotEvent =
  | { type: 'swap:new';            data: SwapEvent }
  | { type: 'candle:closed';       data: { mint: string; timeframe: '15s' | '1m' | '5m'; candle: Candle } }
  | { type: 'signal:emitted';      data: Signal }
  | { type: 'intent:created';      data: OrderIntent }
  | { type: 'intent:rejected';     data: { intent: OrderIntent; reason: string } }
  | { type: 'fill:confirmed';      data: Fill }
  | { type: 'safety:veto';         data: { mint: string; reason: string; riskScore: number; flags: string[] } }
  | { type: 'token:new';           data: TokenMeta }
  | { type: 'token:migrated';      data: { mint: string } }
  | { type: 'position:opened';     data: Position }
  | { type: 'position:closed';     data: { position: Position; pnlSol: number; pnlPct: number } }
  | { type: 'position:updated';    data: Position }
  | { type: 'strategy:disabled';   data: { strategyId: string; reason: string } }
  | { type: 'strategy:enabled';    data: { strategyId: string } }
  | { type: 'portfolio:updated';   data: PortfolioState }
  | { type: 'kill_switch';         data: { reason: string } }
  | { type: 'log';                 data: LogEntry }
  | { type: 'system:status';       data: SystemStatus }
  | { type: 'scanner:connected';   data: { rpc: string } }
  | { type: 'scanner:disconnected';data: { reason: string } }
  | { type: 'token:discovered';    data: DiscoveredToken }
  | { type: 'signal:outcome';      data: SignalOutcome }

// ─── Log ─────────────────────────────────────────────────────

export interface LogEntry {
  id: string
  level: LogLevel
  message: string
  data?: Record<string, unknown>
  timestamp: number
}

// ─── System Status ────────────────────────────────────────────

export interface SystemStatus {
  uptime: number
  mode: ExecutorMode
  balanceSol: number
  tokensTracked: number
  openPositions: number
  activeStrategies: number
  totalTrades: number
  dayPnlSol: number
  scannerConnected: boolean
  version: string
  swapsProcessed?: number
  signalsToday?: number
}

// ─── Discovery ───────────────────────────────────────────────

export interface DiscoveredToken {
  mint:           string
  name:           string
  symbol:         string
  creator:        string
  discoveredAt:   number          // unix ms
  source:         'helius' | 'mock' | 'manual'
  lifecycleStage: LifecycleStage
  lastActivity:   number          // last swap seen, unix ms
  swapCount:      number
  active:         boolean
}

// ─── Signal Outcome ───────────────────────────────────────────
// Records what the market did after a signal was emitted.
// Used to measure signal quality independent of whether we traded.

export interface SignalOutcome {
  signalId:             string
  strategyId:           string
  tokenMint:            string
  side:                 Side
  signalTs:             number
  priceAtSignal:        number     // SOL
  priceAt30s:           number     // SOL (0 if not yet measured)
  priceAt1m:            number
  priceAt5m:            number
  maxGainPct:           number     // max price gain in 5m window (%)
  maxLossPct:           number     // max price drop in 5m window (%)
  directionCorrect30s:  boolean
  directionCorrect1m:   boolean
  directionCorrect5m:   boolean
  resolved:             boolean    // all windows measured
}

// ─── Backtest ─────────────────────────────────────────────────

export interface BacktestConfig {
  startTs:           number       // unix ms
  endTs:             number       // unix ms
  strategyIds:       string[]     // empty = all
  initialBalanceSol: number
  label?:            string
}

export interface BacktestResult {
  config:        BacktestConfig
  runAt:         number           // unix ms when backtest was run
  durationMs:    number           // how long the backtest took
  swapsReplayed: number
  signalsEmitted: number
  tradesExecuted: number
  perStrategy:   Record<string, StrategyMetrics>
  totalPnlSol:   number
  winRate:        number
}

// ─── Config ──────────────────────────────────────────────────

export interface BotConfig {
  mode: ExecutorMode
  heliusApiKey: string
  heliusRpcUrl: string
  heliusWssUrl: string
  walletPrivateKey?: string
  jitoTipLamports: number
  maxOpenPositions: number
  maxPositionSizeSol: number
  maxTokenExposurePct: number
  maxStrategyExposurePct: number
  dailyLossLimitSol: number
  tradeTimeLimitMs: number
  safetyRiskThreshold: number
  strategyDrawdownLimit: number
  wsPort: number
  httpPort: number
  dbPath: string
  logLevel: LogLevel
}
