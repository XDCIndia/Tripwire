# Tripwire

**Smart Contract Financial Guardian.** A [Zodiac Guard](https://github.com/gnosisguild/zodiac) enabled on a [Safe](https://safe.global) wallet that watches every transaction before it executes, scores it for risk, and enforces configurable protection - spending limits, a cooling-off delay, or a full emergency freeze - before funds ever move.

Blockchain transactions are irreversible. Tripwire's job is to make sure nothing moves out of a protected Safe until it's been checked.

## How it works

1. **Sense** - a watcher sees a transaction the moment it's proposed (via Safe's Transaction Service where available, or by decoding on-chain `execTransaction` attempts directly where it isn't - see `backend/src/onchainAttemptWatcher.ts`).
2. **Reason** - a rule engine scores it against real drainer signatures (`setApprovalForAll`, unlimited `approve`, `permit`, first-seen counterparties, unverified contracts, anomalous amounts) - see `backend/src/ruleEngine.ts`.
3. **Act** - a relayer writes the verdict on-chain to `RiskRegistry`, which the Guard reads at execution time to allow, delay, or block the transaction - see `contracts/TripwireGuard.sol`.

The Guard fails closed: a transaction with no verdict yet recorded is blocked by default, never allowed.

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
