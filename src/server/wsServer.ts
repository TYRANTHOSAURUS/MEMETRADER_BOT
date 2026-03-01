import { WebSocketServer, WebSocket } from 'ws'
import { bus } from '../core/eventBus.js'
import { logger } from '../core/logger.js'
import { getRecentLogs } from '../storage/sqlite.js'
import type { BotEvent, SwapEvent } from '../core/types.js'

const clients = new Set<WebSocket>()

// Throttled swap feed — buffer swaps and flush every 500ms to avoid flooding UI
const swapBuffer: SwapEvent[] = []
let swapFlushTimer: ReturnType<typeof setTimeout> | null = null
const SWAP_FEED_INTERVAL = 500
const SWAP_FEED_CAP = 20

function bufferSwap(swap: SwapEvent): void {
  swapBuffer.push(swap)
  if (swapBuffer.length > SWAP_FEED_CAP * 2) swapBuffer.splice(0, swapBuffer.length - SWAP_FEED_CAP)
  if (swapFlushTimer) return
  swapFlushTimer = setTimeout(() => {
    swapFlushTimer = null
    if (clients.size === 0 || swapBuffer.length === 0) return
    const batch = swapBuffer.splice(0, SWAP_FEED_CAP)
    broadcast({ type: 'swap:new', data: batch[batch.length - 1] } as BotEvent)  // latest swap
    // Also send a mini-summary for the UI feed
    broadcastRaw(JSON.stringify({ type: 'swap:feed', data: batch }))
  }, SWAP_FEED_INTERVAL)
}

export function startWsServer(port: number): void {
  const wss = new WebSocketServer({ port })

  wss.on('connection', (client) => {
    clients.add(client)
    logger.debug(`WS client connected (total: ${clients.size})`)

    // Send recent logs on connect so UI has history
    const logs = getRecentLogs(100) as import('../core/types.js').LogEntry[]
    for (const log of [...logs].reverse()) {
      send(client, { type: 'log', data: log })
    }

    client.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as { command: string; params?: Record<string, unknown> }
        handleCommand(msg)
      } catch {
        // ignore
      }
    })

    client.on('close', () => {
      clients.delete(client)
      logger.debug(`WS client disconnected (total: ${clients.size})`)
    })

    client.on('error', () => {
      clients.delete(client)
    })
  })

  // swap:new is throttled via buffer — do NOT broadcast raw to avoid flooding
  bus.on('swap:new', (data: SwapEvent) => {
    bufferSwap(data)
  })

  // Forward all other bus events to connected UI clients
  const BROADCAST_EVENTS: BotEvent['type'][] = [
    'candle:closed',
    'signal:emitted',
    'intent:created',
    'intent:rejected',
    'fill:confirmed',
    'safety:veto',
    'token:new',
    'token:migrated',
    'position:opened',
    'position:closed',
    'position:updated',
    'strategy:disabled',
    'strategy:enabled',
    'portfolio:updated',
    'kill_switch',
    'log',
    'system:status',
    'scanner:connected',
    'scanner:disconnected',
  ]

  for (const eventType of BROADCAST_EVENTS) {
    bus.on(eventType as BotEvent['type'], (data) => {
      broadcast({ type: eventType, data } as BotEvent)
    })
  }

  logger.info(`WS server listening on ws://localhost:${port}`)
}

function broadcast(event: BotEvent): void {
  if (clients.size === 0) return
  broadcastRaw(JSON.stringify(event))
}

function broadcastRaw(msg: string): void {
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg)
    }
  }
}

function send(client: WebSocket, event: BotEvent): void {
  if (client.readyState === WebSocket.OPEN) {
    client.send(JSON.stringify(event))
  }
}

function handleCommand(msg: { command: string; params?: Record<string, unknown> }): void {
  logger.debug(`WS command: ${msg.command}`, msg.params)
  // Commands handled in app.ts via bus or direct function calls
  bus.emit({ type: 'log', data: {
    id: Date.now().toString(),
    level: 'DEBUG',
    message: `UI command: ${msg.command}`,
    timestamp: Date.now(),
  }})
}
