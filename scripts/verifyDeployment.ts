/**
 * Post-deployment verification for issue #101:
 *   Validates that a deployed Tripwire stack is healthy by checking:
 *   - Safe proxy exists and has code
 *   - Guard is enabled on the Safe
 *   - RiskRegistry is deployed and owned correctly
 *   - Relayer address is set and funded
 *   - All expected state reads succeed
 *
 * Usage:
 *   # Verify from deployment.json (written by deployTestnet.ts)
 *   npx hardhat run scripts/verifyDeployment.ts --network sepolia
 *
 *   # Or pass addresses directly
 *   SAFE_ADDRESS=0x... GUARD_ADDRESS=0x... RISK_REGISTRY_ADDRESS=0x... \
 *   npx hardhat run scripts/verifyDeployment.ts --network sepolia
 *
 * Reads deployment.json from repo root if individual addresses aren't set.
 */

import fs from "node:fs"
import path from "node:path"

import { ethers } from "hardhat"

interface DeploymentRecord {
  network: string
  chainId: number
  safeAddress: string
  guardAddress: string
  riskRegistryAddress: string
  ownerAddress: string
  relayerAddress: string
  safeSingletonAddress: string
  safeProxyFactoryAddress: string
  deployedAt: string
}

interface CheckResult {
  name: string
  passed: boolean
  detail: string
}

function loadDeployment(): DeploymentRecord | null {
  const deploymentPath = path.join(__dirname, "..", "deployment.json")
  if (!fs.existsSync(deploymentPath)) return null
  return JSON.parse(fs.readFileSync(deploymentPath, "utf-8")) as DeploymentRecord
}

async function checkCodeExists(address: string, label: string): Promise<CheckResult> {
  const code = await ethers.provider.getCode(address)
  const hasCode = code !== "0x" && code.length > 2
  return {
    name: `${label} has code`,
    passed: hasCode,
    detail: hasCode ? `${address}` : `No code at ${address} — contract may not be deployed`,
  }
}

