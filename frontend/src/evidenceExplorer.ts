/**
 * Issue #85: Risk Signal Evidence Explorer
 *
 * Interactive evidence explorer that allows users to drill from a final
 * risk verdict down to the individual evidence responsible for that
 * decision. Every risk signal is inspectable with source, value,
 * threshold, and confidence.
 */

// ─── Types ───────────────────────────────────────────────────────────

export type SignalSeverity = "low" | "medium" | "high" | "critical"

export interface RiskEvidence {
  /** The evidence source (rule_engine, simulator, blacklist, etc.) */
  source: string
  /** Human-readable description of what was observed */
  observation: string
  /** The raw value observed */
  observedValue: string
  /** The threshold that was compared against (if applicable) */
  threshold?: string
  /** ISO timestamp of when this evidence was collected */
  timestamp: string
  /** Confidence level 0-1 */
  confidence: number
  /** The transaction field this evidence relates to */
  relatedField?: string
  /** Whether this evidence is verified or estimated */
  verified: boolean
}

export interface RiskSignal {
  /** Unique signal ID */
  id: string
  /** Signal name (e.g. "Unlimited Approval") */
  name: string
  /** Severity level */
  severity: SignalSeverity
  /** Evidence supporting this signal */
  evidence: RiskEvidence[]
  /** Human-readable explanation of why this signal matters */
  explanation: string
  /** The transaction hash this signal relates to */
  txHash: string
  /** Contribution weight to overall risk score (0-100) */
  weight: number
}

export interface VerdictWithEvidence {
  /** Overall risk level */
  riskLevel: "low" | "medium" | "high" | "critical"
  /** Numeric score 0-100 */
  score: number
  /** The action recommended by the verdict */
  action: "allow" | "delay" | "block" | "freeze"
  /** All signals that contributed to this verdict */
  signals: RiskSignal[]
  /** Transaction hash */
  txHash: string
  /** Human-readable summary */
  summary: string
}

// ─── Signal creation helpers ─────────────────────────────────────────

let signalIdCounter = 0

function makeSignalId(): string {
  signalIdCounter++
  return `sig-${signalIdCounter}-${Date.now()}`
}

/**
 * Create a risk signal with evidence.
 */
export function createSignal(
  name: string,
  severity: SignalSeverity,
  evidence: RiskEvidence[],
  txHash: string,
  weight: number,
  explanation: string,
): RiskSignal {
  return {
    id: makeSignalId(),
    name,
    severity,
    evidence,
    txHash,
    weight,
    explanation,
  }
}

/**
 * Create an evidence entry.
 */
export function createEvidence(
  source: string,
  observation: string,
  observedValue: string,
  _txHash: string,
  options?: { threshold?: string; confidence?: number; relatedField?: string; verified?: boolean },
): RiskEvidence {
  return {
    source,
    observation,
    observedValue,
    timestamp: new Date().toISOString(),
    confidence: options?.confidence ?? 1.0,
    verified: options?.verified ?? true,
    threshold: options?.threshold,
    relatedField: options?.relatedField,
  }
}

// ─── Verdict creation ────────────────────────────────────────────────

/**
 * Create a verdict from a set of signals.
 * The verdict level is determined by the highest-severity signal.
 */
export function createVerdict(
  txHash: string,
  signals: RiskSignal[],
  summary: string,
): VerdictWithEvidence {
  // Determine risk level from highest severity signal
  const severityOrder: Record<SignalSeverity, number> = { low: 0, medium: 1, high: 2, critical: 3 }
  let maxSeverity = 0
  for (const sig of signals) {
    const sev = severityOrder[sig.severity]
    if (sev > maxSeverity) maxSeverity = sev
  }

  const riskLevel: VerdictWithEvidence["riskLevel"] =
    maxSeverity >= 3 ? "critical" : maxSeverity >= 2 ? "high" : maxSeverity >= 1 ? "medium" : "low"

  // Calculate score from signal weights
  const score = Math.min(100, signals.reduce((sum, s) => sum + s.weight, 0))

  // Determine action
  let action: VerdictWithEvidence["action"]
  if (riskLevel === "critical") action = "block"
  else if (riskLevel === "high") action = "block"
  else if (riskLevel === "medium") action = "delay"
  else action = "allow"

  return {
    riskLevel,
    score,
    action,
    signals,
    txHash,
    summary,
  }
}

// ─── Query helpers ───────────────────────────────────────────────────

/**
 * Get signals by severity level.
 */
export function getSignalsBySeverity(verdict: VerdictWithEvidence, severity: SignalSeverity): RiskSignal[] {
  return verdict.signals.filter((s) => s.severity === severity)
}

/**
 * Get the total evidence count across all signals.
 */
export function getTotalEvidenceCount(verdict: VerdictWithEvidence): number {
  return verdict.signals.reduce((sum, s) => sum + s.evidence.length, 0)
}

/**
 * Check if any evidence is unverified.
 */
export function hasUnverifiedEvidence(verdict: VerdictWithEvidence): boolean {
  return verdict.signals.some((s) => s.evidence.some((e) => !e.verified))
}

/**
 * Get the average confidence across all evidence.
 */
export function getAverageConfidence(verdict: VerdictWithEvidence): number {
  const allEvidence = verdict.signals.flatMap((s) => s.evidence)
  if (allEvidence.length === 0) return 0
  return allEvidence.reduce((sum, e) => sum + e.confidence, 0) / allEvidence.length
}
