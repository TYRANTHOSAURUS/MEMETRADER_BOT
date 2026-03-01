# MEMETRADER_BOT — Claude Instructions

## Memory Protocol (CRITICAL)
After every significant decision, update BOTH:
1. This file under the relevant section
2. `/Users/x/.claude/projects/-Users-x/memory/memetrader.md`

Significant decisions include:
- Architecture changes
- New strategy implementations or removals
- Bug fixes that changed behavior
- Config/env changes
- Deployment steps
- Performance findings
- What works and what doesn't in live/paper trading

---

## Project Layout
```
src/          ← Bot engine (Node.js + TypeScript, run with tsx)
ui/           ← Frontend (Next.js 14 + Tailwind, port 3000)
data/         ← SQLite database (gitignored)
CLAUDE.md     ← This file
.env          ← Secrets (gitignored)
```

## Running
```bash
npm run dev        # Bot only (paper mode)
npm run ui         # Frontend only
npm run start:all  # Both concurrently
```

## Key Architecture Decisions
- PaperExecutor is default; switch via EXECUTOR_MODE=live in .env
- All strategy signals route through SignalAggregator before execution
- SQLite at data/bot.db — raw swaps stored from day 1 for backtesting
- Bot exposes WebSocket on port 8080, HTTP API on port 3001
- UI connects to bot WS at ws://localhost:8080
- EMA9/EMA21 (not 20/50) — memecoin speed requires faster EMAs
- Jito bundles for all live transactions (MEV protection)
- Jupiter API v6 for swap routing and price quotes
- Wallet tracking is a confidence modifier only, NOT a primary strategy (EL risk)

## Adding a Strategy
1. Create `src/strategies/yourStrategy.ts` implementing the `Strategy` interface
2. Register it in `src/strategies/index.ts`
3. Restart bot (no hot-reload yet)
4. Update this file and memory

## Environment Variables
See `.env.example` for all variables. Required for live mode:
- HELIUS_API_KEY
- HELIUS_RPC_URL
- HELIUS_WSS_URL
- WALLET_PRIVATE_KEY (LIVE mode only)

## Phase Status
Current Phase: **1 — Paper Trading**

- [x] Project scaffolding
- [x] Core types and contracts
- [x] Event bus
- [x] SQLite storage layer
- [x] Candle engine (swap → OHLCV)
- [x] Indicator engine (EMA, VWAP, swings, RSI)
- [x] Safety engine
- [x] Strategy: EMA Pullback
- [x] Strategy: Breakout Retest
- [x] Strategy: Migration Momentum
- [x] Strategy: Holder Velocity
- [x] Strategy: Social Divergence (social spike → price divergence)
- [x] Strategy: Dev Wallet Signal (confidence modifier)
- [x] Signal aggregator
- [x] Paper executor
- [x] Portfolio & risk manager
- [x] Strategy metrics engine
- [x] WebSocket server (bot → UI)
- [x] HTTP API
- [x] Frontend terminal UI
- [ ] Helius scanner live (needs HELIUS_API_KEY)
- [ ] Live executor (needs WALLET_PRIVATE_KEY)
- [ ] Social engine (needs Twitter API key)

## Risk Rules (Hardcoded Defaults)
- Max open positions: 5
- Max per-trade size: 0.5 SOL
- Max token exposure: 10% of balance
- Daily loss limit: 2 SOL (hard stop)
- Per-trade time stop: 30 minutes
- Strategy auto-disable: 7d drawdown > 30%

## Important Notes
- Never commit .env
- Always paper trade first — minimum 1 week before going live
- The scanner emits mock data if HELIUS_API_KEY is not set (dev mode)
- Check strategy metrics daily to disable underperformers
