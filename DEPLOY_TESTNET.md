# Deploying Tripwire to a Testnet

This guide walks through deploying Tripwire (Guard + RiskRegistry) to a
live testnet, creating a real Safe, enabling the Guard on it, and wiring
up the backend and frontend to the deployed addresses.

## Supported Networks

| Network | Chain ID | Native Token | Notes |
|---------|----------|-------------|-------|
| Sepolia | 11155111 | ETH | Default testnet. You need Sepolia ETH from a faucet. |
| XDC Apothem | 51 | TXDC | XDC testnet. You need TXDC from the XDC faucet. |

## Prerequisites

- Node.js 22+ and npm
- This repo cloned, with `npm install` run at the repo root, in `backend/`, and in `frontend/`
- A private key with testnet funds (ETH for Sepolia, TXDC for Apothem)

## Step 1 — Configure environment

Copy the root `.env.example` to `.env` and fill in:

```bash
cp .env.example .env
```

```env
# For Sepolia:
SEPOLIA_URL=https://eth-sepolia.alchemyapi.io/v2/<YOUR ALCHEMY KEY>
PRIVATE_KEY=0x<YOUR PRIVATE KEY>

# For Apothem (no SEPOLIA_URL needed):
PRIVATE_KEY=0x<YOUR PRIVATE KEY>
```

## Step 2 — Deploy contracts

```bash
# Sepolia
npx hardhat run scripts/deployTestnet.ts --network sepolia

# XDC Apothem
npx hardhat run scripts/deployTestnet.ts --network apothem
```

Expected output:

```
=== Tripwire Testnet Deployment ===
Network: sepolia (chainId: 11155111)
Deployer/Owner: 0xYourAddress
Deployer balance: 0.5 ETH

[1/6] Deploying Safe singleton...
  Safe singleton: 0x...
[2/6] Deploying Safe proxy factory...
  Safe proxy factory: 0x...
[3/6] Creating Safe proxy (single owner, threshold 1)...
  Safe address: 0x...
[4/6] Deploying RiskRegistry...
  RiskRegistry: 0x...
  Relayer (initial): 0xYourAddress
[5/6] Deploying TripwireGuard...
  TripwireGuard: 0x...
[6/6] Enabling Guard on Safe via execTransaction...
  Guard enabled on Safe ✓

=== Deployment Complete ===
Wrote deployment.json
{
  "network": "sepolia",
  "chainId": 11155111,
  "safeAddress": "0x...",
  "guardAddress": "0x...",
  "riskRegistryAddress": "0x...",
  "ownerAddress": "0xYourAddress",
  "relayerAddress": "0xYourAddress",
  "safeSingletonAddress": "0x...",
  "safeProxyFactoryAddress": "0x...",
  "deployedAt": "2026-09-04T..."
}
```

The script writes `deployment.json` at the repo root (gitignored).

## Step 3 — Configure the backend

```bash
cd backend
cp .env.example .env
```

Edit `backend/.env` with the deployed addresses:

```env
SAFE_ADDRESS=<safeAddress from deployment.json>
CHAIN_ID=<chainId from deployment.json>
# Use the same private key you deployed with (or a dedicated relayer key)
POLL_INTERVAL_MS=5000
```

Start the backend:

```bash
npm run dev
```

The backend will:
1. Watch the Safe's pending transaction queue (via Safe Transaction Service on Sepolia)
2. Score each transaction using the rule engine
3. Write verdicts to the on-chain RiskRegistry

## Step 4 — Configure the frontend

```bash
cd frontend
cp .env.example .env
```

Edit `frontend/.env` with the deployed addresses:

```env
# For Sepolia:
VITE_CHAIN=sepolia

# For Apothem:
VITE_CHAIN=apothem

VITE_SAFE_ADDRESS=<safeAddress from deployment.json>
VITE_GUARD_ADDRESS=<guardAddress from deployment.json>
VITE_RISK_REGISTRY_ADDRESS=<riskRegistryAddress from deployment.json>
```

