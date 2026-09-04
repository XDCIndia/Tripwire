/**
 * Issue #54: Deterministic Risk Decision Replay & Policy Versioning
 *
 * Versions every risk policy and analysis configuration, and allows
 * any historical Safe transaction to be replayed against the exact
 * policy/model versions that produced its original verdict.
 */

import { randomUUID } from "node:crypto"
import { type RuleEngineResult, type RuleEngineInput, scoreTransaction } from "./ruleEngine.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Immutable snapshot of a risk policy configuration. */
export interface PolicyVersion {
  id: string
  version: string
  description: string
  /** Rule engine thresholds. */
  thresholds: { highRisk: number; mediumRisk: number }
  /** Rule engine signal weights. */
  weights: Record<string, number>
  createdAt: number
  /** Whether this version is currently active for new verdicts. */
  isActive: boolean
}

/** Immutable snapshot of an AI/LLM model configuration. */
export interface ModelVersion {
  id: string
  version: string
  description: string
  /** Model identifier (e.g. "claude-3-opus", "gpt-4"). */
  modelId: string
  /** Prompt version hash or identifier. */
  promptVersion: string
  createdAt: number
  isActive: boolean
}

/** Immutable snapshot of a simulation configuration. */
export interface SimulationVersion {
  id: string
  version: string
  description: string
  /** Fork block number or tag. */
  forkReference: string
  createdAt: number
  isActive: boolean
}

/** The version references stored with every canonical verdict. */
export interface VersionReferences {
  policyVersionId: string
  ruleVersion: string
  simulationVersionId: string | null
  modelVersionId: string | null
}

/** A versioned verdict — a verdict with its version references attached. */
export interface VersionedVerdict {
  txHash: string
  score: number
  label: "low_risk" | "medium_risk" | "high_risk"
  matchedSignals: string[]
  versions: VersionReferences
  /** The original rule engine input used to produce this verdict. */
  originalInput: RuleEngineInput
  createdAt: number
}

/** Result of replaying a historical transaction. */
export interface ReplayResult {
  txHash: string
  /** The original verdict being replayed. */
  originalVerdict: VersionedVerdict
  /** The replayed verdict using the original versions. */
  replayedVerdict: RuleEngineResult
  /** Whether the results match. */
  matchStatus: "MATCH" | "DIFFERENT" | "REPLAY_FAILED"
  /** Explanation of differences, if any. */
  differenceExplanation: string
  replayedAt: number
}

// ---------------------------------------------------------------------------
// PolicyVersionRegistry
// ---------------------------------------------------------------------------

export class PolicyVersionRegistry {
  private readonly policies = new Map<string, PolicyVersion>()
  private readonly models = new Map<string, ModelVersion>()
  private readonly simulations = new Map<string, SimulationVersion>()

  /** Create a new policy version. Sets it as active, deactivates previous. */
  createPolicy(version: string, description: string, thresholds: PolicyVersion["thresholds"], weights: Record<string, number>): PolicyVersion {
    // Deactivate all existing policies.
    for (const p of this.policies.values()) p.isActive = false

    const policy: PolicyVersion = {
      id: randomUUID(),
      version,
      description,
      thresholds,
      weights,
      createdAt: Date.now(),
      isActive: true,
    }
    this.policies.set(policy.id, policy)
    return policy
  }

  /** Create a new model version. */
  createModel(version: string, description: string, modelId: string, promptVersion: string): ModelVersion {
    for (const m of this.models.values()) m.isActive = false
    const model: ModelVersion = {
      id: randomUUID(),
      version,
      description,
      modelId,
      promptVersion,
      createdAt: Date.now(),
      isActive: true,
    }
    this.models.set(model.id, model)
    return model
  }

  /** Create a new simulation version. */
  createSimulation(version: string, description: string, forkReference: string): SimulationVersion {
    for (const s of this.simulations.values()) s.isActive = false
    const sim: SimulationVersion = {
      id: randomUUID(),
      version,
      description,
      forkReference,
      createdAt: Date.now(),
      isActive: true,
    }
    this.simulations.set(sim.id, sim)
    return sim
  }

  /** Get the currently active policy version. */
  getActivePolicy(): PolicyVersion | null {
    for (const p of this.policies.values()) {
      if (p.isActive) return p
    }
    return null
  }

  /** Get a specific policy by ID (for replay). */
  getPolicy(id: string): PolicyVersion | null {
    return this.policies.get(id) ?? null
  }

  /** Get a specific model by ID. */
  getModel(id: string): ModelVersion | null {
    return this.models.get(id) ?? null
  }

  /** Get a specific simulation by ID. */
  getSimulation(id: string): SimulationVersion | null {
    return this.simulations.get(id) ?? null
  }

  /** List all policy versions (for audit). */
  listPolicies(): PolicyVersion[] {
    return [...this.policies.values()].sort((a, b) => a.createdAt - b.createdAt)
  }

  /** List all model versions. */
  listModels(): ModelVersion[] {
    return [...this.models.values()].sort((a, b) => a.createdAt - b.createdAt)
  }

