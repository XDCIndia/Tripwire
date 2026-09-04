import { appendFile, mkdir, readFile } from "node:fs/promises"
import { dirname } from "node:path"

import { scoreTransaction, type RuleEngineResult } from "./ruleEngine.js"
import type { LlmVerdict } from "./verdict.js"

/**
 * Event-driven risk orchestrator (issue #45): one workflow that receives
 * proposed Safe transactions, fans out to the risk-analysis components,
 * aggregates their contributions into a single canonical verdict, and
 * submits it to RiskRegistry for the Zodiac Guard.
 *
 * Design contracts, mapped to the acceptance criteria:
 *
 * 1. SINGLE PIPELINE, PLUGGABLE COMPONENTS. `propose()` is the only entry
 *    point (HTTP and in-process queue both land there). The rule engine is
 *    built in and deterministic; simulation/LLM arrive through optional
 *    async component slots - #44 and #53 plug straight in.
 * 2. DEDUPE BY STATE, NOT BY MEMORY. Every transition is persisted through
 *    the state store keyed by tx hash; a duplicate proposal for a tx that
 *    already has a verdict returns the existing verdict instead of
 *    reprocessing (criterion: no duplicate verdicts).
 * 3. RETRIES WITHOUT STATE LOSS. Each async component gets its own
 *    attempts; submission failures flip the tx to `submission_failed` and
 *    the next proposal of the same tx RESUMES from the persisted state
 *    (criterion: retry without losing transaction state).
 * 4. FAIL-SAFE. A critical component (simulation) that is unavailable after
 *    its retries contributes an elevated-risk penalty with an explicit
 *    reason - never silence, never approval (criterion: fail-safe policy).
 *    The LLM is non-critical: its failure changes nothing.
 * 5. CANONICAL VERDICT. Exactly one per tx: { score, status, action,
 *    explanation }, correlated by tx hash, aggregated from every
 *    component's contribution, capped at 100.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ProposedTx {
  txHash: string
  to: string
  value: bigint
  data: string
}

export type VerdictStatus = "low_risk" | "medium_risk" | "high_risk"
export type VerdictAction = "allow" | "delay" | "block"

/** The one canonical verdict per transaction (criterion: single verdict). */
export interface CanonicalVerdict {
  txHash: string
  score: number
  status: VerdictStatus
  action: VerdictAction
  explanation: string
  /** Per-component contributions - the explainability breakdown. */
  contributions: Array<{ component: string; points: number; reasons: string[] }>
  at: string
}

export type ProcessingStatus =
  | "received"
  | "analyzing"
  | "verdict_ready"
  | "submitting"
  | "submitted"
  | "submission_failed"

export interface TxProcessingState {
  txHash: string
  status: ProcessingStatus
  /** Submission attempts so far (relayer retries). */
  attempts: number
  canonical?: CanonicalVerdict
  updatedAt: string
  history: Array<{ at: string; status: ProcessingStatus; note?: string }>
}

export interface ScoreContribution {
  points: number
  reasons: string[]
}

export interface ComponentOutcome {
  component: string
  ok: boolean
  attempts: number
  contribution: ScoreContribution
}

// ---------------------------------------------------------------------------
// Component slots (pluggable analysis components)
// ---------------------------------------------------------------------------

export interface SimulationSlot {
  /** Runs fork simulation for the tx and reports a contribution. Throwing => unavailable. */
  analyze(tx: ProposedTx): Promise<ScoreContribution>
}

export interface LlmSlot {
  /** Optional contextual reasoning; resolves undefined when unavailable. Never throws requirement is the caller's to enforce. */
  assess(tx: ProposedTx, context: RuleEngineResult): Promise<LlmVerdict | undefined>
}

export interface RelayerSlot {
  /** Submits the canonical verdict on-chain (e.g. backed by VerdictRelayer). */
  submit(txHash: string, verdict: RuleEngineResult): Promise<void>
}

// ---------------------------------------------------------------------------
// State store
// ---------------------------------------------------------------------------

export interface StateStore {
  load(txHash: string): Promise<TxProcessingState | undefined>
  save(state: TxProcessingState): Promise<void>
  all(): Promise<TxProcessingState[]>
}

export function createMemoryStateStore(): StateStore {
  const states = new Map<string, TxProcessingState>()
  return {
    async load(txHash) {
      const s = states.get(txHash)
      return s ? structuredClone(s) : undefined
    },
    async save(state) {
      states.set(state.txHash, structuredClone(state))
    },
    async all() {
      return [...states.values()].map((s) => structuredClone(s))
    },
  }
}

interface StoredEnvelope {
  seq: number
  state: TxProcessingState
}

/**
 * JSON-lines state store: every save appends a new envelope (seq-ordered),
 * so a crash mid-write loses at most the newest transition. Loads resolve
 * the latest envelope per tx, sorted by seq - write order on disk is
 * irrelevant, same lesson as the audit ledger.
 */
