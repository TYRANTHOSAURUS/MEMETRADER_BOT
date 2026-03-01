'use client'

import { useState, useEffect } from 'react'
import PanelBox from '../../components/PanelBox'
import { fmtTime } from '../../lib/fmt'

interface SignalQualityRow {
  strategyId:    string
  side:          string
  totalSignals:  number
  resolvedCount: number
  accuracy30s:   number
  accuracy1m:    number
  accuracy5m:    number
  avgMaxGain:    number
  avgMaxLoss:    number
  expectedValue: number
}

interface ConfidenceBucket {
  bucket:     string
  count:      number
  accuracy1m: number
  avgMaxGain: number
}

const HTTP_URL = 'http://localhost:3001'

function accColor(pct: number) {
  if (pct >= 60) return 'text-g'
  if (pct >= 50) return 'text-o'
  return 'text-r'
}

function evColor(ev: number) {
  if (ev > 2) return 'text-g'
  if (ev > 0) return 'text-o'
  return 'text-r'
}

export default function Analytics() {
  const [quality,      setQuality]      = useState<SignalQualityRow[]>([])
  const [calibration,  setCalibration]  = useState<ConfidenceBucket[]>([])
  const [loading,      setLoading]      = useState(true)
  const [lastUpdated,  setLastUpdated]  = useState(0)

  const load = async () => {
    try {
      const [qRes, cRes] = await Promise.all([
        fetch(`${HTTP_URL}/api/analytics/signal-quality`),
        fetch(`${HTTP_URL}/api/analytics/confidence`),
      ])
      if (qRes.ok) setQuality(await qRes.json() as SignalQualityRow[])
      if (cRes.ok) setCalibration(await cRes.json() as ConfidenceBucket[])
      setLastUpdated(Date.now())
    } catch {
      // bot offline
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    const interval = setInterval(load, 15_000)
    return () => clearInterval(interval)
  }, [])

  // Group by strategyId for the combined view
  const strategies = Array.from(new Set(quality.map(r => r.strategyId))).sort()
  const totalSignals  = quality.reduce((s, r) => s + r.totalSignals, 0)
  const totalResolved = quality.reduce((s, r) => s + r.resolvedCount, 0)

  return (
    <div className="space-y-3">
      {/* Summary strip */}
      <div className="grid grid-cols-3 gap-3">
        <div className="panel p-3">
          <div className="text-gdim text-[10px] tracking-widest uppercase mb-1">TOTAL SIGNALS</div>
          <div className="text-lg font-bold text-g">{totalSignals}</div>
        </div>
        <div className="panel p-3">
          <div className="text-gdim text-[10px] tracking-widest uppercase mb-1">RESOLVED</div>
          <div className="text-lg font-bold text-g">
            {totalResolved}
            <span className="text-gdim text-sm ml-2">
              {totalSignals > 0 ? `(${((totalResolved / totalSignals) * 100).toFixed(0)}%)` : ''}
            </span>
          </div>
        </div>
        <div className="panel p-3">
          <div className="text-gdim text-[10px] tracking-widest uppercase mb-1">LAST UPDATED</div>
          <div className="text-lg font-bold text-gdim">
            {fmtTime(lastUpdated || undefined)}
          </div>
        </div>
      </div>

      {/* Signal quality table */}
      <PanelBox title="SIGNAL QUALITY BY STRATEGY">
        <div className="overflow-auto">
          <div className="px-3 py-1.5 grid grid-cols-[160px_50px_60px_65px_65px_65px_70px_70px_75px] gap-2 text-[10px] text-gdim border-b border-[#00ff4108] sticky top-0 bg-panel">
            <span>STRATEGY</span>
            <span>SIDE</span>
            <span>SIGNALS</span>
            <span>RESOLVED</span>
            <span>ACC@30s</span>
            <span>ACC@1m</span>
            <span>ACC@5m</span>
            <span>AVG GAIN</span>
            <span>EV</span>
          </div>

          {loading && (
            <div className="px-3 py-6 text-gdim text-[11px]">loading<span className="cursor" /></div>
          )}

          {strategies.map(strat => {
            const rows = quality.filter(r => r.strategyId === strat)
            return rows.map((r, i) => (
              <div
                key={`${strat}-${r.side}`}
                className={`t-row px-3 py-1.5 grid grid-cols-[160px_50px_60px_65px_65px_65px_70px_70px_75px] gap-2 items-center text-[11px] ${i === 0 ? 'border-t border-[#00ff4108]' : ''}`}
              >
                <span className={`text-[10px] truncate ${i === 0 ? 'text-g' : 'text-[#0a0a0a]'}`}>
                  {i === 0 ? strat.replace(/_/g, ' ').toUpperCase() : ''}
                </span>
                <span className={r.side === 'BUY' ? 'badge-buy' : 'badge-sell'}>{r.side}</span>
                <span className="text-gdim">{r.totalSignals}</span>
                <span className="text-gdim">{r.resolvedCount}</span>
                <span className={accColor(r.accuracy30s)}>
                  {r.resolvedCount > 0 ? `${r.accuracy30s.toFixed(1)}%` : '—'}
                </span>
                <span className={accColor(r.accuracy1m)}>
                  {r.resolvedCount > 0 ? `${r.accuracy1m.toFixed(1)}%` : '—'}
                </span>
                <span className={accColor(r.accuracy5m)}>
                  {r.resolvedCount > 0 ? `${r.accuracy5m.toFixed(1)}%` : '—'}
                </span>
                <span className="text-g">
                  {r.resolvedCount > 0 ? `+${r.avgMaxGain.toFixed(1)}%` : '—'}
                </span>
                <span className={evColor(r.expectedValue)}>
                  {r.resolvedCount > 0 ? `${r.expectedValue > 0 ? '+' : ''}${r.expectedValue.toFixed(1)}` : '—'}
                </span>
              </div>
            ))
          })}

          {!loading && quality.length === 0 && (
            <div className="px-3 py-6 text-gdim text-[11px]">
              no signal data yet — outcomes resolve 30m after each signal
            </div>
          )}
        </div>
      </PanelBox>

      {/* Confidence calibration */}
      <PanelBox title="CONFIDENCE CALIBRATION — is high confidence actually more accurate?">
        <div className="overflow-auto">
          <div className="px-3 py-1.5 grid grid-cols-[100px_80px_100px_120px] gap-4 text-[10px] text-gdim border-b border-[#00ff4108] sticky top-0 bg-panel">
            <span>BUCKET</span>
            <span>COUNT</span>
            <span>ACC@1m</span>
            <span>AVG MAX GAIN</span>
          </div>

          {calibration.map(b => (
            <div
              key={b.bucket}
              className="t-row px-3 py-1.5 grid grid-cols-[100px_80px_100px_120px] gap-4 items-center text-[11px]"
            >
              <span className="text-c">{b.bucket}</span>
              <span className="text-gdim">{b.count}</span>
              <span className={accColor(b.accuracy1m)}>
                {b.count > 0 ? `${b.accuracy1m.toFixed(1)}%` : '—'}
              </span>
              <span className="text-g">
                {b.count > 0 ? `+${b.avgMaxGain.toFixed(1)}%` : '—'}
              </span>
            </div>
          ))}

          {!loading && calibration.length === 0 && (
            <div className="px-3 py-6 text-gdim text-[11px]">
              no calibration data yet
            </div>
          )}
        </div>
      </PanelBox>
    </div>
  )
}
