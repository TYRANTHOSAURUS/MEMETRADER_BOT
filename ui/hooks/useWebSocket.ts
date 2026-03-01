'use client'

import { useEffect, useRef, useCallback, useState } from 'react'
import type { BotMessage } from '../lib/types'

const WS_URL = 'ws://localhost:8080'
const RECONNECT_DELAY = 3000

export function useWebSocket(onMessage: (msg: BotMessage) => void) {
  const ws = useRef<WebSocket | null>(null)
  const [connected, setConnected] = useState(false)
  const [reconnecting, setReconnecting] = useState(false)
  const onMessageRef = useRef(onMessage)
  onMessageRef.current = onMessage

  const connect = useCallback(() => {
    if (ws.current?.readyState === WebSocket.OPEN) return

    try {
      const socket = new WebSocket(WS_URL)

      socket.onopen = () => {
        setConnected(true)
        setReconnecting(false)
      }

      socket.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data) as BotMessage
          onMessageRef.current(msg)
        } catch {
          // ignore
        }
      }

      socket.onclose = () => {
        setConnected(false)
        setReconnecting(true)
        setTimeout(connect, RECONNECT_DELAY)
      }

      socket.onerror = () => {
        socket.close()
      }

      ws.current = socket
    } catch {
      setReconnecting(true)
      setTimeout(connect, RECONNECT_DELAY)
    }
  }, [])

  useEffect(() => {
    connect()
    return () => {
      ws.current?.close()
    }
  }, [connect])

  const send = useCallback((command: string, params?: Record<string, unknown>) => {
    if (ws.current?.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify({ command, params }))
    }
  }, [])

  return { connected, reconnecting, send }
}
