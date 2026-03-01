// Fee constants
const SOLANA_BASE_FEE_SOL = 0.000005      // per transaction
const RAYDIUM_FEE_PCT     = 0.0025        // 0.25%
const PUMPFUN_FEE_PCT     = 0.01          // 1%
const JUPITER_FEE_PCT     = 0.0           // Jupiter itself is free (DEX fees apply)

export interface FeeBreakdown {
  txFeeSol:      number
  dexFeeSol:     number
  priorityFeeSol:number
  jitoTipSol:    number
  totalFeeSol:   number
}

export function calculateFee(params: {
  solAmount:      number
  program:        'pumpfun' | 'raydium' | 'orca' | 'jupiter'
  priorityLamports?: number
  jitoTipLamports?: number
  paper:          boolean
}): FeeBreakdown {
  const { solAmount, program, priorityLamports = 0, jitoTipLamports = 0, paper } = params

  const txFeeSol       = SOLANA_BASE_FEE_SOL
  const priorityFeeSol = priorityLamports / 1e9
  const jitoTipSol     = jitoTipLamports / 1e9

  let dexFeePct = 0
  if (program === 'pumpfun') dexFeePct = PUMPFUN_FEE_PCT
  if (program === 'raydium') dexFeePct = RAYDIUM_FEE_PCT
  if (program === 'orca')    dexFeePct = RAYDIUM_FEE_PCT  // same as Raydium

  const dexFeeSol = solAmount * dexFeePct

  // Paper mode still tracks fees for accurate simulation
  const totalFeeSol = txFeeSol + dexFeeSol + (paper ? 0 : priorityFeeSol + jitoTipSol)

  return { txFeeSol, dexFeeSol, priorityFeeSol, jitoTipSol, totalFeeSol }
}