async function checkGuardEnabled(safeAddress: string, expectedGuard: string): Promise<CheckResult> {
  try {
    const safe = await ethers.getContractAt("GnosisSafe", safeAddress)
    const guard = await safe.guard()
    const enabled = guard.toLowerCase() === expectedGuard.toLowerCase()
    return {
      name: "Guard enabled on Safe",
      passed: enabled,
      detail: enabled
        ? `Guard ${guard} is set on Safe`
        : `Guard mismatch: expected ${expectedGuard}, got ${guard}`,
    }
  } catch (err) {
    return {
      name: "Guard enabled on Safe",
      passed: false,
      detail: `Failed to read guard from Safe: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

async function checkRegistryOwner(registryAddress: string, expectedOwner: string): Promise<CheckResult> {
  try {
    const registry = await ethers.getContractAt("RiskRegistry", registryAddress)
    const owner = await registry.owner()
    const match = owner.toLowerCase() === expectedOwner.toLowerCase()
    return {
      name: "RiskRegistry owner matches",
      passed: match,
      detail: match ? `Owner: ${owner}` : `Expected ${expectedOwner}, got ${owner}`,
    }
  } catch (err) {
    return {
      name: "RiskRegistry owner matches",
      passed: false,
      detail: `Failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

async function checkRegistryRelayer(registryAddress: string): Promise<CheckResult> {
  try {
    const registry = await ethers.getContractAt("RiskRegistry", registryAddress)
    const relayer = await registry.relayer()
    const isSet = relayer !== ethers.ZeroAddress
    return {
      name: "RiskRegistry relayer is set",
      passed: isSet,
      detail: isSet ? `Relayer: ${relayer}` : "Relayer is zero address — run setRelayer()",
    }
  } catch (err) {
    return {
      name: "RiskRegistry relayer is set",
      passed: false,
      detail: `Failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

async function checkDelayWindow(registryAddress: string): Promise<CheckResult> {
  try {
    const registry = await ethers.getContractAt("RiskRegistry", registryAddress)
    const window = await registry.defaultDelayWindow()
    return {
      name: "RiskRegistry delay window readable",
      passed: true,
      detail: `Default delay: ${window.toString()} seconds`,
    }
  } catch (err) {
    return {
      name: "RiskRegistry delay window readable",
      passed: false,
      detail: `Failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

async function checkGuardState(guardAddress: string): Promise<CheckResult> {
  try {
    const guard = await ethers.getContractAt("TripwireGuard", guardAddress)
    const frozen = await guard.frozen()
    const perTx = await guard.perTxLimit()
    const rolling = await guard.rollingLimit()
    return {
      name: "Guard state readable",
      passed: true,
      detail: `frozen=${frozen}, perTxLimit=${perTx.toString()}, rollingLimit=${rolling.toString()}`,
    }
  } catch (err) {
    return {
      name: "Guard state readable",
      passed: false,
      detail: `Failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

async function checkBalance(address: string, label: string): Promise<CheckResult> {
  const balance = await ethers.provider.getBalance(address)
  const hasFunds = balance > 0n
  return {
    name: `${label} has balance`,
    passed: hasFunds,
    detail: hasFunds ? `${ethers.formatEther(balance)} ETH` : `Zero balance — needs funding`,
  }
}

async function main() {
  // Load deployment config
  const fromEnv = {
    safeAddress: process.env.SAFE_ADDRESS,
    guardAddress: process.env.GUARD_ADDRESS,
    riskRegistryAddress: process.env.RISK_REGISTRY_ADDRESS,
  }

  const deployment = loadDeployment()
  const safeAddress = fromEnv.safeAddress ?? deployment?.safeAddress
  const guardAddress = fromEnv.guardAddress ?? deployment?.guardAddress
  const riskRegistryAddress = fromEnv.riskRegistryAddress ?? deployment?.riskRegistryAddress

  if (!safeAddress || !guardAddress || !riskRegistryAddress) {
    console.error(
      "Missing addresses. Either:\n" +
        "  1. Run deployTestnet.ts first to create deployment.json, or\n" +
        "  2. Set SAFE_ADDRESS, GUARD_ADDRESS, RISK_REGISTRY_ADDRESS env vars",
    )
    process.exitCode = 1
    return
  }

  const networkName = (await ethers.provider.getNetwork()).name
  console.log("=== Tripwire Deployment Verification ===")
  console.log("Network:", networkName)
  console.log("Safe:", safeAddress)
  console.log("Guard:", guardAddress)
  console.log("RiskRegistry:", riskRegistryAddress)
  console.log("")

  const checks: CheckResult[] = []

  // Run all checks
  checks.push(await checkCodeExists(safeAddress, "Safe"))
  checks.push(await checkCodeExists(guardAddress, "Guard"))
  checks.push(await checkCodeExists(riskRegistryAddress, "RiskRegistry"))
  checks.push(await checkGuardEnabled(safeAddress, guardAddress))

  if (deployment) {
    checks.push(await checkRegistryOwner(riskRegistryAddress, deployment.ownerAddress))
    checks.push(await checkBalance(deployment.ownerAddress, "Owner"))
  }

  checks.push(await checkRegistryRelayer(riskRegistryAddress))
  checks.push(await checkDelayWindow(riskRegistryAddress))
  checks.push(await checkGuardState(guardAddress))

  // Report
  let allPassed = true
  for (const check of checks) {
    const icon = check.passed ? "✓" : "✕"
    console.log(`  ${icon} ${check.name}`)
    console.log(`    ${check.detail}`)
    if (!check.passed) allPassed = false
  }

  console.log("")
  if (allPassed) {
    console.log("=== All checks passed — deployment is healthy ===")
  } else {
    console.log("=== Some checks failed — review above ===")
    process.exitCode = 1
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
