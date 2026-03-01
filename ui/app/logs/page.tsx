'use client'

import { useState, useRef, useEffect } from 'react'
import { useBotData } from '../../hooks/useBotData'
import type { LogLevel } from '../../lib/types'

const LEVELS: LogLevel[] = ['DEBUG', 'INFO', 'WARN', 'ERROR', 'TRADE']

const LEVEL_COLORS: Record<LogLevel, string> = {
  DEBUG: 'text-[#666]',
  INFO:  'text-gdim',
  WARN:  'text-o',
  ERROR: 'text-r',
  TRADE: 'text-c',
}

export default function Logs() {
  const { logs } = useBotData()
  const [filterLevel, setFilterLevel] = useState<LogLevel | 'ALL'>('ALL')
  const [filterText, setFilterText]   = useState('')
  const [paused, setPaused]           = useState(false)
  const [autoScroll, setAutoScroll]   = useState(true)
  const bottomRef = useRef<HTMLDivElement>(null)

  const filtered = logs.filter(log => {
    if (filterLevel !== 'ALL' && log.level !== filterLevel) return false
    if (filterText && !log.message.toLowerCase().includes(filterText.toLowerCase())) return false
    return true
  })

  useEffect(() => {
    if (autoScroll && !paused && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [filtered.length, autoScroll, paused])

  return (
    <div className="flex flex-col h-full gap-2">
      {/* Controls */}
      <div className="panel p-2 flex items-center gap-3 shrink-0">
        {/* Level filter */}
        <div className="flex gap-1">
          {(['ALL', ...LEVELS] as const).map(level => (
            <button
              key={level}
              onClick={() => setFilterLevel(level)}
              className={`text-[10px] px-2 py-0.5 border transition-colors ${
                filterLevel === level
                  ? 'border-g text-g bg-[#00ff4110]'
                  : 'border-[#00ff4120] text-gdim hover:text-g'
              }`}
            >
              {level}
            </button>
          ))}
        </div>

        <span className="text-[#00ff4115]">│</span>

        {/* Text search */}
        <div className="flex items-center gap-1.5 flex-1">
          <span className="text-gdim text-[11px]">{'>'}</span>
          <input
            type="text"
            value={filterText}
            onChange={e => setFilterText(e.target.value)}
            placeholder="search logs_"
            className="bg-transparent text-g text-[11px] outline-none placeholder:text-gdark flex-1"
          />
        </div>

        <span className="text-[#00ff4115]">│</span>

        {/* Auto-scroll toggle */}
        <button
          onClick={() => setAutoScroll(!autoScroll)}
          className={`text-[10px] px-2 py-0.5 border transition-colors ${
            autoScroll
              ? 'border-g text-g'
              : 'border-[#00ff4120] text-gdim'
          }`}
        >
          {autoScroll ? 'AUTO-SCROLL ON' : 'AUTO-SCROLL OFF'}
        </button>

        <span className="text-gdim text-[10px]">{filtered.length} entries</span>
      </div>

      {/* Log output */}
      <div className="panel flex-1 overflow-auto p-3 font-mono">
        <div className="space-y-0.5">
          {filtered.slice().reverse().map(log => {
            const time = new Date(log.timestamp).toISOString().slice(11, 23)
            return (
              <div key={log.id} className={`text-[11px] leading-relaxed ${LEVEL_COLORS[log.level]}`}>
                <span className="text-[#666] select-none">[{time}]</span>
                {' '}
                <span className="text-[10px] tracking-wide">[{log.level.padEnd(5)}]</span>
                {' '}
                <span>{log.message}</span>
                {log.data && (
                  <span className="text-[#555] ml-2 text-[10px]">
                    {JSON.stringify(log.data).slice(0, 120)}
                  </span>
                )}
              </div>
            )
          })}
          {filtered.length === 0 && (
            <div className="text-gdim text-[11px]">no logs<span className="cursor" /></div>
          )}
        </div>
        <div ref={bottomRef} />
      </div>
    </div>
  )
}
