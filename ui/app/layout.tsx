'use client'

import './globals.css'
import Nav from '../components/Nav'
import StatusBar from '../components/StatusBar'
import { useBotData } from '../hooks/useBotData'

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const { status, connected, swapCount } = useBotData()

  return (
    <html lang="en">
      <head>
        <title>MEMETRADER</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </head>
      <body className="bg-black text-g font-mono">
        <div className="flex h-screen overflow-hidden">
          <Nav
            connected={connected}
            mode={status?.mode ?? 'PAPER'}
            uptime={status?.uptime ?? 0}
            totalTrades={status?.totalTrades ?? 0}
          />
          <div className="flex-1 flex flex-col overflow-hidden">
            <StatusBar status={status} connected={connected} swapCount={swapCount} />
            <main className="flex-1 overflow-auto p-3">
              {children}
            </main>
          </div>
        </div>
      </body>
    </html>
  )
}
