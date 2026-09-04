/**
 * Reconciliation persistence (issue #50: "persist reconciliation results").
 *
 * Same shape as the job log: an append-only sequence of full snapshots, so
 * the latest state is derived by replay and the history is immutable - a
 * MISMATCH is never edited into a MATCH, later checks are appended after it.
 * In-memory and fsynced-file implementations share one interface.
 *
 * Amounts are stored as decimal strings, never bigints, so a record (and
 * its whole history) round-trips through JSON and survives a restart.
 */

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs"
import { dirname } from "node:path"

import { type ExpectedEnforcement, type ReconciliationResult, type RegistryVerdictState } from "./reconcileTypes.js"

/** One transaction's enforcement record - the thing being attested. */
export interface EnforcementRecord {
  safeTxHash: string
  /** Stable id of the canonical verdict being attested. */
  verdictId: string | null
  /** The verdict the expectation was built from. */
  verdictAtSubmit: RegistryVerdictState
  /** Transaction value in wei, as a decimal string. */
  value: string
  /** Guard controls at submit time (decimal strings for limits). */
  guardAtSubmit: {
    frozen: boolean
    perTxLimit: string
    rollingLimit: string
    windowSpent: string
  }
  expected: ExpectedEnforcement
  /** On-chain hash of the enforcement/safe-exec attempt, when known. */
  enforcementTxHash: string | null
  recordedAt: number
  /** When the record was last checked. */
  updatedAt: number
  /** Automatic re-checks performed so far. */
  rechecks: number
  /** Latest reconciliation outcome (null until first check). */
  latest: ReconciliationResult | null
  /** Epoch ms of the first MISMATCH ever seen for this transaction. Latch:
   * once set it never clears, so an incident can never be silently erased
   * by later healthy checks - recovery shows up as new history entries and
   * a MATCH `latest`, but the latch keeps telling dashboards "this record
   * has mismatched before". */
  mismatchAt: number | null
}

export type ReconciliationEventKind = "recorded" | "checked"

export interface ReconciliationEvent {
  seq: number
  txHash: string
  at: number
  kind: ReconciliationEventKind
  /** Full record snapshot after this event. */
  record: EnforcementRecord
}

export interface ReconciliationStore {
  append(event: Omit<ReconciliationEvent, "seq">): ReconciliationEvent
  readRecords(): EnforcementRecord[]
  readHistory(txHash?: string): ReconciliationEvent[]
  size(): number
  close(): void
}

export function createInMemoryReconcileStore(): ReconciliationStore {
  const events: ReconciliationEvent[] = []
  return {
    append(event) {
      const stored: ReconciliationEvent = { seq: events.length + 1, ...event }
      events.push(stored)
      return stored
    },
    readRecords() {
      const records = new Map<string, EnforcementRecord>()
      const order: string[] = []
      for (const event of events) {
        if (!records.has(event.txHash)) order.push(event.txHash)
        records.set(event.txHash, event.record)
      }
      return order.map((txHash) => records.get(txHash)!)
    },
    readHistory(txHash) {
      return txHash === undefined ? [...events] : events.filter((event) => event.txHash === txHash)
    },
    size() {
      return events.length
    },
    close() {
      /* nothing to flush */
    },
  }
}

/** Durable JSON-lines store: every check is fsynced before it is reported,
 * and reopening the file replays the full history. */
export function createFileReconcileStore(filePath: string): ReconciliationStore {
  const events: ReconciliationEvent[] = []

  mkdirSync(dirname(filePath), { recursive: true })
  const existing = existsSync(filePath) ? readFileSync(filePath, "utf8") : ""
  if (existing.length > 0) {
    for (const [index, raw] of existing.split("\n").entries()) {
      if (raw.trim() === "") continue
      try {
        events.push(JSON.parse(raw) as ReconciliationEvent)
      } catch {
        throw new Error(`corrupt reconciliation log at ${filePath} line ${index + 1}`)
      }
    }
  }

  const fd = openSync(filePath, "a")
  return {
    append(event) {
      const stored: ReconciliationEvent = { seq: events.length + 1, ...event }
      writeSync(fd, `${JSON.stringify(stored)}\n`)
      fsyncSync(fd)
      events.push(stored)
      return stored
    },
    readRecords() {
      const records = new Map<string, EnforcementRecord>()
      const order: string[] = []
      for (const event of events) {
        if (!records.has(event.txHash)) order.push(event.txHash)
        records.set(event.txHash, event.record)
      }
      return order.map((txHash) => records.get(txHash)!)
    },
    readHistory(txHash) {
      return txHash === undefined ? [...events] : events.filter((event) => event.txHash === txHash)
    },
    size() {
      return events.length
    },
    close() {
      fsyncSync(fd)
      closeSync(fd)
    },
  }
}
