import { logger } from '../core/logger.js'

// On-chain rug detection via Helius/RPC
// Checks mint authority, freeze authority, LP token burn status

export interface OnChainChecks {
  mintRevoked:   boolean
  freezeRevoked: boolean
  lpBurned:      boolean
  error?: string
}

// Cache to avoid hammering RPC for the same token
const cache = new Map<string, { result: OnChainChecks; ts: number }>()
const CACHE_TTL_MS = 5 * 60 * 1000  // 5 min

export async function checkToken(mint: string, rpcUrl: string): Promise<OnChainChecks> {
  const cached = cache.get(mint)
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.result
  }

  if (!rpcUrl) {
    // No RPC configured — return optimistic defaults for dev mode
    return { mintRevoked: true, freezeRevoked: true, lpBurned: false }
  }

  try {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getAccountInfo',
        params: [mint, { encoding: 'jsonParsed' }],
      }),
    })

    const json = await response.json() as {
      result: { value: { data: { parsed: { info: { mintAuthority: string | null; freezeAuthority: string | null } } } } }
    }

    const info = json.result?.value?.data?.parsed?.info
    if (!info) throw new Error('No account info returned')

    const result: OnChainChecks = {
      mintRevoked:   info.mintAuthority === null,
      freezeRevoked: info.freezeAuthority === null,
      lpBurned:      false,  // TODO: check LP token burn via LP mint address
    }

    cache.set(mint, { result, ts: Date.now() })
    return result
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.warn(`RugDetector: RPC check failed for ${mint}: ${msg}`)
    return { mintRevoked: false, freezeRevoked: false, lpBurned: false, error: msg }
  }
}
