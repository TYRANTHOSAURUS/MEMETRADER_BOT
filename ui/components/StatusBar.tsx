import type { SystemStatus } from '../lib/types'

interface StatusBarProps {
  status:    SystemStatus | null
  connected: boolean
  swapCount?: number
}

export default function StatusBar({ status, connected, swapCount = 0 }: StatusBarProps) {
  const pnl = status?.dayPnlSol ?? 0

  return (
    <div className="h-8 bg-[#020202] border-b border-[#00ff4115] flex items-center px-4 gap-5 shrink-0 text-[10px] overflow-x-auto">
      {/* Connection */}
      <div className="flex items-center gap-1.5 shrink-0">
        <span className={`dot ${connected ? 'dot-green' : 'dot-red animate-blink'}`} />
        <span className="text-gdim">{connected ? 'LIVE' : 'OFFLINE'}</span>
      </div>

      <span className="text-[#00ff4115] shrink-0">│</span>

      {/* Mode */}
      <span className={`shrink-0 font-bold ${status?.mode === 'LIVE' ? 'text-r animate-glow' : 'text-o'}`}>
        {status?.mode ?? '---'}
      </span>

      <span className="text-[#00ff4115] shrink-0">│</span>

      {/* Scanner */}
      <div className="flex items-center gap-1.5 shrink-0">
        <span className={`dot ${status?.scannerConnected ? 'dot-green' : 'dot-orange'}`} />
        <span className="text-gdim">SCAN</span>
      </div>

      <span className="text-[#00ff4115] shrink-0">│</span>

      {/* Tokens tracked */}
      <span className="text-gdim shrink-0">
        TOKENS: <span className="text-g">{status?.tokensTracked ?? 0}</span>
      </span>

      <span className="text-[#00ff4115] shrink-0">│</span>

      {/* Swaps */}
      <span className="text-gdim shrink-0">
        SWAPS: <span className="text-c">{(status?.swapsProcessed ?? swapCount).toLocaleString()}</span>
      </span>

      <span className="text-[#00ff4115] shrink-0">│</span>

      {/* Signals today */}
      <span className="text-gdim shrink-0">
        SIG: <span className="text-g">{status?.signalsToday ?? 0}</span>
      </span>

      <span className="text-[#00ff4115] shrink-0">│</span>

      {/* Open positions */}
      <span className="text-gdim shrink-0">
        POS: <span className="text-g">{status?.openPositions ?? 0}/{5}</span>
      </span>

      <span className="text-[#00ff4115] shrink-0">│</span>

      {/* Balance */}
      <span className="text-gdim shrink-0">
        BAL: <span className="text-g">{(status?.balanceSol ?? 0).toFixed(4)} SOL</span>
      </span>

      <span className="text-[#00ff4115] shrink-0">│</span>

      {/* Day P&L */}
      <span className="text-gdim shrink-0">
        P&L: <span className={pnl >= 0 ? 'text-g' : 'text-r'}>
          {pnl >= 0 ? '+' : ''}{pnl.toFixed(4)}
        </span>
      </span>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Trades + version */}
      <span className="text-gdim shrink-0">
        TRADES: <span className="text-g">{status?.totalTrades ?? 0}</span>
      </span>

      <span className="text-[#00ff4115] shrink-0">│</span>

      <span className="text-[#666] shrink-0">v{status?.version ?? '---'}</span>
    </div>
  )
}
