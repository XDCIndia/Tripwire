/**
 * Issue #78: Risk Engine Fail-Closed Security Boundary
 *
 * Admission-control layer that validates every risk verdict before
 * enforcement. Guarantees unsafe or insufficiently analyzed transactions
 * cannot proceed when the risk system is unavailable, incomplete,
 * inconsistent, or compromised.
 *
 * Design: deterministic fail-closed. If any required check cannot be
 * positively confirmed, the verdict is rejected (HOLD/BLOCK) — never
 * silently allowed.
 */

// ─── Types ───────────────────────────────────────────────────────────

export type AdmissionOutcome = "admit" | "hold" | "block"

export type CriticalDependency =
  | "rule_engine"
  | "simulation"
  | "wallet_analysis"
  | "ai_assessment"

export interface AdmissionRequest {
  /** Transaction being evaluated */
  transaction: {
    safeAddress: string
    chainId: number
    txHash: string
  }

  /** The verdict to validate */
  verdict: {
    verdictId: string
    score: number // 0-100
    status: string // low_risk, medium_risk, high_risk
    action: string // allow, delay, block
  }

  /** Which analysis components completed */
  analysisIntegrity: {
    rulesComplete: boolean
    simulationComplete: boolean
    walletAnalysisComplete: boolean
    aiAssessmentComplete: boolean
  }

  /** Policy/model version references */
  policyIntegrity: {
    policyVersion: string
    ruleVersion: string
    modelVersion: string
  }

  /** The transaction hash that was actually analyzed */
  analyzedTxHash: string

  /** When the verdict was generated */
  verdictTimestamp: string

  /** When the verdict was created (for freshness check) */
  createdAt: string

  /** Critical dependency availability */
  dependencyStatus: Record<CriticalDependency, "available" | "unavailable" | "degraded">

  /** Configurable security thresholds */
  thresholds: {
    /** Score at or above which action must be block (default 70) */
    highRiskThreshold: number
    /** Score at or above which action must be delay (default 30) */
    mediumRiskThreshold: number
    /** Maximum age of a verdict before it's considered stale (seconds) */
    maxVerdictAgeSeconds: number
    /** Whether fail-closed mode is enabled (default true) */
    failClosed: boolean
  }
}

export interface AdmissionCheck {
  name: string
  passed: boolean
  reason: string
}

export interface AdmissionResult {
  /** Final outcome */
  outcome: AdmissionOutcome
  /** All checks performed */
  checks: AdmissionCheck[]
  /** Why the outcome was chosen */
  reason: string
  /** Timestamp of this admission decision */
  decidedAt: string
  /** The original request (for audit trail) */
  requestHash: string
}

// ─── Default thresholds ──────────────────────────────────────────────

const DEFAULT_THRESHOLDS = {
  highRiskThreshold: 70,
  mediumRiskThreshold: 30,
  maxVerdictAgeSeconds: 5 * 60, // 5 minutes
  failClosed: true,
}

// ─── Admission boundary ──────────────────────────────────────────────

/**
 * Validate a verdict against all security conditions.
 * Deterministic: same input always produces same output.
 */
