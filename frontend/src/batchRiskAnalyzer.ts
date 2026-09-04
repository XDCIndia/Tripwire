/**
 * Issue #89: Multi-Transaction Batch Risk Matrix & Aggregate Risk Analysis
 *
 * Analyzes Safe batch transactions containing multiple internal calls.
 * Calculates risk at both individual call level and aggregate batch level.
 * Ensures a high-risk operation cannot be hidden inside a legitimate batch.
 */

// ─── Types ───────────────────────────────────────────────────────────

export type CallRiskLevel = "low" | "medium" | "high" | "critical"
export type BatchDecision = "allow" | "hold" | "block"

export interface InternalCall {
  /** Index within the batch */
  index: number
  /** Target contract/address */
  target: string
  /** Decoded function name or selector */
  functionSignature: string
  /** Raw calldata */
  calldata: string
  /** Value in wei */
  value: string
  /** Asset affected (if identifiable) */
  asset?: string
  /** Amount (if identifiable) */
  amount?: string
  /** Counterparty address */
  counterparty: string
  /** Risk signals triggered by this call */
  signals: string[]
  /** Human-readable explanation */
  explanation: string
}

export interface CallRisk {
  call: InternalCall
  /** Individual risk level */
  riskLevel: CallRiskLevel
  /** Risk score 0-100 */
  score: number
  /** Contribution to aggregate risk */
  contribution: "none" | "low" | "medium" | "high" | "critical"
}

export interface BatchRiskAnalysis {
  /** Batch identifier */
  batchId: string
  /** Number of internal calls */
  callCount: number
  /** Per-call risk analysis */
  callRisks: CallRisk[]
  /** Aggregate batch risk level */
  aggregateRisk: CallRiskLevel
  /** Aggregate score */
  aggregateScore: number
  /** Final enforcement decision */
  decision: BatchDecision
  /** Index of the highest-risk call */
  highestRiskIndex: number
  /** Summary of why the batch is risky */
  summary: string
  /** Breakdown by risk level */
  breakdown: { low: number; medium: number; high: number; critical: number }
}

// ─── Function selectors ──────────────────────────────────────────────

const SELECTORS: Record<string, string> = {
  "0x095ea7b3": "approve(address,uint256)",
  "0xa22cb465": "setApprovalForAll(address,bool)",
  "0xa9059cbb": "transfer(address,uint256)",
  "0x23b872dd": "transferFrom(address,address,uint256)",
  "0xd505accf": "permit(address,address,uint256,uint256,uint8,bytes32,bytes32)",
  "0x3805550f": "executeBatch",
}

const MAX_UINT256 = (1n << 256n) - 1n

// ─── Risk classification ─────────────────────────────────────────────

function classifyCallRisk(call: InternalCall): CallRisk {
  const signals: string[] = []
  let score = 0

  const selector = call.calldata.slice(0, 10).toLowerCase()

  // Approve with unlimited amount
  if (selector === "0x095ea7b3") {
    const amountWord = call.calldata.slice(74, 138)
    if (BigInt(`0x${amountWord}`) === MAX_UINT256) {
      score += 45
      signals.push("unlimited-approval")
    } else {
      score += 15
      signals.push("limited-approval")
    }
  }

  // setApprovalForAll
  if (selector === "0xa22cb465") {
    score += 40
    signals.push("blanket-operator-permission")
  }

  // Unknown contract interaction
  if (!SELECTORS[selector] && selector !== "0x") {
    score += 20
    signals.push("unknown-contract-interaction")
  }

  // First-seen counterparty (placeholder — real impl would check history)
  if (signals.length === 0 && selector !== "0x") {
    score += 5
  }

  // Empty calldata with value = native transfer
  if (selector === "0x" && call.value !== "0") {
    score += 5
    signals.push("native-transfer")
  }

  score = Math.min(score, 100)

  let riskLevel: CallRiskLevel
  let contribution: CallRisk["contribution"]
  if (score >= 70) {
    riskLevel = "critical"
    contribution = "critical"
  } else if (score >= 40) {
    riskLevel = "high"
    contribution = "high"
  } else if (score >= 20) {
    riskLevel = "medium"
    contribution = "medium"
  } else {
    riskLevel = "low"
    contribution = "low"
  }

  const funcName = SELECTORS[selector] ?? `unknown(${selector})`

  return {
    call: {
      ...call,
      functionSignature: funcName,
    },
    riskLevel,
    score,
    contribution,
  }
}

// ─── Aggregate analysis ──────────────────────────────────────────────

function calculateAggregate(callRisks: CallRisk[]): {
  aggregateRisk: CallRiskLevel
  aggregateScore: number
  decision: BatchDecision
  highestRiskIndex: number
  breakdown: { low: number; medium: number; high: number; critical: number }
} {
  const breakdown = { low: 0, medium: 0, high: 0, critical: 0 }
  let maxScore = 0
  let highestRiskIndex = 0

  for (const cr of callRisks) {
    breakdown[cr.riskLevel]++
    if (cr.score > maxScore) {
      maxScore = cr.score
      highestRiskIndex = cr.call.index
    }
  }

  // Aggregate risk is dominated by the highest-risk call
  let aggregateRisk: CallRiskLevel
  let decision: BatchDecision

  if (breakdown.critical > 0) {
    aggregateRisk = "critical"
    decision = "block"
  } else if (breakdown.high > 0) {
    aggregateRisk = "high"
    decision = "block"
  } else if (breakdown.medium > 0) {
    aggregateRisk = "medium"
    decision = "hold"
  } else {
    aggregateRisk = "low"
    decision = "allow"
  }

  return { aggregateRisk, aggregateScore: maxScore, decision, highestRiskIndex, breakdown }
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Analyze a batch of internal calls and produce a full risk matrix.
 */
export function analyzeBatch(
  batchId: string,
  calls: InternalCall[],
): BatchRiskAnalysis {
  // Classify each call
  const callRisks = calls.map((call) => classifyCallRisk(call))

  // Calculate aggregate
  const { aggregateRisk, aggregateScore, decision, highestRiskIndex, breakdown } =
    calculateAggregate(callRisks)

  // Build summary
  const criticalCalls = callRisks.filter((cr) => cr.riskLevel === "critical")
  let summary: string
  if (criticalCalls.length > 0) {
    const fn = criticalCalls[0].call.functionSignature
    summary = `Batch contains ${criticalCalls.length} critical operation(s). Call #${criticalCalls[0].call.index + 1} (${fn}) raises aggregate risk above blocking threshold.`
  } else if (breakdown.high > 0) {
    summary = `Batch contains ${breakdown.high} high-risk operation(s). Aggregate risk requires blocking.`
  } else if (breakdown.medium > 0) {
    summary = `Batch contains ${breakdown.medium} medium-risk operation(s). Aggregate risk requires holding for review.`
  } else {
    summary = `All ${calls.length} operation(s) are low risk. Batch is safe to execute.`
  }

  return {
    batchId,
    callCount: calls.length,
    callRisks,
    aggregateRisk,
    aggregateScore,
    decision,
    highestRiskIndex,
    summary,
    breakdown,
  }
}

/**
 * Format a function signature for display.
 */
export function formatFunction(sig: string): string {
  return sig.length > 40 ? `${sig.slice(0, 37)}…` : sig
}
