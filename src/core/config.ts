import 'dotenv/config'
import type { BotConfig, ExecutorMode, LogLevel } from './types.js'

function requireEnv(key: string, fallback?: string): string {
  const val = process.env[key] ?? fallback
  if (!val) throw new Error(`Missing required env var: ${key}`)
  return val
}

function optionalEnv(key: string, fallback: string): string {
  return process.env[key] ?? fallback
}

export function loadConfig(): BotConfig {
  return {
    mode:                   (optionalEnv('EXECUTOR_MODE', 'PAPER')) as ExecutorMode,
    heliusApiKey:           optionalEnv('HELIUS_API_KEY', ''),
    heliusRpcUrl:           optionalEnv('HELIUS_RPC_URL', ''),
    heliusWssUrl:           optionalEnv('HELIUS_WSS_URL', ''),
    walletPrivateKey:       process.env['WALLET_PRIVATE_KEY'],
    jitoTipLamports:        parseInt(optionalEnv('JITO_TIP_LAMPORTS', '500000')),
    maxOpenPositions:       parseInt(optionalEnv('MAX_OPEN_POSITIONS', '5')),
    maxPositionSizeSol:     parseFloat(optionalEnv('MAX_POSITION_SIZE_SOL', '0.5')),
    maxTokenExposurePct:    parseFloat(optionalEnv('MAX_TOKEN_EXPOSURE_PCT', '10')),
    maxStrategyExposurePct: parseFloat(optionalEnv('MAX_STRATEGY_EXPOSURE_PCT', '30')),
    dailyLossLimitSol:      parseFloat(optionalEnv('DAILY_LOSS_LIMIT_SOL', '2')),
    tradeTimeLimitMs:       parseInt(optionalEnv('TRADE_TIME_LIMIT_MS', '180000')),
    safetyRiskThreshold:    parseInt(optionalEnv('SAFETY_RISK_THRESHOLD', '60')),
    strategyDrawdownLimit:  parseFloat(optionalEnv('STRATEGY_DRAWDOWN_LIMIT', '0.3')),
    wsPort:                 parseInt(optionalEnv('WS_PORT', '8080')),
    httpPort:               parseInt(optionalEnv('HTTP_PORT', '3001')),
    dbPath:                 optionalEnv('DB_PATH', 'data/bot.db'),
    logLevel:               (optionalEnv('LOG_LEVEL', 'INFO')) as LogLevel,
  }
}

export const config = loadConfig()
