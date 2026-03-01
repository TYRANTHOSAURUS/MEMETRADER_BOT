export type Side = 'BUY' | 'SELL'
export type ExecutorMode = 'PAPER' | 'LIVE'
export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'TRADE'

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

export interface Fill {
  id: string
  strategyId: string
  tokenMint: string
  tokenName: string
  side: Side
  price: number
  priceInSol: number
  solAmount: number
  fee: number
  timestamp: number
  paper: boolean
}

export interface Signal {
  id: string
  strategyId: string
  tokenMint: string
  side: Side
  confidence: number
  reason: string
  timestamp: number
}

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

export interface LogEntry {
  id: string
  level: LogLevel
  message: string
  data?: Record<string, unknown>
  timestamp: number
}

export interface SwapEvent {
  mint: string
  side: 'buy' | 'sell'
  price: number
  priceInSol: number
  tokenAmount: number
  solAmount: number
  wallet: string
  timestamp: number
  signature: string
  program: string
}

export interface BotMessage {
  type: string
  data: unknown
}

export interface TokenEntry {
  mint:           string
  name:           string
  symbol:         string
  lifecycleStage: string
  swapCount:      number
  lastSeen:       number
  price?:         number
  priceInSol?:    number
  liquidity?:     number
  marketCap?:     number
  holderCount?:   number
  mintRevoked?:   boolean
  freezeRevoked?: boolean
  lpBurned?:      boolean
  imageUrl?:      string | null
  website?:       string | null
  twitter?:       string | null
  telegram?:      string | null
}
