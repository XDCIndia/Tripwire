/**
 * End-to-end walkthrough for issue #50: on-chain verdict attestation and
 * enforcement reconciliation.
 *
 * The story this module exists to tell: writing a HIGH_RISK verdict to the
 * RiskRegistry does NOT mean the transaction was stopped. Between the
 * submit and the next block the verdict can be overwritten, the Guard can
 * be unfrozen, limits raised, or the enforcement transaction dropped. This
 * demo records expected enforcement for three transactions, then shows the
 * reconciliation loop catching each failure mode - including one where the
 * protection quietly stops applying and everything still looks "green" to
 * anyone not looking at the chain.
 *
 * The chain here is a scripted stand-in behind the same
 * `ReconcileChainReader` interface the real viem reader
 * (`createReconcileChainReader` in src/reconcileChain.ts) implements - the
 * whole demo runs offline. Swap the stub for the real reader pointed at an
 * RPC + the deployed RiskRegistry/TripwireGuard addresses and every line
 * below is what an operator would see for real.
 *
 * Usage:  npm run demo:reconcile   (or: npx tsx scripts/reconcileDemo.ts)
 */
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createReconcileApi } from "../src/reconcileApi.js"
import type { ReconcileChainReader } from "../src/reconcileService.js"
import { ReconciliationService } from "../src/reconcileService.js"
import { createFileReconcileStore } from "../src/reconcileStore.js"
import type { ChainStateSnapshot, RegistryVerdictState } from "../src/reconcileTypes.js"
import { RiskStatus, type RiskStatusValue } from "../src/verdict.js"

const GREEN = "\x1b[32m"
const RED = "\x1b[31m"
const YELLOW = "\x1b[33m"
const BOLD = "\x1b[1m"
const RESET = "\x1b[0m"

const step = (title: string): void => console.log(`\n${BOLD}▸ ${title}${RESET}`)
const ok = (line: string): void => console.log(`  ${GREEN}✓${RESET} ${line}`)
const warn = (line: string): void => console.log(`  ${YELLOW}!${RESET} ${line}`)
const crit = (line: string): void => console.log(`  ${RED}✗${RESET} ${line}`)

const TX = {
  drainer: "0xaaaa00000000000000000000000000000000000000000000000000000000000001",
  approved: "0xbbbb00000000000000000000000000000000000000000000000000000000000002",
  delayed: "0xcccc00000000000000000000000000000000000000000000000000000000000003",
} as const

function verdict(status: RiskStatusValue, releaseAt = 0): RegistryVerdictState {
  return { status, score: status === RiskStatus.HIGH_RISK ? 90 : 20, releaseAt }
}

/** Simulated chain: a map of txHash -> current on-chain state. Swap this
 * for `createReconcileChainReader` against a live RPC in production. */
function simulatedChain(
  initial: Record<string, RegistryVerdictState>,
): { reader: ReconcileChainReader; set: (txHash: string, state: ChainStateSnapshot) => void } {
  const state = new Map<string, ChainStateSnapshot>(
    Object.entries(initial).map(([txHash, registryVerdict]) => [
      txHash,
      {
        registryVerdict,
        guard: { frozen: false, perTxLimit: 0n, rollingLimit: 0n, windowSpent: 0n },
        execution: { kind: "none" },
      },
    ]),
  )
  return {
    reader: {
      async readState(safeTxHash) {
        const found = state.get(safeTxHash)
        if (!found) throw new Error(`simulated chain has no state for ${safeTxHash}`)
        return found
      },
    },
    set(txHash, next) {
      state.set(txHash, next)
    },
  }
}

const nowSeconds = (): number => Math.floor(Date.now() / 1000)

