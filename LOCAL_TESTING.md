# Running the full stack locally

This deploys a real Safe (not a mock), a real `TripwireGuard` and
`RiskRegistry`, and enables the Guard on the Safe - then wires up the
actual backend pipeline (`OnchainAttemptWatcher` → rule engine → relayer)
against it, so you can watch the whole system work end to end without a
testnet.

## Why this is a bit unusual: attempts must be forced

Safe's `execTransaction` reverts on a transaction's first attempt by
design - that's `TripwireGuard`'s fail-closed default (no verdict yet).
A normal wallet (MetaMask, etc.) estimates gas before letting you sign, and
that estimate fails for the exact same reason, so it would normally refuse
to let you submit at all. `scripts/localExec.ts` passes an explicit
`gasLimit` to skip that estimate - the same thing a wallet's manual gas
override does - so you can watch a real fail-closed revert land on-chain
instead of never being submitted.

This is a real, open UX question for #38 (Apothem, no Safe Transaction
Service): a typical wallet's default flow would block a user from ever
retrying, since *every* transaction fails its first, unscored attempt.
Worth resolving before relying on this flow for a live demo.

## Running it

Terminal 1:
```
LOCAL_E2E=true npx hardhat node
```
`LOCAL_E2E=true` disables Hardhat Network's `throwOnTransactionFailures`
default - without it, a doomed transaction is rejected before ever being
mined, which isn't how a real chain (or Anvil) behaves, and this whole flow
depends on a failed first attempt actually landing on-chain. Don't set it
for `npx hardhat test` - the test suite's `.to.be.revertedWithCustomError`
assertions rely on the default `true` behavior to detect a revert at all.

Terminal 2 - deploy the Safe, Guard, RiskRegistry, and drainer demo contracts:
```
npx hardhat run scripts/localDeploy.ts --network localhost
```
Writes `local-deployment.json` at the repo root (gitignored - regenerate anytime).

Terminal 3 - start the real backend pipeline watching it:
```
cd backend
npx tsx scripts/localWatcherLoop.ts
```

Terminal 2 again - trigger attempts:
```
# Benign: fails closed, gets scored LOW_RISK, succeeds on retry
ACTION=transfer npx hardhat run scripts/localExec.ts --network localhost
# wait a couple seconds for terminal 3 to score it, then run again to retry:
ACTION=transfer npx hardhat run scripts/localExec.ts --network localhost

# Attack: fails closed, gets scored HIGH_RISK, stays blocked forever
ACTION=approve npx hardhat run scripts/localExec.ts --network localhost
ACTION=approve npx hardhat run scripts/localExec.ts --network localhost   # still blocked

# Confirm the NFT was never actually put at risk
ACTION=drain npx hardhat run scripts/localExec.ts --network localhost    # reverts - no approval was ever granted
```

Point `frontend/.env` at the printed addresses (`VITE_CHAIN=` doesn't matter
here - point `VITE_SAFE_ADDRESS`/`VITE_GUARD_ADDRESS`/`VITE_RISK_REGISTRY_ADDRESS`
at the local ones and wagmi's `injected()` connector at `http://127.0.0.1:8545`,
chain id `31337`) to see the dashboard reading real, live local state.

## What this proved, verified live (not assumed)

- A real `GnosisSafe` proxy, with `TripwireGuard` enabled via `setGuard`, correctly
  reverts a transaction with the Guard's exact custom error (`AwaitingRiskScore`)
  rather than a generic Safe error code.
- The real rule engine (#9) scores a plain transfer `low_risk` (score 0) and
  `setApprovalForAll` `high_risk` (score 90, all three signals fired) - not a
  reimplementation, the actual shipped module.
- The real relayer (#13) writes that verdict to the real `RiskRegistry` on-chain.
- The benign transfer then succeeds on retry; the malicious approval stays
  blocked (`BlockedHighRisk`, confirmed by decoding the exact custom-error
  selector) even after a retry.
- Hardhat Network's `throwOnTransactionFailures` default (a dev-convenience
  feature, not real-chain behavior) had to be disabled for this to work at
  all - without it, a doomed transaction is rejected before ever being
  mined. Scoped to `LOCAL_E2E=true` rather than changed globally, since the
  test suite's revert matchers depend on the default `true` behavior.
