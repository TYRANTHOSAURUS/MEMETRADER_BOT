'use client'

import { useState, useEffect } from 'react'
import { useBotData } from '../../hooks/useBotData'
import PanelBox from '../../components/PanelBox'
import type { Fill } from '../../lib/types'
import {
  AreaChart, Area, XAxis, YAxis, Tooltip,
  ResponsiveContainer, ReferenceLine, BarChart, Bar, Cell,
} from 'recharts'

const HTTP_URL = 'http://localhost:3001'

// Compute cumulative P&L from sell fills
function buildPnlSeries(fills: Fill[]) {
  const sells = fills.filter(f => f.side === 'SELL').sort((a, b) => a.timestamp - b.timestamp)
  let cum = 0
  return sells.map(f => {
    // Rough P&L estimate: we don't have buy price here, so use solAmount as proxy
    cum += f.solAmount * 0.02  // placeholder — real P&L needs buy/sell pairing
    return {
      t:   new Date(f.timestamp).toISOString().slice(11, 16),
      pnl: cum,
    }
  })
}

function buildDailyPnl(fills: Fill[]) {
  const buckets = new Map<string, number>()
  for (const f of fills) {
    if (f.side !== 'SELL') continue
    const day = new Date(f.timestamp).toISOString().slice(0, 10)
    buckets.set(day, (buckets.get(day) ?? 0) + f.solAmount * 0.02)
  }
  return Array.from(buckets.entries())
    .map(([d, v]) => ({ day: d.slice(5), pnl: v }))
    .sort((a, b) => a.day.localeCompare(b.day))
    .slice(-30)
}