export function evaluateAdmission(
  request: AdmissionRequest,
  now: Date = new Date(),
): AdmissionResult {
  const checks: AdmissionCheck[] = []
  const thresholds = { ...DEFAULT_THRESHOLDS, ...request.thresholds }

  // 1. Transaction identity validation
  checks.push(checkTransactionIdentity(request))

  // 2. Analysis completeness
  checks.push(checkAnalysisCompleteness(request))

  // 3. Policy version validity
  checks.push(checkPolicyVersions(request))

  // 4. Verdict freshness
  checks.push(checkVerdictFreshness(request, now, thresholds.maxVerdictAgeSeconds))

  // 5. Risk threshold validation
  checks.push(checkRiskThresholds(request.verdict, thresholds))

  // 6. Critical dependency check
  checks.push(checkCriticalDependencies(request.dependencyStatus, thresholds.failClosed))

  // 7. Verdict internal consistency
  checks.push(checkVerdictConsistency(request.verdict))

  // Determine outcome: any failed check => fail-closed
  const failedChecks = checks.filter((c) => !c.passed)
  const allPassed = failedChecks.length === 0

  let outcome: AdmissionOutcome
  let reason: string

  if (allPassed) {
    outcome = "admit"
    reason = "All security checks passed — verdict admitted for enforcement"
  } else {
    // Fail-closed: determine whether to HOLD or BLOCK
    const hasDependencyFailure = failedChecks.some(
      (c) => c.name === "critical_dependencies" || c.name === "analysis_completeness",
    )
    const hasIdentityFailure = failedChecks.some((c) => c.name === "transaction_identity")
    const hasPolicyFailure = failedChecks.some((c) => c.name === "policy_versions")

    if (hasIdentityFailure || hasPolicyFailure) {
      // Identity or policy mismatch => BLOCK (could be spoofed)
      outcome = "block"
      reason = `BLOCKED: ${failedChecks.map((c) => c.reason).join("; ")}`
    } else if (hasDependencyFailure) {
      // Dependency unavailable => HOLD (retryable)
      outcome = "hold"
      reason = `HELD: ${failedChecks.map((c) => c.reason).join("; ")}`
    } else {
      // Other failures => BLOCK (fail-closed default)
      outcome = thresholds.failClosed ? "block" : "hold"
      reason = `${outcome === "block" ? "BLOCKED" : "HELD"} (fail-closed): ${failedChecks.map((c) => c.reason).join("; ")}`
    }
  }

  return {
    outcome,
    checks,
    reason,
    decidedAt: now.toISOString(),
    requestHash: hashRequest(request),
  }
}

// ─── Individual checks ───────────────────────────────────────────────

function checkTransactionIdentity(request: AdmissionRequest): AdmissionCheck {
  const match = request.analyzedTxHash.toLowerCase() === request.transaction.txHash.toLowerCase()
  return {
    name: "transaction_identity",
    passed: match,
    reason: match
      ? "Transaction identity verified"
      : `Transaction hash mismatch: verdict analyzed ${request.analyzedTxHash} but enforcement targets ${request.transaction.txHash}`,
  }
}

function checkAnalysisCompleteness(request: AdmissionRequest): AdmissionCheck {
  const { analysisIntegrity } = request
  const incomplete: string[] = []
  if (!analysisIntegrity.rulesComplete) incomplete.push("rules")
  if (!analysisIntegrity.simulationComplete) incomplete.push("simulation")
  if (!analysisIntegrity.walletAnalysisComplete) incomplete.push("wallet_analysis")
  if (!analysisIntegrity.aiAssessmentComplete) incomplete.push("ai_assessment")

  const passed = incomplete.length === 0
  return {
    name: "analysis_completeness",
    passed,
    reason: passed
      ? "All required analysis components completed"
      : `Incomplete analysis: ${incomplete.join(", ")} not completed`,
  }
}

function checkPolicyVersions(request: AdmissionRequest): AdmissionCheck {
  const { policyIntegrity } = request
  const invalid: string[] = []
  if (!policyIntegrity.policyVersion || policyIntegrity.policyVersion === "invalid") invalid.push("policy")
  if (!policyIntegrity.ruleVersion || policyIntegrity.ruleVersion === "invalid") invalid.push("rules")
  if (!policyIntegrity.modelVersion || policyIntegrity.modelVersion === "invalid") invalid.push("model")

  const passed = invalid.length === 0
  return {
    name: "policy_versions",
    passed,
    reason: passed
      ? "All policy/model versions valid"
      : `Invalid version references: ${invalid.join(", ")}`,
  }
}

function checkVerdictFreshness(
  request: AdmissionRequest,
  now: Date,
  maxAgeSeconds: number,
): AdmissionCheck {
  const verdictTime = new Date(request.createdAt).getTime()
  const ageMs = now.getTime() - verdictTime
  const ageSeconds = ageMs / 1000
  const passed = ageSeconds <= maxAgeSeconds

  return {
    name: "verdict_freshness",
    passed,
    reason: passed
      ? `Verdict is fresh (${Math.round(ageSeconds)}s old, max ${maxAgeSeconds}s)`
      : `Verdict expired: ${Math.round(ageSeconds)}s old (max ${maxAgeSeconds}s)`,
  }
}