Start the frontend:

```bash
npm run dev
```

Open the URL printed (typically `http://localhost:5173`). Connect your
wallet (MetaMask) to the same network, and you'll see:
- **Safe card:** the deployed Safe address, network, and live balance
- **Guard card:** the Guard address, status (Active), owner, risk registry, limits

## Step 5 — Verify the deployment

### Automated verification (recommended)

Run the verification script to check all deployment health in one pass:

```bash
# Sepolia
npm run deploy:verify -- --network sepolia

# XDC Apothem
npm run deploy:verify -- --network apothem
```

This checks:
- Safe proxy has deployed code
- Guard has deployed code
- RiskRegistry has deployed code
- Guard is enabled on the Safe
- RiskRegistry owner matches deployer
- RiskRegistry relayer is set
- RiskRegistry delay window is readable
- Guard state (frozen, limits) is readable
- Owner account has balance

### Manual verification

**Check the Safe on-chain:**
- Sepolia: https://sepolia.etherscan.io/address/<safeAddress>
- Apothem: https://testnet.xdcscan.com/address/<safeAddress>

**Check the Guard:**
Call `guard()` on the Safe contract — it should return the Guard address.

**Check the RiskRegistry:**
Call `verdictOf(<txHash>)` on the RiskRegistry — it should return
`UNSCORED` (0, 0, 0) for any transaction that hasn't been scored yet.

## Architecture

```
                    ┌──────────────────────┐
                    │   Safe (GnosisSafe)   │
                    │  execTransaction(...) │
                    └──────────┬───────────┘
                               │
                    ┌──────────▼───────────┐
                    │    TripwireGuard      │
                    │  checkTransaction()   │
                    │  checkAfterExecution()│
                    └──────────┬───────────┘
                               │ reads
                    ┌──────────▼───────────┐
                    │    RiskRegistry       │
                    │  verdictOf(txHash)    │
                    └──────────▲───────────┘
                               │ writes
                    ┌──────────┴───────────┐
                    │  Backend Relayer      │
                    │  submitVerdict(...)   │
                    └──────────▲───────────┘
                               │ scores
                    ┌──────────┴───────────┐
                    │     Rule Engine       │
                    │  scoreTransaction()   │
                    └──────────▲───────────┘
                               │ watches
                    ┌──────────┴───────────┐
                    │  PendingTxWatcher     │
                    │  (Safe Tx Service)    │
                    └──────────────────────┘
```

## Security Notes

- **Never commit `PRIVATE_KEY` or `.env` files.** They are gitignored by default.
- **The deployer is initially both the owner and relayer.** In production, rotate the relayer to a dedicated key:
  ```bash
  npx hardhat console --network sepolia
  > const registry = await ethers.getContractAt("RiskRegistry", "<riskRegistryAddress>")
  > await registry.setRelayer("<dedicated-relayer-address>")
  ```
- **The Guard's `freezeAuthority` is initially the deployer.** In production, set it to the backend relayer:
  ```bash
  npx hardhat console --network sepolia
  > const guard = await ethers.getContractAt("TripwireGuard", "<guardAddress>")
  > await guard.setFreezeAuthority("<relayer-address>")
  ```

## Troubleshooting

**"insufficient funds for gas"** — Your account doesn't have enough testnet ETH/TXDC. Get some from a faucet.

**"Nonce too low"** — You may have pending transactions. Wait for them to confirm or reset your nonce.

**Safe deployment fails** — The Safe singleton and proxy factory are compiled from `@gnosis.pm/safe-contracts`. If compilation fails, run `npx hardhat compile` first.

**Guard not appearing on dashboard** — Make sure `VITE_GUARD_ADDRESS` in `frontend/.env` matches the deployed Guard address, and restart `npm run dev` after editing `.env` (Vite reads env vars at startup).
