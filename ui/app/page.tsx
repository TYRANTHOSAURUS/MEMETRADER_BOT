'use client'

import { useState, useEffect, useRef } from 'react'
import { useBotData } from '../hooks/useBotData'
import PanelBox from '../components/PanelBox'
import type { Signal, Fill, SwapEvent } from '../lib/types'
import { fmtTime } from '../lib/fmt'
import {
  AreaChart, Area, XAxis, YAxis, Tooltip,
  ResponsiveContainer, ReferenceLine,
} from 'recharts'

const HTTP_URL = 'http://localhost:3001'

// ─── Mini stat card ───────────────────────────────────────────
function Stat({
  label, value, sub, color = 'text-g', flash,
}: {
  label: string; value: string; sub?: string; color?: string; flash?: boolean
}) {
  return (
    <div className="panel p-3 flex flex-col gap-1">
      <div className="text-gdim text-[10px] tracking-widest uppercase">{label}</div>
      <div className={`text-lg font-bold ${color} ${flash ? 'flash' : ''}`}>{value}</div>
      {sub && <div className="text-gdim text-[10px]">{sub}</div>}
    </div>
  )
}

// ─── Signal row ───────────────────────────────────────────────
function SignalRow({ sig }: { sig: Signal }) {
  const time = fmtTime(sig.timestamp)
  const conf = sig.confidence * 100
  return (
    <div className="t-row px-3 py-1.5 flex items-center gap-2 text-[11px]">
      <span className="text-gdim w-16 shrink-0">{time}</span>
      <span className={sig.side === 'BUY' ? 'badge-buy shrink-0' : 'badge-sell shrink-0'}>{sig.side}</span>
      <span className="text-gdim w-20 shrink-0 text-[10px] truncate">
        {sig.strategyId.replace(/_/g, ' ').slice(0, 12).toUpperCase()}
      </span>
      <span className="text-c flex-1 truncate font-mono text-[10px]">
        {sig.tokenMint.slice(0, 8)}…
      </span>
      {/* Confidence bar */}
      <div className="flex items-center gap-1 shrink-0">
        <div className="w-16 h-1.5 bg-[#111] rounded-sm overflow-hidden">
          <div
            className={`h-full rounded-sm ${conf >= 70 ? 'bg-g' : conf >= 55 ? 'bg-o' : 'bg-r'}`}
            style={{ width: `${conf}%` }}
          />
        </div>
        <span className={`text-[10px] w-8 ${conf >= 70 ? 'text-g' : conf >= 55 ? 'text-o' : 'text-r'}`}>
          {conf.toFixed(0)}%
        </span>
      </div>
    </div>
  )
}

// ─── Fill row ─────────────────────────────────────────────────
function FillRow({ fill }: { fill: Fill }) {
  const time = fmtTime(fill.timestamp)
  return (
    <div className="t-row px-3 py-1.5 flex items-center gap-2 text-[11px]">
      <span className="text-gdim w-16 shrink-0">{time}</span>
      <span className={fill.side === 'BUY' ? 'badge-buy shrink-0' : 'badge-sell shrink-0'}>{fill.side}</span>
      <span className="text-g flex-1 truncate">{fill.tokenName || fill.tokenMint.slice(0, 8)}</span>
      <span className="text-gdim shrink-0">{fill.solAmount.toFixed(4)} SOL</span>
      <span className={`text-[10px] shrink-0 ${fill.paper ? 'text-[#777]' : 'text-o'}`}>
        {fill.paper ? 'PAPER' : 'LIVE'}
      </span>
    </div>
  )
}

// ─── Position row ─────────────────────────────────────────────
function PositionRow({ pos }: { pos: {
  id: string; tokenName: string; tokenMint: string; strategyId: string
  entryPriceInSol: number; solAmount: number; entryTime: number
  unrealizedPnlSol: number; unrealizedPnlPct: number
}}) {
  const pnl = pos.unrealizedPnlSol
  const ageMs = Date.now() - pos.entryTime
  const ageStr = ageMs < 60000 ? `${Math.floor(ageMs / 1000)}s` : `${Math.floor(ageMs / 60000)}m`
  return (
    <div className="t-row px-3 py-2 flex items-center gap-3 text-[11px]">
      <span className="text-g w-20 truncate font-bold">{pos.tokenName || pos.tokenMint.slice(0,8)}</span>
      <span className="text-gdim text-[10px] w-20 truncate">{pos.strategyId}</span>
      <span className="text-gdim w-20">{pos.solAmount.toFixed(4)} SOL</span>
      <span className="text-gdim w-12 text-[10px]">{ageStr}</span>
      <span className={`ml-auto font-bold ${pnl >= 0 ? 'text-g' : 'text-r'}`}>
        {pnl >= 0 ? '+' : ''}{pnl.toFixed(4)} SOL
        <span className="text-[10px] ml-1 font-normal">({(pos.unrealizedPnlPct * 100).toFixed(1)}%)</span>
      </span>
    </div>
  )
}

