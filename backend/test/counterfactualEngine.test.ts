import { describe, expect, it } from "vitest"
import {
  analyzeCounterfactual,
  type ChainState,
  type ProposedTx,
} from "../src/counterfactualEngine.js"

// ─── Test helpers ────────────────────────────────────────────────────

function makeState(overrides?: Partial<ChainState>): ChainState {
  return {
    safeAddress: "0xaaaa000000000000000000000000000000000001",
    chainId: 11155111,
    balances: new Map([
      [
        "0xtoken00000000000000000000000000000000000001",
        new Map([["0xaaaa000000000000000000000000000000000001", 1000000n]]),
      ],
      [
        "native",
        new Map([["0xaaaa000000000000000000000000000000000001", 5000000000000000000n]]),
      ],
    ]),
    allowances: new Map(),
    approvalForAll: new Map(),
    roles: new Map(),
    ...overrides,
  }
}

function makeTx(overrides?: Partial<ProposedTx>): ProposedTx {
  return {
    txHash: "0xtx11111111111111111111111111111111111111111111111111111111111111",
    from: "0xaaaa000000000000000000000000000000000001",
    to: "0xtoken00000000000000000000000000000000000001",
    value: 0n,
    data: "0x",
    ...overrides,
  }
}

/** Encode approve(address,uint256) calldata */
function encodeApprove(spender: string, amount: bigint): string {
  const selector = "0x095ea7b3"
  const spenderWord = spender.toLowerCase().padStart(64, "0")
  const amountWord = amount.toString(16).padStart(64, "0")
  return `${selector}${spenderWord}${amountWord}`
}

/** Encode setApprovalForAll(address,bool) calldata */
function encodeSetApprovalForAll(operator: string, approved: boolean): string {
  const selector = "0xa22cb465"
  const operatorWord = operator.toLowerCase().padStart(64, "0")
  const approvedWord = approved ? "0".repeat(63) + "1" : "0".repeat(64)
  return `${selector}${operatorWord}${approvedWord}`
}

/** Encode transfer(address,uint256) calldata */
function encodeTransfer(to: string, amount: bigint): string {
  const selector = "0xa9059cbb"
  const toWord = to.toLowerCase().padStart(64, "0")
  const amountWord = amount.toString(16).padStart(64, "0")
  return `${selector}${toWord}${amountWord}`
}

// ─── Tests ───────────────────────────────────────────────────────────

