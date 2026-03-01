# SOLANA MEMECOIN QUANT BOT

Competitive, low-cost, modular trading framework for Solana memecoins.

Designed for:

- Pump.fun bonding curve + AMM migrated tokens
- Real-time swap-driven candles
- Pluggable multi-strategy architecture
- Safety & risk veto engine
- Strict separation of reasoning and execution

---

# Philosophy

This is NOT a sniper bot.

It trades:

- 15s – 30m momentum windows
- Breakout → retest structures
- Pullbacks in trend
- Virality acceleration with confirmation
- Token lifecycle stage awareness (bonding curve vs AMM)

Core rule:

Strategies decide WHAT to trade.
Execution engine decides HOW to trade safely.
Metrics engine decides WHICH strategies are worth keeping.

---

# System Architecture

## Engines

1. Scan Engine
2. Market Data Engine
3. Candle + Indicator Engine
4. Virality + Social Engine
5. Safety Engine
6. Strategy Engine
7. Signal Aggregator
8. Portfolio & Risk Manager
9. Execution Engine (Live or Paper, drop-in swap)
10. Strategy Metrics Engine
11. Backtest Engine

Each engine is isolated and communicates through typed contracts.
No engine has a dependency on another engine's internals — only on shared types.

---

# Token Lifecycle

PumpFun tokens move through distinct stages. Strategy behavior must differ per stage.

Stages:

- BONDING_CURVE — token on PumpFun bonding curve, no AMM yet
- MIGRATING — threshold crossed (~85 SOL), migration in progress
- AMM — token live on Raydium/Orca, full order book dynamics

`tokenLifecycleStage` is a required field on every `MarketSnapshot`.
Strategies declare which stages they operate on.
Scanner filters tokens by stage before routing to strategies.

---

# Core Data Contracts

## MarketSnapshot

Read-only object passed to strategies. Never mutated.

```
tokenMint: string
tokenName: string
tokenAge: number                  // seconds since launch
lifecycleStage: LifecycleStage    // BONDING_CURVE | MIGRATING | AMM

price: number
liquidity: number
marketCap: number

candles: {
  s15: Candle[]
  m1:  Candle[]
  m5:  Candle[]
}

indicators: {
  ema9:  number
  ema21: number
  ema50: number
  vwap:  number
  swingHigh: number
  swingLow:  number
  volumeProfile: VolumeNode[]
}

volume: {
  total5m:       number
  buyVolume5m:   number
  sellVolume5m:  number
  uniqueBuyers5m: number
  buyerVelocity: number           // unique buyers per 30s, slope
  volumeToMcap:  number           // 5m volume / mcap ratio
}

virality: {
  score:        number            // 0–100 composite
  slope:        number            // direction of change
  socialScore:  number            // twitter/telegram signal
  onChainScore: number            // holder growth, buy accel
}

safety: {
  riskScore:    number            // 0–100
  flags:        string[]
}

devWallet: {
  address:      string
  bought:       boolean           // bought post-launch?
  sold:         boolean           // sold any amount?
  holdingPct:   number
}

holderCount:    number
holderGrowthRate: number          // holders per minute
```

---

## OrderIntent

Emitted by strategies. Consumed by Signal Aggregator, then Execution Engine.

```
strategyId:        string
tokenMint:         string
side:              BUY | SELL
entryMode:         NOW | RANGE
priceMin?:         number
priceMax?:         number
sizeMode:          FIXED | PERCENT | RISK_BASED
sizeValue:         number
invalidationPrice: number
maxSlippageBps:    number
expiresAt:         number
confidence:        number         // 0–1, used by Signal Aggregator
lifecycleStage:    LifecycleStage // must match current stage or intent rejected
```

Execution may reject an intent if constraints are not met.

---

## Signal

Emitted by strategies to the Signal Aggregator before becoming an OrderIntent.

```
strategyId:   string
tokenMint:    string
side:         BUY | SELL
confidence:   number    // 0–1
reason:       string
timestamp:    number
```

Signal Aggregator combines signals from multiple strategies on the same token,
deduplicates, and optionally amplifies confidence when multiple strategies agree.

---

## Fill

Returned to strategies via `onFill()` after execution confirms.

```
strategyId:  string
tokenMint:   string
side:        BUY | SELL
price:       number
size:        number
fee:         number      // tx fee + dex fee in SOL
timestamp:   number
txSignature: string
```

---

# Strategy Layer

## Responsibilities

- Read MarketSnapshot
- Compute setups from indicators + volume + virality + dev wallet
- Declare which `lifecycleStage` they operate on
- Emit Signal objects (not raw OrderIntents)
- Receive Fill callbacks for position tracking

