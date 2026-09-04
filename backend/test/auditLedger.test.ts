import { describe, expect, it } from "vitest"

import {
  AuditEventType,
  InMemoryAuditLedger,
  RiskLevel,
  auditAnalysisCompleted,
  auditEnforcementConfirmed,
  auditEnforcementSubmitted,
  auditReconciliation,
  auditTransactionDetected,
  auditVerdictGenerated,
} from "../src/auditLedger.js"

const SAFE = "0xSafe0000000000000000000000000000000000" as const
const CHAIN = 11155111
const TX = "0xHash111111111111111111111111111111111111" as const
const VERDICT = "0xVerdict11111111111111111111111111111111" as const

function ledger() {
  return new InMemoryAuditLedger()
}

// ---------------------------------------------------------------------------
// append / getRecord / getEvents
// ---------------------------------------------------------------------------

describe("InMemoryAuditLedger", function () {
  describe("append and retrieve", function () {
    it("creates a transaction record on first event", function () {
      const l = ledger()
      l.append(auditTransactionDetected(TX, SAFE, CHAIN, { to: "0xTarget", value: "0" }))

      const record = l.getRecord(TX)
      expect(record).not.toBeNull()
      expect(record!.txHash).toBe(TX)
      expect(record!.safeAddress).toBe(SAFE)
      expect(record!.chainId).toBe(CHAIN)
      expect(record!.events).toHaveLength(1)
    })

    it("appends multiple events to the same record", function () {
      const l = ledger()
      l.append(auditTransactionDetected(TX, SAFE, CHAIN, {}))
      l.append(auditAnalysisCompleted(TX, VERDICT, SAFE, CHAIN, "RULES", { score: 45 }))
      l.append(auditVerdictGenerated(TX, VERDICT, SAFE, CHAIN, {
        verdictId: VERDICT,
        score: 45,
        riskLevel: RiskLevel.MEDIUM,
        action: "DELAY",
        explanation: "setApprovalForAll detected",
        policyVersion: "1.0",
        ruleVersion: "1.0",
        simulationVersion: "1.0",
        llmVersion: null,
      }))

      const record = l.getRecord(TX)
      expect(record!.events).toHaveLength(3)
      expect(record!.currentVerdict).not.toBeNull()
      expect(record!.currentVerdict!.score).toBe(45)
    })

    it("returns all events for a txHash", function () {
      const l = ledger()
      l.append(auditTransactionDetected(TX, SAFE, CHAIN, {}))
      l.append(auditTransactionDetected("0xOther", SAFE, CHAIN, {}))

      expect(l.getEvents(TX)).toHaveLength(1)
      expect(l.getEvents("0xOther")).toHaveLength(1)
    })

    it("getRecord returns null for unknown txHash", function () {
      const l = ledger()
      expect(l.getRecord("0xUnknown")).toBeNull()
    })

    it("each event gets a unique id and timestamp", function () {
      const l = ledger()
      const e1 = l.append(auditTransactionDetected(TX, SAFE, CHAIN, {}))
      const e2 = l.append(auditTransactionDetected(TX, SAFE, CHAIN, {}))
      expect(e1.id).not.toBe(e2.id)
      expect(e1.timestamp).toBeLessThanOrEqual(e2.timestamp)
    })
  })

  // ---------------------------------------------------------------------------
  // Derived snapshots
  // ---------------------------------------------------------------------------

  describe("derived snapshots", function () {
    it("currentVerdict is updated on VERDICT_GENERATED", function () {
      const l = ledger()
      l.append(auditTransactionDetected(TX, SAFE, CHAIN, {}))
      l.append(auditVerdictGenerated(TX, VERDICT, SAFE, CHAIN, {
        verdictId: VERDICT,
        score: 90,
        riskLevel: RiskLevel.HIGH,
        action: "BLOCK",
        explanation: "unlimited approve",
        policyVersion: "1.0",
        ruleVersion: "1.0",
        simulationVersion: "1.0",
        llmVersion: null,
      }))

      const record = l.getRecord(TX)!
      expect(record.currentVerdict!.score).toBe(90)
      expect(record.currentVerdict!.riskLevel).toBe(RiskLevel.HIGH)
      expect(record.currentVerdict!.action).toBe("BLOCK")
    })

    it("enforcementStatus is updated on ENFORCEMENT_CONFIRMED", function () {
      const l = ledger()
      l.append(auditTransactionDetected(TX, SAFE, CHAIN, {}))
      l.append(auditEnforcementConfirmed(TX, VERDICT, SAFE, CHAIN, "0xEnfTx"))

      const record = l.getRecord(TX)!
      expect(record.enforcementStatus!.status).toBe("CONFIRMED")
      expect(record.enforcementStatus!.enforcementTxHash).toBe("0xEnfTx")
    })

    it("reconciliationStatus is updated on RECONCILIATION_CHECKED", function () {
      const l = ledger()
      l.append(auditTransactionDetected(TX, SAFE, CHAIN, {}))
      l.append(auditReconciliation(TX, VERDICT, SAFE, CHAIN, "BLOCKED", "BLOCKED", "MATCH"))

      const record = l.getRecord(TX)!
      expect(record.reconciliationStatus!.status).toBe("MATCH")
    })
  })

  // ---------------------------------------------------------------------------
  // query with filters
  // ---------------------------------------------------------------------------

  describe("query", function () {
    it("filters by safeAddress", function () {
      const l = ledger()
      l.append(auditTransactionDetected(TX, SAFE, CHAIN, {}))
      l.append(auditTransactionDetected("0xOther", "0xOtherSafe", CHAIN, {}))

      const results = l.query({ safeAddress: SAFE })
      expect(results).toHaveLength(1)
      expect(results[0].txHash).toBe(TX)
    })

    it("filters by eventType", function () {
      const l = ledger()
      l.append(auditTransactionDetected(TX, SAFE, CHAIN, {}))
      l.append(auditAnalysisCompleted(TX, VERDICT, SAFE, CHAIN, "RULES", {}))

      const results = l.query({ eventType: AuditEventType.ANALYSIS_COMPLETED })
      expect(results).toHaveLength(1)
    })

    it("filters by riskLevel via VERDICT_GENERATED events", function () {
      const l = ledger()
      l.append(auditTransactionDetected(TX, SAFE, CHAIN, {}))
      l.append(auditVerdictGenerated(TX, VERDICT, SAFE, CHAIN, {
        verdictId: VERDICT,
        score: 90,
        riskLevel: RiskLevel.HIGH,
        action: "BLOCK",
        explanation: "",
        policyVersion: "1.0",
        ruleVersion: "1.0",
        simulationVersion: "1.0",
        llmVersion: null,
      }))
      l.append(auditTransactionDetected("0xOther", SAFE, CHAIN, {}))
      l.append(auditVerdictGenerated("0xOther", "0xV2", SAFE, CHAIN, {
        verdictId: "0xV2",
        score: 5,
        riskLevel: RiskLevel.LOW,
        action: "ALLOW",
        explanation: "",
        policyVersion: "1.0",
        ruleVersion: "1.0",
        simulationVersion: "1.0",
        llmVersion: null,
      }))

      const highRisk = l.query({ riskLevel: RiskLevel.HIGH })
      // Returns all events for transactions with HIGH risk verdicts.
      expect(highRisk.length).toBeGreaterThanOrEqual(1)
      expect(highRisk.every((e) => e.txHash === TX)).toBe(true)
    })

    it("filters by timestamp range", function () {
      const l = ledger()
      const e1 = l.append(auditTransactionDetected(TX, SAFE, CHAIN, {}))
      const e2 = l.append(auditTransactionDetected("0xOther", SAFE, CHAIN, {}))

      // Query events after e1's timestamp — should include e2.
      const results = l.query({ fromTimestamp: e1.timestamp })
      expect(results.length).toBeGreaterThanOrEqual(2)
      expect(results.every((e) => e.timestamp >= e1.timestamp)).toBe(true)
    })

    it("applies pagination (limit + offset)", function () {
      const l = ledger()
      for (let i = 0; i < 10; i++) {
        l.append(auditTransactionDetected(`0x${i}`, SAFE, CHAIN, {}))
      }

      const page = l.query({ limit: 3, offset: 2 })
      expect(page).toHaveLength(3)
    })

    it("returns results sorted by timestamp ascending", function () {
      const l = ledger()
      const e1 = l.append(auditTransactionDetected(TX, SAFE, CHAIN, {}))
      const e2 = l.append(auditAnalysisCompleted(TX, VERDICT, SAFE, CHAIN, "RULES", {}))
      const e3 = l.append(auditVerdictGenerated(TX, VERDICT, SAFE, CHAIN, {
        verdictId: VERDICT, score: 0, riskLevel: RiskLevel.LOW, action: "ALLOW",
        explanation: "", policyVersion: "1.0", ruleVersion: "1.0",
        simulationVersion: "1.0", llmVersion: null,
      }))

      const results = l.query({ txHash: TX })
      expect(results[0].eventType).toBe(AuditEventType.TRANSACTION_DETECTED)
      expect(results[1].eventType).toBe(AuditEventType.ANALYSIS_COMPLETED)
      expect(results[2].eventType).toBe(AuditEventType.VERDICT_GENERATED)
    })
  })

  // ---------------------------------------------------------------------------
  // listTxHashes / stats
  // ---------------------------------------------------------------------------

  describe("listTxHashes and stats", function () {
    it("listTxHashes returns all unique tx hashes", function () {
      const l = ledger()
      l.append(auditTransactionDetected("0xaaa", SAFE, CHAIN, {}))
      l.append(auditTransactionDetected("0xaaa", SAFE, CHAIN, {}))
      l.append(auditTransactionDetected("0xbbb", SAFE, CHAIN, {}))

      const hashes = l.listTxHashes()
      expect(hashes).toHaveLength(2)
      expect(hashes).toContain("0xaaa")
      expect(hashes).toContain("0xbbb")
    })

    it("stats returns correct counts", function () {
      const l = ledger()
      l.append(auditTransactionDetected(TX, SAFE, CHAIN, {}))
      l.append(auditAnalysisCompleted(TX, VERDICT, SAFE, CHAIN, "RULES", {}))
      l.append(auditVerdictGenerated(TX, VERDICT, SAFE, CHAIN, {
        verdictId: VERDICT, score: 90, riskLevel: RiskLevel.HIGH, action: "BLOCK",
        explanation: "", policyVersion: "1.0", ruleVersion: "1.0",
        simulationVersion: "1.0", llmVersion: null,
      }))

      const stats = l.stats()
      expect(stats.totalEvents).toBe(3)
      expect(stats.totalTransactions).toBe(1)
      expect(stats.eventsByType[AuditEventType.TRANSACTION_DETECTED]).toBe(1)
      expect(stats.riskLevelDistribution[RiskLevel.HIGH]).toBe(1)
    })
  })

  // ---------------------------------------------------------------------------
  // Full lifecycle
  // ---------------------------------------------------------------------------

  describe("full lifecycle", function () {
    it("records a complete transaction lifecycle with all event types", function () {
      const l = ledger()

      // 1. Transaction detected
      l.append(auditTransactionDetected(TX, SAFE, CHAIN, { to: "0xTarget", value: "1000" }))

      // 2. Analysis started + completed
      l.append({ ...auditAnalysisCompleted(TX, VERDICT, SAFE, CHAIN, "RULES", { score: 45 }), eventType: AuditEventType.ANALYSIS_STARTED })
      l.append(auditAnalysisCompleted(TX, VERDICT, SAFE, CHAIN, "RULES", { score: 45 }))
      l.append(auditAnalysisCompleted(TX, VERDICT, SAFE, CHAIN, "SIMULATION", { success: true }))

      // 3. Verdict generated
      l.append(auditVerdictGenerated(TX, VERDICT, SAFE, CHAIN, {
        verdictId: VERDICT,
        score: 45,
        riskLevel: RiskLevel.MEDIUM,
        action: "DELAY",
        explanation: "setApprovalForAll to unverified contract",
        policyVersion: "1.0",
        ruleVersion: "1.0",
        simulationVersion: "1.0",
        llmVersion: null,
      }))

      // 4. Enforcement
      l.append(auditEnforcementSubmitted(TX, VERDICT, SAFE, CHAIN, "0xEnfTx1"))
      l.append(auditEnforcementConfirmed(TX, VERDICT, SAFE, CHAIN, "0xEnfTx1"))

      // 5. Reconciliation
      l.append(auditReconciliation(TX, VERDICT, SAFE, CHAIN, "DELAYED", "DELAYED", "MATCH"))

      const record = l.getRecord(TX)!
      expect(record.events).toHaveLength(8)
      expect(record.currentVerdict!.action).toBe("DELAY")
      expect(record.enforcementStatus!.status).toBe("CONFIRMED")
      expect(record.reconciliationStatus!.status).toBe("MATCH")

      // Verify full timeline reconstruction.
      const eventTypes = record.events.map((e) => e.eventType)
      expect(eventTypes).toEqual([
        AuditEventType.TRANSACTION_DETECTED,
        AuditEventType.ANALYSIS_STARTED,
        AuditEventType.ANALYSIS_COMPLETED,
        AuditEventType.ANALYSIS_COMPLETED,
        AuditEventType.VERDICT_GENERATED,
        AuditEventType.ENFORCEMENT_SUBMITTED,
        AuditEventType.ENFORCEMENT_CONFIRMED,
        AuditEventType.RECONCILIATION_CHECKED,
      ])
    })

    it("records a failed enforcement lifecycle", function () {
      const l = ledger()
      l.append(auditTransactionDetected(TX, SAFE, CHAIN, {}))
      l.append(auditVerdictGenerated(TX, VERDICT, SAFE, CHAIN, {
        verdictId: VERDICT, score: 95, riskLevel: RiskLevel.HIGH, action: "BLOCK",
        explanation: "", policyVersion: "1.0", ruleVersion: "1.0",
        simulationVersion: "1.0", llmVersion: null,
      }))
      l.append(auditEnforcementSubmitted(TX, VERDICT, SAFE, CHAIN, "0xEnfTx2"))
      l.append({
        txHash: TX, verdictId: VERDICT, eventType: AuditEventType.ENFORCEMENT_FAILED,
        safeAddress: SAFE, chainId: CHAIN,
        payload: { txHash: "0xEnfTx2", status: "FAILED", enforcementTxHash: "0xEnfTx2", error: "revert", timestamp: Date.now() },
      })

      const record = l.getRecord(TX)!
      expect(record.enforcementStatus!.status).toBe("FAILED")
      expect(record.enforcementStatus!.error).toBe("revert")
    })
  })
})
