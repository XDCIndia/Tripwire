/**
 * Issue #92: Transaction Simulation Result Integrity & Mismatch Detection
 *
 * Binds every simulation result to the exact transaction that was analyzed.
 * If any security-critical field changes after simulation, the previous
 * simulation result is immediately invalidated.
 */

// ─── Types ───────────────────────────────────────────────────────────

export type SimulationStatus = "verified" | "invalid" | "unknown" | "expired"

export type IntegrityField =
  | "chain"
  | "safe"
  | "target"
  | "value"
  | "calldata"
  | "operation"
  | "nonce"

export interface TransactionFingerprint {
  chainId: number
  safeAddress: string
  target: string
  value: string
  calldata: string
  operation: string
  nonce: number
}

export interface SimulationResult {
  /** The transaction this simulation analyzed */
  fingerprint: TransactionFingerprint
  /** Simulation outcome */
  outcome: "safe" | "warning" | "danger"
  /** Human-readable summary of what the simulation found */
  summary: string
  /** State changes detected by simulation */
  stateChanges: string[]
  /** ISO timestamp of when simulation was run */
  simulatedAt: string
}

export interface IntegrityCheck {
  status: SimulationStatus
  /** Which fields have changed */
  changedFields: IntegrityField[]
  /** Per-field comparison details */
  fieldDetails: FieldComparison[]
  /** Human-readable explanation */
  explanation: string
}

export interface FieldComparison {
  field: IntegrityField
  matches: boolean
  simulated: string
  current: string
}

// ─── Fingerprint creation ────────────────────────────────────────────

/**
 * Create a fingerprint from a transaction. This is the identity
 * the simulation result is bound to.
 */
export function createFingerprint(tx: {
  chainId: number
  safeAddress: string
  target: string
  value: string
  calldata: string
  operation?: string
  nonce: number
}): TransactionFingerprint {
  return {
    chainId: tx.chainId,
    safeAddress: tx.safeAddress.toLowerCase(),
    target: tx.target.toLowerCase(),
    value: tx.value,
    calldata: tx.calldata.toLowerCase(),
    operation: tx.operation ?? "call",
    nonce: tx.nonce,
  }
}

// ─── Integrity checking ──────────────────────────────────────────────

/**
 * Compare the current transaction against the simulated fingerprint.
 * Returns integrity details if any security-critical field has changed.
 */
export function checkIntegrity(
  simulation: SimulationResult | null,
  current: TransactionFingerprint,
): IntegrityCheck {
  if (!simulation) {
    return {
      status: "unknown",
      changedFields: [],
      fieldDetails: [],
      explanation: "No simulation exists. Run a simulation before executing.",
    }
  }

  const fields: IntegrityField[] = ["chain", "safe", "target", "value", "calldata", "operation", "nonce"]
  const fieldDetails: FieldComparison[] = []
  const changedFields: IntegrityField[] = []
  const sim = simulation.fingerprint

  for (const field of fields) {
    let simulated: string
    let currentVal: string
    let matches: boolean

    switch (field) {
      case "chain":
        simulated = String(sim.chainId)
        currentVal = String(current.chainId)
        matches = simulated === currentVal
        break
      case "safe":
        simulated = sim.safeAddress.toLowerCase()
        currentVal = current.safeAddress.toLowerCase()
        matches = simulated === currentVal
        break
      case "target":
        simulated = sim.target.toLowerCase()
        currentVal = current.target.toLowerCase()
        matches = simulated === currentVal
        break
      case "value":
        simulated = sim.value
        currentVal = current.value
        matches = simulated === currentVal
        break
      case "calldata":
        simulated = sim.calldata.toLowerCase()
        currentVal = current.calldata.toLowerCase()
        matches = simulated === currentVal
        break
      case "operation":
        simulated = sim.operation
        currentVal = current.operation
        matches = simulated === currentVal
        break
      case "nonce":
        simulated = String(sim.nonce)
        currentVal = String(current.nonce)
        matches = simulated === currentVal
        break
    }

    fieldDetails.push({ field, matches, simulated, current: currentVal })
    if (!matches) changedFields.push(field)
  }

  const status: SimulationStatus = changedFields.length === 0 ? "verified" : "invalid"

  let explanation: string
  if (status === "verified") {
    explanation = "Simulation is valid. The current transaction matches the simulated version."
  } else {
    const fieldList = changedFields.join(", ")
    explanation = `Simulation INVALID. Changed field${changedFields.length !== 1 ? "s" : ""}: ${fieldList}. The previous simulation cannot be trusted.`
  }

  return { status, changedFields, fieldDetails, explanation }
}

/**
 * Final integrity check before execution.
 * Returns true only if simulation is verified and matches.
 */
export function canUseSimulation(
  simulation: SimulationResult | null,
  current: TransactionFingerprint,
): { allowed: boolean; reason: string } {
  if (!simulation) {
    return { allowed: false, reason: "No simulation exists." }
  }

  const integrity = checkIntegrity(simulation, current)
  if (integrity.status === "invalid") {
    return {
      allowed: false,
      reason: `Transaction changed after simulation. Changed: ${integrity.changedFields.join(", ")}.`,
    }
  }

  return { allowed: true, reason: "Simulation verified. Result is safe to use." }
}
