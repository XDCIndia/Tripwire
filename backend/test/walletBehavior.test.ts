import { describe, expect, it } from "vitest"

import { type ObservedTransaction, WalletBehaviorEngine } from "../src/walletBehavior.js"

const WALLET = "0xWallet1111111111111111111111111111111111"
const RECIPIENT = "0xRecipient111111111111111111111111111111"
const NEW_RECIPIENT = "0xNewRecipient11111111111111111111111111"

function tx(overrides: Partial<ObservedTransaction> = {}): ObservedTransaction {
  return {
    txHash: "0xhash",
    to: RECIPIENT,
    value: 100n,
    data: "0x",
    timestamp: Date.now(),
    ...overrides,
  }
}

function engine(config?: ConstructorParameters<typeof WalletBehaviorEngine>[0]) {
  return new WalletBehaviorEngine(config)
}

function bulkObserve(e: WalletBehaviorEngine, wallet: string, count: number, value: bigint, startTime: number) {
  for (let i = 0; i < count; i++) {
    e.observe(wallet, tx({
      txHash: `0x${i}`,
      value,
      timestamp: startTime + i * 3600, // 1 per hour
    }))
  }
}

// ---------------------------------------------------------------------------
// Profile maintenance
// ---------------------------------------------------------------------------

describe("WalletBehaviorEngine", function () {
  describe("profile maintenance", function () {
    it("creates a profile on first observation", function () {
      const e = engine()
      const now = Date.now()
      e.observe(WALLET, tx({ timestamp: now }))
      const p = e.getProfile(WALLET)
      expect(p).not.toBeNull()
      expect(p!.transactionCount).toBe(1)
      expect(p!.firstSeenAt).toBe(now)
    })

    it("tracks transaction count and counterparty", function () {
      const e = engine()
      e.observe(WALLET, tx({ to: RECIPIENT }))
      e.observe(WALLET, tx({ to: NEW_RECIPIENT }))
      const p = e.getProfile(WALLET)!
      expect(p.transactionCount).toBe(2)
      expect(p.knownCounterparties.size).toBe(2)
    })

    it("rolls window to maxHistory", function () {
      const e = engine({ maxHistory: 3 })
      for (let i = 0; i < 5; i++) {
        e.observe(WALLET, tx({ timestamp: i }))
      }
      expect(e.getProfile(WALLET)!.recentTransactions).toHaveLength(3)
    })

    it("getProfile returns null for unknown wallet", function () {
      expect(engine().getProfile("0xunknown")).toBeNull()
    })
  })

  // ---------------------------------------------------------------------------
  // Baseline computation
  // ---------------------------------------------------------------------------

  describe("baseline computation", function () {
    it("computes average, median, p95, and stddev", function () {
      const e = engine()
      const now = Date.now()
      // 10 transactions with known values.
      const values = [100n, 200n, 300n, 400n, 500n, 600n, 700n, 800n, 900n, 1000n]
      values.forEach((v, i) => {
        e.observe(WALLET, tx({ value: v, timestamp: now + i * 3600 }))
      })
      const p = e.getProfile(WALLET)!
      // average = (100+...+1000)/10 = 550
      expect(p.baseline.averageValue).toBe(550n)
      // median = middle value of sorted array = 500 or 600
      expect(p.baseline.medianValue).toBeGreaterThanOrEqual(500n)
      expect(p.baseline.medianValue).toBeLessThanOrEqual(600n)
      // p95 should be near the top
      expect(p.baseline.p95Value).toBeGreaterThanOrEqual(900n)
    })

    it("tracks known recipients", function () {
      const e = engine()
      e.observe(WALLET, tx({ to: "0xAAA" }))
      e.observe(WALLET, tx({ to: "0xBBB" }))
      const p = e.getProfile(WALLET)!
      expect(p.baseline.knownRecipients.size).toBe(2)
      expect(p.baseline.knownRecipients.has("0xaaa")).toBe(true)
    })

    it("tracks approval ratio", function () {
      const e = engine()
      const now = Date.now()
      // 4 normal txs, 1 approval
      for (let i = 0; i < 4; i++) {
        e.observe(WALLET, tx({ timestamp: now + i * 3600 }))
      }
      e.observe(WALLET, tx({ data: "0xa22cb465" + "0".repeat(64), timestamp: now + 4 * 3600 }))
      const p = e.getProfile(WALLET)!
      expect(p.baseline.approvalCount).toBe(1)
      expect(p.baseline.approvalRatio).toBeCloseTo(0.2, 1)
    })

    it("getP95Value returns 0 for unknown wallet", function () {
      expect(engine().getP95Value("0xunknown")).toBe(0n)
    })
  })

  // ---------------------------------------------------------------------------
  // Anomaly detection
  // ---------------------------------------------------------------------------

  describe("anomaly detection", function () {
    it("returns no anomaly with insufficient history", function () {
      const e = engine()
      e.observe(WALLET, tx())
      const result = e.detect(WALLET, tx())
      expect(result.isAnomalous).toBe(false)
      expect(result.anomalyScore).toBe(0)
    })

    it("detects abnormal value (above p95 threshold)", function () {
      const e = engine({ minTransactionsForBaseline: 3, valueP95Multiplier: 2 })
      const now = Date.now()
      // Build baseline: 5 small txs.
      for (let i = 0; i < 5; i++) {
        e.observe(WALLET, tx({ value: 100n, timestamp: now + i * 3600 }))
      }
      // Now try a huge value.
      const result = e.detect(WALLET, tx({ value: 1000n, timestamp: now + 5 * 3600 }))
      expect(result.isAnomalous).toBe(true)
      expect(result.signals.some((s) => s.signal === "ABNORMAL_VALUE")).toBe(true)
      expect(result.anomalyScore).toBeGreaterThan(0)
    })

    it("detects first-seen counterparty", function () {
      const e = engine({ minTransactionsForBaseline: 3 })
      const now = Date.now()
      for (let i = 0; i < 5; i++) {
        e.observe(WALLET, tx({ to: RECIPIENT, timestamp: now + i * 3600 }))
      }
      const result = e.detect(WALLET, tx({ to: NEW_RECIPIENT, timestamp: now + 5 * 3600 }))
      expect(result.isAnomalous).toBe(true)
      expect(result.signals.some((s) => s.signal === "FIRST_SEEN_COUNTERPARTY")).toBe(true)
    })

    it("detects unusual approval for a wallet that rarely approves", function () {
      const e = engine({ minTransactionsForBaseline: 3 })
      const now = Date.now()
      // 10 normal txs, 0 approvals → low approval ratio.
      for (let i = 0; i < 10; i++) {
        e.observe(WALLET, tx({ timestamp: now + i * 3600 }))
      }
      // Now an approval — unusual.
      const result = e.detect(WALLET, tx({ data: "0xa22cb465" + "0".repeat(64), timestamp: now + 10 * 3600 }))
      expect(result.isAnomalous).toBe(true)
      expect(result.signals.some((s) => s.signal === "UNUSUAL_APPROVAL")).toBe(true)
    })

    it("reports normal approval as low severity for wallets that approve often", function () {
      const e = engine({ minTransactionsForBaseline: 3 })
      const now = Date.now()
      // 3 normal, 7 approvals → high approval ratio.
      for (let i = 0; i < 3; i++) {
        e.observe(WALLET, tx({ timestamp: now + i * 3600 }))
      }
      for (let i = 3; i < 10; i++) {
        e.observe(WALLET, tx({ data: "0xa22cb465" + "0".repeat(64), timestamp: now + i * 3600 }))
      }
      // Another approval — matches pattern, low severity.
      const result = e.detect(WALLET, tx({ data: "0xa22cb465" + "0".repeat(64), timestamp: now + 10 * 3600 }))
      const approvalSignal = result.signals.find((s) => s.signal === "APPROVAL_PATTERN")
      expect(approvalSignal).toBeDefined()
      expect(approvalSignal!.severity).toBe("low")
    })

    it("returns no anomaly for a typical transaction", function () {
      const e = engine({ minTransactionsForBaseline: 3 })
      const now = Date.now()
      for (let i = 0; i < 10; i++) {
        e.observe(WALLET, tx({ value: 100n, timestamp: now + i * 3600 }))
      }
      // Normal value, known recipient, no approval.
      const result = e.detect(WALLET, tx({ value: 100n, to: RECIPIENT, timestamp: now + 10 * 3600 }))
      expect(result.isAnomalous).toBe(false)
      expect(result.anomalyScore).toBe(0)
      expect(result.explanation).toMatch(/matches established behavioral patterns/)
    })

    it("first-seen counterparty on a new wallet is detected", function () {
      const e = engine({ minTransactionsForBaseline: 3 })
      const now = Date.now()
      for (let i = 0; i < 5; i++) {
        e.observe(WALLET, tx({ to: RECIPIENT, timestamp: now + i * 3600 }))
      }
      const result = e.detect(WALLET, tx({ to: NEW_RECIPIENT, timestamp: now + 5 * 3600 }))
      expect(result.signals.find((s) => s.signal === "FIRST_SEEN_COUNTERPARTY")).toBeDefined()
    })

    it("anomaly score is capped at 100", function () {
      const e = engine({ minTransactionsForBaseline: 3, valueP95Multiplier: 1 })
      const now = Date.now()
      for (let i = 0; i < 5; i++) {
        e.observe(WALLET, tx({ value: 10n, timestamp: now + i * 3600 }))
      }
      // Extreme value + new counterparty + unusual approval + rapid tx.
      const result = e.detect(WALLET, tx({
        value: 10000n,
        to: NEW_RECIPIENT,
        data: "0x095ea7b3" + "f".repeat(64),
        timestamp: now + 5 * 3600 + 1, // 1 second after previous
      }))
      expect(result.anomalyScore).toBeLessThanOrEqual(100)
    })

    it("explanation lists all triggered signals", function () {
      const e = engine({ minTransactionsForBaseline: 3, valueP95Multiplier: 1 })
      const now = Date.now()
      for (let i = 0; i < 5; i++) {
        e.observe(WALLET, tx({ value: 10n, to: RECIPIENT, timestamp: now + i * 3600 }))
      }
      const result = e.detect(WALLET, tx({
        value: 10000n,
        to: NEW_RECIPIENT,
        timestamp: now + 5 * 3600,
      }))
      expect(result.explanation).toContain("exceeds 1x p95")
      expect(result.explanation).toContain("has not been seen before")
    })
  })

  // ---------------------------------------------------------------------------
  // isFirstSeenCounterparty
  // ---------------------------------------------------------------------------

  describe("isFirstSeenCounterparty", function () {
    it("returns true for unknown wallet", function () {
      expect(engine().isFirstSeenCounterparty("0xunknown", "0xaddr")).toBe(true)
    })

    it("returns true for first-seen counterparty", function () {
      const e = engine()
      e.observe(WALLET, tx({ to: "0xAAA" }))
      expect(e.isFirstSeenCounterparty(WALLET, "0xBBB")).toBe(true)
    })

    it("returns false for known counterparty", function () {
      const e = engine()
      e.observe(WALLET, tx({ to: "0xAAA" }))
      expect(e.isFirstSeenCounterparty(WALLET, "0xAAA")).toBe(false)
    })
  })
})