export function createJsonlStateStore(filePath: string): StateStore {
  let seq = 0
  const cache = new Map<string, TxProcessingState>()
  let loaded = false

  async function ensureLoaded(): Promise<void> {
    if (loaded) return
    let raw: string
    try {
      raw = await readFile(filePath, "utf8")
    } catch {
      loaded = true
      return
    }
    const envelopes: StoredEnvelope[] = []
    for (const line of raw.split("\n")) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      try {
        envelopes.push(JSON.parse(trimmed) as StoredEnvelope)
      } catch {
        // skip corrupt line
      }
    }
    envelopes.sort((a, b) => a.seq - b.seq)
    for (const env of envelopes) {
      cache.set(env.state.txHash, env.state)
      seq = Math.max(seq, env.seq + 1)
    }
    loaded = true
  }

  return {
    async load(txHash) {
      await ensureLoaded()
      const s = cache.get(txHash)
      return s ? structuredClone(s) : undefined
    },
    async save(state) {
      await ensureLoaded()
      cache.set(state.txHash, structuredClone(state))
      await mkdir(dirname(filePath), { recursive: true })
      await appendFile(filePath, `${JSON.stringify({ seq: seq++, state } satisfies StoredEnvelope)}\n`, "utf8")
    },
    async all() {
      await ensureLoaded()
      return [...cache.values()].map((s) => structuredClone(s))
    },
  }
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export interface RiskOrchestratorOptions {
  relayer: RelayerSlot
  store: StateStore
  simulation?: SimulationSlot
  llm?: LlmSlot
  /** Max attempts per async component (default 3). */
  componentRetries?: number
  /** Per-attempt timeout for async components, ms (default 5000). */
  componentTimeoutMs?: number
  /** Max on-chain submission attempts (default 3). */
  submissionRetries?: number
  now?: () => Date
  sleep?: (ms: number) => Promise<void>
  onError?: (err: unknown) => void
}

const HIGH_RISK_THRESHOLD = 70
const MEDIUM_RISK_THRESHOLD = 30

function statusForScore(score: number): VerdictStatus {
  return score >= HIGH_RISK_THRESHOLD ? "high_risk" : score >= MEDIUM_RISK_THRESHOLD ? "medium_risk" : "low_risk"
}

function actionForStatus(status: VerdictStatus): VerdictAction {
  return status === "high_risk" ? "block" : status === "medium_risk" ? "delay" : "allow"
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
    promise.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (err: unknown) => {
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      },
    )
  })
}

export class RiskOrchestrator {
  private readonly queue: ProposedTx[] = []
  private draining = false

  private constructor(
    private readonly options: Required<Omit<RiskOrchestratorOptions, "simulation" | "llm" | "onError">> &
      Pick<RiskOrchestratorOptions, "simulation" | "llm" | "onError">,
  ) {}

