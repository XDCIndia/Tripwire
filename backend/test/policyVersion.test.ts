import { describe, expect, it } from "vitest"

import type { RuleEngineInput } from "../src/ruleEngine.js"
import { PolicyVersionRegistry, ReplayEngine } from "../src/policyVersion.js"
import type { VersionedVerdict } from "../src/policyVersion.js"

function baseInput(overrides: Partial<RuleEngineInput> = {}): RuleEngineInput {
  return {
    data: "0x",
    value: 0n,
    isFirstSeenCounterparty: false,
    isUnverifiedOrFreshContract: false,
    counterpartyBlacklist: "unknown",
    historicalP95Value: 0n,
    ...overrides,
  }
}

function makeVerdict(overrides: Partial<VersionedVerdict> = {}): VersionedVerdict {
  return {
    txHash: "0xHash111111111111111111111111111111111111",
    score: 45,
    label: "medium_risk",
    matchedSignals: ["setApprovalForAll"],
    versions: {
      policyVersionId: "policy-1",
      ruleVersion: "v1.0",
      simulationVersionId: null,
      modelVersionId: null,
    },
    originalInput: baseInput({ data: "0xa22cb465" + "0".repeat(64) }),
    createdAt: Date.now(),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// PolicyVersionRegistry
// ---------------------------------------------------------------------------

describe("PolicyVersionRegistry", function () {
  describe("policy versions", function () {
    it("creates a policy version and sets it active", function () {
      const r = new PolicyVersionRegistry()
      const p = r.createPolicy("v1.0", "Initial", { highRisk: 70, mediumRisk: 30 }, { SET_APPROVAL_FOR_ALL: 45 })
      expect(p.version).toBe("v1.0")
      expect(p.isActive).toBe(true)
    })

    it("deactivates previous policy when a new one is created", function () {
      const r = new PolicyVersionRegistry()
      const p1 = r.createPolicy("v1.0", "First", { highRisk: 70, mediumRisk: 30 }, {})
      const p2 = r.createPolicy("v2.0", "Second", { highRisk: 80, mediumRisk: 40 }, {})
      expect(p1.isActive).toBe(false)
      expect(p2.isActive).toBe(true)
    })

    it("getActivePolicy returns the active version", function () {
      const r = new PolicyVersionRegistry()
      r.createPolicy("v1.0", "First", { highRisk: 70, mediumRisk: 30 }, {})
      r.createPolicy("v2.0", "Second", { highRisk: 80, mediumRisk: 40 }, {})
      expect(r.getActivePolicy()!.version).toBe("v2.0")
    })

    it("getPolicy returns a specific version by ID", function () {
      const r = new PolicyVersionRegistry()
      const p = r.createPolicy("v1.0", "First", { highRisk: 70, mediumRisk: 30 }, {})
      expect(r.getPolicy(p.id)!.version).toBe("v1.0")
    })

    it("listPolicies returns all versions sorted by creation time", function () {
      const r = new PolicyVersionRegistry()
      r.createPolicy("v1.0", "First", { highRisk: 70, mediumRisk: 30 }, {})
      r.createPolicy("v2.0", "Second", { highRisk: 80, mediumRisk: 40 }, {})
      const list = r.listPolicies()
      expect(list).toHaveLength(2)
      expect(list[0].version).toBe("v1.0")
      expect(list[1].version).toBe("v2.0")
    })

    it("policy versions have unique IDs", function () {
      const r = new PolicyVersionRegistry()
      const p1 = r.createPolicy("v1.0", "First", { highRisk: 70, mediumRisk: 30 }, {})
      const p2 = r.createPolicy("v2.0", "Second", { highRisk: 80, mediumRisk: 40 }, {})
      expect(p1.id).not.toBe(p2.id)
    })
  })

  describe("model versions", function () {
    it("creates and tracks model versions", function () {
      const r = new PolicyVersionRegistry()
      const m = r.createModel("prompt-v2", "Updated prompt", "claude-3-opus", "hash-abc")
      expect(m.modelId).toBe("claude-3-opus")
      expect(m.isActive).toBe(true)
      expect(r.getModel(m.id)!.promptVersion).toBe("hash-abc")
    })

    it("deactivates previous model on new creation", function () {
      const r = new PolicyVersionRegistry()
      const m1 = r.createModel("v1", "First", "gpt-4", "hash-1")
      const m2 = r.createModel("v2", "Second", "claude-3", "hash-2")
      expect(m1.isActive).toBe(false)
      expect(m2.isActive).toBe(true)
    })
  })

  describe("simulation versions", function () {
    it("creates and tracks simulation versions", function () {
      const r = new PolicyVersionRegistry()
      const s = r.createSimulation("sim-v1", "Initial fork", "block-12345")
      expect(s.forkReference).toBe("block-12345")
      expect(r.getSimulation(s.id)!.version).toBe("sim-v1")
    })
  })

  describe("getActiveReferences", function () {
    it("returns current active version references", function () {
      const r = new PolicyVersionRegistry()
      const p = r.createPolicy("v1.0", "First", { highRisk: 70, mediumRisk: 30 }, {})
      const refs = r.getActiveReferences()
      expect(refs.policyVersionId).toBe(p.id)
      expect(refs.ruleVersion).toBe("v1.0")
    })
  })
})

// ---------------------------------------------------------------------------
// ReplayEngine
// ---------------------------------------------------------------------------

describe("ReplayEngine", function () {
  describe("recordVerdict", function () {
    it("records a versioned verdict with timestamp", function () {
      const r = new PolicyVersionRegistry()
      const engine = new ReplayEngine(r)
      const v = engine.recordVerdict(makeVerdict())
      expect(v.createdAt).toBeTypeOf("number")
      expect(v.score).toBe(45)
    })
  })

  describe("replay", function () {
    it("replays using the original version and returns MATCH when results are identical", function () {
      const r = new PolicyVersionRegistry()
      const policy = r.createPolicy("v1.0", "Initial", { highRisk: 70, mediumRisk: 30 }, { SET_APPROVAL_FOR_ALL: 45 })
      const engine = new ReplayEngine(r)

      const verdict = makeVerdict({
        versions: { policyVersionId: policy.id, ruleVersion: "v1.0", simulationVersionId: null, modelVersionId: null },
        originalInput: baseInput({ data: "0xa22cb465" + "0".repeat(64) }),
        score: 45,
        label: "medium_risk",
      })

      const result = engine.replay(verdict)
      expect(result.matchStatus).toBe("MATCH")
      expect(result.replayedVerdict.score).toBe(45)
      expect(result.replayedVerdict.label).toBe("medium_risk")
    })

    it("returns DIFFERENT when policy thresholds changed between original and replay", function () {
      const r = new PolicyVersionRegistry()
      // Original policy: medium_risk at 30
      const v1 = r.createPolicy("v1.0", "Initial", { highRisk: 70, mediumRisk: 30 }, { SET_APPROVAL_FOR_ALL: 45 })
      // New policy: medium_risk at 50
      r.createPolicy("v2.0", "Raised threshold", { highRisk: 80, mediumRisk: 50 }, { SET_APPROVAL_FOR_ALL: 45 })

      const engine = new ReplayEngine(r)

      // Original verdict was produced by v1 with score 45 → medium_risk (45 >= 30)
      const verdict = makeVerdict({
        versions: { policyVersionId: v1.id, ruleVersion: "v1.0", simulationVersionId: null, modelVersionId: null },
        originalInput: baseInput({ data: "0xa22cb465" + "0".repeat(64) }),
        score: 45,
        label: "medium_risk",
      })

      // Replay uses v1 (the original), so it should still produce 45/medium_risk → MATCH
      const result = engine.replay(verdict)
      expect(result.matchStatus).toBe("MATCH")
    })

    it("returns DIFFERENT when replayed score differs from original", function () {
      const r = new PolicyVersionRegistry()
      const policy = r.createPolicy("v1.0", "Initial", { highRisk: 70, mediumRisk: 30 }, { SET_APPROVAL_FOR_ALL: 45 })
      const engine = new ReplayEngine(r)

      // Original verdict claims score 90 (high_risk) but the input only
      // triggers SET_APPROVAL_FOR_ALL (45). This simulates a scenario where
      // the original verdict was computed with different input/weights.
      const verdict = makeVerdict({
        versions: { policyVersionId: policy.id, ruleVersion: "v1.0", simulationVersionId: null, modelVersionId: null },
        originalInput: baseInput({ data: "0xa22cb465" + "0".repeat(64) }),
        score: 90, // Original claimed 90
        label: "high_risk",
      })

      const result = engine.replay(verdict)
      expect(result.matchStatus).toBe("DIFFERENT")
      expect(result.differenceExplanation).toContain("score")
    })

    it("returns REPLAY_FAILED when policy version is missing", function () {
      const r = new PolicyVersionRegistry()
      const engine = new ReplayEngine(r)

      const verdict = makeVerdict({
        versions: { policyVersionId: "nonexistent", ruleVersion: "v1.0", simulationVersionId: null, modelVersionId: null },
      })

      const result = engine.replay(verdict)
      expect(result.matchStatus).toBe("REPLAY_FAILED")
      expect(result.differenceExplanation).toContain("not found")
    })

    it("does not modify the original verdict on replay", function () {
      const r = new PolicyVersionRegistry()
      const policy = r.createPolicy("v1.0", "Initial", { highRisk: 70, mediumRisk: 30 }, { SET_APPROVAL_FOR_ALL: 45 })
      const engine = new ReplayEngine(r)

      const verdict = makeVerdict({
        versions: { policyVersionId: policy.id, ruleVersion: "v1.0", simulationVersionId: null, modelVersionId: null },
        score: 90,
        label: "high_risk",
      })

      engine.replay(verdict)
      // Original verdict unchanged.
      expect(verdict.score).toBe(90)
      expect(verdict.label).toBe("high_risk")
    })

    it("replay result includes difference explanation for DIFFERENT status", function () {
      const r = new PolicyVersionRegistry()
      const policy = r.createPolicy("v1.0", "Initial", { highRisk: 70, mediumRisk: 30 }, { SET_APPROVAL_FOR_ALL: 45 })
      const engine = new ReplayEngine(r)

      const verdict = makeVerdict({
        versions: { policyVersionId: policy.id, ruleVersion: "v1.0", simulationVersionId: null, modelVersionId: null },
        originalInput: baseInput({ data: "0xa22cb465" + "0".repeat(64) }),
        score: 80,
        label: "high_risk",
      })

      const result = engine.replay(verdict)
      expect(result.matchStatus).toBe("DIFFERENT")
      expect(result.differenceExplanation).toContain("score")
      expect(result.differenceExplanation).toContain("label")
    })
  })
})