function checkRiskThresholds(
  verdict: AdmissionRequest["verdict"],
  thresholds: AdmissionRequest["thresholds"],
): AdmissionCheck {
  const { score, action } = verdict
  let expectedAction: string

  if (score >= thresholds.highRiskThreshold) {
    expectedAction = "block"
  } else if (score >= thresholds.mediumRiskThreshold) {
    expectedAction = "delay"
  } else {
    expectedAction = "allow"
  }

  const passed = action === expectedAction
  return {
    name: "risk_thresholds",
    passed,
    reason: passed
      ? `Risk score ${score} correctly maps to action "${action}"`
      : `Risk score ${score} should map to "${expectedAction}" but verdict says "${action}"`,
  }
}

function checkCriticalDependencies(
  status: Record<CriticalDependency, "available" | "unavailable" | "degraded">,
  failClosed: boolean,
): AdmissionCheck {
  const unavailable = Object.entries(status)
    .filter(([, s]) => s === "unavailable")
    .map(([k]) => k)

  const degraded = Object.entries(status)
    .filter(([, s]) => s === "degraded")
    .map(([k]) => k)

  // In fail-closed mode, unavailable dependencies cause failure
  // Degraded dependencies are allowed but noted
  const passed = failClosed ? unavailable.length === 0 : unavailable.length === 0

  return {
    name: "critical_dependencies",
    passed,
    reason: passed
      ? unavailable.length === 0
        ? "All critical dependencies available"
        : `Degraded dependencies (non-critical in current mode): ${degraded.join(", ")}`
      : `Critical dependencies unavailable: ${unavailable.join(", ")} — fail-closed enforced`,
  }
}

function checkVerdictConsistency(verdict: AdmissionRequest["verdict"]): AdmissionCheck {
  const { score, status, action } = verdict
  const issues: string[] = []

  // Score must be 0-100
  if (score < 0 || score > 100) {
    issues.push(`Score ${score} out of range [0-100]`)
  }

  // Status must be valid
  const validStatuses = ["low_risk", "medium_risk", "high_risk"]
  if (!validStatuses.includes(status)) {
    issues.push(`Invalid status "${status}"`)
  }

  // Action must be valid
  const validActions = ["allow", "delay", "block"]
  if (!validActions.includes(action)) {
    issues.push(`Invalid action "${action}"`)
  }

  const passed = issues.length === 0
  return {
    name: "verdict_consistency",
    passed,
    reason: passed
      ? "Verdict is internally consistent"
      : `Verdict inconsistency: ${issues.join("; ")}`,
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * Simple hash of the admission request for audit trail.
 * NOT cryptographic — just a deterministic identifier.
 */
function hashRequest(request: AdmissionRequest): string {
  const parts = [
    request.transaction.txHash,
    request.transaction.safeAddress,
    request.transaction.chainId.toString(),
    request.verdict.verdictId,
    request.verdict.score.toString(),
    request.createdAt,
  ]
  let hash = 0
  const str = parts.join("|")
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0
  }
  return (hash >>> 0).toString(16).padStart(8, "0")
}

// ─── Admission log (audit trail) ─────────────────────────────────────

export interface AdmissionLogEntry {
  result: AdmissionResult
  request: AdmissionRequest
}

export class AdmissionLog {
  private entries: AdmissionLogEntry[] = []

  record(request: AdmissionRequest, result: AdmissionResult): void {
    this.entries.push({ request, result })
  }

  getEntries(): AdmissionLogEntry[] {
    return [...this.entries]
  }

  getEntriesByOutcome(outcome: AdmissionOutcome): AdmissionLogEntry[] {
    return this.entries.filter((e) => e.result.outcome === outcome)
  }

  getStats(): { total: number; admitted: number; held: number; blocked: number } {
    const total = this.entries.length
    const admitted = this.entries.filter((e) => e.result.outcome === "admit").length
    const held = this.entries.filter((e) => e.result.outcome === "hold").length
    const blocked = this.entries.filter((e) => e.result.outcome === "block").length
    return { total, admitted, held, blocked }
  }

  clear(): void {
    this.entries = []
  }
}
