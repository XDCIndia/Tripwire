import { describe, expect, it, vi } from "vitest"

import type { RawPendingTx, SafeTxServiceClient } from "../src/types.js"
import { PendingTxWatcher } from "../src/watcher.js"

const SAFE = "0xSafe0000000000000000000000000000000000"

function mockClient(...batches: RawPendingTx[][]): SafeTxServiceClient {
  let call = 0
  return {
    getPendingTransactions: vi.fn(async () => {
      const results = batches[Math.min(call, batches.length - 1)]
      call += 1
      return { results }
    }),
  }
}

function raw(overrides: Partial<RawPendingTx> = {}): RawPendingTx {
  return {
    safeTxHash: "0xhash1",
    to: "0xTarget00000000000000000000000000000000",
    value: "1000000000000000000",
    data: "0xabcdef",
    nonce: "3",
    proposer: "0xProposer0000000000000000000000000000000",
    ...overrides,
  }
}

describe("PendingTxWatcher", function () {
  it("normalizes and emits every pending tx on the first poll", async function () {
    const client = mockClient([raw()])
    const seen: unknown[] = []
    const watcher = new PendingTxWatcher(client, SAFE, (tx) => seen.push(tx))

    const fresh = await watcher.pollOnce()

    expect(fresh).toEqual([
      {
        safeTxHash: "0xhash1",
        to: "0xTarget00000000000000000000000000000000",
        value: "1000000000000000000",
        data: "0xabcdef",
        proposer: "0xProposer0000000000000000000000000000000",
        nonce: "3",
      },
    ])
    expect(seen).toEqual(fresh)
  })

  it("defaults missing data to 0x", async function () {
    const client = mockClient([raw({ data: null })])
    const watcher = new PendingTxWatcher(client, SAFE, () => {})
    const [tx] = await watcher.pollOnce()
    expect(tx.data).toBe("0x")
  })

  it("falls back to the first confirmation's owner when proposer is absent", async function () {
    const client = mockClient([
      raw({ proposer: null, confirmations: [{ owner: "0xFirstSigner000000000000000000000000000" }] }),
    ])
    const watcher = new PendingTxWatcher(client, SAFE, () => {})
    const [tx] = await watcher.pollOnce()
    expect(tx.proposer).toBe("0xFirstSigner000000000000000000000000000")
  })

  it("does not re-emit a transaction already seen in a previous poll", async function () {
    const client = mockClient([raw()], [raw()])
    const onNewTx = vi.fn()
    const watcher = new PendingTxWatcher(client, SAFE, onNewTx)

    await watcher.pollOnce()
    const second = await watcher.pollOnce()

    expect(second).toEqual([])
    expect(onNewTx).toHaveBeenCalledTimes(1)
  })

  it("emits only the newly-appeared transaction when the queue grows", async function () {
    const client = mockClient(
      [raw({ safeTxHash: "0xhash1" })],
      [raw({ safeTxHash: "0xhash1" }), raw({ safeTxHash: "0xhash2", nonce: "4" })],
    )
    const onNewTx = vi.fn()
    const watcher = new PendingTxWatcher(client, SAFE, onNewTx)

    await watcher.pollOnce()
    const second = await watcher.pollOnce()

    expect(second).toHaveLength(1)
    expect(second[0].safeTxHash).toBe("0xhash2")
    expect(onNewTx).toHaveBeenCalledTimes(2)
  })
})

describe("PendingTxWatcher circuit breaker", function () {
  function failingClient(error: Error): { client: SafeTxServiceClient; calls: ReturnType<typeof vi.fn> } {
    const calls = vi.fn(async () => {
      throw error
    })
    return { client: { getPendingTransactions: calls }, calls }
  }

  it("opens after maxConsecutiveFailures and reports via onBreakerChange", async function () {
    const { client } = failingClient(new Error("service down"))
    const transitions: boolean[] = []
    const watcher = new PendingTxWatcher(client, SAFE, () => {}, {
      maxConsecutiveFailures: 3,
      onBreakerChange: (open) => transitions.push(open),
    })

    for (let i = 0; i < 3; i++) {
      await expect(watcher.pollOnce()).rejects.toThrow("service down")
    }

    expect(watcher.breakerState).toBe("open")
    expect(transitions).toEqual([true])
  })

  it("closes again on the first successful poll after failures", async function () {
    let fail = true
    const calls = vi.fn(async () => {
      if (fail) throw new Error("service down")
      return { results: [] }
    })
    const transitions: boolean[] = []
    const watcher = new PendingTxWatcher({ getPendingTransactions: calls }, SAFE, () => {}, {
      maxConsecutiveFailures: 2,
      onBreakerChange: (open) => transitions.push(open),
    })

    await expect(watcher.pollOnce()).rejects.toThrow()
    await expect(watcher.pollOnce()).rejects.toThrow()
    expect(watcher.breakerState).toBe("open")

    fail = false
    await watcher.pollOnce()

    expect(watcher.breakerState).toBe("closed")
    expect(transitions).toEqual([true, false])
  })

  it("start() stops calling the service while the breaker is open, and probes after the cooldown", async function () {
    vi.useFakeTimers()
    try {
      let now = 0
      let fail = true
      const calls = vi.fn(async () => {
        if (fail) throw new Error("service down")
        return { results: [] }
      })
      const watcher = new PendingTxWatcher({ getPendingTransactions: calls }, SAFE, () => {}, {
        maxConsecutiveFailures: 2,
        breakerCooldownMs: 10_000,
        now: () => now,
      })

      // Trip the breaker with two direct failures.
      await expect(watcher.pollOnce()).rejects.toThrow()
      await expect(watcher.pollOnce()).rejects.toThrow()
      const callsWhenTripped = calls.mock.calls.length

      const handle = watcher.start(1000)
      try {
        // Three interval ticks inside the cooldown: service must not be hit.
        await vi.advanceTimersByTimeAsync(3000)
        expect(calls.mock.calls.length).toBe(callsWhenTripped)

        // After the cooldown the next tick probes once; success closes the
        // breaker and normal polling resumes.
        now += 10_000
        fail = false
        await vi.advanceTimersByTimeAsync(2000)
        expect(calls.mock.calls.length).toBeGreaterThan(callsWhenTripped)
        expect(watcher.breakerState).toBe("closed")
      } finally {
        clearInterval(handle)
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it("a failed probe poll reopens the breaker for another full cooldown", async function () {
    vi.useFakeTimers()
    try {
      let now = 0
      const calls = vi.fn(async () => {
        throw new Error("service down")
      })
      const watcher = new PendingTxWatcher({ getPendingTransactions: calls }, SAFE, () => {}, {
        maxConsecutiveFailures: 2,
        breakerCooldownMs: 10_000,
        now: () => now,
      })

      await expect(watcher.pollOnce()).rejects.toThrow()
      await expect(watcher.pollOnce()).rejects.toThrow()

      const handle = watcher.start(1000)
      try {
        // First cooldown elapses -> one probe, which fails -> reopen.
        now += 10_000
        await vi.advanceTimersByTimeAsync(1000)
        expect(watcher.breakerState).toBe("open")

        // Inside the NEW cooldown the service is not called again.
        const callsAfterProbe = calls.mock.calls.length
        await vi.advanceTimersByTimeAsync(5000)
        expect(calls.mock.calls.length).toBe(callsAfterProbe)
      } finally {
        clearInterval(handle)
      }
    } finally {
      vi.useRealTimers()
    }
  })
})
