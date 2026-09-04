import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import type { EnforcementRecord } from "../src/reconcileStore.js"
import { createFileReconcileStore, createInMemoryReconcileStore } from "../src/reconcileStore.js"
import { RiskStatus } from "../src/verdict.js"

const tmpDirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "reconcile-store-"))
  tmpDirs.push(dir)
  return dir
}

afterEach(function () {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function recordOf(overrides: Partial<EnforcementRecord> = {}): EnforcementRecord {
  return {
    safeTxHash: "0x1111",
    verdictId: null,
    verdictAtSubmit: { status: RiskStatus.HIGH_RISK, score: 90, releaseAt: 0 },
    value: "1000000000000000000",
    guardAtSubmit: { frozen: false, perTxLimit: "0", rollingLimit: "0", windowSpent: "0" },
    expected: {
      action: "BLOCK",
      reason: "verdict is HIGH_RISK",
      verdictStatus: RiskStatus.HIGH_RISK,
      releaseAt: 0,
      freezeExpected: false,
    },
    enforcementTxHash: null,
    recordedAt: 1000,
    updatedAt: 1000,
    rechecks: 0,
    latest: null,
    mismatchAt: null,
    ...overrides,
  }
}

describe("createInMemoryReconcileStore", function () {
  it("derives the latest record per txHash by replay, in first-seen order", function () {
    const store = createInMemoryReconcileStore()
    store.append({ txHash: "0xaaa", at: 1, kind: "recorded", record: recordOf({ safeTxHash: "0xaaa", recordedAt: 1 }) })
    store.append({ txHash: "0xbbb", at: 2, kind: "recorded", record: recordOf({ safeTxHash: "0xbbb", recordedAt: 2 }) })
    store.append({
      txHash: "0xaaa",
      at: 3,
      kind: "checked",
      record: recordOf({ safeTxHash: "0xaaa", recordedAt: 1, rechecks: 1 }),
    })

    const records = store.readRecords()
    expect(records.map((record) => record.safeTxHash)).toEqual(["0xaaa", "0xbbb"])
    expect(records[0].rechecks).toBe(1)
    expect(records[1].rechecks).toBe(0)
    expect(store.size()).toBe(3)
  })

  it("keeps per-txHash history immutable and ordered", function () {
    const store = createInMemoryReconcileStore()
    store.append({ txHash: "0xaaa", at: 1, kind: "recorded", record: recordOf({ safeTxHash: "0xaaa" }) })
    store.append({ txHash: "0xaaa", at: 2, kind: "checked", record: recordOf({ safeTxHash: "0xaaa" }) })
    store.append({ txHash: "0xaaa", at: 3, kind: "checked", record: recordOf({ safeTxHash: "0xaaa" }) })

    const history = store.readHistory("0xaaa")
    expect(history.map((event) => event.seq)).toEqual([1, 2, 3])
    expect(history.map((event) => event.kind)).toEqual(["recorded", "checked", "checked"])
    expect(store.readHistory()).toHaveLength(3)
  })
})

describe("createFileReconcileStore", function () {
  it("replays the full log on reopen - records and history survive a restart", function () {
    const filePath = join(tempDir(), "log.jsonl")
    const first = createFileReconcileStore(filePath)
    first.append({ txHash: "0xaaa", at: 1, kind: "recorded", record: recordOf({ safeTxHash: "0xaaa" }) })
    first.append({
      txHash: "0xaaa",
      at: 2,
      kind: "checked",
      record: recordOf({ safeTxHash: "0xaaa", rechecks: 1, mismatchAt: 2 }),
    })
    first.close()

    const reopened = createFileReconcileStore(filePath)
    expect(reopened.size()).toBe(2)
    const [record] = reopened.readRecords()
    expect(record.safeTxHash).toBe("0xaaa")
    expect(record.rechecks).toBe(1)
    expect(record.mismatchAt).toBe(2)
    expect(reopened.readHistory("0xaaa")).toHaveLength(2)

    // The reopened store keeps appending at the right seq number.
    reopened.append({ txHash: "0xaaa", at: 3, kind: "checked", record: recordOf({ safeTxHash: "0xaaa", rechecks: 2 }) })
    expect(reopened.readHistory("0xaaa").map((event) => event.seq)).toEqual([1, 2, 3])
    reopened.close()
  })

  it("serializes bigint-free records that round-trip through JSON", function () {
    const filePath = join(tempDir(), "log.jsonl")
    const store = createFileReconcileStore(filePath)
    store.append({ txHash: "0xaaa", at: 1, kind: "recorded", record: recordOf({ safeTxHash: "0xaaa" }) })
    store.close()
    // JSON.stringify throws on bigints, so a line that parses cleanly proves
    // amounts were stored as decimal strings (never as bigint literals).
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as {
      record: { value: string; guardAtSubmit: { perTxLimit: string } }
    }
    expect(parsed.record.value).toBe("1000000000000000000")
    expect(parsed.record.guardAtSubmit.perTxLimit).toBe("0")
  })

  it("fails loudly on a corrupt log instead of silently dropping events", function () {
    const filePath = join(tempDir(), "log.jsonl")
    writeFileSync(filePath, '{"seq":1,"txHash":"0xaaa"}\nnot-json\n', "utf8")
    expect(() => createFileReconcileStore(filePath)).toThrow(/corrupt reconciliation log/)
  })
})