## Strategy Interface

```typescript
interface Strategy {
  id: string
  name: string
  lifecycleStages: LifecycleStage[]   // which stages this strategy runs on
  warmupPeriods: number
  evaluate(snapshot: MarketSnapshot): Signal[]
  onFill?(fill: Fill): void
}
```

Strategies NEVER:

- Send transactions
- Access private keys
- Handle slippage or fee logic
- Modify wallet or position state
- Communicate with each other directly

---

# Signal Aggregator

Sits between strategies and execution. Prevents duplicate entries, amplifies
conviction when multiple independent strategies agree on the same token.

Responsibilities:

- Collect Signals from all active strategies
- Deduplicate signals on the same token within a time window
- Merge confidence scores when strategies agree
- Emit a single OrderIntent per token per decision cycle
- Discard conflicting signals (one strategy buying, another selling)

---

# Safety Engine

Produces:

- riskScore (0–100)
- flags[]

Veto conditions:

- Liquidity below minimum threshold
- Top holder concentration too high (>30% single wallet)
- Freeze authority not revoked
- Mint authority not revoked
- LP not burned / locked
- Dev sold any tokens in first 30 minutes
- Extreme slippage (simulated on-chain)
- Abnormal sell pressure (sell volume > 70% of total in last 60s)
- Token age < minimum (avoid instant rugs)
- Buyer velocity collapsing (holders leaving, not entering)

If riskScore exceeds threshold → trade blocked regardless of strategy signal.
Safety Engine runs before Signal Aggregator passes to Execution.

Rug detection uses on-chain checks (mint authority, freeze authority, LP status)
via Helius enhanced transaction API. Do not rely on third-party rug APIs alone.

---

# Virality + Social Engine

Produces a composite `virality.score` and `virality.socialScore` for MarketSnapshot.

Data sources:

- Twitter/X API v2 — mention count and velocity for token ticker/name
- Telegram — channel message rate (MTProto scraping or monitoring known alpha groups)
- On-chain holder growth rate — proxy for organic interest

Score components:

- socialScore: weighted twitter + telegram mentions velocity (last 5 min vs prior 5 min)
- onChainScore: unique buyer count velocity + holder growth rate
- Composite score: weighted blend, configurable per strategy

Slope matters more than absolute score — a token at 30 and rising beats one at 80 and falling.

---

# Execution Engine

Two implementations, same interface. Drop-in swap via config flag.

```typescript
interface Executor {
  submit(intent: OrderIntent): Promise<Fill>
  cancel(intentId: string): Promise<void>
  getPosition(tokenMint: string): Position | null
}
```

## LiveExecutor

- Validate OrderIntent fields
- Quote swap route via Jupiter API v6
- Simulate transaction, check slippage
- Submit via Jito bundle for MEV protection + priority inclusion
- Dynamic priority fee based on network congestion
- Confirm fill, return Fill object
- Track open positions in memory + SQLite

## PaperExecutor

- Same interface as LiveExecutor
- Uses Jupiter quote for realistic price simulation
- Applies simulated slippage (configurable)
- Logs fills to SQLite identically to live
- Never touches wallet or private key
- Default executor in Phase 1

## Jito Bundle Submission

- All live transactions submitted as Jito bundles
- Tip configurable (default: 0.0005 SOL)
- Protects against sandwich attacks on low-liquidity tokens
- Falls back to standard RPC if Jito unavailable

Execution is the ONLY module allowed to:

- Access private keys
- Submit transactions
- Modify wallet state

---

# Strategy Metrics Engine

Tracks per-strategy performance in real time. Critical for knowing what works.

Tracks per strategy:

- Total trades
- Win rate
- Average P&L per trade (in SOL, after fees)
- Average hold duration
- Best / worst trade
- Sharpe ratio (rolling 7d)
- Max drawdown

Strategies that exceed drawdown threshold get auto-disabled pending review.
All metrics persisted to SQLite and queryable at any time.

---

# Backtest Engine

Replays stored swap events through the full strategy pipeline.

Architecture:

- Raw swap events stored to SQLite from day 1 (never skip this)
- BacktestRunner replays events in order, feeding MarketSnapshot to strategies
- PaperExecutor handles fills with simulated slippage
- Strategy Metrics Engine accumulates results
- Output: per-strategy backtest report

Backtest before live. No exceptions.

---

# Fee Tracker

Accurate P&L requires tracking all fees per trade:

- Solana transaction fee (~0.000005 SOL base)
- Priority fee / Jito tip (variable)
- DEX fee: PumpFun bonding curve fee, Raydium 0.25%
- Jupiter routing fee (if applicable)

