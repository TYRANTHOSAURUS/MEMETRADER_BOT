'use client'

import { useState, useEffect } from 'react'
import PanelBox from '../../components/PanelBox'

interface RecentSignal {
  id:          string
  strategyId:  string
  tokenMint:   string
  tokenName:   string
  side:        string
  confidence:  number
  reason:      string
  timestamp:   number
  resolved:    boolean | null
  accuracy30s: boolean | null
  maxGain:     number | null
  maxLoss:     number | null
}

const HTTP_URL = 'http://localhost:3001'

const STRATEGIES = [
  'all',
  'ema_pullback',
  'breakout_retest',
  'migration_momentum',
  'holder_velocity',
  'social_divergence',
  'dev_wallet_signal',
]

function accBadge(val: boolean | null) {
  if (val === null) return <span className="text-[#666]">—</span>
  return val
    ? <span className="text-g text-[10px]">✓</span>
    : <span className="text-r text-[10px]">✗</span>
}

function gainColor(val: number | null) {
  if (val === null) return 'text-[#666]'
  return val >= 0 ? 'text-g' : 'text-r'
}

export default function Signals() {
  const [signals, setSignals]     = useState<RecentSignal[]>([])
  const [strategy, setStrategy]   = useState('all')
  const [side, setSide]           = useState<'ALL' | 'BUY' | 'SELL'>('ALL')
  const [loading, setLoading]     = useState(true)

  const load = async () => {
    try {
      const params = new URLSearchParams({ limit: '200' })
      if (strategy !== 'all') params.set('strategy', strategy)
      const res  = await fetch(`${HTTP_URL}/api/analytics/recent-signals?${params}`)
      const data = await res.json() as RecentSignal[]
      setSignals(data)
    } catch {
      // bot offline
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    setLoading(true)
    load()
    const interval = setInterval(load, 5_000)
    return () => clearInterval(interval)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strategy])

  const filtered = side === 'ALL' ? signals : signals.filter(s => s.side === side)
  const resolved = filtered.filter(s => s.resolved)

  return (
    <div className="space-y-3">
      {/* Filter bar */}
      <div className="panel p-2 flex flex-wrap items-center gap-3 text-[11px]">
        <div className="flex items-center gap-2">
          <span className="text-gdim">STRATEGY</span>
          <select
            value={strategy}
            onChange={e => setStrategy(e.target.value)}
            className="bg-[#0a0a0a] border border-[#00ff4120] text-g text-[11px] px-2 py-0.5 outline-none"
          >
            {STRATEGIES.map(s => (
              <option key={s} value={s}>{s === 'all' ? 'ALL' : s.replace(/_/g, ' ').toUpperCase()}</option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-1">
          {(['ALL', 'BUY', 'SELL'] as const).map(s => (
            <button
              key={s}
              onClick={() => setSide(s)}
              className={`px-3 py-0.5 text-[10px] border transition-colors ${
                side === s
                  ? s === 'BUY' ? 'border-g text-g bg-[#00ff4110]'
                    : s === 'SELL' ? 'border-r text-r bg-[#ff333310]'
                    : 'border-gdim text-gdim bg-[#00ff4106]'
                  : 'border-[#444] text-[#888] hover:border-[#666]'
              }`}
            >
              {s}
            </button>
          ))}
        </div>

        <span className="ml-auto text-gdim text-[10px]">
          {filtered.length} signals • {resolved.length} resolved
        </span>
      </div>

      <PanelBox title={`SIGNALS (${filtered.length})`}>
        <div className="overflow-auto max-h-[calc(100vh-160px)]">
          {/* Header */}
          <div className="px-3 py-1.5 grid grid-cols-[80px_150px_100px_50px_55px_50px_65px_65px_1fr] gap-2 text-[10px] text-gdim border-b border-[#00ff4108] sticky top-0 bg-panel">
            <span>TIME</span>
            <span>STRATEGY</span>
            <span>TOKEN</span>
            <span>SIDE</span>
            <span>CONF</span>
            <span>ACC@30s</span>
            <span>MAX GAIN</span>
            <span>MAX LOSS</span>
            <span>REASON</span>
          </div>

          {loading && (
            <div className="px-3 py-6 text-gdim text-[11px]">loading<span className="cursor" /></div>
          )}

          {filtered.map(s => {
            const time = new Date(s.timestamp).toISOString().slice(11, 19)
            return (
              <div
                key={s.id}
                className="t-row px-3 py-1.5 grid grid-cols-[80px_150px_100px_50px_55px_50px_65px_65px_1fr] gap-2 items-center text-[11px]"
              >
                <span className="text-gdim text-[10px]">{time}</span>
                <span className="text-gdim truncate text-[10px]">
                  {s.strategyId.replace(/_/g, ' ').toUpperCase()}
                </span>
                <span className="text-c truncate">{s.tokenName || s.tokenMint.slice(0, 8)}</span>
                <span>
                  <span className={s.side === 'BUY' ? 'badge-buy' : 'badge-sell'}>{s.side}</span>
                </span>
                <span className="text-gdim">{(s.confidence * 100).toFixed(0)}%</span>
                <span>
                  {s.resolved === null
                    ? <span className="text-[#666] text-[10px]">…</span>
                    : accBadge(s.accuracy30s)
                  }
                </span>
                <span className={`${gainColor(s.maxGain)} text-[10px]`}>
                  {s.maxGain !== null ? `+${s.maxGain.toFixed(1)}%` : '—'}
                </span>
                <span className={`${gainColor(s.maxLoss)} text-[10px]`}>
                  {s.maxLoss !== null ? `${s.maxLoss.toFixed(1)}%` : '—'}
                </span>
                <span className="text-gdim text-[10px] truncate">{s.reason}</span>
              </div>
            )
          })}

          {!loading && filtered.length === 0 && (
            <div className="px-3 py-6 text-gdim text-[11px]">
              no signals yet — start the bot and wait for the first trade cycle
            </div>
          )}
        </div>
      </PanelBox>
    </div>
  )
}
