# Tripwire backend

Off-chain risk engine: watches a Safe's pending transaction queue, scores
each new transaction (deterministic rule engine + external reputation
signals), optionally replays it against a fork to see what the calldata
actually does, and writes the verdict to the `RiskRegistry` contract.

Pipeline:

```
Safe Transaction Service          (watched via @safe-global/api-kit)
        │
        ▼
PendingTxWatcher                  Sense: dedupe + normalize (circuit breaker built in)
        │
        ▼
BlacklistChecker (#10)            GoPlus address/token_security, tri-state verdict,
                                  every failure collapses to "unknown" - never blocks
        │
        ▼
scoreTransaction (#9)             Reason: deterministic, no I/O, combines signals
        │
        ▼
simulateTransaction (#11)         Replays calldata on an Anvil fork; snapshot/revert,
                                  reads "after" state before reverting
        │
        ▼
VerdictRelayer (#13)              Act: submitFast immediately, submitFinal if an LLM
                                  verdict (#12) arrives later; retries transient
                                  failures, receipt-confirmed, never leaves UNSCORED
        │
        ▼
RiskRegistry                      On-chain verdict store; TripwireGuard reads it
```

## Setup

```bash
npm ci
cp .env.example .env   # fill in SAFE_ADDRESS, CHAIN_ID, ...
```

| Env var                                         | Required        | Notes                                        |
| ----------------------------------------------- | --------------- | -------------------------------------------- |
| `SAFE_ADDRESS`                                  | yes             | The Safe to watch.                           |
| `CHAIN_ID`                                      | yes             | e.g. `11155111` for Sepolia.                 |
| `TX_SERVICE_URL`                                | no              | Only for self-hosted Transaction Service.    |
| `SAFE_TX_SERVICE_API_KEY`                       | no              | Required for api.safe.global / api.5afe.dev. |
| `POLL_INTERVAL_MS`                              | no              | Default `5000`.                              |
| `GOPLUS_API_KEY`                                | no              | Raises the blacklist-lookup rate limit.      |
| `GOPLUS_TIMEOUT_MS`                             | no              | Per-request timeout, default `3000`.         |
| `RELAYER_PRIVATE_KEY` / `RISK_REGISTRY_ADDRESS` | for the relayer | Never commit these.                          |

## Test + typecheck

```bash
npm test
npm run typecheck
```

## Rehearse the full pipeline locally

Issue #15's acceptance bar: the full pipeline must run repeatedly against
local Anvil with no manual intervention. `scripts/runPipeline.ts` deploys a
fresh `RiskRegistry` to a running anvil and drives every real module through
watcher → blacklist → rule engine → simulation → relayer → on-chain
readback, `RUNS` times in a row (default 3), asserting each verdict reads
back exactly as submitted:

```bash
anvil --port 8545 &
RPC_URL=http://127.0.0.1:8545 npx tsx scripts/runPipeline.ts
```

The live GoPlus call in the rehearsal resolves to `unknown` on anvil's
chain id (GoPlus doesn't support it) - that is the failure fallback proving
in situ that scoring never blocks on the external lookup. A quicker smoke
test of just the fork client lives in `scripts/verifyAnvilFork.ts`.

## Failure behavior (what "stabilized" means here)

- **GoPlus down / slow / rate-limited** → verdict `unknown`, scoring
  continues with remaining signals. Never treated as "clean".
- **Safe Transaction Service down** → watcher's circuit breaker opens after
  5 consecutive failures, polls pause for 30 s, one probe poll is allowed,
  success closes the breaker. No manual intervention.
- **RPC submission hiccup** → relayer retries with exponential backoff (3
  attempts), resubmitting the identical verdict. A mined revert fails fast
  (`VerdictRevertedError`) - retrying a deterministic revert can't help.
- **RPC hang** → all viem transports carry a 10 s timeout; a hung endpoint
  fails its step instead of stalling the pipeline.
- **Claude/LLM step (#12)** → not implemented yet; `verdict.ts` already
  defines the plug-in point (`finalVerdict` prefers an LLM verdict when
  present, rule-engine verdict otherwise).
