/**
 * Natural-language policy parser for Tripwire Guard configuration.
 *
 * Converts human-readable policy descriptions into the Guard's config
 * struct (per-tx limit, rolling limit, delay window).
 */

/** Parsed Guard configuration from natural language input. */
export interface ParsedPolicy {
  perTxLimit: string | null
  rollingLimit: string | null
  delayWindow: string | null
  explanation: string
}

/**
 * Parse a natural-language policy string into a Guard config struct.
 *
 * Handles common patterns:
 *   - "limit $500 per transaction"
 *   - "max $500 per tx, $5000 per day"
 *   - "delay everything 30 minutes"
 *   - "freeze on anything over $10000"
 *
 * Returns null for each field the input doesn't specify.
 */
export function parsePolicy(input: string): ParsedPolicy {
  const lower = input.toLowerCase()
  const explanations: string[] = []
  let perTxLimit: string | null = null
  let rollingLimit: string | null = null
  let delayWindow: string | null = null

  // Extract dollar amounts: "$500", "$1,000", "$10,000", etc.
  const dollarPattern = /\$[\d,]+(?:\.\d+)?/g
  const amounts = [...lower.matchAll(dollarPattern)].map((m) => {
    const num = parseFloat(m[0].replace(/[$,]/g, ""))
    // Convert dollars to wei (18 decimals) — approximate for display.
    return Math.round(num * 1e18).toString()
  })

  // Detect "per tx" / "per transaction" / "each transaction"
  const isPerTx = /per\s*(?:tx|transaction|send|transfer)/.test(lower)

  // Detect "per day" / "per 24h" / "rolling" / "daily"
  const isRolling = /per\s*(?:day|24h)|rolling|daily/.test(lower)

  // Detect delay: "delay 30 minutes", "wait 1 hour", "cooldown 2 hours"
  const delayMatch = lower.match(
    /(?:delay|wait|cooldown|cool\s*off)\s*(\d+)\s*(minutes?|hours?|hrs?|mins?)/,
  )
  if (delayMatch) {
    const value = parseInt(delayMatch[1])
    const unit = delayMatch[2]
    const seconds =
      unit.startsWith("hour") || unit.startsWith("hr") ? value * 3600 : value * 60
    delayWindow = seconds.toString()
    explanations.push(`Delay: ${value} ${unit}`)
  }

  // Detect "freeze" / "block" patterns
  const isFreeze = /freeze|block everything/.test(lower)

  // Parse amounts based on context
  if (amounts.length === 1) {
    if (isPerTx) {
      perTxLimit = amounts[0]
      explanations.push(`Per-transaction limit: $${extractDollar(input)}`)
    } else if (isRolling) {
      rollingLimit = amounts[0]
      explanations.push(`Daily rolling limit: $${extractDollar(input)}`)
    } else {
      // Default: if context is ambiguous, assume per-tx
      perTxLimit = amounts[0]
      explanations.push(`Per-transaction limit: $${extractDollar(input)}`)
    }
  } else if (amounts.length >= 2) {
    // First amount is per-tx, second is rolling
    perTxLimit = amounts[0]
    rollingLimit = amounts[1]
    const dollars = extractDollars(input)
    explanations.push(`Per-transaction limit: $${dollars[0]}`)
    explanations.push(`Daily rolling limit: $${dollars[1]}`)
  }

  if (isFreeze) {
    explanations.push("Emergency freeze enabled")
  }

  if (explanations.length === 0) {
    explanations.push(
      'Could not parse a specific policy from this input. Try: "limit $500 per tx, $5000 per day, delay 30 minutes"',
    )
  }

  return {
    perTxLimit,
    rollingLimit,
    delayWindow,
    explanation: explanations.join("; "),
  }
}

/** Extract the first dollar amount as a number string (without $ sign). */
function extractDollar(input: string): string {
  const match = input.match(/\$([\d,]+(?:\.\d+)?)/)
  return match ? match[1] : "0"
}

/** Extract all dollar amounts as number strings. */
function extractDollars(input: string): string[] {
  return [...input.matchAll(/\$([\d,]+(?:\.\d+)?)/g)].map((m) => m[1])
}

/** Format wei as a human-readable dollar amount for display. */
export function formatWei(wei: string): string {
  const num = parseFloat(wei)
  if (num >= 1e18) return `$${(num / 1e18).toLocaleString()}`
  if (num >= 1e15)
    return `$${(num / 1e15).toLocaleString(undefined, { maximumFractionDigits: 0 })}`
  return `$${(num / 1e18).toFixed(2)}`
}

/** Format seconds as a human-readable duration. */
export function formatDuration(seconds: string): string {
  const s = parseInt(seconds)
  if (s >= 3600) return `${s / 3600} hour(s)`
  return `${s / 60} minute(s)`
}
