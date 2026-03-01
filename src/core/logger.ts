import { v4 as uuid } from 'uuid'
import { bus } from './eventBus.js'
import type { LogLevel, LogEntry } from './types.js'

const LEVELS: Record<LogLevel, number> = {
  DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3, TRADE: 1,
}

let currentLevel: LogLevel = 'INFO'

export function setLogLevel(level: LogLevel): void {
  currentLevel = level
}

const COLORS: Record<LogLevel, string> = {
  DEBUG: '\x1b[90m',
  INFO:  '\x1b[32m',
  WARN:  '\x1b[33m',
  ERROR: '\x1b[31m',
  TRADE: '\x1b[36m',
}
const RESET = '\x1b[0m'

function log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
  if (LEVELS[level] < LEVELS[currentLevel]) return

  const entry: LogEntry = { id: uuid(), level, message, data, timestamp: Date.now() }
  const time = new Date().toISOString().slice(11, 23)
  const color = COLORS[level]

  console.log(`${color}[${time}] [${level.padEnd(5)}] ${message}${RESET}`, data ?? '')
  bus.emit({ type: 'log', data: entry })
}

export const logger = {
  debug: (msg: string, data?: Record<string, unknown>) => log('DEBUG', msg, data),
  info:  (msg: string, data?: Record<string, unknown>) => log('INFO',  msg, data),
  warn:  (msg: string, data?: Record<string, unknown>) => log('WARN',  msg, data),
  error: (msg: string, data?: Record<string, unknown>) => log('ERROR', msg, data),
  trade: (msg: string, data?: Record<string, unknown>) => log('TRADE', msg, data),
}