Fee is attached to every Fill. Strategy Metrics Engine subtracts fees before
computing P&L. Without this, losing strategies appear profitable at high frequency.

---

# Portfolio & Risk Rules

- Max open positions: configurable (default 5)
- Max exposure per token: 10% of total balance
- Max exposure per strategy: 30% of total balance
- Daily loss limit: hard stop at -X SOL (configurable)
- Per-trade time stop: auto-exit after N minutes regardless of P&L
- Global kill switch: shuts all engines, cancels pending intents
- Strategy auto-disable: if strategy drawdown exceeds threshold

---

# Strategies

## Strategy 1 — EMA Pullback (Trend Continuation)

Lifecycle stages: AMM

Setup:
- EMA9 > EMA21 on 15s candles (trend confirmed)
- Price pulls back to EMA9 zone
- Volume dips on pullback (healthy retracement)
- Bounce candle with volume expansion on recovery
- Buyer velocity not collapsing

Entry: on bounce confirmation candle close
Stop: below EMA21
Exit: EMA9 cross down + volume collapse OR virality slope negative

Note: use EMA9/21 not EMA20/50 — at memecoin speed, 20/50 is too slow.

---

## Strategy 2 — Breakout → Retest

Lifecycle stages: AMM

Setup:
- Clean break above prior swing high
- Volume expansion on break (volume > 2x 5m average)
- Retest of breakout level holds (price returns, does not close below)
- volumeToMcap ratio elevated (active price discovery)

Entry: on confirmed retest hold
Stop: below breakout level
Exit: structure break OR volumeToMcap collapses

---

## Strategy 3 — Migration Momentum

Lifecycle stages: MIGRATING → AMM (first 10 minutes post-migration)

The PumpFun → Raydium migration is a liquidity event. Volume expands.
Many bots ignore the post-migration window.

Setup:
- Token just migrated (lifecycleStage transition detected)
- Migration candle closes green with expansion volume
- Safety check passes (LP burned, mint revoked)
- Dev wallet has not sold

Entry: break of migration candle high
Stop: below migration candle low
Exit: 2x target OR first bearish engulfing on volume

---

## Strategy 4 — Holder Velocity Acceleration

Lifecycle stages: BONDING_CURVE, AMM

Unique buyer count velocity is a leading indicator. Tokens with accelerating
unique buyers rarely rug immediately — the rug happens when inflows stop.

Setup:
- uniqueBuyers5m accelerating (current 30s rate > prior 30s rate by >50%)
- holderGrowthRate positive and accelerating
- Price not yet parabolic (no vertical candle, avoid chasing)
- socialScore rising (confirms organic not bot activity)

Entry: confirmation after 2 consecutive accelerating buyer periods
Stop: buyer velocity reversal (2 consecutive decelerating periods)
Exit: velocity peak + virality slope turns negative

---

## Strategy 5 — Social Spike → Price Divergence

Lifecycle stages: BONDING_CURVE, AMM

When social mentions spike but price has not moved yet, there is an
early entry window before the crowd arrives. Requires fast social data.

