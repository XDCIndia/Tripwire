/**
 * Issue #97: Nonce & Transaction Replacement Conflict Detection
 *
 * Detects stale, replaced, conflicting, or superseded transactions by
 * tracking nonce and execution state. Groups transactions sharing the
 * same nonce and identifies the active vs superseded ones.
 */

// ─── Transaction types ───────────────────────────────────────────────

export type TxState =
  | "active"
  | "pending"
  | "replaced"
  | "superseded"
  | "confirmed"
  | "reverted"
  | "stale"
  | "unknown"

export interface NonceTransaction {
  txHash: string
  nonce: number
  from: string
  to: string
  state: TxState
  /** Individual transaction risk from the risk engine */
  risk?: "low" | "medium" | "high"
  /** Human-readable description of what this tx does */
  description?: string
  /** Block number if confirmed */
  blockNumber?: number
  /** Timestamp (unix seconds) */
  timestamp?: number
  /** Gas price or priority fee for comparison */
  gasPrice?: bigint
}

export interface NonceConflict {
  /** The nonce all these transactions share */
  nonce: number
  /** All transactions at this nonce, sorted by timestamp */
  transactions: NonceTransaction[]
  /** The currently active transaction (if any) */
  active: NonceTransaction | null
  /** Whether a conflict exists (more than one tx at this nonce) */
  hasConflict: boolean
}

// ─── Detection logic ─────────────────────────────────────────────────

/**
 * Given a list of transactions, group by nonce and detect conflicts.
 * Returns one NonceConflict per nonce.
 */
export function detectNonceConflicts(transactions: NonceTransaction[]): NonceConflict[] {
  // Group by nonce
  const byNonce = new Map<number, NonceTransaction[]>()
  for (const tx of transactions) {
    const existing = byNonce.get(tx.nonce)
    if (existing) {
      existing.push(tx)
    } else {
      byNonce.set(tx.nonce, [tx])
    }
  }

  const conflicts: NonceConflict[] = []

  for (const [nonce, txs] of byNonce) {
    // Sort by timestamp, newest first
    txs.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0))

    // Determine the active transaction
    // Priority: confirmed > active > pending > unknown
    const active = findActiveTransaction(txs)
    const hasConflict = txs.length > 1

    // Mark superseded transactions
    if (active) {
      for (const tx of txs) {
        if (tx.txHash !== active.txHash && tx.state !== "confirmed" && tx.state !== "reverted") {
          tx.state = "superseded"
        }
      }
    }

    conflicts.push({ nonce, transactions: txs, active, hasConflict })
  }

  // Sort by nonce
  conflicts.sort((a, b) => a.nonce - b.nonce)
  return conflicts
}

/**
 * Find the active transaction from a group sharing the same nonce.
 *
 * Priority order:
 * 1. Confirmed (on-chain executed)
 * 2. Active (explicitly marked active)
 * 3. Pending (in mempool, not yet replaced)
 * 4. Unknown (unrecognized state)
 */
function findActiveTransaction(txs: NonceTransaction[]): NonceTransaction | null {
  // Priority 1: confirmed
  const confirmed = txs.find((tx) => tx.state === "confirmed")
  if (confirmed) return confirmed

  // Priority 2: active
  const active = txs.find((tx) => tx.state === "active")
  if (active) return active

  // Priority 3: pending
  const pending = txs.find((tx) => tx.state === "pending")
  if (pending) return pending

  // Priority 4: unknown — never treat as active
  return null
}

/**
 * Calculate the risk invalidation status for a superseded transaction.
 * Returns a warning if the superseded tx had a risk decision that is
 * now stale.
 */
export function getInvalidationWarning(
  supersededTx: NonceTransaction,
  activeTx: NonceTransaction | null,
): string | null {
  if (!activeTx) return null
  if (supersededTx.risk === undefined) return null

  return `Risk decision (${supersededTx.risk.toUpperCase()}) on ${shortHash(supersededTx.txHash)} is no longer valid. Active transaction is ${shortHash(activeTx.txHash)}.`
}

// ─── Helpers ─────────────────────────────────────────────────────────

function shortHash(hash: string): string {
  return hash.length > 12 ? `${hash.slice(0, 8)}…${hash.slice(-4)}` : hash
}

export { shortHash }

/**
 * Get the overall conflict severity for display.
 */
export function getConflictSeverity(conflict: NonceConflict): "critical" | "high" | "medium" | "low" {
  if (!conflict.hasConflict) return "low"

  // Check if the active tx is high risk
  if (conflict.active?.risk === "high") return "critical"

  // Check if any superseded tx had a different risk level
  const risks = new Set(conflict.transactions.map((tx) => tx.risk).filter(Boolean))
  if (risks.size > 1) return "high"

  // Multiple transactions at same nonce is at least medium
  if (conflict.transactions.length > 2) return "high"
  return "medium"
}
