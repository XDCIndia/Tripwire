/**
 * Issue #96: Execution Authorization Drift Detection
 *
 * Binds a security decision to the exact transaction that was reviewed.
 * If any security-critical field changes after authorization, the
 * authorization is invalidated and the user must re-review.
 */

// ─── Types ───────────────────────────────────────────────────────────

export type AuthStatus = "valid" | "invalid" | "unknown"

export type SecurityField =
  | "target"
  | "value"
  | "calldata"
  | "nonce"
  | "chain"
  | "safe"

export interface TransactionSnapshot {
  /** Target contract address */
  target: string
  /** Value in wei */
  value: string
  /** Full calldata */
  calldata: string
  /** Transaction nonce */
  nonce: number
  /** Chain ID */
  chainId: number
  /** Safe wallet address */
  safeAddress: string
}

export interface AuthorizationSnapshot {
  /** The transaction that was reviewed and authorized */
  transaction: TransactionSnapshot
  /** Risk decision at time of authorization */
  riskDecision: {
    score: number
    label: string
    action: string
  }
  /** ISO timestamp of when authorization was created */
  authorizedAt: string
  /** Who authorized it (wallet address) */
  authorizedBy: string
}

export interface DriftResult {
  /** Whether the authorization is still valid */
  status: AuthStatus
  /** Which fields have changed */
  changedFields: SecurityField[]
  /** Per-field comparison details */
  fieldDetails: FieldComparison[]
  /** Human-readable summary */
  summary: string
}

export interface FieldComparison {
  field: SecurityField
  matches: boolean
  reviewed: string
  current: string
}

// ─── Core functions ──────────────────────────────────────────────────

/**
 * Create an authorization snapshot from a reviewed transaction.
 * This is the "lock-in" point — the exact state the user approved.
 */
export function createAuthorization(
  transaction: TransactionSnapshot,
  riskDecision: AuthorizationSnapshot["riskDecision"],
  authorizedBy: string,
): AuthorizationSnapshot {
  return {
    transaction: { ...transaction },
    riskDecision: { ...riskDecision },
    authorizedAt: new Date().toISOString(),
    authorizedBy,
  }
}

/**
 * Compare the current transaction against the authorized snapshot.
 * Returns drift details if any security-critical field has changed.
 */
export function checkAuthorization(
  auth: AuthorizationSnapshot | null,
  current: TransactionSnapshot,
): DriftResult {
  if (!auth) {
    return {
      status: "unknown",
      changedFields: [],
      fieldDetails: [],
      summary: "No authorization exists. Review the transaction before executing.",
    }
  }

  const fields: SecurityField[] = ["target", "value", "calldata", "nonce", "chain", "safe"]
  const fieldDetails: FieldComparison[] = []
  const changedFields: SecurityField[] = []

  for (const field of fields) {
    let reviewed: string
    let currentVal: string
    let matches: boolean

    switch (field) {
      case "target":
        reviewed = auth.transaction.target.toLowerCase()
        currentVal = current.target.toLowerCase()
        matches = reviewed === currentVal
        break
      case "value":
        reviewed = auth.transaction.value
        currentVal = current.value
        matches = reviewed === currentVal
        break
      case "calldata":
        reviewed = auth.transaction.calldata.toLowerCase()
        currentVal = current.calldata.toLowerCase()
        matches = reviewed === currentVal
        break
      case "nonce":
        reviewed = String(auth.transaction.nonce)
        currentVal = String(current.nonce)
        matches = reviewed === currentVal
        break
      case "chain":
        reviewed = String(auth.transaction.chainId)
        currentVal = String(current.chainId)
        matches = reviewed === currentVal
        break
      case "safe":
        reviewed = auth.transaction.safeAddress.toLowerCase()
        currentVal = current.safeAddress.toLowerCase()
        matches = reviewed === currentVal
        break
    }

    fieldDetails.push({ field, matches, reviewed, current: currentVal })
    if (!matches) changedFields.push(field)
  }

  const status: AuthStatus = changedFields.length === 0 ? "valid" : "invalid"

  let summary: string
  if (status === "valid") {
    summary = "Authorization is valid. The transaction matches the reviewed version."
  } else {
    const fieldList = changedFields.join(", ")
    summary = `Authorization INVALID. Changed field${changedFields.length !== 1 ? "s" : ""}: ${fieldList}. Re-review required.`
  }

  return { status, changedFields, fieldDetails, summary }
}

/**
 * Final integrity check before execution.
 * Returns true only if authorization is valid and matches.
 */
export function canExecute(
  auth: AuthorizationSnapshot | null,
  current: TransactionSnapshot,
): { allowed: boolean; reason: string } {
  if (!auth) {
    return { allowed: false, reason: "No authorization exists." }
  }

  const drift = checkAuthorization(auth, current)
  if (drift.status === "invalid") {
    return {
      allowed: false,
      reason: `Transaction changed after review. Changed: ${drift.changedFields.join(", ")}.`,
    }
  }

  return { allowed: true, reason: "Authorization verified. Transaction matches reviewed version." }
}
