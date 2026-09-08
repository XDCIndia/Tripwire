# Tripwire — the existing flow, traced

Every step from a proposed transaction to allow / delay / block, with the exact
file, function and contract responsible. Traced by reading the code at
`13060a1`, not from the design docs.

Read this before adding anything: it names the seam each Financial Guardian
upgrade will attach to.

```
Transaction → Watcher → Risk Engine → Risk Registry → Policy Decision
           → Tripwire Guard → Safe → Allow / Delay / Block
```

The single most important property: **the off-chain half only advises. The
on-chain half decides.** Everything before the Risk Registry is a
recommendation; everything from the Guard onward is enforcement.

---

## 0. Why there is time to do any of this

A Safe transaction is not atomic with its proposal. A signer proposes it, it
waits for signatures, and only then does someone call `execTransaction`. The
whole risk pipeline runs inside that pause, which is why the Guard never has to
make an off-chain call while a transaction is executing.

---

## 1. Transaction → Watcher

Two ingest paths, because not every chain has Safe's Transaction Service.

| Path | File | Entry point | Used when |
|---|---|---|---|
| Transaction Service | `backend/src/watcher.ts` (147 ln) | `PendingTxWatcher.start()` / `.poll()` | Safe API is available (Sepolia) |
| On-chain decoding | `backend/src/onchainAttemptWatcher.ts` (94 ln) | watches confirmed blocks | Safe API is not available (**XDC Apothem**) |

Supporting:

- `backend/src/safeApiClient.ts` — `createSafeApiClient()`, wraps `@safe-global/api-kit`
- `backend/src/safeExecDecoder.ts` — decodes `execTransaction` calldata, and computes `txHashOf` to match the contract bit-for-bit
- `backend/src/types.ts` — `PendingTx`, `RawPendingTx`, `SafeTxServiceClient`

`PendingTxWatcher` polls with a **circuit breaker**: consecutive failures open
it, a cooldown allows one probe, success closes it.

> **The on-chain watcher matters more than it looks.** On a chain without the
> Transaction Service, a signer calls `execTransaction` directly. The first
> attempt is blocked by the Guard's fail-closed default (no verdict exists), and
> *that reverted attempt* is what the watcher sees and scores. Protection on
> Apothem depends on this path.

---

## 2. Watcher → Risk Engine

Single funnel: **`RiskOrchestrator.propose()`** — `backend/src/riskOrchestrator.ts:283` (463 ln).

HTTP and the in-process queue both land there. `private process()` (`:353`) runs
the pipeline. Duplicate proposals return the existing verdict rather than
re-scoring.

### 2a. Rule engine — deterministic, always runs

`backend/src/ruleEngine.ts:98` — `scoreTransaction(input): RuleEngineResult`

| Signal | Where |
|---|---|
| `setApprovalForAll` | selector `0xa22cb465`, `:57` |
| unlimited `approve` | selector `0x095ea7b3` + max-uint check, `:58` |
| `permit` (EIP-2612) | selector `0xd505accf`, `:59` |
| first-seen counterparty | `isFirstSeenCounterparty` input |
| unverified / fresh contract | `isUnverifiedOrFreshContract` input |
| amount vs wallet p95 | `historicalP95Value` input |
| blacklist match | `counterpartyBlacklist` (tri-state) |
| simulation findings | optional `simulation` input |

### 2b. Optional components — pluggable slots on the orchestrator

| Slot | File | Failure behaviour |
|---|---|---|
| `simulation` | `simulate.ts` (163) + `simulationSignals.ts` (111) + `anvilForkClient.ts` (74) | **Elevated-risk penalty** — never silence, never approval |
| `llm` | `llmReasoning.ts` (245) | Non-critical: failure changes nothing |
| `relayer` | `relayer.ts` (138) | Retries, then `submission_failed` |

Feeding inputs: `walletBehavior.ts` (325) supplies the behavioural baseline —
p95 value, `frequencyPerDay`, `knownCounterparties`; `blacklist.ts` (162)
supplies the GoPlus reputation lookup.

### 2c. Aggregation

`riskOrchestrator.ts:~390` sums contributions into a `CanonicalVerdict`
(`score`, `status`, `action`, `explanation`, `contributions`).
Thresholds: **≥70 high_risk → block**, **≥30 medium_risk → delay**, else allow.

---

## 3. Policy Decision

Distinct from the rule engine: the rule engine says *how risky*, the policy says
*what the owner wants done about it*.

| Stage | File | Function |
|---|---|---|
| Compile English → policy | `nlPolicyCompiler.ts` (280) | `parsePolicyText`, `parseClause` |
| Compile machine/LLM JSON | `policyCompiler.ts` (238) | `compilePolicy`, `compilePolicyFromJson` |
| Validate | `policyValidator.ts` (111) | `validatePolicy` — rejects conflicts and fail-open allows |
| Render back to English | `policyMapper.ts:117` | `explainPolicy` |
| Resolve to Guard config | `policyMapper.ts:220` | `resolvePolicy` → `PolicyGuardConfig` |
| Decide per transaction | `policyMapper.ts:259` | `evaluateResolvedPolicy` |
| Shape the on-chain verdict | `policyMapper.ts:279` | `verdictForEvaluation` |
| Versioning / replay | `policyVersion.ts` | — |

`resolvePolicy` **requires** an explicit `usdPerNative` rate for fiat amounts —
it refuses to guess. `PolicyGuardConfig.rollingLimit` always resolves to `0`
today: the grammar has no daily-limit construct yet.

---

## 4. Risk Registry — the off-chain/on-chain boundary

