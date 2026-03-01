import type { Strategy } from '../core/types.js'
import { emaPullback }      from './emaPullback.js'
import { breakoutRetest }   from './breakoutRetest.js'
import { migrationMomentum } from './migrationMomentum.js'
import { holderVelocity }   from './holderVelocity.js'
import { socialDivergence } from './socialDivergence.js'
import { devWalletSignal }  from './devWalletSignal.js'

// ── Strategy Registry ────────────────────────────────────────
// Add new strategies here. The rest of the system picks them up automatically.

const ALL_STRATEGIES: Strategy[] = [
  emaPullback,
  breakoutRetest,
  migrationMomentum,
  holderVelocity,
  socialDivergence,
  devWalletSignal,
]

export function getStrategies(): Strategy[] {
  return ALL_STRATEGIES.filter(s => s.enabled)
}

export function getStrategy(id: string): Strategy | undefined {
  return ALL_STRATEGIES.find(s => s.id === id)
}

export function enableStrategy(id: string): boolean {
  const s = getStrategy(id)
  if (!s) return false
  s.enabled = true
  return true
}

export function disableStrategy(id: string): boolean {
  const s = getStrategy(id)
  if (!s) return false
  s.enabled = false
  return true
}

export function getAllStrategyIds(): string[] {
  return ALL_STRATEGIES.map(s => s.id)
}

export { emaPullback, breakoutRetest, migrationMomentum, holderVelocity, socialDivergence, devWalletSignal }