export default function Portfolio() {
  const { portfolio, fills: wsFills } = useBotData()
  const [allFills, setAllFills] = useState<Fill[]>([])

  useEffect(() => {
    fetch(`${HTTP_URL}/api/fills`)
      .then(r => r.json())
      .then((d: Fill[]) => setAllFills(d))
      .catch(() => {})
  }, [])

  const fills = [...wsFills, ...allFills.filter(h => !wsFills.find(w => w.id === h.id))]
    .sort((a, b) => a.timestamp - b.timestamp)

  const pnl     = portfolio?.dayPnlSol ?? 0
  const total   = portfolio?.totalPnlSol ?? 0
  const balance = portfolio?.totalBalanceSol ?? 0

  const pnlSeries  = buildPnlSeries(fills)
  const dailySeries = buildDailyPnl(fills)

  const buys  = fills.filter(f => f.side === 'BUY').length
  const sells = fills.filter(f => f.side === 'SELL').length
  const totalFees = fills.reduce((s, f) => s + f.fee, 0)

  return (
    <div className="space-y-3">
      {/* Summary */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: 'BALANCE',   value: `${balance.toFixed(4)} SOL`,                        color: 'text-g' },
          { label: 'DAY P&L',   value: `${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} SOL`,      color: pnl >= 0 ? 'text-g' : 'text-r' },
          { label: 'TOTAL P&L', value: `${total >= 0 ? '+' : ''}${total.toFixed(4)} SOL`,   color: total >= 0 ? 'text-g' : 'text-r' },
          { label: 'FEES PAID', value: `${totalFees.toFixed(6)} SOL`,                        color: 'text-o' },
        ].map(s => (
          <div key={s.label} className="panel p-3">
            <div className="text-gdim text-[10px] tracking-widest uppercase mb-1">{s.label}</div>
            <div className={`text-xl font-bold ${s.color}`}>{s.value}</div>
          </div>
        ))}
      </div>

      {/* Charts row */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
        {/* Cumulative P&L */}
        <PanelBox title="CUMULATIVE P&L (SELL TRADES)">
          {pnlSeries.length > 1 ? (
            <div className="p-3 h-[160px]">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={pnlSeries} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                  <defs>
                    <linearGradient id="pnlG" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%"  stopColor="#00ff41" stopOpacity={0.2} />
                      <stop offset="95%" stopColor="#00ff41" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="t" tick={{ fill: '#00b32c', fontSize: 9 }} axisLine={false} tickLine={false} interval="preserveEnd" />
                  <YAxis tick={{ fill: '#00b32c', fontSize: 9 }} axisLine={false} tickLine={false} width={45} />
                  <Tooltip
                    contentStyle={{ background: '#050505', border: '1px solid #00ff4130', fontSize: 11, color: '#00ff41' }}
                    formatter={(v: number) => [`${v.toFixed(4)} SOL`]}
                  />
                  <ReferenceLine y={0} stroke="#00ff4120" strokeDasharray="3 3" />
                  <Area type="monotone" dataKey="pnl" stroke="#00ff41" strokeWidth={1.5} fill="url(#pnlG)" dot={false} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="px-3 py-8 text-gdim text-[11px]">no closed trades yet</div>
          )}
        </PanelBox>

        {/* Daily P&L bars */}
        <PanelBox title="DAILY P&L">
          {dailySeries.length > 0 ? (
            <div className="p-3 h-[160px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={dailySeries} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                  <XAxis dataKey="day" tick={{ fill: '#00b32c', fontSize: 9 }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fill: '#00b32c', fontSize: 9 }} axisLine={false} tickLine={false} width={45} />
                  <Tooltip
                    contentStyle={{ background: '#050505', border: '1px solid #00ff4130', fontSize: 11, color: '#00ff41' }}
                    formatter={(v: number) => [`${v >= 0 ? '+' : ''}${v.toFixed(4)} SOL`]}
                  />
                  <ReferenceLine y={0} stroke="#00ff4120" />
                  <Bar dataKey="pnl" radius={[2, 2, 0, 0]}>
                    {dailySeries.map((entry, i) => (
                      <Cell key={i} fill={entry.pnl >= 0 ? '#00ff41' : '#ff3333'} fillOpacity={0.8} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="px-3 py-8 text-gdim text-[11px]">no daily data yet</div>
          )}
        </PanelBox>
      </div>

      {/* Trade stats strip */}
      <div className="panel p-3 grid grid-cols-3 md:grid-cols-6 gap-4 text-[11px]">
        <div>
          <div className="text-gdim text-[10px]">TOTAL FILLS</div>
          <div className="text-g font-bold">{fills.length}</div>
        </div>
        <div>
          <div className="text-gdim text-[10px]">BUYS</div>
          <div className="text-g font-bold">{buys}</div>
        </div>
        <div>
          <div className="text-gdim text-[10px]">SELLS</div>
          <div className="text-g font-bold">{sells}</div>
        </div>
        <div>
          <div className="text-gdim text-[10px]">OPEN POS</div>
          <div className="text-g font-bold">{portfolio?.openPositionCount ?? 0}</div>
        </div>
        <div>
          <div className="text-gdim text-[10px]">DAILY LIMIT</div>
          <div className="text-o font-bold">{portfolio?.dailyLossLimitSol ?? 2} SOL</div>
        </div>
        <div>
          <div className="text-gdim text-[10px]">TOTAL FEES</div>
          <div className="text-r font-bold">{totalFees.toFixed(6)}</div>
        </div>
      </div>

      {/* Open Positions */}
      <PanelBox title={`OPEN POSITIONS (${portfolio?.openPositionCount ?? 0})`}>
        <div className="overflow-auto">
          <div className="px-3 py-1.5 flex gap-4 text-[10px] text-gdim border-b border-[#00ff4108]">
            <span className="w-24">TOKEN</span>
            <span className="w-24">STRATEGY</span>
            <span className="w-28">ENTRY SOL</span>
            <span className="w-20">SIZE</span>
            <span className="w-24">CURRENT</span>
            <span className="ml-auto">P&L</span>
          </div>
          {portfolio?.openPositions.map(p => {
            const pnl = p.unrealizedPnlSol
            const ageMs = Date.now() - p.entryTime
            const age = ageMs < 60000 ? `${Math.floor(ageMs / 1000)}s` : `${Math.floor(ageMs / 60000)}m`
            return (
              <div key={p.id} className="t-row px-3 py-2 flex gap-4 items-center text-[11px]">
                <span className="text-g w-24 truncate font-bold">{p.tokenName || p.tokenMint.slice(0, 8)}</span>
                <span className="text-gdim w-24 truncate text-[10px]">{p.strategyId}</span>
                <span className="text-gdim w-28 font-mono">{p.entryPriceInSol.toFixed(10)}</span>
                <span className="text-gdim w-20">{p.solAmount.toFixed(4)} SOL</span>
                <span className="text-c w-24 font-mono">{p.currentPrice.toFixed(10)}</span>
                <span className="text-gdim text-[10px] w-8">{age}</span>
                <span className={`ml-auto font-bold ${pnl >= 0 ? 'text-g' : 'text-r'}`}>
                  {pnl >= 0 ? '+' : ''}{pnl.toFixed(4)} SOL
                  <span className="text-[10px] ml-1 font-normal">({(p.unrealizedPnlPct * 100).toFixed(1)}%)</span>
                </span>
              </div>
            )
          })}
          {!portfolio?.openPositions.length && (
            <div className="px-3 py-6 text-gdim text-[11px]">no open positions</div>
          )}
        </div>
      </PanelBox>

      {/* Trade History */}
      <PanelBox title={`TRADE HISTORY (${fills.length})`}>
        <div className="overflow-auto max-h-96">
          <div className="px-3 py-1.5 flex gap-3 text-[10px] text-gdim border-b border-[#00ff4108]">
            <span className="w-20">TIME</span>
            <span className="w-14">SIDE</span>
            <span className="w-24">TOKEN</span>
            <span className="w-24">STRATEGY</span>
            <span className="w-28">PRICE SOL</span>
            <span className="w-20">SIZE SOL</span>
            <span className="w-16">FEE</span>
            <span className="ml-auto">MODE</span>
          </div>
          {fills.slice().reverse().map(f => {
            const time = new Date(f.timestamp).toISOString().slice(11, 19)
            return (
              <div key={f.id} className="t-row px-3 py-1.5 flex gap-3 items-center text-[11px]">
                <span className="text-gdim w-20">{time}</span>
                <span className={f.side === 'BUY' ? 'badge-buy w-14' : 'badge-sell w-14'}>{f.side}</span>
                <span className="text-g w-24 truncate">{f.tokenName || f.tokenMint.slice(0, 8)}</span>
                <span className="text-gdim w-24 truncate text-[10px]">{f.strategyId}</span>
                <span className="text-gdim w-28 font-mono">{f.priceInSol?.toFixed(10) ?? '—'}</span>
                <span className="text-gdim w-20">{f.solAmount.toFixed(4)}</span>
                <span className="text-r w-16">{f.fee.toFixed(6)}</span>
                <span className={`ml-auto text-[10px] ${f.paper ? 'text-[#777]' : 'text-o font-bold'}`}>
                  {f.paper ? 'PAPER' : 'LIVE'}
                </span>
              </div>
            )
          })}
          {fills.length === 0 && (
            <div className="px-3 py-6 text-gdim text-[11px]">no trades yet</div>
          )}
        </div>
      </PanelBox>

      {/* Kill switch warning */}
      {portfolio?.killed && (
        <div className="panel border border-r p-4 text-r font-bold text-center text-sm animate-blink">
          ⚠ KILL SWITCH ACTIVE — ALL TRADING HALTED — DAILY LOSS LIMIT REACHED
        </div>
      )}
    </div>
  )
}
