import { describe, it, expect } from "vitest"
import {
  evaluateAdmission,
  AdmissionLog,
  type AdmissionRequest,
  type CriticalDependency,
} from "../src/admissionBoundary.js"

// ─── Helpers ─────────────────────────────────────────────────────────

const VALID_DEPS: Record<CriticalDependency, "available" | "unavailable" | "degraded"> = {
  rule_engine: "available",
  simulation: "available",
  wallet_analysis: "available",
  ai_assessment: "available",
}

function makeRequest(overrides: Partial<AdmissionRequest> = {}): AdmissionRequest {
  const now = new Date()
  return {
    transaction: {
      safeAddress: "0xSafe000000000000000000000000000000000001",
      chainId: 50,
      txHash: "0xabc111122223333444455556666777788889999aaaabbbbccccddddeeeeffff",
    },
    verdict: {
      verdictId: "v-001",
      score: 15,
      status: "low_risk",
      action: "allow",
    },
    analysisIntegrity: {
      rulesComplete: true,
      simulationComplete: true,
      walletAnalysisComplete: true,
      aiAssessmentComplete: true,
    },
    policyIntegrity: {
      policyVersion: "1.0.0",
      ruleVersion: "1.0.0",
      modelVersion: "1.0.0",
    },
    analyzedTxHash: "0xabc111122223333444455556666777788889999aaaabbbbccccddddeeeeffff",
    verdictTimestamp: now.toISOString(),
    createdAt: now.toISOString(),
    dependencyStatus: { ...VALID_DEPS },
    thresholds: {
      highRiskThreshold: 70,
      mediumRiskThreshold: 30,
      maxVerdictAgeSeconds: 300,
      failClosed: true,
    },
    ...overrides,
  }
}

// ─── Tests ───────────────────────────────────────────────────────────

