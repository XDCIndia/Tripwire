import { describe, expect, it, vi } from "vitest"

import type { ForkClient } from "../src/simulate.js"
import type { SimulationDiff } from "../src/simulate.js"
import { NO_SIMULATION_SIGNALS, analyzeSimulation, simulateSafely } from "../src/simulationSignals.js"

const SAFE = "0xSafe0000000000000000000000000000000000" as const
const TOKEN = "0xToken000000000000000000000000000000000" as const
const ATTACKER = "0xAttacker0000000000000000000000000000000" as const

const pad32 = (hex: string): string => hex.padStart(64, "0")
const APPROVE_CLAIMED_SPENDER =
  `0x095ea7b3${pad32("abcdefabcdefabcdefabcdefabcdefabcdefabcd")}${pad32("f".repeat(64))}` as `0x${string}`
const SET_APPROVAL_FOR_ALL =
  `0xa22cb465${pad32("abcdefabcdefabcdefabcdefabcdefabcdefabcd")}${pad32("1")}` as `0x${string}`
const PLAIN_TRANSFER = "0x" as `0x${string}`

function diff(overrides: Partial<SimulationDiff> = {}): SimulationDiff {
  return {
    balanceBefore: 1000n,
    balanceAfter: 1000n,
    newAllowances: [],
    ownershipChanges: [],
    success: true,
    ...overrides,
  }
}

describe("analyzeSimulation", function () {
  it("a clean plain transfer raises no signals", function () {
    const signals = analyzeSimulation(
      { from: SAFE, to: ATTACKER, value: 100n, data: PLAIN_TRANSFER },
      diff({ balanceAfter: 900n }), // value 100 out, nothing else
    )
    expect(signals).toEqual(NO_SIMULATION_SIGNALS)
  })

  it("flags a reverted call", function () {
    const signals = analyzeSimulation(
      { from: SAFE, to: TOKEN, value: 0n, data: PLAIN_TRANSFER },
      diff({ success: false }),
    )
    expect(signals.callReverted).toBe(true)
    expect(signals.simulationFailed).toBe(false)
  })

  it("flags a hidden native outflow beyond the stated value", function () {
    const signals = analyzeSimulation(
      { from: SAFE, to: ATTACKER, value: 100n, data: PLAIN_TRANSFER },
      diff({ balanceAfter: 800n }), // 200 left, tx only claims 100
    )
    expect(signals.hiddenNativeOutflow).toBe(true)
  })

  it("does NOT flag the stated value itself as hidden outflow", function () {
    const signals = analyzeSimulation(
      { from: SAFE, to: ATTACKER, value: 100n, data: PLAIN_TRANSFER },
      diff({ balanceAfter: 900n }),
    )
    expect(signals.hiddenNativeOutflow).toBe(false)
  })

  it("accepts an allowance the calldata itself claims (approve to its word-0 spender)", function () {
    const claimedSpender = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd" as const
    const signals = analyzeSimulation(
      { from: SAFE, to: TOKEN, value: 0n, data: APPROVE_CLAIMED_SPENDER },
      diff({
        newAllowances: [{ token: TOKEN, spender: claimedSpender, standard: "erc20", before: 0n, after: 500n }],
      }),
    )
    expect(signals.unexpectedAllowanceIncrease).toBe(false)
  })

  it("accepts a setApprovalForAll the calldata claims", function () {
    const claimedOperator = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd" as const
    const signals = analyzeSimulation(
      { from: SAFE, to: TOKEN, value: 0n, data: SET_APPROVAL_FOR_ALL },
      diff({
        newAllowances: [{ token: TOKEN, spender: claimedOperator, standard: "nft", before: 0n, after: 1n }],
      }),
    )
    expect(signals.unexpectedAllowanceIncrease).toBe(false)
  })

  it("flags an allowance appearing on a DIFFERENT spender than the calldata claims", function () {
    const signals = analyzeSimulation(
      { from: SAFE, to: TOKEN, value: 0n, data: APPROVE_CLAIMED_SPENDER }, // claims 0xabc...
      diff({
        newAllowances: [{ token: TOKEN, spender: ATTACKER, standard: "erc20", before: 0n, after: 500n }],
      }),
    )
    expect(signals.unexpectedAllowanceIncrease).toBe(true)
  })

  it("flags an allowance on a token the calldata never touches (issue #44's example)", function () {
    const HIDDEN_TOKEN = "0xHidden000000000000000000000000000000000" as const
    const signals = analyzeSimulation(
      { from: SAFE, to: ATTACKER, value: 0n, data: PLAIN_TRANSFER }, // claims nothing
      diff({
        newAllowances: [{ token: HIDDEN_TOKEN, spender: ATTACKER, standard: "erc20", before: 0n, after: 1n }],
      }),
    )
    expect(signals.unexpectedAllowanceIncrease).toBe(true)
  })

  it("does not flag allowance DECREASES (revocations)", function () {
    const signals = analyzeSimulation(
      { from: SAFE, to: ATTACKER, value: 0n, data: PLAIN_TRANSFER },
      diff({
        newAllowances: [{ token: TOKEN, spender: ATTACKER, standard: "erc20", before: 500n, after: 0n }],
      }),
    )
    expect(signals.unexpectedAllowanceIncrease).toBe(false)
  })

  it("flags a watched NFT leaving the wallet", function () {
    const NFT = "0xNft0000000000000000000000000000000000000" as const
    const signals = analyzeSimulation(
      { from: SAFE, to: TOKEN, value: 0n, data: PLAIN_TRANSFER },
      diff({
        ownershipChanges: [{ token: NFT, tokenId: 1n, ownerBefore: SAFE, ownerAfter: ATTACKER }],
      }),
    )
    expect(signals.ownershipTransferDetected).toBe(true)
  })

  it("ignores NFTs arriving FROM other wallets (not our asset leaving)", function () {
    const NFT = "0xNft0000000000000000000000000000000000000" as const
    const SOMEONE = "0xSomeone0000000000000000000000000000000" as const
    const signals = analyzeSimulation(
      { from: SAFE, to: TOKEN, value: 0n, data: PLAIN_TRANSFER },
      diff({
        ownershipChanges: [{ token: NFT, tokenId: 1n, ownerBefore: SOMEONE, ownerAfter: ATTACKER }],
      }),
    )
    expect(signals.ownershipTransferDetected).toBe(false)
  })
})

