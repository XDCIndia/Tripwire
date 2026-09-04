# Testing Tripwire locally — full guide

This walks through running the entire stack on your own machine: a real
Safe wallet, `TripwireGuard` enabled on it, the backend risk pipeline, and
the dashboard — no testnet, no API keys, nothing external required.

By the end you will have watched, live: a benign transaction get blocked,
scored, and let through; and a real drainer attack get blocked, scored, and
**stay blocked forever**, with the victim's NFT never actually at risk.

## What you're testing

```
Safe (real GnosisSafe, one owner)
   │  execTransaction(...)
   ▼
TripwireGuard  ──fails closed──►  reverts if no verdict yet recorded
   ▲
   │ reads
RiskRegistry  ◄──writes──  backend relayer
                               ▲
                               │ scores
                          rule engine
                               ▲
                               │ decodes
                     OnchainAttemptWatcher ──watches blocks for──► execTransaction attempts
```

A transaction's first attempt is *always* rejected — nothing has scored it
yet. The backend sees that reverted attempt, scores it, and writes a
verdict. A second attempt then either succeeds (low risk) or stays blocked
forever (high risk).

## Prerequisites

- Node.js 22+ and npm
- This repo cloned, with `npm install` run at the repo root, in `backend/`, and in `frontend/`
- MetaMask (or any injected-wallet browser extension), only needed for Part 3

You do **not** need Anvil, a testnet RPC, or any API key for any of this.

---

## Part 1 — Start the local chain and deploy everything

**Terminal 1:**
```
LOCAL_E2E=true npx hardhat node
```
Leave this running. It's a local Ethereum-compatible chain at
`http://127.0.0.1:8545`, chain id `31337`.

> **Why `LOCAL_E2E=true`:** Hardhat Network's default behavior rejects a
> transaction that would revert *before* it's ever mined — a dev
> convenience, but not how a real chain (or Anvil) behaves. This whole
> flow depends on a rejected first attempt actually landing on-chain so the
> backend can see it. Never set this for `npx hardhat test` — the test
> suite's revert assertions rely on the default behavior.

**Terminal 2:**
```
npx hardhat run scripts/localDeploy.ts --network localhost
```
This deploys, in order: a real `GnosisSafe` (single owner, threshold 1),
`RiskRegistry`, `TripwireGuard` (enabled on the Safe via `setGuard`), funds
the Safe with 10 ETH, and the drainer demo contracts (`MockDrainableNFT`,
`DrainerAttacker`), minting one NFT into the Safe.

Expected output ends with something like:
```
Wrote .../local-deployment.json
{
  safeAddress: '0x8dAF17A20c9DBA35f005b6324F493785D239719d',
  guardAddress: '0x9A676e781A523b5d0C0e43731313A708CB607508',
  riskRegistryAddress: '0x0DCd1Bf9A1b36cE34237eEaFef220932846BCD82',
  nftAddress: '0x...',
  attackerAddress: '0x...',
  ownerAddress: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  ownerPrivateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  relayerAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  relayerPrivateKey: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
}
```
`local-deployment.json` (gitignored — regenerate anytime) is read by
everything else below. **Addresses are different every time you redeploy**
— always use what your own run printed, not the examples in this doc.

---

## Part 2 — Start the backend pipeline

**Terminal 3:**
```
cd backend
npx tsx scripts/localWatcherLoop.ts
```
This is the real, shipped pipeline — `OnchainAttemptWatcher` → rule engine
→ relayer, not a reimplementation. It polls every 2 seconds and logs every
transaction attempt it sees, its score, and the verdict it wrote on-chain.
Leave it running for the rest of this guide; every command in Part 4/5 gets
picked up here within a couple of seconds.

---

## Part 3 — Start the dashboard and connect a wallet

**Terminal 4:**
```
cd frontend
cp .env.example .env
```
Edit `.env` and set `VITE_CHAIN=localhost`, plus the three addresses from
Part 1's output:
```
VITE_CHAIN=localhost
VITE_SAFE_ADDRESS=<safeAddress from local-deployment.json>
VITE_GUARD_ADDRESS=<guardAddress from local-deployment.json>
VITE_RISK_REGISTRY_ADDRESS=<riskRegistryAddress from local-deployment.json>
```
Then:
```
npm run dev
```
Open the URL it prints (`http://localhost:5173`).

**Add the network to MetaMask:**
1. Click the MetaMask extension icon
2. Click the network dropdown at the top → **Add network** → **Add a network manually**
3. Fill in: Network name `Localhost 8545`, RPC URL `http://127.0.0.1:8545`, Chain ID `31337`, Currency symbol `ETH`
4. Save, and make sure this network is the one selected

**Import a test account (optional but recommended):**
1. Click the account icon (top right) → **Add account or hardware wallet** → **Import account**
2. Paste the `ownerPrivateKey` from Part 1's output
3. Import

