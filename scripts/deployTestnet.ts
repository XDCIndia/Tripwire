/**
 * Testnet deployment for issue #21:
 *   Deploys RiskRegistry + TripwireGuard to Sepolia (or XDC Apothem),
 *   creates a real single-owner Safe, enables the Guard on it, and
 *   writes deployment.json for the backend and frontend to consume.
 *
 * Usage:
 *   # Sepolia
 *   PRIVATE_KEY=0x... SEPOLIA_URL=https://... npx hardhat run scripts/deployTestnet.ts --network sepolia
 *
 *   # XDC Apothem
 *   PRIVATE_KEY=0x... npx hardhat run scripts/deployTestnet.ts --network apothem
 *
 * Prerequisites:
 *   - PRIVATE_KEY env var set (the deployer/owner account)
 *   - SEPOLIA_URL env var set (for Sepolia; Apothem uses built-in RPC)
 *   - The account must have enough ETH/TXDC for gas
 *
 * Output:
 *   - Writes `deployment.json` at the repo root
 *   - Prints all deployed addresses
 */
import fs from "node:fs"
import path from "node:path"

import { ethers } from "hardhat"

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required env var: ${name}`)
  return value
}

function approvedHashSignature(owner: string): string {
  const r = ethers.zeroPadValue(owner, 32)
  const s = ethers.ZeroHash
  const v = "01"
  return r + s.slice(2) + v
}

async function main() {
  const [deployer] = await ethers.getSigners()
  const deployerAddress = deployer.address
  const networkName = (await ethers.provider.getNetwork()).name
  const chainId = Number((await ethers.provider.getNetwork()).chainId)

  console.log("=== Tripwire Testnet Deployment ===")
  console.log("Network:", networkName, `(chainId: ${chainId})`)
  console.log("Deployer/Owner:", deployerAddress)

  const balance = await ethers.provider.getBalance(deployerAddress)
  console.log("Deployer balance:", ethers.formatEther(balance), networkName === "apothem" ? "TXDC" : "ETH")

  // ──────────────────────────────────────────────────────────────
  // 1. Deploy Safe singleton + proxy factory
  // ──────────────────────────────────────────────────────────────
  console.log("\n[1/6] Deploying Safe singleton...")
  const SafeSingleton = await ethers.getContractFactory("GnosisSafe")
  const singleton = await SafeSingleton.deploy()
  await singleton.waitForDeployment()
  const singletonAddress = await singleton.getAddress()
  console.log("  Safe singleton:", singletonAddress)

  console.log("[2/6] Deploying Safe proxy factory...")
  const SafeProxyFactory = await ethers.getContractFactory("GnosisSafeProxyFactory")
  const factory = await SafeProxyFactory.deploy()
  await factory.waitForDeployment()
  const factoryAddress = await factory.getAddress()
  console.log("  Safe proxy factory:", factoryAddress)

  // ──────────────────────────────────────────────────────────────
  // 2. Create a single-owner Safe
  // ──────────────────────────────────────────────────────────────
  console.log("\n[3/6] Creating Safe proxy (single owner, threshold 1)...")
  const setupData = singleton.interface.encodeFunctionData("setup", [
    [deployerAddress], // owners
    1, // threshold
    ethers.ZeroAddress, // to (no delegate call)
    "0x", // data
    ethers.ZeroAddress, // fallback
    ethers.ZeroAddress, // payment token
    0, // payment
    ethers.ZeroAddress, // payment receiver
  ])

  const createTx = await factory.createProxy(await singleton.getAddress(), setupData)
  const createReceipt = await createTx.wait()
  const creationEvent = createReceipt!.logs
    .map((log) => {
      try {
        return factory.interface.parseLog(log)
      } catch {
        return null
      }
    })
    .find((parsed) => parsed?.name === "ProxyCreation")
  const safeAddress: string = creationEvent!.args.proxy
  console.log("  Safe address:", safeAddress)

  // ──────────────────────────────────────────────────────────────
  // 3. Deploy RiskRegistry
  // ──────────────────────────────────────────────────────────────
  console.log("\n[4/6] Deploying RiskRegistry...")
  const RiskRegistry = await ethers.getContractFactory("RiskRegistry")
  const registry = await RiskRegistry.deploy(deployerAddress, deployerAddress) // owner + relayer = deployer initially
  await registry.waitForDeployment()
  const registryAddress = await registry.getAddress()
  console.log("  RiskRegistry:", registryAddress)
  console.log("  Relayer (initial):", deployerAddress)

  // ──────────────────────────────────────────────────────────────
  // 4. Deploy TripwireGuard
  // ──────────────────────────────────────────────────────────────
  console.log("\n[5/6] Deploying TripwireGuard...")
  const TripwireGuard = await ethers.getContractFactory("TripwireGuard")
  const guard = await TripwireGuard.deploy(
    deployerAddress, // owner
    registryAddress, // riskRegistry
    deployerAddress, // freezeAuthority (deployer initially)
    safeAddress, // avatar (the Safe)
  )
  await guard.waitForDeployment()
  const guardAddress = await guard.getAddress()
  console.log("  TripwireGuard:", guardAddress)

  // ──────────────────────────────────────────────────────────────
  // 5. Enable the Guard on the Safe
  // ──────────────────────────────────────────────────────────────
  console.log("\n[6/6] Enabling Guard on Safe via execTransaction...")
  const safe = await ethers.getContractAt("GnosisSafe", safeAddress)
  const setGuardData = safe.interface.encodeFunctionData("setGuard", [guardAddress])

  const enableTx = await safe
    .connect(deployer)
    .execTransaction(
      safeAddress, // to: call the Safe itself
      0, // value
      setGuardData, // data: setGuard(guardAddress)
      0, // operation: Call
      0, // safeTxGas
      0, // baseGas
      0, // gasPrice
      ethers.ZeroAddress, // gasToken
      ethers.ZeroAddress, // refundReceiver
      approvedHashSignature(deployerAddress), // signature
    )
  await enableTx.wait()
  console.log("  Guard enabled on Safe ✓")

  // ──────────────────────────────────────────────────────────────
  // 6. Write deployment.json
  // ──────────────────────────────────────────────────────────────
  const deployment = {
    network: networkName,
    chainId,
    safeAddress,
    guardAddress,
    riskRegistryAddress: registryAddress,
    ownerAddress: deployerAddress,
    relayerAddress: deployerAddress, // same as owner for now
    safeSingletonAddress: singletonAddress,
    safeProxyFactoryAddress: factoryAddress,
    deployedAt: new Date().toISOString(),
  }

  const outPath = path.join(__dirname, "..", "deployment.json")
  fs.writeFileSync(outPath, JSON.stringify(deployment, null, 2))
  console.log("\n=== Deployment Complete ===")
  console.log("Wrote", outPath)
  console.log(deployment)

  console.log("\n--- Next steps ---")
  console.log("1. Backend: Set these env vars in backend/.env:")
  console.log(`   SAFE_ADDRESS=${safeAddress}`)
  console.log(`   CHAIN_ID=${chainId}`)
  console.log(`   RELAYER_PRIVATE_KEY=<your private key>`)
  console.log("")
  console.log("2. Frontend: Set these env vars in frontend/.env:")
  console.log(`   VITE_CHAIN=${networkName === "apothem" ? "apothem" : "sepolia"}`)
  console.log(`   VITE_SAFE_ADDRESS=${safeAddress}`)
  console.log(`   VITE_GUARD_ADDRESS=${guardAddress}`)
  console.log(`   VITE_RISK_REGISTRY_ADDRESS=${registryAddress}`)
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
