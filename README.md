# Tripwire

**Smart Contract Financial Guardian.** A [Zodiac Guard](https://github.com/gnosisguild/zodiac) enabled on a [Safe](https://safe.global) wallet that watches every transaction before it executes, scores it for risk, and enforces configurable protection - spending limits, a cooling-off delay, or a full emergency freeze - before funds ever move.

Blockchain transactions are irreversible. Tripwire's job is to make sure nothing moves out of a protected Safe until it's been checked.

## How it works

1. **Sense** - a watcher sees a transaction the moment it's proposed (via Safe's Transaction Service where available, or by decoding on-chain `execTransaction` attempts directly where it isn't - see `backend/src/onchainAttemptWatcher.ts`).
2. **Reason** - a rule engine scores it against real drainer signatures (`setApprovalForAll`, unlimited `approve`, `permit`, first-seen counterparties, unverified contracts, anomalous amounts) - see `backend/src/ruleEngine.ts`.
3. **Act** - a relayer writes the verdict on-chain to `RiskRegistry`, which the Guard reads at execution time to allow, delay, or block the transaction - see `contracts/TripwireGuard.sol`.

The Guard fails closed: a transaction with no verdict yet recorded is blocked by default, never allowed.

## Natural-language policies

Wallet owners can describe their protection in plain English and have it compiled into the exact Guard controls that enforce it:

> "Allow payments below $500 to previously used addresses. Delay everything else for 1 hour. Freeze transactions above $10,000."

becomes, deterministically and before anything is activated:

```
1. ALLOW  value < $500        AND recipient previously used
2. FREEZE value > $10,000     (any recipient)
3. DELAY  everything else     for 1 hour
```

Everything under `backend/src/policy*` + `backend/src/nlPolicyCompiler.ts` implements the pipeline (**issue #39**):

1. **Compile** - `nlPolicyCompiler.ts` parses plain English into a canonical, ordered, JSON-serializable `CompiledPolicy`. Sentences it cannot map onto the policy model are hard errors, never silent drops.
2. **LLM/machine path** - `policyCompiler.ts#compilePolicyFromJson` validates an LLM-produced policy document against the same rules a human author is held to (unknown fields, wrong types, duplicates, and conflicts all rejected with precise paths). The LLM *interprets*; it is never given authority to bypass validation or to act.
3. **Validate** - `policyValidator.ts` rejects invalid and conflicting policies (duplicate rules, disagreeing catch-alls, zero/negative amounts, delays without lengths, fail-open allows) before deployment.
4. **Preview** - `policyMapper.ts#explainPolicy` renders the compiled policy back into readable English, shown to the owner before activation.
5. **Map to Guard controls** - `resolvePolicy` converts amounts to wei (an explicit `usdPerNative` rate is *required* for fiat amounts, never assumed) and derives the Guard parameters: `perTxLimit` from freeze floors, the cooling-off `defaultDelaySeconds` from delay rules, plus the per-transaction ALLOW / DELAY / FREEZE decision and the exact `RiskRegistry` verdict for it.
6. **Enforce without an LLM** - `evaluateResolvedPolicy` decides each proposed transaction deterministically; the relayer writes the verdict on-chain before execution and `TripwireGuard.sol` enforces it (fail-closed when no verdict exists). No model call ever happens during execution.

Try it on the example above:

```
cd backend && npm run demo:policy
```

### Reconciling enforcement with the chain (attestation)

Writing a verdict is not the same as enforcing it. Between the submit and the next block a verdict can be overwritten, the Guard unfrozen, or limits raised - so the backend never assumes a verdict it wrote actually stopped anything. For every verdict it submits, it records the **expected enforcement** (allow / delay / block, derived the same way `TripwireGuard.checkTransaction` enforces) and independently re-reads the chain to compare. Outcomes are `MATCH`, `MISMATCH` (critical - a protection gap, latched forever on the record), `PENDING` (auto re-checked with backoff), `REVERTED`, or `DROPPED` - there is deliberately no way to silently confirm a failure. See `backend/src/reconcile*.ts`, run the walkthrough with `cd backend && npm run demo:reconcile`.
>>

## Durable job queue

The risk pipeline fans one Safe transaction event into four independent analyses - **rules, wallet risk, simulation, and LLM judgment** - and any one of them can time out, crash, rate-limit, or vanish mid-run. `backend/src/job*` implements the durable job layer that keeps a transaction workflow alive through that (issue **#55**):

- **`jobTypes.ts`** - the job model and its state machine (QUEUED → PROCESSING → COMPLETED / RETRYING → DEAD_LETTER / FAILED), plus the exponential-backoff retry policy.
- **`jobStore.ts`** - an append-only, fsynced event log. Every transition is a durable snapshot event, so jobs persist *before* processing, state after a crash is rebuilt by replaying the log, and the log itself is the permanent audit trail (every failure reason and retry is an event, never overwritten).
- **`jobEngine.ts`** - enqueue (idempotent per transaction + analysis type), exclusive lease-based claiming, guarded completion/failure, bounded retries with exponential backoff, dead-lettering, cancellation, abandoned-job recovery, and dead-letter replay.
- **`jobWorker.ts`** - the claim → run → complete/fail loop. Workers are idempotent (duplicate event delivery or two racing workers can never produce a duplicate result), run each analysis under a per-job timeout that aborts it, and route failures into retry/DLQ.
- **`jobStatusApi.ts`** - the internal status endpoint: `GET /jobs`, `GET /jobs/:id`, `GET /jobs/:id/events` (audit trail), `POST /jobs/:id/replay`. Bind it to 127.0.0.1 only.

Walk through the whole failure story (flaky simulation → retry, failing LLM → dead-letter → replay → complete, restart recovery from disk) with:

```
cd backend && npm run demo:jobs
```

  ## Repo layout

- **`contracts/`** - `TripwireGuard.sol` (the Zodiac Guard), `RiskRegistry.sol` (the on-chain verdict store), tests, and deploy/demo scripts. Hardhat + Foundry.
- **`backend/`** - the off-chain pipeline: watcher, rule engine, fork simulation, relayer. TypeScript + viem.
- **`frontend/`** - the dashboard: wallet connect, the Safe's live state, the Guard's configuration, and an owner-gated policy panel that changes limits / the delay window / freeze state as real on-chain transactions. React + Vite + wagmi.

## Quick start

```
npm install
npm test              # contracts
cd backend && npm test   # backend
cd frontend && npm install && npm run dev
```

The dashboard's policy panel signs real `setLimits` / `setDelayWindow` / `freeze` / `unfreeze` transactions from the connected owner wallet — point it at a Guard deployed from `contracts/` via the `VITE_*` env vars (see `frontend/.env.example`).

To run the whole stack together against a real local Safe - see **[LOCAL_TESTING.md](./LOCAL_TESTING.md)**.

## Attribution

This repo started from Gnosis Guild's [`zodiac-mod-starter-kit`](https://github.com/gnosisguild/zodiac-mod-starter-kit) template.
