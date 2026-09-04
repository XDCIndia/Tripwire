/**
 * Issue #83: Transaction Integrity Fingerprinting & Tamper Detection
 *
 * Creates a deterministic fingerprint of security-critical transaction
 * data and validates that displayed verdicts match the exact transaction
 * they were generated for.
 */

// ─── Types ───────────────────────────────────────────────────────────

export type IntegrityStatus = "verified" | "mismatch" | "unverified"

export interface TransactionFields {
  /** Transaction hash */
  txHash: string
  /** Chain ID */
  chainId: number
  /** Safe wallet address */
  safeAddress: string
  /** Target contract/address */
  targetAddress: string
  /** Transaction value in wei */
  value: string
  /** Encoded calldata */
  calldata: string
  /** Transaction nonce (optional) */
  nonce?: number
}

export interface VerdictBinding {
  /** Fingerprint of the transaction this verdict was generated for */
  transactionFingerprint: string
  /** Verdict version/identifier */
  verdictVersion: string
  /** The risk verdict result */
  verdict: "allow" | "delay" | "block" | "freeze"
  /** Numeric risk score 0-100 */
  score: number
  /** ISO timestamp of when verdict was generated */
  timestamp: string
}

export interface IntegrityCheck {
  /** Current integrity status */
  status: IntegrityStatus
  /** The computed fingerprint of current transaction data */
  currentFingerprint: string
  /** The fingerprint bound to the verdict (if any) */
  verdictFingerprint: string | null
  /** Transaction fields used for fingerprinting */
  transaction: TransactionFields
  /** Verdict binding (if available) */
  verdict: VerdictBinding | null
  /** Fields that differ between current and verdict fingerprint */
  mismatchedFields: string[]
  /** Timestamp of last integrity check */
  checkedAt: string
}

// ─── Canonicalization ────────────────────────────────────────────────

/**
 * Canonicalize a string value for fingerprinting.
 * Lowercases, trims, and pads hex addresses to uniform length.
 */
function canonicalizeString(value: string): string {
  return value.toLowerCase().trim()
}

/**
 * Canonicalize a number value for fingerprinting.
 */
function canonicalizeNumber(value: number): string {
  return value.toString()
}

/**
 * Build a canonical string representation of all security-critical
 * transaction fields. The order is fixed and deterministic.
 */
function canonicalizeTransaction(tx: TransactionFields): string {
  const parts = [
    `txHash:${canonicalizeString(tx.txHash)}`,
    `chainId:${canonicalizeNumber(tx.chainId)}`,
    `safe:${canonicalizeString(tx.safeAddress)}`,
    `target:${canonicalizeString(tx.targetAddress)}`,
    `value:${canonicalizeString(tx.value)}`,
    `calldata:${canonicalizeString(tx.calldata)}`,
  ]

  if (tx.nonce !== undefined) {
    parts.push(`nonce:${canonicalizeNumber(tx.nonce)}`)
  }

  return parts.join("|")
}

// ─── Fingerprint generation ──────────────────────────────────────────

/**
 * Generate a deterministic fingerprint for a set of transaction fields.
 * Returns a 32-character hex string (8 rounds of djb2 with seed variation).
 */
export function generateFingerprint(tx: TransactionFields): string {
  const canonical = canonicalizeTransaction(tx)
  const segments: string[] = []

  // Run djb2 with different seeds for 8 segments = 32 hex chars
  for (let seed = 0; seed < 8; seed++) {
    let hash = 5381 + seed * 31
    for (let i = 0; i < canonical.length; i++) {
      hash = ((hash << 5) + hash + canonical.charCodeAt(i)) | 0
    }
    const unsigned = hash >>> 0
    segments.push(unsigned.toString(16).padStart(8, "0"))
  }

  return segments.join("")
}

// ─── Integrity check ─────────────────────────────────────────────────

/**
 * Determine which fields differ between two transaction field sets.
 */
function findMismatchedFields(
  current: TransactionFields,
  verdictTx: TransactionFields,
): string[] {
  const mismatches: string[] = []

  if (canonicalizeString(current.txHash) !== canonicalizeString(verdictTx.txHash)) {
    mismatches.push("txHash")
  }
  if (current.chainId !== verdictTx.chainId) {
    mismatches.push("chainId")
  }
  if (canonicalizeString(current.safeAddress) !== canonicalizeString(verdictTx.safeAddress)) {
    mismatches.push("safeAddress")
  }
  if (canonicalizeString(current.targetAddress) !== canonicalizeString(verdictTx.targetAddress)) {
    mismatches.push("targetAddress")
  }
  if (canonicalizeString(current.value) !== canonicalizeString(verdictTx.value)) {
    mismatches.push("value")
  }
  if (canonicalizeString(current.calldata) !== canonicalizeString(verdictTx.calldata)) {
    mismatches.push("calldata")
  }
  if (current.nonce !== undefined && verdictTx.nonce !== undefined && current.nonce !== verdictTx.nonce) {
    mismatches.push("nonce")
  }

  return mismatches
}