// ─── Swap feed row ────────────────────────────────────────────
function SwapRow({ swap }: { swap: SwapEvent }) {
  const ago = Math.floor((Date.now() - swap.timestamp) / 1000)
  return (
    <div className="t-row px-3 py-1 flex items-center gap-2 text-[10px]">
      <span className={swap.side === 'buy' ? 'text-g shrink-0' : 'text-r shrink-0'}>
        {swap.side === 'buy' ? '▲' : '▼'}
      </span>
      <span className="text-c shrink-0 font-mono">{swap.mint.slice(0, 8)}…</span>
      <span className="text-gdim shrink-0">{swap.solAmount.toFixed(4)} SOL</span>
      <span className="text-gdim shrink-0">@ {swap.priceInSol.toFixed(8)}</span>
      <span className="text-[#777] ml-auto shrink-0">{ago}s ago</span>
    </div>
  )
}

// ─── P&L chart data builder ───────────────────────────────────
interface PnlPoint { t: string; pnl: number; raw: number }

function buildPnlData(fills: Fill[]): PnlPoint[] {
  const sorted = [...fills].sort((a, b) => a.timestamp - b.timestamp)
  let cumulative = 0
  const points: PnlPoint[] = []

  // Build sell-side P&L (simplified — pair each SELL with its rough P&L)
  for (const f of sorted) {
    if (f.side !== 'SELL') continue
    // Approximate P&L: this is imprecise without buy prices, but gives trend direction
    // Real P&L is in portfolio state; this is just for the chart
    points.push({
      t:   fmtTime(f.timestamp, [11, 16]),
      pnl: cumulative,
      raw: f.solAmount,
    })
  }
  return points.slice(-48)  // last 48 data points
}