Setup:
- socialScore spike > 2x baseline in last 5 minutes
- Price change in same window < 15% (divergence present)
- onChainScore not yet elevated (crowd hasn't arrived on-chain)
- Safety check passes

Entry: market entry with tight size
Stop: socialScore collapses without price follow-through (timeout: 10 min)
Exit: onChainScore catches up and virality peaks OR stop hit

---

## Strategy 6 — Dev Wallet Confirmation

Lifecycle stages: BONDING_CURVE, AMM

Dev buying post-launch is a conviction signal. Dev selling is a hard exit.
This is not wallet following (which risks being exit liquidity) —
it is specifically tracking the token's own creator as a signal filter.

Rules:
- Dev buys post-launch → add confidence bonus to any existing signal on this token
- Dev sells any amount in first 30 min → emit SELL signal regardless of price action, hard exit
- This strategy does not generate standalone entries — it modifies confidence of other signals

Used by Signal Aggregator as a confidence multiplier, not a standalone entry.

---

## Note on Wallet / Smart Money Following

Tracking known alpha wallets and copying their entries is tempting but increasingly
unreliable. The core problem: by the time a known wallet's transaction is visible
on-chain and you react, you are often buying their exit liquidity. KOLs and
known wallets are aware they are tracked and may exploit this.

Wallet tracking is retained as an optional auxiliary data point (confidence modifier)
but is NOT a primary strategy. The edge has compressed significantly.

If wallet tracking is used, the rule is:
- Only follow wallets with verifiable on-chain history (>20 profitable exits)
- Enter only if price has moved <5% since their buy
- Never follow into a token already up >30%

---

# Data Sources

| Need | Source |
|---|---|
| Real-time swaps | Helius WebSocket (enhanced transactions) |
| Token metadata + holders | Birdeye API |
| Swap routing + quotes | Jupiter API v6 |
| MEV protection + priority | Jito bundles |
| Social signals | Twitter API v2, Telegram MTProto |
| On-chain rug checks | Helius + direct RPC (mint/freeze authority) |

---

# Tech Stack

- Node.js + TypeScript
- WebSocket Solana RPC (Helius)
- Custom swap → candle builder
- SQLite (local persistence: candles, fills, metrics, backtest data)
- Jupiter API v6 (quote + routing)
- Jito (bundle submission)
- Minimal dependencies

Optional later:
- Postgres (if SQLite becomes a bottleneck)
- Supabase
- UI dashboard with per-strategy metrics

---

# Folder Structure

```
src/
  core/
    types.ts              ← all shared types: OrderIntent, MarketSnapshot, Signal, Fill
    eventBus.ts
    tokenRegistry.ts      ← lifecycle stage, metadata cache, dedup
  market/
    candleEngine.ts       ← swap events → candles
    indicatorEngine.ts    ← EMA, VWAP, swing detection, volume profile
    stateStore.ts
    feeTracker.ts         ← per-trade fee accounting
  scan/
    scanner.ts            ← discover new tokens, route to correct engines
  social/
    twitterClient.ts
    telegramScraper.ts
    socialAggregator.ts
  virality/
    viralityEngine.ts     ← composite virality score + slope
  safety/
    safetyEngine.ts
    rugDetector.ts        ← freeze authority, mint authority, LP status, dev sells
  strategies/
    emaPullback.ts
    breakoutRetest.ts
    migrationMomentum.ts
    holderVelocity.ts
    socialDivergence.ts
    devWalletSignal.ts    ← confidence modifier, not standalone entry
    index.ts              ← strategy registry
  signalAggregator/
    aggregator.ts
  risk/
    portfolioManager.ts
    strategyMetrics.ts    ← per-strategy P&L, win rate, Sharpe, drawdown
  execution/
    executor.ts           ← interface
    liveExecutor.ts       ← Jito bundles, Jupiter routing, real signing
    paperExecutor.ts      ← drop-in paper mode, same interface
    quote.ts
    jitoBundle.ts
    routers/
  backtest/
    runner.ts             ← replay stored swap events through strategy pipeline
    replayStore.ts
  storage/
    sqlite.ts
  app.ts
```

---

# Development Phases

## Phase 1 — Foundation (Paper Only)

- Helius WebSocket swap stream ingestion
- Candle engine + indicator engine
- Token registry with lifecycle stage tracking
- Safety Engine (on-chain rug checks)
- PaperExecutor
- Fee tracker
- SQLite: raw swap events, fills, metrics
- One strategy: EMA Pullback
- Strategy Metrics Engine (from day 1)

Do not go live until Phase 1 runs stable for at least 1 week in paper mode.

## Phase 2 — Strategy Expansion

- All 6 strategies implemented and backtested
- Signal Aggregator live
- Virality + Social Engine (at least on-chain score; social APIs optional)
- Portfolio & Risk Manager with hard limits
- Backtest runner validated against Phase 1 paper data

## Phase 3 — Live Trading

- Switch PaperExecutor → LiveExecutor (config flag, not code change)
- Jito bundle submission
- Daily loss limit enforced
- Strategy Metrics driving decisions (disable underperformers)
- Start at minimum position sizes (0.1–0.25 SOL per trade)

## Phase 4 — Scale

- Full social engine (Twitter + Telegram)
- Dev Wallet Signal modifier integrated
- Dashboard: real-time positions, per-strategy metrics
- Strategy hot-swap without restart

---

# Risk Rules (Hard Limits)

- Max open positions: 5
- Max per-trade size: 0.5 SOL (Phase 3 start)
- Max single token exposure: 10% of balance
- Daily loss limit: -2 SOL hard stop (Phase 3 start)
- Per-trade time stop: 30 minutes
- Auto-disable strategy if 7d drawdown > 30%
- Global kill switch: immediate flatten of all positions

---

# Disclaimer

This is experimental trading software.

Memecoins are volatile. Most tokens go to zero.
Execution risk, slippage, MEV, and liquidity traps are real.

Always run paper mode first.
Never trade more than you can afford to lose entirely.

---

# Goal

Build a modular, measurable, competitive trading framework
without expensive infrastructure.

Control your data.
Control your risk.
Measure everything.
Replace what doesn't work.