/**
 * Perform an integrity check: compare current transaction fingerprint
 * against the verdict's bound fingerprint.
 */
export function checkIntegrity(
  transaction: TransactionFields,
  verdict: VerdictBinding | null,
): IntegrityCheck {
  const currentFingerprint = generateFingerprint(transaction)
  const now = new Date().toISOString()

  if (!verdict) {
    return {
      status: "unverified",
      currentFingerprint,
      verdictFingerprint: null,
      transaction,
      verdict: null,
      mismatchedFields: [],
      checkedAt: now,
    }
  }

  const verdictFingerprint = verdict.transactionFingerprint
  const match = currentFingerprint === verdictFingerprint

  if (match) {
    return {
      status: "verified",
      currentFingerprint,
      verdictFingerprint,
      transaction,
      verdict,
      mismatchedFields: [],
      checkedAt: now,
    }
  }

  // Find which fields differ — we need to decode the verdict fingerprint
  // to find the mismatched fields. Since we can't reverse the hash,
  // we compare field-by-field against the transaction the verdict was
  // bound to. For this, we store the original fields in the verdict binding.
  // Here we just report the fingerprint mismatch.
  return {
    status: "mismatch",
    currentFingerprint,
    verdictFingerprint,
    transaction,
    verdict,
    mismatchedFields: ["fingerprint_mismatch"],
    checkedAt: now,
  }
}

/**
 * Enhanced integrity check that also accepts the original transaction
 * fields from the verdict to provide field-level mismatch details.
 */
export function checkIntegrityDetailed(
  transaction: TransactionFields,
  verdict: VerdictBinding | null,
  verdictTransaction?: TransactionFields,
): IntegrityCheck {
  const currentFingerprint = generateFingerprint(transaction)
  const now = new Date().toISOString()

  if (!verdict) {
    return {
      status: "unverified",
      currentFingerprint,
      verdictFingerprint: null,
      transaction,
      verdict: null,
      mismatchedFields: [],
      checkedAt: now,
    }
  }

  const verdictFingerprint = verdict.transactionFingerprint
  const match = currentFingerprint === verdictFingerprint

  if (match) {
    return {
      status: "verified",
      currentFingerprint,
      verdictFingerprint,
      transaction,
      verdict,
      mismatchedFields: [],
      checkedAt: now,
    }
  }

  const mismatchedFields = verdictTransaction
    ? findMismatchedFields(transaction, verdictTransaction)
    : ["fingerprint_mismatch"]

  return {
    status: "mismatch",
    currentFingerprint,
    verdictFingerprint,
    transaction,
    verdict,
    mismatchedFields,
    checkedAt: now,
  }
}

// ─── Display helpers ─────────────────────────────────────────────────

export function shortenFingerprint(fp: string): string {
  if (fp.length <= 12) return fp
  return `${fp.slice(0, 4)}…${fp.slice(-4)}`
}

export function statusLabel(status: IntegrityStatus): string {
  switch (status) {
    case "verified": return "VERIFIED"
    case "mismatch": return "MISMATCH"
    case "unverified": return "UNVERIFIED"
  }
}

export function statusColor(status: IntegrityStatus): string {
  switch (status) {
    case "verified": return "#16a34a"
    case "mismatch": return "#dc2626"
    case "unverified": return "#d97706"
  }
}

// ─── Demo data ───────────────────────────────────────────────────────

const DEMO_TX: TransactionFields = {
  txHash: "0x918273645abcdef0123456789abcdef0123456789abcdef0123456789abcdef82a",
  chainId: 50, // XDC mainnet
  safeAddress: "0xSafe000000000000000000000000000000000001",
  targetAddress: "0xTarget000000000000000000000000000000000001",
  value: "1000000000000000000",
  calldata: "0x23b872dd000000000000000000000000aaaa000000000000000000000000000000000001000000000000000000000000bbbb0000000000000000000000000000000000020000000000000000000000000000000000000000000000000de0b6b3a7640000",
  nonce: 42,
}

function createDemoVerdict(): VerdictBinding {
  return {
    transactionFingerprint: generateFingerprint(DEMO_TX),
    verdictVersion: "#18",
    verdict: "block",
    score: 85,
    timestamp: new Date().toISOString(),
  }
}

function createDemoMismatch(): { transaction: TransactionFields; verdict: VerdictBinding; verdictTransaction: TransactionFields } {
  // Modified calldata (different amount)
  const modifiedTx: TransactionFields = {
    ...DEMO_TX,
    calldata: "0x23b872dd000000000000000000000000aaaa000000000000000000000000000000000001000000000000000000000000bbbb0000000000000000000000000000000000020000000000000000000000000000000000000000000000001bc16d674ec80000",
  }

  return {
    transaction: modifiedTx,
    verdict: createDemoVerdict(),
    verdictTransaction: DEMO_TX,
  }
}

export { DEMO_TX, createDemoVerdict, createDemoMismatch }