| Piece | File | Detail |
|---|---|---|
| Verdict shaping | `verdict.ts` (91) | `verdictFromRuleEngine`, `finalVerdict` |
| Relayer | `relayer.ts` (138) | `VerdictRelayer`, typed revert-vs-retry, caches `delayWindow()` for 60s |
| Chain writer | `riskRegistryClient.ts` (69) | `createRiskRegistryClient` → `writeContract`, hard RPC timeout |
| Contract | `contracts/RiskRegistry.sol` (78) | `submitVerdict(bytes32, Verdict)` — `onlyRelayer`, `nonReentrant` |

`Verdict = { Status status, uint8 score, uint256 releaseAt }`
`Status = UNSCORED | LOW_RISK | DELAYED | HIGH_RISK | FROZEN`

**The relayer key is the one component with real custody.** It is scoped to
`submitVerdict` only — it cannot move funds.

---

## 5–8. Guard → Safe → Allow / Delay / Block

`contracts/TripwireGuard.sol` (219 ln). A Zodiac Guard enabled on the Safe via
`setGuard()`. **Safe calls the Guard**, not the reverse.

`checkTransaction(...)` at `:158`, checks in this exact order:

| # | Condition | Revert |
|---|---|---|
| 1 | `frozen` | `GuardIsFrozen()` |
| 2 | `UNSCORED` | `AwaitingRiskScore()` — **the fail-closed default** |
| 3 | `FROZEN` | `GuardIsFrozen()` |
| 4 | `HIGH_RISK` | `BlockedHighRisk()` |
| 5 | `DELAYED` before `releaseAt` | `InCoolingOffWindow()` |
| 6 | `value > perTxLimit` | `PerTxLimitExceeded()` |
| 7 | window spend + value > `rollingLimit` | `RollingLimitExceeded()` |

Then `checkAfterExecution` (`:203`) records the spend — **only on success**, so a
reverted inner call cannot burn the rolling limit.

Two properties worth preserving in any upgrade:

- **Steps 6–7 are verdict-independent.** Limits hold even if the entire
  off-chain engine is down.
- **The Guard always reads the *current* verdict**, never one snapshotted when
  the transaction was first delayed — so the engine can escalate a delayed
  transaction to `HIGH_RISK` mid-window and it will be blocked. No separate
  cancellation path is needed.

Controls: `setLimits`, `freeze()` (owner **or** freeze authority), `unfreeze()`
(**owner only** — deliberately one-directional). All setters reject the zero
address.

### The hash both halves must agree on

```solidity
// TripwireGuard.sol:154
keccak256(abi.encode(to, value, data, operation))
```

Reproduced off-chain in `safeExecDecoder.ts` `txHashOf`. **If these ever
diverge, every verdict silently misses and the Guard fail-closes on
everything.** Any change to the hash is a breaking change on both sides at once.

---

## Cross-cutting layers

These do not add steps; they make the existing arrows survive failure.

| Layer | Files | Purpose |
|---|---|---|
| Durable job queue | `job{Types,Store,Engine,Queue,Worker,Workers,Orchestrator,Timeout,StatusApi}.ts` | enqueue, claim, retry, dead-letter, replay, timeout |
| Reconciliation | `reconcile{Types,Engine,Store,Service,Chain,Api}.ts` (~1,100 ln) | derive expected enforcement, compare against the chain |
| Audit ledger | `auditLedgerSink.ts` + `auditHttp.ts` | append-only trail, jsonl sink, replay on open |

> `auditLedger.ts` was a superseded in-memory implementation and has been
> deleted. `auditLedgerSink.ts` is the live one.

---

## HTTP surface

| Service | Port | Endpoints |
|---|---|---|
| Orchestrator | 3001 | `/health`, `POST /tx/propose`, `GET /tx`, `GET /tx/:hash/status`, `POST /policy/compile` |
| Audit | 3002 | `/audit/health`, `/audit`, `/audit/timeline/:txHash` |
| Simulation | 3003 | `/health`, `/simulations/latest` |
| Reconcile | — | `/reconcile/{health,check,cycle,records}` — **no entrypoint yet** |
| Jobs | — | `/health`, `/jobs`, `/events`, `/replay` — **no entrypoint yet** |

`npm run dev:all` starts the first three plus the dashboard.

---

## Where the upgrades attach

| Upgrade | Seam | Notes |
|---|---|---|
| Contract scanner | New optional slot on `RiskOrchestratorOptions`, beside `simulation` / `llm` | Pattern already exists; failure semantics must be chosen deliberately |
| Richer behavioural signals | `walletBehavior.ts` → `RuleEngineInput` | No contract change |
| New risk signals | `ruleEngine.ts` `WEIGHTS` + `scoreTransaction` | No contract change |
| New enforcement actions | `RiskRegistry.Status` **and** `TripwireGuard.checkTransaction` | **Contract change — both sides, plus redeploy** |
| Daily-limit policy grammar | `nlPolicyCompiler` + `policyMapper.resolvePolicy` | `rollingLimit` already exists on the Guard; only the grammar is missing |
| Non-Safe wallets | A new enforcement hook | The Guard interface is Safe-specific |

---

## Gaps found while tracing

1. **Reconcile and job APIs have no entrypoint.** Same class of bug as the
   orchestrator/audit/sim servers before they were fixed: the routes exist and
   nothing starts them.
2. **`rollingLimit` is unreachable from policy.** The Guard enforces it, but
   `resolvePolicy` always returns `0` because the grammar has no daily-limit
   construct. The on-chain half is waiting on the language half.
3. **The relayer in `dev:all` is a dry-run logger.** Scoring is real end to end;
   nothing is written on-chain until a real `VerdictRelayer` is wired, which
   needs a deployment.