describe("simulateSafely (issue #44 fail-safe: failure can never approve)", function () {
  function throwingClient(message: string): ForkClient {
    return {
      getBalance: vi.fn(async () => {
        throw new Error(message)
      }),
      readErc20Allowance: vi.fn(async () => 0n),
      readIsApprovedForAll: vi.fn(async () => false),
      readErc721Owner: vi.fn(async () => SAFE),
      snapshot: vi.fn(async () => "0x1"),
      revert: vi.fn(async () => {}),
      execute: vi.fn(async () => ({ success: true })),
    }
  }

  it("resolves (never rejects) when the fork client throws", async function () {
    const result = await simulateSafely(throwingClient("anvil unreachable"), {
      from: SAFE,
      to: TOKEN,
      value: 0n,
      data: PLAIN_TRANSFER,
    })
    expect(result.diff).toBeUndefined()
    expect(result.signals.simulationFailed).toBe(true)
    expect(result.signals.callReverted).toBe(false)
    expect(result.signals.hiddenNativeOutflow).toBe(false)
    expect(result.signals.unexpectedAllowanceIncrease).toBe(false)
    expect(result.signals.ownershipTransferDetected).toBe(false)
  })

  it("resolves with analyzed signals on success", async function () {
    const client = throwingClient("unused")
    client.getBalance = vi.fn().mockResolvedValueOnce(1000n).mockResolvedValueOnce(400n)
    const result = await simulateSafely(client, {
      from: SAFE,
      to: ATTACKER,
      value: 100n,
      data: PLAIN_TRANSFER,
    })
    expect(result.diff).toBeDefined()
    expect(result.signals.simulationFailed).toBe(false)
    expect(result.signals.hiddenNativeOutflow).toBe(true) // 600 gone, only 100 claimed
  })
})