describe("admissionBoundary", () => {
  describe("admit (all checks pass)", () => {
    it("admits a valid low-risk verdict", () => {
      const result = evaluateAdmission(makeRequest())
      expect(result.outcome).toBe("admit")
      expect(result.checks.every((c) => c.passed)).toBe(true)
    })

    it("admits a valid medium-risk verdict", () => {
      const result = evaluateAdmission(makeRequest({
        verdict: { verdictId: "v-002", score: 50, status: "medium_risk", action: "delay" },
      }))
      expect(result.outcome).toBe("admit")
    })

    it("admits a valid high-risk verdict", () => {
      const result = evaluateAdmission(makeRequest({
        verdict: { verdictId: "v-003", score: 85, status: "high_risk", action: "block" },
      }))
      expect(result.outcome).toBe("admit")
    })
  })

  describe("transaction identity", () => {
    it("rejects when analyzed tx hash does not match", () => {
      const result = evaluateAdmission(makeRequest({
        analyzedTxHash: "0xdifferent_hash",
      }))
      expect(result.outcome).toBe("block")
      expect(result.checks.find((c) => c.name === "transaction_identity")!.passed).toBe(false)
    })

    it("matches case-insensitively", () => {
      const result = evaluateAdmission(makeRequest({
        analyzedTxHash: "0xABC111122223333444455556666777788889999AAAABBBBCCCCDDDDEEEEFFFF",
      }))
      expect(result.checks.find((c) => c.name === "transaction_identity")!.passed).toBe(true)
    })
  })

  describe("analysis completeness", () => {
    it("rejects when rules not complete", () => {
      const result = evaluateAdmission(makeRequest({
        analysisIntegrity: {
          rulesComplete: false,
          simulationComplete: true,
          walletAnalysisComplete: true,
          aiAssessmentComplete: true,
        },
      }))
      expect(result.outcome).toBe("hold")
      expect(result.checks.find((c) => c.name === "analysis_completeness")!.passed).toBe(false)
    })

    it("rejects when simulation not complete", () => {
      const result = evaluateAdmission(makeRequest({
        analysisIntegrity: {
          rulesComplete: true,
          simulationComplete: false,
          walletAnalysisComplete: true,
          aiAssessmentComplete: true,
        },
      }))
      expect(result.outcome).toBe("hold")
    })

    it("rejects when wallet analysis not complete", () => {
      const result = evaluateAdmission(makeRequest({
        analysisIntegrity: {
          rulesComplete: true,
          simulationComplete: true,
          walletAnalysisComplete: false,
          aiAssessmentComplete: true,
        },
      }))
      expect(result.outcome).toBe("hold")
    })

    it("rejects when AI assessment not complete", () => {
      const result = evaluateAdmission(makeRequest({
        analysisIntegrity: {
          rulesComplete: true,
          simulationComplete: true,
          walletAnalysisComplete: true,
          aiAssessmentComplete: false,
        },
      }))
      expect(result.outcome).toBe("hold")
    })
  })

  describe("policy versions", () => {
    it("rejects invalid policy version", () => {
      const result = evaluateAdmission(makeRequest({
        policyIntegrity: {
          policyVersion: "invalid",
          ruleVersion: "1.0.0",
          modelVersion: "1.0.0",
        },
      }))
      expect(result.outcome).toBe("block")
      expect(result.checks.find((c) => c.name === "policy_versions")!.passed).toBe(false)
    })

    it("rejects empty policy version", () => {
      const result = evaluateAdmission(makeRequest({
        policyIntegrity: {
          policyVersion: "",
          ruleVersion: "1.0.0",
          modelVersion: "1.0.0",
        },
      }))
      expect(result.outcome).toBe("block")
    })
  })

  describe("verdict freshness", () => {
    it("rejects expired verdicts", () => {
      const old = new Date(Date.now() - 600_000).toISOString() // 10 minutes ago
      const result = evaluateAdmission(makeRequest({ createdAt: old }))
      expect(result.outcome).toBe("block")
      expect(result.checks.find((c) => c.name === "verdict_freshness")!.passed).toBe(false)
    })

    it("accepts fresh verdicts", () => {
      const result = evaluateAdmission(makeRequest())
      expect(result.checks.find((c) => c.name === "verdict_freshness")!.passed).toBe(true)
    })
  })

  describe("risk thresholds", () => {
    it("blocks when score >= 70 but action is allow", () => {
      const result = evaluateAdmission(makeRequest({
        verdict: { verdictId: "v-err", score: 80, status: "high_risk", action: "allow" },
      }))
      expect(result.outcome).toBe("block")
      expect(result.checks.find((c) => c.name === "risk_thresholds")!.passed).toBe(false)
    })

    it("allows when score < 30 and action is allow", () => {
      const result = evaluateAdmission(makeRequest({
        verdict: { verdictId: "v-ok", score: 10, status: "low_risk", action: "allow" },
      }))
      expect(result.outcome).toBe("admit")
      expect(result.checks.find((c) => c.name === "risk_thresholds")!.passed).toBe(true)
    })

    it("delays when score >= 30 but < 70 and action is delay", () => {
      const result = evaluateAdmission(makeRequest({
        verdict: { verdictId: "v-med", score: 50, status: "medium_risk", action: "delay" },
      }))
      expect(result.outcome).toBe("admit")
    })
  })

  describe("critical dependencies", () => {
    it("holds when simulation is unavailable", () => {
      const result = evaluateAdmission(makeRequest({
        dependencyStatus: { ...VALID_DEPS, simulation: "unavailable" },
      }))
      expect(result.outcome).toBe("hold")
      expect(result.checks.find((c) => c.name === "critical_dependencies")!.passed).toBe(false)
    })

    it("holds when rule_engine is unavailable", () => {
      const result = evaluateAdmission(makeRequest({
        dependencyStatus: { ...VALID_DEPS, rule_engine: "unavailable" },
      }))
      expect(result.outcome).toBe("hold")
    })

    it("admits when dependencies are degraded (not unavailable)", () => {
      const result = evaluateAdmission(makeRequest({
        dependencyStatus: { ...VALID_DEPS, simulation: "degraded" },
      }))
      expect(result.checks.find((c) => c.name === "critical_dependencies")!.passed).toBe(true)
    })
  })

  describe("verdict consistency", () => {
    it("blocks verdict with score > 100", () => {
      const result = evaluateAdmission(makeRequest({
        verdict: { verdictId: "v-bad", score: 150, status: "high_risk", action: "block" },
      }))
      expect(result.outcome).toBe("block")
      expect(result.checks.find((c) => c.name === "verdict_consistency")!.passed).toBe(false)
    })

    it("blocks verdict with invalid status", () => {
      const result = evaluateAdmission(makeRequest({
        verdict: { verdictId: "v-bad", score: 10, status: "unknown", action: "allow" },
      }))
      expect(result.outcome).toBe("block")
    })

    it("blocks verdict with invalid action", () => {
      const result = evaluateAdmission(makeRequest({
        verdict: { verdictId: "v-bad", score: 10, status: "low_risk", action: "freeze" as string },
      }))
      expect(result.outcome).toBe("block")
    })
  })

  describe("fail-closed behavior", () => {
    it("multiple failures produce a single block/hold", () => {
      const result = evaluateAdmission(makeRequest({
        analyzedTxHash: "0xdifferent",
        dependencyStatus: { ...VALID_DEPS, simulation: "unavailable" },
      }))
      // Identity mismatch => block (takes precedence)
      expect(result.outcome).toBe("block")
      expect(result.checks.filter((c) => !c.passed).length).toBeGreaterThanOrEqual(2)
    })

    it("never produces admit when checks fail", () => {
      const result = evaluateAdmission(makeRequest({
        analysisIntegrity: {
          rulesComplete: false,
          simulationComplete: false,
          walletAnalysisComplete: false,
          aiAssessmentComplete: false,
        },
      }))
      expect(result.outcome).not.toBe("admit")
    })
  })

  describe("audit trail", () => {
    it("records request hash in result", () => {
      const result = evaluateAdmission(makeRequest())
      expect(result.requestHash).toMatch(/^[0-9a-f]{8}$/)
    })

    it("includes timestamp in result", () => {
      const result = evaluateAdmission(makeRequest())
      expect(result.decidedAt).toBeTruthy()
    })
  })

  describe("admission log", () => {
    it("tracks all admission decisions", () => {
      const log = new AdmissionLog()
      log.record(makeRequest(), evaluateAdmission(makeRequest()))
      log.record(makeRequest({ analyzedTxHash: "0xdifferent" }), evaluateAdmission(makeRequest({ analyzedTxHash: "0xdifferent" })))

      const stats = log.getStats()
      expect(stats.total).toBe(2)
      expect(stats.admitted).toBe(1)
      expect(stats.blocked).toBe(1)
    })

    it("filters by outcome", () => {
      const log = new AdmissionLog()
      log.record(makeRequest(), evaluateAdmission(makeRequest()))
      log.record(makeRequest({ analyzedTxHash: "0xdifferent" }), evaluateAdmission(makeRequest({ analyzedTxHash: "0xdifferent" })))

      expect(log.getEntriesByOutcome("admit").length).toBe(1)
      expect(log.getEntriesByOutcome("block").length).toBe(1)
      expect(log.getEntriesByOutcome("hold").length).toBe(0)
    })
  })
})
