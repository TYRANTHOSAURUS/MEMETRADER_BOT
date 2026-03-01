'use client'

import { useState, useEffect } from 'react'
import PanelBox from '../../components/PanelBox'

interface TokenEntry {
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
  mintRevoked?:   boolean
  freezeRevoked?: boolean
  lpBurned?:      boolean
}

const HTTP_URL = 'http://localhost:3001'

type SortKey = 'lastSeen' | 'swapCount' | 'liquidity' | 'marketCap'

function fmtUsd(n: number | undefined): string {
  if (!n || n === 0) return '—'
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(1)}K`
  return `$${n.toFixed(0)}`
}

function fmtPrice(n: number | undefined): string {
  if (!n || n === 0) return '—'
  if (n < 0.000001) return n.toExponential(3)
  return n.toFixed(8)
}

export default function Watchlist() {
  const [tokens, setTokens]   = useState<TokenEntry[]>([])
  const [filter, setFilter]   = useState('')
  const [sort, setSort]       = useState<SortKey>('lastSeen')
  const [stage, setStage]     = useState<string>('ALL')
  const [loading, setLoading] = useState(true)

  const load = async () => {
    try {
      const res  = await fetch(`${HTTP_URL}/api/tokens`)
      const data = await res.json() as TokenEntry[]
      setTokens(data)
    } catch {
      // bot offline
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    const interval = setInterval(load, 3_000)
    return () => clearInterval(interval)
  }, [])

  const filtered = tokens
    .filter(t => {
      if (stage !== 'ALL' && t.lifecycleStage !== stage) return false
      if (!filter) return true
      const q = filter.toLowerCase()
      return t.name.toLowerCase().includes(q) || t.symbol.toLowerCase().includes(q) || t.mint.includes(q)
    })
    .sort((a, b) => {
      if (sort === 'lastSeen')   return b.lastSeen - a.lastSeen
      if (sort === 'swapCount')  return b.swapCount - a.swapCount
      if (sort === 'liquidity')  return (b.liquidity ?? 0) - (a.liquidity ?? 0)
      if (sort === 'marketCap')  return (b.marketCap ?? 0) - (a.marketCap ?? 0)
      return 0
    })

  const stageColor = (s: string) => {
    if (s === 'AMM')           return 'text-g'
    if (s === 'MIGRATING')     return 'text-o'
    if (s === 'BONDING_CURVE') return 'text-c'
    return 'text-gdim'
  }

  const safetyDots = (t: TokenEntry) => (
    <div className="flex gap-0.5">
      <span className={`dot w-1.5 h-1.5 ${t.mintRevoked ? 'dot-green' : 'dot-red'}`} title="Mint revoked" />
      <span className={`dot w-1.5 h-1.5 ${t.freezeRevoked ? 'dot-green' : 'dot-red'}`} title="Freeze revoked" />
      <span className={`dot w-1.5 h-1.5 ${t.lpBurned ? 'dot-green' : 'dot-orange'}`} title="LP burned" />
    </div>
  )

  const STAGES = ['ALL', 'BONDING_CURVE', 'MIGRATING', 'AMM']

  return (
    <div className="space-y-3">
      {/* Filter + sort bar */}
      <div className="panel p-2 flex flex-wrap items-center gap-3 text-[11px]">
        {/* Search */}
        <div className="flex items-center gap-1.5 flex-1 min-w-32">
          <span className="text-gdim">{'>'}</span>
          <input
            type="text"
            value={filter}
            onChange={e => setFilter(e.target.value)}
            placeholder="filter name / symbol / mint_"
            className="flex-1 bg-transparent text-g text-[11px] outline-none placeholder:text-gdark"
          />
        </div>

        {/* Stage filter */}
        <div className="flex gap-1">
          {STAGES.map(s => (
            <button
              key={s}
              onClick={() => setStage(s)}
              className={`px-2 py-0.5 text-[10px] border transition-colors ${
                stage === s
                  ? 'border-g text-g bg-[#00ff4110]'
                  : 'border-[#00ff4120] text-gdim hover:text-g'
              }`}
            >
              {s === 'ALL' ? 'ALL' : s.replace('_', ' ')}
            </button>
          ))}
        </div>

        {/* Sort */}
        <div className="flex items-center gap-1.5">
          <span className="text-gdim">SORT</span>
          <select
            value={sort}
            onChange={e => setSort(e.target.value as SortKey)}
            className="bg-[#0a0a0a] border border-[#00ff4120] text-g text-[10px] px-2 py-0.5 outline-none"
          >
            <option value="lastSeen">RECENT</option>
            <option value="swapCount">SWAPS</option>
            <option value="liquidity">LIQUIDITY</option>
            <option value="marketCap">MCAP</option>
          </select>
        </div>

        <span className="text-gdim text-[10px]">{filtered.length} / {tokens.length}</span>
      </div>

      <PanelBox title={`TOKEN WATCHLIST (${tokens.length})`}>
        <div className="overflow-auto max-h-[calc(100vh-180px)]">
          {/* Header */}
          <div className="px-3 py-1.5 grid grid-cols-[140px_60px_100px_70px_70px_80px_80px_50px_1fr] gap-2 text-[10px] text-gdim border-b border-[#00ff4108] sticky top-0 bg-panel">
            <span>TOKEN</span>
            <span>SYM</span>
            <span>STAGE</span>
            <span>PRICE SOL</span>
            <span>LIQUIDITY</span>
            <span>MCAP</span>
            <span>SWAPS</span>
            <span>SAFE</span>
            <span>LAST SEEN</span>
          </div>

          {loading && (
            <div className="px-3 py-6 text-gdim text-[11px]">loading<span className="cursor" /></div>
          )}

          {filtered.map(t => {
            const ago = Math.floor((Date.now() - t.lastSeen) / 1000)
            const agoStr = ago < 60 ? `${ago}s` : ago < 3600 ? `${Math.floor(ago / 60)}m` : `${Math.floor(ago / 3600)}h`
            return (
              <div
                key={t.mint}
                className="t-row px-3 py-1.5 grid grid-cols-[140px_60px_100px_70px_70px_80px_80px_50px_1fr] gap-2 items-center text-[11px]"
              >
                <span className="text-g font-bold truncate">{t.name}</span>
                <span className="text-gdim text-[10px]">{t.symbol}</span>
                <span className={`text-[10px] ${stageColor(t.lifecycleStage)}`}>
                  {t.lifecycleStage?.replace('_', ' ')}
                </span>
                <span className="text-c font-mono text-[10px]">{fmtPrice(t.priceInSol)}</span>
                <span className="text-gdim text-[10px]">{fmtUsd(t.liquidity)}</span>
                <span className="text-gdim text-[10px]">{fmtUsd(t.marketCap)}</span>
                <span className="text-gdim">{t.swapCount.toLocaleString()}</span>
                <div>{safetyDots(t)}</div>
                <div className="flex items-center gap-2">
                  <span className="text-[#333] text-[10px]">{agoStr}</span>
                  <span className="text-[#222] text-[10px] truncate">{t.mint.slice(0, 16)}…</span>
                </div>
              </div>
            )
          })}

          {!loading && filtered.length === 0 && (
            <div className="px-3 py-6 text-gdim text-[11px]">
              {tokens.length === 0 ? 'no tokens tracked yet — start the bot' : 'no matches'}
            </div>
          )}
        </div>
      </PanelBox>
    </div>
  )
}