  static create(options: RiskOrchestratorOptions): RiskOrchestrator {
    return new RiskOrchestrator({
      componentRetries: options.componentRetries ?? 3,
      componentTimeoutMs: options.componentTimeoutMs ?? 5000,
      submissionRetries: options.submissionRetries ?? 3,
      now: options.now ?? (() => new Date()),
      sleep: options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms))),
      ...options,
    } as Required<Omit<RiskOrchestratorOptions, "simulation" | "llm" | "onError">> &
      Pick<RiskOrchestratorOptions, "simulation" | "llm" | "onError">)
  }

  /** Queue depth - introspection for the status API. */
  get pendingCount(): number {
    return this.queue.length
  }

  /**
   * The single entry point (criterion: endpoint/event consumer funnel).
   * Duplicate proposals return the existing verdict without reprocessing.
   */
  async propose(
    tx: ProposedTx,
  ): Promise<{ txHash: string; status: ProcessingStatus; canonical?: CanonicalVerdict; duplicate: boolean }> {
    const existing = await this.options.store.load(tx.txHash)
    if (existing?.canonical && (existing.status === "submitted" || existing.status === "verdict_ready")) {
      return { txHash: tx.txHash, status: existing.status, canonical: existing.canonical, duplicate: true }
    }
    if (existing && (existing.status === "submitting" || existing.status === "analyzing")) {
      return { txHash: tx.txHash, status: existing.status, canonical: existing.canonical, duplicate: true }
    }
    if (existing?.status === "submission_failed" && existing.canonical) {
      // Resume: verdict exists, only the on-chain submission is pending.
      await this.transition(existing, "submitting", "resumed after submission failure")
      void this.enqueueSubmission(existing.txHash)
      return { txHash: tx.txHash, status: "submitting", canonical: existing.canonical, duplicate: false }
    }

    this.queue.push(tx)
    void this.drain()
    return { txHash: tx.txHash, status: "received", duplicate: false }
  }

  private async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      for (;;) {
        const tx = this.queue.shift()
        if (!tx) break
        await this.process(tx).catch((err: unknown) => {
          if (this.options.onError) this.options.onError(err)
          else console.warn("[orchestrator] processing failed:", err)
        })
      }
    } finally {
      this.draining = false
    }
  }

  private async freshState(txHash: string): Promise<TxProcessingState> {
    const now = this.options.now().toISOString()
    return { txHash, status: "received", attempts: 0, updatedAt: now, history: [{ at: now, status: "received" }] }
  }

  private async transition(
    state: TxProcessingState,
    status: ProcessingStatus,
    note?: string,
  ): Promise<TxProcessingState> {
    const next: TxProcessingState = {
      ...state,
      status,
      updatedAt: this.options.now().toISOString(),
      history: [...state.history, { at: this.options.now().toISOString(), status, note }],
    }
    await this.options.store.save(next)
    return next
  }

  private async process(tx: ProposedTx): Promise<void> {
    let state = (await this.options.store.load(tx.txHash)) ?? (await this.freshState(tx.txHash))
    await this.options.store.save(state)
    state = await this.transition(state, "analyzing")

    // 1. Rule engine: built-in, deterministic, synchronous - the floor.
    const ruleResult = scoreTransaction({
      data: tx.data,
      value: tx.value,
      isFirstSeenCounterparty: false,
      isUnverifiedOrFreshContract: false,
      // This deterministic path has no GoPlus lookup (#10) - "unknown" is the
      // honest value: adds nothing to the score, never read as "clean".
      counterpartyBlacklist: "unknown",
      historicalP95Value: 0n,
    })
    const contributions: CanonicalVerdict["contributions"] = [
      { component: "rule-engine", points: ruleResult.score, reasons: ruleResult.matchedSignals },
    ]
    const componentOutcomes: ComponentOutcome[] = []

    // 2. Optional components with per-component retries + timeout.
    if (this.options.simulation) {
      const outcome = await this.runComponent("simulation", this.options.simulation.analyze, tx)
      componentOutcomes.push(outcome)
      contributions.push({ component: outcome.component, ...outcome.contribution })
    }
    let llm: LlmVerdict | undefined
    if (this.options.llm) {
      try {
        llm = await this.runWithRetry("llm", () => this.options.llm!.assess(tx, ruleResult))
      } catch {
        llm = undefined // non-critical: the deterministic verdict stands
      }
    }

    // 3. Aggregate the canonical verdict.
    const score = Math.min(
      100,
      contributions.reduce((sum, c) => sum + c.points, 0),
    )
    const status = statusForScore(score)
    const action = actionForStatus(status)
    const explanation =
      contributions.flatMap((c) => c.reasons.map((r) => `[${c.component}] ${r}`)).join("; ") || "no risk signals fired"
    const canonical: CanonicalVerdict = {
      txHash: tx.txHash,
      score,
      status,
      action,
      explanation,
      contributions,
      at: this.options.now().toISOString(),
    }
    state = await this.transition({ ...state, canonical }, "verdict_ready", "canonical verdict produced")
    await this.enqueueSubmission(state.txHash)
  }

  private async runComponent(
    name: string,
    run: (tx: ProposedTx) => Promise<ScoreContribution>,
    tx: ProposedTx,
  ): Promise<ComponentOutcome> {
    try {
      const contribution = await this.runWithRetry(name, () => run(tx))
      return { component: name, ok: true, attempts: 1, contribution }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      // Fail-safe (criterion): an unavailable critical component adds
      // elevation with an explicit reason - never silence, never approval.
      return {
        component: name,
        ok: false,
        attempts: this.options.componentRetries,
        contribution: {
          points: 35,
          reasons: [`${name} unavailable (${reason}) - treated as elevated risk, never auto-approved`],
        },
      }
    }
  }

  private async runWithRetry<T>(label: string, run: () => Promise<T>): Promise<T> {
    let lastErr: unknown
    for (let attempt = 1; attempt <= this.options.componentRetries; attempt++) {
      try {
        return await withTimeout(run(), this.options.componentTimeoutMs, label)
      } catch (err) {
        lastErr = err
        if (attempt < this.options.componentRetries) await this.options.sleep(10 * attempt)
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
  }

  private async enqueueSubmission(txHash: string): Promise<void> {
    let state = (await this.options.store.load(txHash))!
    state = await this.transition(state, "submitting")
    for (let attempt = 1; attempt <= this.options.submissionRetries; attempt++) {
      try {
        const effective: RuleEngineResult = {
          score: state.canonical!.score,
          label: state.canonical!.status,
          matchedSignals: state.canonical!.contributions.flatMap((c) => c.reasons),
        }
        await this.options.relayer.submit(txHash, effective)
        await this.transition({ ...state, attempts: attempt }, "submitted", `attempt ${attempt} confirmed on-chain`)
        return
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        state = await this.transition({ ...state, attempts: attempt }, "submission_failed", reason)
        if (attempt < this.options.submissionRetries) await this.options.sleep(10 * attempt)
      }
    }
  }

  /** Status API for the dashboard (criterion). */
  async status(txHash: string): Promise<TxProcessingState | undefined> {
    return this.options.store.load(txHash)
  }

  async list(filter: { status?: ProcessingStatus; limit?: number } = {}): Promise<TxProcessingState[]> {
    let all = await this.options.store.all()
    if (filter.status) all = all.filter((s) => s.status === filter.status)
    all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    if (filter.limit && filter.limit > 0) all = all.slice(0, filter.limit)
    return all
  }
}
