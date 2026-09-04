# Tripwire Dashboard

Dashboard for a Guard-protected Safe: wallet connect, the demo Safe's address/balance, the Guard's live configuration (owner, risk registry, frozen state, spending limits, delay window), and — for the Guard owner — a policy panel that changes that configuration as real on-chain transactions signed by the connected wallet.

## Setup

```
cp .env.example .env
npm install
npm run dev
```

`VITE_SAFE_ADDRESS` / `VITE_GUARD_ADDRESS` / `VITE_RISK_REGISTRY_ADDRESS` are unset until #21 deploys real contracts — until then, each card shows a clear "not deployed yet" state instead of fake data.

`VITE_CHAIN` selects the network: `apothem` (default) or `sepolia`.

## Policy controls (#18)

Connect the Guard **owner**'s wallet to unlock the panel (the Guard restricts `setLimits`, `setDelayWindow` and `unfreeze` to `onlyOwner`; `freeze` additionally accepts the freeze authority). Every control is a real transaction:

- **Per-tx limit / rolling 24h limit** — entered in ETH, sent as wei via `TripwireGuard.setLimits`. A value of `0` disables that check on-chain.
- **Delay window** — entered in minutes, sent as seconds via `RiskRegistry.setDefaultDelayWindow`. The backend relayer reads this on-chain value when it writes a `DELAYED` verdict (`releaseAt = now + window`), so the owner-set window is what enforcement actually honors. A value of `0` means the relayer falls back to its own default (10 minutes). This lives on the RiskRegistry — not the Guard — because a delay window only binds through the per-verdict `releaseAt` the relayer persists; the Guard reverts to block and a revert unwinds any state it writes in the same call, so the Guard can never anchor a window itself.
- **Freeze / unfreeze** — `TripwireGuard.freeze` / `unfreeze`, the emergency circuit breaker. Freeze is available to the owner or freeze authority; unfreeze is owner-only, matching the contract.

Each action shows the pending transaction hash (linked to the explorer), waits for its receipt, and the cards poll so the displayed state reflects what the chain now says — nothing is local-only.

## What's here vs. what's next

The live risk feed is #17's job.