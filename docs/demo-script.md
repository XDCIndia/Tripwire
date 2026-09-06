# Tripwire — 3-Minute Demo Script

The exact script used for the demo rehearsal (see `demo/rehearsal-run-1.txt`
and `demo/rehearsal-run-2.txt` for two clean full runs, and
`scripts/demo/rehearse.sh` to reproduce). Total wall time ≈ 3 minutes.

## Cast (pre-staged before the audience sees anything)

- Terminal 1: `LOCAL_E2E=true npx hardhat node` (local chain)
- Terminal 2: `npx hardhat run scripts/localDeploy.ts --network localhost`
  — deploys a real GnosisSafe, enables `TripwireGuard`, funds the Safe
  with 10 ETH, deploys `MockDrainableNFT` + `DrainerAttacker`, mints one
  NFT into the Safe
- Terminal 3: `cd backend && npx tsx scripts/localWatcherLoop.ts`
  — the shipped pipeline: `OnchainAttemptWatcher` → rule engine → relayer
- Dashboard open at `http://localhost:5173`, connected, showing the Safe
  (10 ETH, one NFT) and the Guard (Active, spend 0)

## Minute 1 — "A normal transaction, with a guard in the loop"

> Say: *Every transaction through this Safe hits the Guard first. The Guard
> fails closed — if nothing has scored the transaction yet, it reverts.*

**Terminal 2:** `ACTION=transfer npx hardhat run scripts/localExec.ts --network localhost`

- Expected: `execTransaction MINED BUT REVERTED (fail-closed)` — the first
  attempt is always rejected. Point at Terminal 3: the watcher saw the
  attempt, the rule engine scored it `0 / low_risk`, and the relayer wrote
  the verdict on-chain.
- Dashboard: Guard "Spent in current window" still `0`.

**Run the exact same command again.**

- Expected: `execTransaction SUCCEEDED.` The verdict is on-chain now, the
  Guard lets it through.
- Dashboard: balance drops 0.01 ETH, spend shows `10000000000000000` —
  real state, updated by a real transaction, read live.

## Minute 2 — "Now the drainer attack"

> Say: *This is the real payload from a wallet drainer: `setApprovalForAll`
> on the victim's NFT. One signature and the entire collection is gone.*

**Terminal 2:** `ACTION=approve npx hardhat run scripts/localExec.ts --network localhost`

- Expected: reverted, fail-closed — same as the benign first attempt.
- Terminal 3 is the money shot: `score: 90, label: 'high_risk'` with three
  matched signals (`setApprovalForAll`, first-seen counterparty, freshly
  deployed unverified contract), verdict `status: 3` (HIGH_RISK).

**Retry it.** And again, if the audience wants.

- Expected: **still reverted, every time.** Unlike the benign case, a
  high-risk verdict never expires.

## Minute 3 — "The theft never happened"

**Terminal 2:** `ACTION=drain npx hardhat run scripts/localExec.ts --network localhost`

- Expected: `Drain reverted - no approval was ever granted.`
- Dashboard: the NFT is still in the Safe. The attacker never got the
  approval, so the drain is impossible — not just blocked, *impossible*.

> Close: *The user signed one bad signature. Tripwire turned that into a
> two-second delay on a payment — and a permanent wall in front of the
> theft.*

## Fallback

If anything flakes live, play `demo/rehearsal-run-2.txt` (a complete
captured run with the full watcher log) — or rerun
`bash scripts/demo/rehearse.sh` to capture a fresh one.