This is one of Hardhat's well-known default test keys — every developer
running `npx hardhat node` gets the exact same one. It only ever holds fake
ETH on your local chain; never use it anywhere real.

**Connect:** back on the dashboard, click Connect and approve in MetaMask.
You should see:
- **Safe card:** the deployed address, network "Hardhat", balance `10 ETH`
- **Guard card:** the deployed address, status **Active**, the owner address, the risk registry address, both limits "disabled", spend "0"

The dashboard is **read-only** — it can't trigger transactions itself
(that's #18/#19, not built yet). Parts 4 and 5 below use the CLI for that.

---

## Part 4 — The benign flow: blocked, scored, then allowed

**Terminal 2:**
```
ACTION=transfer npx hardhat run scripts/localExec.ts --network localhost
```
Expected: `execTransaction MINED BUT REVERTED (fail-closed) - this is expected on a first attempt.`

Within a couple of seconds, **Terminal 3** (the watcher) logs:
```
[watcher] new attempt: { to: '0x...', value: '10000000000000000', safeTxHash: '0x...' }
[rule engine] { score: 0, label: 'low_risk', matchedSignals: [] }
[relayer] submitted verdict: { status: 1, score: 0, releaseAt: 0 }
```

Run the **exact same command again**:
```
ACTION=transfer npx hardhat run scripts/localExec.ts --network localhost
```
Expected this time: `execTransaction SUCCEEDED.`

Refresh the dashboard: the Safe's balance drops slightly, and the Guard's
"Spent in current window" changes from `0` to `10000000000000000` (0.01 ETH
in wei) — real state, updated by a real transaction, read live.

---

## Part 5 — The attack flow: blocked, scored high-risk, stays blocked

**Terminal 2:**
```
ACTION=approve npx hardhat run scripts/localExec.ts --network localhost
```
This proposes the drainer's real payload: `setApprovalForAll` on the NFT,
granting the attacker contract blanket control. Expected: reverted,
fail-closed, same as before.

**Terminal 3** logs the score:
```
[rule engine] {
  score: 90,
  label: 'high_risk',
  matchedSignals: [
    'setApprovalForAll: grants blanket control over an entire NFT collection',
    'first-seen counterparty: this wallet has never interacted with this address before',
    'target contract is unverified or was deployed very recently'
  ]
}
[relayer] submitted verdict: { status: 3, score: 90, releaseAt: 0 }
```

Now retry it — **this is the point of the whole exercise:**
```
ACTION=approve npx hardhat run scripts/localExec.ts --network localhost
```
Expected: **still** `execTransaction MINED BUT REVERTED`. Unlike the benign
case, this never succeeds, no matter how many times you retry it — the
verdict is `HIGH_RISK`, and the Guard checks the live verdict every time.

Finally, confirm the theft never actually worked:
```
ACTION=drain npx hardhat run scripts/localExec.ts --network localhost
```
Expected: `Drain reverted - no approval was ever granted.` The NFT never
left the Safe.

---

## Resetting

Everything above is disposable. To start over: stop all four terminals
(`Ctrl+C`), delete `local-deployment.json`, and repeat from Part 1 — a
fresh chain, fresh addresses, fresh state.

## Troubleshooting — real problems hit while building this

**`GS013` instead of a Tripwire error, on a transaction that should be
low-risk.** This means the Guard already approved it — `GS013` comes from
*inside* Safe's own execution, after the Guard already said yes, meaning
the actual transfer itself failed. Almost always: the Safe doesn't have
enough ETH. `scripts/localDeploy.ts` funds it with 10 ETH automatically;
if you're debugging a modified flow, check the Safe's balance first.

**Nothing happens at all — no error, no success, script just throws
immediately with no tx hash.** Ethers.js estimates gas before broadcasting
any transaction, and that estimate itself fails for any transaction the
Guard would currently reject (which is *every* fresh transaction, by
design — nothing is ever pre-scored). `scripts/localExec.ts` already works
around this with an explicit `gasLimit`, the same thing a wallet's manual
gas override does. If you're writing your own script against this stack,
you'll need to do the same.

**This is also a real, unresolved product question, not just a test
detail:** on a chain without Safe's hosted Transaction Service (see #38,
XDC Apothem), a normal wallet's default flow would refuse to let a real
user submit their first attempt at *any* transaction, not just malicious
ones, since MetaMask-style wallets estimate gas before allowing a signature
and that estimate always fails pre-verdict. Worth resolving before relying
on this exact flow for a live demo.

**The dashboard shows "not deployed yet" for everything.** Check
`frontend/.env` has real addresses from your latest `local-deployment.json`
(they change every redeploy) and that you restarted `npm run dev` after
editing `.env` — Vite only reads env vars at startup.

**MetaMask shows the wrong network / dashboard shows nothing after
connecting.** Confirm "Localhost 8545" (chain id `31337`) is the *active*
network in MetaMask, not just added.
