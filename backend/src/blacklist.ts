/**
 * Blacklist lookup - the counterparty-reputation signal (#10). Queries the
 * GoPlus Security API (address_security + token_security endpoints) for the
 * transaction's target contract and distills the response into a tri-state
 * verdict the deterministic rule engine can score.
 *
 * The verdict is deliberately NOT boolean. GoPlus being down, slow, or
 * returning an unparsable payload is a regular event, and the failure mode
 * that matters is "we couldn't check" - which must never be read as "safe".
 * So every failure path (network error, HTTP error status, non-1 business
 * code, malformed body, timeout) collapses to "unknown", and scoring
 * continues with the remaining signals instead of blocking on this one.
 *
 * Combination rule across the two endpoints:
 *   - any endpoint reports malicious          -> "malicious"
 *   - otherwise, any endpoint is "unknown"    -> "unknown" (partial data)
 *   - otherwise (both checked, nothing found) -> "clean"
 *
 * This module owns the network call and nothing else - same split as
 * `watcher.ts`/`safeApiClient.ts` and `simulate.ts`/`anvilForkClient.ts`.
 * The pure classifiers below are exported so the decision logic is testable
 * without a live API.
 */

export type BlacklistVerdict = "malicious" | "clean" | "unknown"

export interface BlacklistChecker {
  /**
   * Returns the blacklist verdict for a counterparty address. Never rejects:
   * every failure mode resolves to "unknown" so callers can treat this as a
   * non-blocking lookup (see the module doc comment).
   */
  checkCounterparty(address: string): Promise<BlacklistVerdict>
}

export interface GoPlusBlacklistCheckerOptions {
  chainId: bigint | number | string
  /** Optional API key - the free tier works without one, at lower rate limits. */
  apiKey?: string
  /** Per-request timeout in milliseconds. Default 3000. */
  timeoutMs?: number
  /** Injectable fetch - defaults to globalThis.fetch; tests inject a mock. */
  fetchImpl?: typeof fetch
}

const GOPLUS_BASE_URL = "https://api.gopluslabs.io/api/v1"
const DEFAULT_TIMEOUT_MS = 3000

// Token-security boolean flags (GoPlus serializes booleans as "0"/"1"
// strings) that, when set, mean the contract itself is a known scam rather
// than merely unvetted. This list is the deliberate curation point - add
// new GoPlus flags here rather than special-casing them at call sites.
const TOKEN_MALICIOUS_FLAGS = ["is_honeypot", "is_proxy_malicious"] as const

const isAddress = (value: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(value)

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined
}

/** True when a GoPlus boolean-as-string flag is set ("1", 1, or true). */
function flagIsSet(value: unknown): boolean {
  return value === "1" || value === 1 || value === true
}

/**
 * Classifies an address_security response body. "unknown" here means the
 * payload was unusable (HTTP/business failure or unexpected shape) - a
 * well-formed response with no flags is "clean".
 */
export function classifyAddressSecurity(payload: unknown): BlacklistVerdict {
  const body = asRecord(payload)
  if (!body || body.code !== 1) return "unknown"

  // result can be null for addresses GoPlus has no data on - the call
  // itself succeeded, so this is "clean" (no flags), not "unknown".
  const result = asRecord(body.result)
  if (!result) return "clean"

  const hasLabel = typeof result.malicious_label === "string" && result.malicious_label.length > 0
  const behavior = result.malicious_behavior
  const hasBehavior = Array.isArray(behavior) && behavior.length > 0

  return hasLabel || hasBehavior ? "malicious" : "clean"
}

/**
 * Classifies a token_security response body for one contract address. The
 * endpoint keys its result map by lowercase address and returns null when
 * the queried address isn't a token - both count as a successful check.
 */
export function classifyTokenSecurity(payload: unknown, address: string): BlacklistVerdict {
  const body = asRecord(payload)
  if (!body || body.code !== 1) return "unknown"

  const result = asRecord(body.result)
  if (!result) return "clean"

  const entry = asRecord(result[address.toLowerCase()])
  if (!entry) return "clean"

  for (const flag of TOKEN_MALICIOUS_FLAGS) {
    if (flagIsSet(entry[flag])) return "malicious"
  }
  return "clean"
}

function combineVerdicts(addressVerdict: BlacklistVerdict, tokenVerdict: BlacklistVerdict): BlacklistVerdict {
  if (addressVerdict === "malicious" || tokenVerdict === "malicious") return "malicious"
  if (addressVerdict === "unknown" || tokenVerdict === "unknown") return "unknown"
  return "clean"
}

async function fetchJsonWithTimeout(url: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, { signal: controller.signal })
    if (!response.ok) throw new Error(`GoPlus HTTP ${response.status}`)
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Builds a BlacklistChecker backed by the live GoPlus Security API. The two
 * endpoint queries run in parallel; each is independently bounded by the
 * timeout. Any rejection inside a query is caught and mapped to "unknown" so
 * `checkCounterparty` itself never throws.
 */
export function createGoPlusBlacklistChecker(options: GoPlusBlacklistCheckerOptions): BlacklistChecker {
  const { chainId, apiKey } = options
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const fetchImpl = options.fetchImpl ?? globalThis.fetch

  const keyParam = apiKey ? `&api_key=${encodeURIComponent(apiKey)}` : ""

  async function queryAddressSecurity(address: string): Promise<BlacklistVerdict> {
    const url = `${GOPLUS_BASE_URL}/address_security/${address}?chain_id=${chainId}${keyParam}`
    return classifyAddressSecurity(await fetchJsonWithTimeout(url, fetchImpl, timeoutMs))
  }

  async function queryTokenSecurity(address: string): Promise<BlacklistVerdict> {
    const url = `${GOPLUS_BASE_URL}/token_security/${chainId}?contract_addresses=${address}${keyParam}`
    return classifyTokenSecurity(await fetchJsonWithTimeout(url, fetchImpl, timeoutMs), address)
  }

  return {
    async checkCounterparty(address: string): Promise<BlacklistVerdict> {
      // A malformed address can't be looked up; report "unknown" (couldn't
      // check) rather than guessing "clean".
      if (!isAddress(address)) return "unknown"

      const [addressVerdict, tokenVerdict] = await Promise.all([
        queryAddressSecurity(address).catch((): BlacklistVerdict => "unknown"),
        queryTokenSecurity(address).catch((): BlacklistVerdict => "unknown"),
      ])
      return combineVerdicts(addressVerdict, tokenVerdict)
    },
  }
}
