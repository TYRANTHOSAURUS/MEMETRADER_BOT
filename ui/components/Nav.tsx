'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

interface NavProps {
  connected:    boolean
  mode:         string
  uptime:       number
  totalTrades?: number
}

function formatUptime(s: number): string {
  const h   = Math.floor(s / 3600)
  const m   = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`
}

const LINKS = [
  { href: '/',           label: 'DASHBOARD',  key: 'dashboard' },
  { href: '/watchlist',  label: 'WATCHLIST',  key: 'watchlist' },
  { href: '/signals',    label: 'SIGNALS',    key: 'signals' },
  { href: '/analytics',  label: 'ANALYTICS',  key: 'analytics' },
  { href: '/portfolio',  label: 'PORTFOLIO',  key: 'portfolio' },
  { href: '/strategies', label: 'STRATEGIES', key: 'strategies' },
  { href: '/logs',       label: 'LOGS',       key: 'logs' },
]

export default function Nav({ connected, mode, uptime, totalTrades = 0 }: NavProps) {
  const pathname = usePathname()

  return (
    <nav className="w-44 shrink-0 flex flex-col border-r border-[#00ff4115] bg-[#020202] h-screen sticky top-0">
      {/* Header */}
      <div className="px-3 py-4 border-b border-[#00ff4115]">
        <div className="text-g font-bold tracking-widest text-sm">MEMETRADER</div>
        <div className="flex items-center gap-2 mt-1">
          <span className={`text-[10px] font-bold px-1.5 py-0.5 ${
            mode === 'LIVE'
              ? 'bg-[#ff333320] text-r border border-[#ff333340]'
              : 'bg-[#ff8c0015] text-o border border-[#ff8c0030]'
          }`}>{mode}</span>
          <span className="text-gdim text-[10px]">v0.3</span>
        </div>
      </div>

      {/* Links */}
      <div className="flex-1 py-2">
        {LINKS.map(link => {
          const active = pathname === link.href
          return (
            <Link
              key={link.key}
              href={link.href}
              className={`flex items-center gap-2 px-3 py-2 text-[11px] tracking-wider transition-colors ${
                active
                  ? 'text-g bg-[#00ff410a] border-r-2 border-g'
                  : 'text-gdim hover:text-g hover:bg-[#00ff4106]'
              }`}
            >
              <span className={active ? 'text-g' : 'text-gdark'}>{'>'}</span>
              {link.label}
            </Link>
          )
        })}
      </div>

      {/* Status footer */}
      <div className="px-3 py-3 border-t border-[#00ff4115] space-y-2">
        <div className="flex items-center gap-2 text-[10px]">
          <span className={`dot ${connected ? 'dot-green' : 'dot-red'}`} />
          <span className={connected ? 'text-g' : 'text-r'}>
            {connected ? 'CONNECTED' : 'OFFLINE'}
          </span>
        </div>
        <div className="text-[10px] text-gdim">
          UP {formatUptime(uptime)}
        </div>
        {totalTrades > 0 && (
          <div className="text-[10px] text-gdim">
            {totalTrades} <span className="text-[#888]">trades</span>
          </div>
        )}
      </div>
    </nav>
  )
}