async function main(): Promise<void> {
  console.log(`${BOLD}Tripwire - on-chain verdict attestation & enforcement reconciliation${RESET}`)
  console.log("(issue #50) - simulated chain behind the real ReconcileChainReader interface\n")

  const logPath = join(tmpdir(), `reconcile-demo-${process.pid}.jsonl`)
  const chain = simulatedChain({
    [TX.drainer]: verdict(RiskStatus.HIGH_RISK),
    [TX.approved]: verdict(RiskStatus.LOW_RISK),
    [TX.delayed]: verdict(RiskStatus.DELAYED, nowSeconds() + 3600),
  })
  const alerts: unknown[] = []
  const service = new ReconciliationService(createFileReconcileStore(logPath), {
    reader: chain.reader,
    onAlert: (alert) => alerts.push(alert),
  })

  step("1. Verdicts land on-chain; expected enforcement is derived and recorded")
  const guard = { frozen: false, perTxLimit: 1_000_000_000_000_000_000n, rollingLimit: 0n, windowSpent: 0n }
  const drainerRecord = service.recordEnforcement({
    safeTxHash: TX.drainer,
    verdictAtSubmit: verdict(RiskStatus.HIGH_RISK),
    // Inside the 1 ETH per-tx limit on purpose: the demo drift must not be
    // masked by the spending-limit backstop - the point is that *nothing*
    // protects this tx after the verdict rewrite.
    value: 500_000_000_000_000_000n,
    guardAtSubmit: guard,
    verdictId: "verdict-901",
  })
  service.recordEnforcement({
    safeTxHash: TX.approved,
    verdictAtSubmit: verdict(RiskStatus.LOW_RISK),
    value: 10_000_000_000_000_000n,
    guardAtSubmit: guard,
    verdictId: "verdict-902",
  })
  service.recordEnforcement({
    safeTxHash: TX.delayed,
    verdictAtSubmit: verdict(RiskStatus.DELAYED, nowSeconds() + 3600),
    value: 50_000_000_000_000_000n,
    guardAtSubmit: guard,
    verdictId: "verdict-903",
  })
  ok(`${TX.drainer.slice(0, 18)}… → expected ${drainerRecord.expected.action} (${drainerRecord.expected.reason})`)
  ok(`3 enforcement records persisted to ${logPath}`)

  step("2. First reconciliation pass - everything still green (MATCH)")
  const first = await service.check(TX.drainer)
  ok(`drainer tx: ${first.result.status} - ${first.result.notes[0]}`)

  step("3. Attack / silent drift: the HIGH_RISK verdict is overwritten to LOW_RISK")
  // No freeze, limits unchanged: nothing blocks this transaction any more.
  chain.set(TX.drainer, {
    registryVerdict: verdict(RiskStatus.LOW_RISK),
    guard: { frozen: false, perTxLimit: 1_000_000_000_000_000_000n, rollingLimit: 0n, windowSpent: 0n },
    execution: { kind: "none" },
  })
  const drifted = await service.check(TX.drainer)
  if (drifted.result.status === "MISMATCH") crit(`drainer tx: ${drifted.result.status} (CRITICAL)`)
  else ok(`drainer tx: ${drifted.result.status}`)
  for (const note of drifted.result.notes) crit(`  ${note}`)
  const incident = alerts[alerts.length - 1] as { kind: string; verdictId: string | null } | undefined
  if (incident) crit(`  alert raised: kind=${incident.kind} verdictId=${incident.verdictId}`)

  step("4. The verdict is restored - reconciliation observes recovery, but the incident latch stays")
  chain.set(TX.drainer, {
    registryVerdict: verdict(RiskStatus.HIGH_RISK),
    guard: { frozen: false, perTxLimit: 1_000_000_000_000_000_000n, rollingLimit: 0n, windowSpent: 0n },
    execution: { kind: "none" },
  })
  const recovered = await service.check(TX.drainer)
  ok(`drainer tx: ${recovered.result.status} again (protection is active)`)
  const record = service.getRecord(TX.drainer)!
  warn(`  but mismatchAt=${record.mismatchAt} is latched - the incident was never erased, only resolved`)

  step("5. Slow-but-honest outcomes: a DELAY pending its window, an ALLOW awaiting execution")
  const delayCheck = await service.check(TX.delayed)
  if (delayCheck.result.status === "PENDING") {
    warn(`delayed tx: ${delayCheck.result.status} until recheckAt=${delayCheck.result.recheckAt}`)
  } else {
    ok(`delayed tx: ${delayCheck.result.status}`)
  }
  const allowCheck = await service.check(TX.approved)
  if (allowCheck.result.status === "PENDING") {
    warn(
      `approved tx: ${allowCheck.result.status} - no execution observed yet; ` +
        "an allow is only confirmed by executing",
    )
  } else {
    ok(`approved tx: ${allowCheck.result.status}`)
  }

  step("6. The approved transaction finally executes - MATCH at last")
  chain.set(TX.approved, {
    registryVerdict: verdict(RiskStatus.LOW_RISK),
    guard: { frozen: false, perTxLimit: 1_000_000_000_000_000_000n, rollingLimit: 0n, windowSpent: 0n },
    execution: { kind: "success" },
  })
  const executed = await service.check(TX.approved)
  ok(`approved tx: ${executed.result.status} - ${executed.result.notes[0]}`)

  step("7. Restart durability: reopen the fsynced log and the story is intact")
  service.log.close()
  const reopened = new ReconciliationService(createFileReconcileStore(logPath), {
    reader: chain.reader,
    onAlert: (alert) => alerts.push(alert),
  })
  const drainerAgain = reopened.getRecord(TX.drainer)
  if (drainerAgain && drainerAgain.mismatchAt !== null && drainerAgain.latest?.status === "MATCH") {
    ok(
      `after restart: drainer tx latest=${drainerAgain.latest.status}, ` +
        `mismatchAt latch=${drainerAgain.mismatchAt} ✓`,
    )
  } else {
    warn(`after restart: drainer tx latest=${drainerAgain?.latest?.status}, mismatchAt=${drainerAgain?.mismatchAt}`)
  }
  ok(`${reopened.records().length} records, ${reopened.log.size()} log events survived the restart`)

  step("8. Status API (the same handlers the HTTP server exposes)")
  const api = createReconcileApi(reopened)
  const list = api.listRecords({})
  const health = api.health()
  const mismatches = reopened.records({ status: "MISMATCH" })
  if (list.ok && health.ok) ok(`GET /reconcile/health → ${JSON.stringify(health.data)}`)
  ok(`records: ${(list.ok ? (list.data as unknown[]).length : 0)} total, ${mismatches.length} still MISMATCH`)
  if (mismatches.length === 0) {
    ok(`no open MISMATCHes - and the latched incident on ${TX.drainer.slice(0, 18)}… is history, not erased`)
  }

  console.log(`\n${BOLD}Done.${RESET} Every enforcement outcome was attested against the chain - nothing was assumed.`)
  console.log(
    "The 3 tx story (blocked→drifted→recovered, allowed→executed, delayed→pending) is persisted in the log.\n",
  )
  rmSync(logPath, { force: true })
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
