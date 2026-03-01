'use client'

import { useState, useEffect } from 'react'
import PanelBox from '../../components/PanelBox'
import type { StrategyMetrics } from '../../lib/types'

const HTTP_URL = 'http://localhost:3001'

function pct(n: number) { return `${(n * 100).toFixed(1)}%` }
function sol(n: number) { return `${n >= 0 ? '+' : ''}${n.toFixed(4)}` }
function dur(ms: number) {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`
  return `${Math.floor(ms / 60_000)}m`
}

interface StrategyCardProps {
  m: StrategyMetrics
  onToggle: (id: string, enable: boolean) => void
}

function StrategyCard({ m, onToggle }: StrategyCardProps) {
  const isActive = !m.autoDisabled
  const winRate = m.totalTrades > 0 ? m.winRate : 0

  return (
    <div className={`panel p-4 space-y-3 ${m.autoDisabled ? 'opacity-50' : ''}`}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="text-g font-bold tracking-wide">{m.strategyId.replace(/_/g, ' ').toUpperCase()}</div>
          <div className="text-gdim text-[10px] mt-0.5">
            {m.totalTrades} trades • avg hold {dur(m.avgHoldDurationMs)}
          </div>
        </div>
        <button
          onClick={() => onToggle(m.strategyId, m.autoDisabled)}
          className={`text-[10px] px-3 py-1 border transition-colors ${
            isActive
              ? 'border-g text-g hover:bg-[#00ff4110]'
              : 'border-r text-r hover:bg-[#ff333310]'
          }`}
        >
          {isActive ? 'ACTIVE' : 'DISABLED'}
        </button>
      </div>

      {/* Metrics grid */}
      <div className="grid grid-cols-3 gap-2 text-[11px]">
        <div>
          <div className="text-gdim text-[10px]">P&L TOTAL</div>
          <div className={m.totalPnlSol >= 0 ? 'text-g' : 'text-r'}>{sol(m.totalPnlSol)} SOL</div>
        </div>
        <div>
          <div className="text-gdim text-[10px]">WIN RATE</div>
          <div className={winRate > 0.5 ? 'text-g' : winRate > 0.3 ? 'text-o' : 'text-r'}>
            {pct(winRate)}
          </div>
        </div>
        <div>
          <div className="text-gdim text-[10px]">AVG TRADE</div>
          <div className={m.avgPnlPerTrade >= 0 ? 'text-g' : 'text-r'}>{sol(m.avgPnlPerTrade)} SOL</div>
        </div>
        <div>
          <div className="text-gdim text-[10px]">BEST</div>
          <div className="text-g">{sol(m.bestTradeSol)} SOL</div>
        </div>
        <div>
          <div className="text-gdim text-[10px]">WORST</div>
          <div className="text-r">{sol(m.worstTradeSol)} SOL</div>
        </div>
        <div>
          <div className="text-gdim text-[10px]">DRAWDOWN</div>
          <div className={m.maxDrawdownSol < -0.1 ? 'text-r' : 'text-o'}>{sol(m.maxDrawdownSol)} SOL</div>
        </div>
      </div>

      {/* Win rate bar */}
      <div className="h-1 bg-[#111] rounded-sm overflow-hidden">
        <div
          className={`h-full transition-all ${winRate > 0.5 ? 'bg-g' : winRate > 0.3 ? 'bg-o' : 'bg-r'}`}
          style={{ width: `${winRate * 100}%` }}
        />
      </div>

      {m.autoDisabled && (
        <div className="text-r text-[10px]">⚠ AUTO-DISABLED: drawdown limit exceeded</div>
      )}
    </div>
  )
}

export default function Strategies() {
  const [metrics, setMetrics] = useState<StrategyMetrics[]>([])
  const [loading, setLoading] = useState(true)

  const load = async () => {
    try {
      const res = await fetch(`${HTTP_URL}/api/strategies`)
      const data = await res.json() as StrategyMetrics[]
      setMetrics(data)
    } catch {
      // bot not connected yet
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    const interval = setInterval(load, 10_000)
    return () => clearInterval(interval)
  }, [])

  const handleToggle = async (id: string, enable: boolean) => {
    try {
      await fetch(`${HTTP_URL}/api/strategies/${id}/${enable ? 'enable' : 'disable'}`, { method: 'POST' })
      load()
    } catch {
      // ignore
    }
  }

  return (
    <div className="space-y-3">
      <div className="panel p-3 text-[11px] text-gdim">
        <span className="text-g">{metrics.filter(m => !m.autoDisabled).length}</span> active •{' '}
        <span className="text-r">{metrics.filter(m => m.autoDisabled).length}</span> disabled •{' '}
        strategies auto-disable if 7d drawdown exceeds 30%
      </div>

      {loading && (
        <div className="text-gdim text-[11px] p-4">loading strategies<span className="cursor" /></div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        {metrics.map(m => (
          <StrategyCard key={m.strategyId} m={m} onToggle={handleToggle} />
        ))}
      </div>

      {!loading && metrics.length === 0 && (
        <div className="text-gdim text-[11px] p-4">
          no strategy data yet — start the bot and let it run
        </div>
      )}
    </div>
  )
}