describe("counterfactualEngine", () => {
  describe("immediate impact", () => {
    it("detects unlimited ERC-20 approval", () => {
      const state = makeState()
      const spender = "0xbbbb000000000000000000000000000000000002"
      const tx = makeTx({ data: encodeApprove(spender, (1n << 256n) - 1n) })

      const result = analyzeCounterfactual(state, tx)

      expect(result.immediateImpact).toHaveLength(1)
      expect(result.immediateImpact[0].kind).toBe("allowance")
      expect(result.immediateImpact[0].after).toBe(((1n << 256n) - 1n).toString())
      expect(result.immediateImpact[0].description).toContain("Unlimited approval")
    })

    it("detects limited ERC-20 approval", () => {
      const state = makeState()
      const spender = "0xbbbb000000000000000000000000000000000002"
      const tx = makeTx({ data: encodeApprove(spender, 500n) })

      const result = analyzeCounterfactual(state, tx)

      expect(result.immediateImpact).toHaveLength(1)
      expect(result.immediateImpact[0].kind).toBe("allowance")
      expect(result.immediateImpact[0].after).toBe("500")
      expect(result.immediateImpact[0].description).toContain("Approval of 500")
    })

    it("detects setApprovalForAll", () => {
      const state = makeState()
      const operator = "0xcccc000000000000000000000000000000000003"
      const collection = "0xnft00000000000000000000000000000000000001"
      const tx = makeTx({ to: collection, data: encodeSetApprovalForAll(operator, true) })

      const result = analyzeCounterfactual(state, tx)

      expect(result.immediateImpact).toHaveLength(1)
      expect(result.immediateImpact[0].kind).toBe("approval")
      expect(result.immediateImpact[0].after).toBe("true")
      expect(result.immediateImpact[0].description).toContain("blanket control")
    })

    it("detects native token transfer", () => {
      const state = makeState()
      const recipient = "0xdddd000000000000000000000000000000000004"
      const tx = makeTx({
        to: recipient,
        value: 1000000000000000000n,
        data: "0x",
      })

      const result = analyzeCounterfactual(state, tx)

      expect(result.immediateImpact).toHaveLength(1)
      expect(result.immediateImpact[0].kind).toBe("balance")
      expect(result.immediateImpact[0].asset).toBe("native")
    })

    it("records contract interaction for unknown calldata", () => {
      const state = makeState()
      const contract = "0xeeee000000000000000000000000000000000005"
      const tx = makeTx({ to: contract, data: "0xdeadbeef" })

      const result = analyzeCounterfactual(state, tx)

      expect(result.immediateImpact).toHaveLength(1)
      expect(result.immediateImpact[0].kind).toBe("contract_relationship")
    })
  })

  describe("future capabilities", () => {
    it("detects transferFrom as follow-up to unlimited approval", () => {
      const state = makeState()
      const spender = "0xbbbb000000000000000000000000000000000002"
      const tx = makeTx({ data: encodeApprove(spender, (1n << 256n) - 1n) })

      const result = analyzeCounterfactual(state, tx)

      expect(result.futureCapabilities.length).toBeGreaterThan(0)
      const transferFrom = result.futureCapabilities.find((f) => f.action.includes("transferFrom"))
      expect(transferFrom).toBeDefined()
      expect(transferFrom!.riskLevel).toBe("high")
    })

    it("detects operator transfer as follow-up to setApprovalForAll", () => {
      const state = makeState()
      const operator = "0xcccc000000000000000000000000000000000003"
      const collection = "0xnft00000000000000000000000000000000000001"
      const tx = makeTx({ to: collection, data: encodeSetApprovalForAll(operator, true) })

      const result = analyzeCounterfactual(state, tx)

      expect(result.futureCapabilities.length).toBeGreaterThan(0)
      const operatorAction = result.futureCapabilities.find((f) => f.riskLevel === "high")
      expect(operatorAction).toBeDefined()
    })

    it("returns no follow-ups for simple transfer", () => {
      const state = makeState()
      const recipient = "0xdddd000000000000000000000000000000000004"
      const tx = makeTx({
        to: recipient,
        value: 1000000000000000000n,
        data: "0x",
      })

      const result = analyzeCounterfactual(state, tx)

      // Transfer doesn't create new spending permissions
      expect(result.futureCapabilities).toHaveLength(0)
    })
  })

  describe("counterfactual paths", () => {
    it("always includes step 0 (the proposed transaction)", () => {
      const state = makeState()
      const tx = makeTx({ data: encodeApprove("0xbbbb000000000000000000000000000000000002", 500n) })

      const result = analyzeCounterfactual(state, tx)

      expect(result.paths.length).toBeGreaterThanOrEqual(1)
      expect(result.paths[0].step).toBe(0)
      expect(result.paths[0].description).toBe("Proposed transaction execution")
    })

    it("builds multi-step paths for high-risk follow-ups", () => {
      const state = makeState()
      const spender = "0xbbbb000000000000000000000000000000000002"
      const tx = makeTx({ data: encodeApprove(spender, (1n << 256n) - 1n) })

      const result = analyzeCounterfactual(state, tx)

      // Should have step 0 + counterfactual steps
      expect(result.paths.length).toBeGreaterThan(1)
      expect(result.paths[1].step).toBe(1)
      expect(result.paths[1].cumulativeRisk).toBeGreaterThan(0)
    })

    it("bounds path depth to MAX_PATH_DEPTH", () => {
      const state = makeState()
      const spender = "0xbbbb000000000000000000000000000000000002"
      const tx = makeTx({ data: encodeApprove(spender, (1n << 256n) - 1n) })

      const result = analyzeCounterfactual(state, tx)

      // Should not exceed 4 steps (MAX_PATH_DEPTH)
      expect(result.paths.length).toBeLessThanOrEqual(4)
    })
  })

  describe("risk scoring", () => {
    it("scores unlimited approval as high risk", () => {
      const state = makeState()
      const spender = "0xbbbb000000000000000000000000000000000002"
      const tx = makeTx({ data: encodeApprove(spender, (1n << 256n) - 1n) })

      const result = analyzeCounterfactual(state, tx)

      expect(["high", "critical"]).toContain(result.riskLevel)
      expect(["block", "freeze"]).toContain(result.recommendedAction)
    })

    it("scores setApprovalForAll as high risk", () => {
      const state = makeState()
      const operator = "0xcccc000000000000000000000000000000000003"
      const collection = "0xnft00000000000000000000000000000000000001"
      const tx = makeTx({ to: collection, data: encodeSetApprovalForAll(operator, true) })

      const result = analyzeCounterfactual(state, tx)

      expect(["high", "critical"]).toContain(result.riskLevel)
    })

    it("scores simple transfer as low risk", () => {
      const state = makeState()
      const recipient = "0xdddd000000000000000000000000000000000004"
      const tx = makeTx({
        to: recipient,
        value: 1000000000000000000n,
        data: "0x",
      })

      const result = analyzeCounterfactual(state, tx)

      expect(result.riskLevel).toBe("low")
      expect(result.recommendedAction).toBe("allow")
    })

    it("scores limited approval as low-to-medium risk", () => {
      const state = makeState()
      const spender = "0xbbbb000000000000000000000000000000000002"
      const tx = makeTx({ data: encodeApprove(spender, 500n) })

      const result = analyzeCounterfactual(state, tx)

      // Limited approval of 500 is bounded — follow-up is medium risk
      // but overall score may land below the medium threshold
      expect(["low", "medium"]).toContain(result.riskLevel)
    })
  })

  describe("exposure calculation", () => {
    it("reports exposure when follow-ups could drain assets", () => {
      const state = makeState()
      const spender = "0xbbbb000000000000000000000000000000000002"
      const tx = makeTx({ data: encodeApprove(spender, (1n << 256n) - 1n) })

      const result = analyzeCounterfactual(state, tx)

      // With unlimited approval, there should be exposure
      expect(result.potentialExposure.length).toBeGreaterThan(0)
      expect(result.potentialExposure[0].reversible).toBe(false)
    })

    it("reports no exposure for simple transfers", () => {
      const state = makeState()
      const recipient = "0xdddd000000000000000000000000000000000004"
      const tx = makeTx({
        to: recipient,
        value: 1000000000000000000n,
        data: "0x",
      })

      const result = analyzeCounterfactual(state, tx)

      expect(result.potentialExposure).toHaveLength(0)
    })
  })

  describe("preconditions", () => {
    it("identifies attacker control as precondition for high-risk follow-ups", () => {
      const state = makeState()
      const spender = "0xbbbb000000000000000000000000000000000002"
      const tx = makeTx({ data: encodeApprove(spender, (1n << 256n) - 1n) })

      const result = analyzeCounterfactual(state, tx)

      expect(result.preconditions.some((p) => p.includes("controlled by an attacker"))).toBe(true)
    })

    it("reports no specific preconditions for low-risk txs", () => {
      const state = makeState()
      const recipient = "0xdddd000000000000000000000000000000000004"
      const tx = makeTx({
        to: recipient,
        value: 1000000000000000000n,
        data: "0x",
      })

      const result = analyzeCounterfactual(state, tx)

      expect(result.preconditions).toContain("No specific preconditions required for observed state changes")
    })
  })

  describe("confidence", () => {
    it("returns higher confidence when follow-ups are detected", () => {
      const state = makeState()
      const spender = "0xbbbb000000000000000000000000000000000002"
      const tx = makeTx({ data: encodeApprove(spender, (1n << 256n) - 1n) })

      const result = analyzeCounterfactual(state, tx)

      expect(result.confidence).toBeGreaterThanOrEqual(0.8)
    })

    it("returns lower confidence when no follow-ups detected", () => {
      const state = makeState()
      const recipient = "0xdddd000000000000000000000000000000000004"
      const tx = makeTx({
        to: recipient,
        value: 1000000000000000000n,
        data: "0x",
      })

      const result = analyzeCounterfactual(state, tx)

      expect(result.confidence).toBeLessThan(0.8)
    })
  })

  describe("hypothetical vs fact distinction", () => {
    it("never mutates the original state", () => {
      const state = makeState()
      const originalBalance = state.balances.get("native")?.get(state.safeAddress)
      const spender = "0xbbbb000000000000000000000000000000000002"
      const tx = makeTx({ data: encodeApprove(spender, (1n << 256n) - 1n) })

      analyzeCounterfactual(state, tx)

      // Original state should be unchanged
      expect(state.balances.get("native")?.get(state.safeAddress)).toBe(originalBalance)
      expect(state.allowances.size).toBe(0)
    })
  })

  describe("summary", () => {
    it("provides human-readable summary for risky transactions", () => {
      const state = makeState()
      const spender = "0xbbbb000000000000000000000000000000000002"
      const tx = makeTx({ data: encodeApprove(spender, (1n << 256n) - 1n) })

      const result = analyzeCounterfactual(state, tx)

      expect(result.summary).toContain("Counterfactual analysis")
      expect(result.summary).toContain("Risk:")
    })

    it("provides clean summary for safe transactions", () => {
      const state = makeState()
      const recipient = "0xdddd000000000000000000000000000000000004"
      const tx = makeTx({
        to: recipient,
        value: 1000000000000000000n,
        data: "0x",
      })

      const result = analyzeCounterfactual(state, tx)

      expect(result.summary).toContain("No significant counterfactual risk")
    })
  })
})