  /** Get the active version references (current snapshot). */
  getActiveReferences(): VersionReferences {
    const policy = this.getActivePolicy()
    return {
      policyVersionId: policy?.id ?? "",
      ruleVersion: policy?.version ?? "",
      simulationVersionId: null,
      modelVersionId: null,
    }
  }
}

// ---------------------------------------------------------------------------
// ReplayEngine
// ---------------------------------------------------------------------------

export class ReplayEngine {
  constructor(private readonly registry: PolicyVersionRegistry) {}

  /**
   * Record a versioned verdict for a transaction.
   * Stores the verdict with its version references and original input.
   */
  recordVerdict(verdict: Omit<VersionedVerdict, "createdAt">): VersionedVerdict {
    const record: VersionedVerdict = { ...verdict, createdAt: Date.now() }
    // In production this would persist to a database. For now the caller
    // holds the record — the replay API below demonstrates the full flow.
    return record
  }

  /**
   * Replay a historical transaction against the exact versions that
   * produced its original verdict.
   *
   * This re-runs the rule engine using the saved input and the original
   * policy weights/thresholds, then compares the results.
   */
  replay(verdict: VersionedVerdict): ReplayResult {
    const policy = this.registry.getPolicy(verdict.versions.policyVersionId)
    if (!policy) {
      return {
        txHash: verdict.txHash,
        originalVerdict: verdict,
        replayedVerdict: { score: 0, label: "low_risk", matchedSignals: [] },
        matchStatus: "REPLAY_FAILED",
        differenceExplanation: `Policy version ${verdict.versions.policyVersionId} not found`,
        replayedAt: Date.now(),
      }
    }

    // Re-score using the original input and the saved policy weights.
    // We patch the WEIGHTS temporarily to use the original version's weights.
    const originalWeights = { ...policy.weights }
    const replayed = this.scoreWithWeights(verdict.originalInput, originalWeights, policy.thresholds)

    // Compare results.
    const scoreMatch = replayed.score === verdict.score
    const labelMatch = replayed.label === verdict.label
    const matchStatus: ReplayResult["matchStatus"] = scoreMatch && labelMatch ? "MATCH" : "DIFFERENT"

    let differenceExplanation = ""
    if (matchStatus === "DIFFERENT") {
      const diffs: string[] = []
      if (!scoreMatch) diffs.push(`score: original=${verdict.score} replayed=${replayed.score}`)
      if (!labelMatch) diffs.push(`label: original=${verdict.label} replayed=${replayed.label}`)
      differenceExplanation = diffs.join("; ")
    }

    return {
      txHash: verdict.txHash,
      originalVerdict: verdict,
      replayedVerdict: replayed,
      matchStatus,
      differenceExplanation,
      replayedAt: Date.now(),
    }
  }

  /** Score a transaction using custom weights and thresholds. */
  private scoreWithWeights(input: RuleEngineInput, weights: Record<string, number>, thresholds: { highRisk: number; mediumRisk: number }): RuleEngineResult {
    // Re-use the existing rule engine logic but with custom thresholds.
    // The rule engine's `scoreTransaction` uses hardcoded WEIGHTS and thresholds,
    // so we replicate the scoring logic here with the provided weights.
    const matchedSignals: string[] = []
    let score = 0

    const selector = input.data.length >= 10 ? input.data.slice(0, 10).toLowerCase() : ""

    if (selector === "0xa22cb465") {
      score += weights["SET_APPROVAL_FOR_ALL"] ?? 45
      matchedSignals.push("setApprovalForAll")
    }
    if (selector === "0x095ea7b3") {
      // Check for unlimited approve
      if (input.data.length >= 74) {
        const amountWord = input.data.slice(74, 138).toLowerCase()
        if (amountWord === "f".repeat(64)) {
          score += weights["UNLIMITED_APPROVE"] ?? 40
          matchedSignals.push("unlimited approve")
        }
      }
    }
    if (selector === "0xd505accf") {
      score += weights["PERMIT"] ?? 25
      matchedSignals.push("permit")
    }
    if (input.isFirstSeenCounterparty) {
      score += weights["FIRST_SEEN_COUNTERPARTY"] ?? 20
      matchedSignals.push("first-seen counterparty")
    }
    if (input.isUnverifiedOrFreshContract) {
      score += weights["UNVERIFIED_OR_FRESH_CONTRACT"] ?? 25
      matchedSignals.push("unverified contract")
    }
    if (input.counterpartyBlacklist === "malicious") {
      score += weights["BLACKLISTED_COUNTERPARTY"] ?? 60
      matchedSignals.push("blacklisted counterparty")
    }
    if (input.historicalP95Value > 0n && input.value > input.historicalP95Value) {
      score += weights["ABOVE_HISTORICAL_P95"] ?? 15
      matchedSignals.push("above p95")
    }

    score = Math.min(score, 100)
    const label: "low_risk" | "medium_risk" | "high_risk" =
      score >= thresholds.highRisk ? "high_risk" : score >= thresholds.mediumRisk ? "medium_risk" : "low_risk"

    return { score, label, matchedSignals }
  }
}