// ─── Dashboard ────────────────────────────────────────────────
export default function Dashboard() {
  const { status, portfolio, signals, fills, logs, swapFeed, swapCount, connected } = useBotData()
  const [allFills, setAllFills] = useState<Fill[]>([])
  const prevPnl = useRef(0)

  const pnl   = portfolio?.dayPnlSol ?? 0
  const total = portfolio?.totalPnlSol ?? 0
  const pnlFlash = pnl !== prevPnl.current
  prevPnl.current = pnl

  // Fetch historical fills for P&L chart on mount
  useEffect(() => {
    fetch(`${HTTP_URL}/api/fills`)
      .then(r => r.json())
      .then((data: Fill[]) => setAllFills(data))
      .catch(() => {})
  }, [])

  // Merge WS fills with historical fills for chart
  const mergedFills = [...fills, ...allFills.filter(
    hf => !fills.find(wf => wf.id === hf.id)
  )].sort((a, b) => a.timestamp - b.timestamp)

  const chartData = buildPnlData(mergedFills)
  const winRate   = status?.totalTrades
    ? (portfolio?.openPositions.reduce((acc, p) => acc + (p.unrealizedPnlSol > 0 ? 1 : 0), 0) ?? 0)
    : 0

  return (
    <div className="space-y-3">
      {/* ── Stats row 1 ── */}
      <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 gap-3">
        <Stat
          label="Balance"
          value={`${(portfolio?.totalBalanceSol ?? 0).toFixed(4)} SOL`}
        />
        <Stat
          label="Day P&L"
          value={`${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} SOL`}
          color={pnl >= 0 ? 'text-g' : 'text-r'}
          flash={pnlFlash}
        />
        <Stat
          label="Total P&L"
          value={`${total >= 0 ? '+' : ''}${total.toFixed(4)} SOL`}
          color={total >= 0 ? 'text-g' : 'text-r'}
        />
        <Stat
          label="Positions"
          value={`${portfolio?.openPositionCount ?? 0} / ${portfolio?.maxPositions ?? 5}`}
          sub={`${portfolio?.openPositions.reduce((s, p) => s + p.solAmount, 0).toFixed(4) ?? 0} SOL at risk`}
        />
        <Stat
          label="Swaps / Signals"
          value={`${status?.swapsProcessed ?? swapCount}`}
          sub={`${status?.signalsToday ?? signals.length} signals today`}
          color="text-c"
        />
        <Stat
          label="Trades"
          value={`${status?.totalTrades ?? 0}`}
          sub={`${status?.activeStrategies ?? 0} strategies active`}
        />
      </div>

      {/* ── Main row ── */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
        {/* Left: Open Positions */}
        <PanelBox title={`OPEN POSITIONS (${portfolio?.openPositionCount ?? 0})`}>
          <div className="px-3 py-1.5 flex gap-3 text-[10px] text-gdim border-b border-[#00ff4108]">
            <span className="w-20">TOKEN</span>
            <span className="w-20">STRATEGY</span>
            <span className="w-20">SIZE</span>
            <span className="w-12">AGE</span>
            <span className="ml-auto">UNREALIZED P&L</span>
          </div>
          {portfolio?.openPositions.length ? (
            portfolio.openPositions.map(p => <PositionRow key={p.id} pos={p} />)
          ) : (
            <div className="px-3 py-6 text-gdim text-[11px]">
              no open positions<span className="cursor" />
            </div>
          )}
        </PanelBox>

        {/* Right: P&L Chart */}
        <PanelBox title="P&L CHART (SELL TRADES)">
          {chartData.length > 1 ? (
            <div className="p-3 h-[160px]">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                  <defs>
                    <linearGradient id="pnlGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%"  stopColor="#00ff41" stopOpacity={0.2} />
                      <stop offset="95%" stopColor="#00ff41" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="t" tick={{ fill: '#00b32c', fontSize: 9 }} axisLine={false} tickLine={false} interval="preserveEnd" />
                  <YAxis tick={{ fill: '#00b32c', fontSize: 9 }} axisLine={false} tickLine={false} width={45} />
                  <Tooltip
                    contentStyle={{ background: '#050505', border: '1px solid #00ff4130', fontSize: 11, color: '#00ff41' }}
                    formatter={(v: number) => [`${v.toFixed(4)} SOL`, 'Cumulative']}
                  />
                  <ReferenceLine y={0} stroke="#00ff4120" strokeDasharray="3 3" />
                  <Area
                    type="monotone" dataKey="pnl"
                    stroke="#00ff41" strokeWidth={1.5}
                    fill="url(#pnlGrad)"
                    dot={false} activeDot={{ r: 3, fill: '#00ff41' }}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="px-3 py-6 text-gdim text-[11px]">
              no trade history yet<span className="cursor" />
            </div>
          )}
        </PanelBox>
      </div>

      {/* ── Activity row ── */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        {/* Live Signals */}
        <PanelBox title={`LIVE SIGNALS (${signals.length})`}>
          <div className="px-3 py-1.5 flex gap-2 text-[10px] text-gdim border-b border-[#00ff4108]">
            <span className="w-16">TIME</span>
            <span>DIR</span>
            <span>STRATEGY</span>
            <span className="flex-1">TOKEN</span>
            <span>CONF</span>
          </div>
          <div className="overflow-auto max-h-52">
            {signals.slice(0, 25).map(s => <SignalRow key={s.id} sig={s} />)}
            {signals.length === 0 && (
              <div className="px-3 py-4 text-gdim text-[11px]">waiting for signals<span className="cursor" /></div>
            )}
          </div>
        </PanelBox>

        {/* Recent Fills */}
        <PanelBox title={`RECENT FILLS (${fills.length})`}>
          <div className="px-3 py-1.5 flex gap-2 text-[10px] text-gdim border-b border-[#00ff4108]">
            <span className="w-16">TIME</span>
            <span>SIDE</span>
            <span className="flex-1">TOKEN</span>
            <span>SIZE</span>
            <span>MODE</span>
          </div>
          <div className="overflow-auto max-h-52">
            {fills.slice(0, 25).map(f => <FillRow key={f.id} fill={f} />)}
            {fills.length === 0 && (
              <div className="px-3 py-4 text-gdim text-[11px]">no fills yet<span className="cursor" /></div>
            )}
          </div>
        </PanelBox>

        {/* Live Swap Feed */}
        <PanelBox title={`SWAP FEED (${swapCount.toLocaleString()} total)`}>
          <div className="px-3 py-1.5 flex gap-2 text-[10px] text-gdim border-b border-[#00ff4108]">
            <span>DIR</span>
            <span>TOKEN</span>
            <span>SIZE</span>
            <span>PRICE</span>
            <span className="ml-auto">AGE</span>
          </div>
          <div className="overflow-auto max-h-52">
            {swapFeed.slice(0, 20).map(s => <SwapRow key={s.signature} swap={s} />)}
            {swapFeed.length === 0 && (
              <div className="px-3 py-4 text-gdim text-[11px]">
                {connected ? 'waiting for swaps' : 'bot offline'}<span className="cursor" />
              </div>
            )}
          </div>
        </PanelBox>
      </div>

      {/* ── Log stream ── */}
      <PanelBox title="LOG STREAM">
        <div className="overflow-auto max-h-36 px-3 py-2 space-y-0.5">
          {logs.slice(0, 30).map(log => (
              <div key={log.id} className={`text-[11px] log-${log.level} leading-relaxed`}>
                <span className="text-[#666] mr-2">[{fmtTime(log.timestamp, [11, 23])}]</span>
                <span className="text-[10px] tracking-wide mr-2">[{log.level}]</span>
                {log.message}
              </div>
            )
          })}
          {logs.length === 0 && (
            <div className="text-gdim text-[11px]">connecting to bot...<span className="cursor" /></div>
          )}
        </div>
      </PanelBox>
    </div>
  )
}
