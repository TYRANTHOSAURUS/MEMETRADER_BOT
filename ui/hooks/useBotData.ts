'use client'

import { useReducer, useCallback } from 'react'
import { useWebSocket } from './useWebSocket'
import type {
  SystemStatus, PortfolioState, Position, Fill,
  Signal, StrategyMetrics, LogEntry, BotMessage, SwapEvent
} from '../lib/types'

export interface BotState {
  status:     SystemStatus | null
  portfolio:  PortfolioState | null
  signals:    Signal[]
  fills:      Fill[]
  logs:       LogEntry[]
  metrics:    StrategyMetrics[]
  swapFeed:   SwapEvent[]
  swapCount:  number
}

const MAX_SIGNALS  = 100
const MAX_LOGS     = 500
const MAX_FILLS    = 200
const MAX_SWAPS    = 30

type Action =
  | { type: 'status';          data: SystemStatus }
  | { type: 'portfolio';       data: PortfolioState }
  | { type: 'signal';          data: Signal }
  | { type: 'fill';            data: Fill }
  | { type: 'log';             data: LogEntry }
  | { type: 'metrics';         data: StrategyMetrics[] }
  | { type: 'position_update'; data: Position }
  | { type: 'swap_feed';       data: SwapEvent[] }
  | { type: 'swap_new';        data: SwapEvent }

function reducer(state: BotState, action: Action): BotState {
  switch (action.type) {
    case 'status':
      return { ...state, status: action.data }
    case 'portfolio':
      return { ...state, portfolio: action.data }
    case 'signal':
      return { ...state, signals: [action.data, ...state.signals].slice(0, MAX_SIGNALS) }
    case 'fill':
      return { ...state, fills: [action.data, ...state.fills].slice(0, MAX_FILLS) }
    case 'log':
      return { ...state, logs: [action.data, ...state.logs].slice(0, MAX_LOGS) }
    case 'metrics':
      return { ...state, metrics: action.data }
    case 'position_update': {
      if (!state.portfolio) return state
      const positions = state.portfolio.openPositions.map(p =>
        p.tokenMint === action.data.tokenMint ? action.data : p
      )
      return { ...state, portfolio: { ...state.portfolio, openPositions: positions } }
    }
    case 'swap_feed':
      return {
        ...state,
        swapFeed:  [...action.data, ...state.swapFeed].slice(0, MAX_SWAPS),
        swapCount: state.swapCount + action.data.length,
      }
    case 'swap_new':
      return {
        ...state,
        swapFeed:  [action.data, ...state.swapFeed].slice(0, MAX_SWAPS),
        swapCount: state.swapCount + 1,
      }
    default:
      return state
  }
}

const INITIAL: BotState = {
  status: null, portfolio: null, signals: [], fills: [], logs: [], metrics: [],
  swapFeed: [], swapCount: 0,
}

export function useBotData() {
  const [state, dispatch] = useReducer(reducer, INITIAL)

  const onMessage = useCallback((msg: BotMessage) => {
    switch (msg.type) {
      case 'system:status':
        dispatch({ type: 'status',          data: msg.data as SystemStatus })
        break
      case 'portfolio:updated':
        dispatch({ type: 'portfolio',        data: msg.data as PortfolioState })
        break
      case 'signal:emitted':
        dispatch({ type: 'signal',           data: msg.data as Signal })
        break
      case 'fill:confirmed':
        dispatch({ type: 'fill',             data: msg.data as Fill })
        break
      case 'log':
        dispatch({ type: 'log',              data: msg.data as LogEntry })
        break
      case 'position:updated':
        dispatch({ type: 'position_update',  data: msg.data as Position })
        break
      case 'swap:feed':
        dispatch({ type: 'swap_feed',        data: msg.data as SwapEvent[] })
        break
      case 'swap:new':
        dispatch({ type: 'swap_new',         data: msg.data as SwapEvent })
        break
    }
  }, [])

  const { connected, reconnecting, send } = useWebSocket(onMessage)

  return { ...state, connected, reconnecting, send }
}
