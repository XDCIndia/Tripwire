# XDC Apothem — parallel deployment runbook

Goal: the **identical** Guard + RiskRegistry setup that runs on Sepolia also
runs on XDC Apothem testnet (chainId 51), so the pitch can claim a second
live chain (see `docs/pitch-deck.md`, "Works on..." slide).

## Status

- [x] Same deploy script verified end-to-end against a live fork of Apothem
      state — full Safe + Guard + RiskRegistry deployed, all verify checks
      pass (see Evidence below)
- [ ] Real Apothem deployment — **needs a TXDC-funded private key**
      (one command, see below)
- [ ] Fill `deployments/apothem.json` with the real addresses

## 1-command real deployment (chainId 51)

```bash
# key must hold ~1 TXDC (faucet: https://faucet.apothem.network)
PRIVATE_KEY=0x... npx hardhat run scripts/deployTestnet.ts --network apothem
npx hardhat run scripts/verifyDeployment.ts --network apothem
```

Copy the printed addresses into `deployments/apothem.json` and flip the
`forkVerification` note. That is the entire pitch line:

> "Same Safe + Guard + RiskRegistry setup, live on XDC Apothem testnet."

## Fork verification evidence

Date: 2026-09-07. Method: `anvil --fork-url https://rpc.apothem.network`
(chainId returned: 0x33 = 51), then the unchanged
`scripts/deployTestnet.ts` run against the fork. Result:

- RiskRegistry: `0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512`
- Guard:        `0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0`
- Safe:         `0x5FbDB2315678afecb367f032d93F642f64180aa3`
- chainId 51 · owner matches · relayer set · guard state readable

`verifyDeployment.ts` output (this run, truncated):

```
✓ Safe has code
✓ Guard has code
✓ RiskRegistry has code
✓ RiskRegistry owner matches
✓ Owner has balance
✓ RiskRegistry relayer is set
✓ RiskRegistry delay window readable
✓ Guard state readable
```

The identical script deploys unchanged on the real network — the fork only
replaces the RPC endpoint; no contract or config changes were required.

## Troubleshooting

- `nonce too low` — the key was recently used; add `NONCE_OVERRIDE=<n>` or
  wait one block.
- `insufficient funds` — fund the deployer from the Apothem faucet; gas on
  Apothem is paid in TXDC.
