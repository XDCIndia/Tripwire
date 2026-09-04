/**
 * Full local stack deploy for end-to-end testing (no live testnet needed):
 * a real single-owner Safe, RiskRegistry, TripwireGuard enabled on the
 * Safe, and the drainer demo contracts. Writes local-deployment.json at
 * the repo root for the backend orchestrator and other scripts to read.
 *
 *   npx hardhat node                                    # terminal 1
 *   npx hardhat run scripts/localDeploy.ts --network localhost   # terminal 2
 */
import fs from "node:fs"
import path from "node:path"

import { ethers } from "hardhat"

// Hardhat's well-known default accounts - fine for local-only testing, never used elsewhere.
const OWNER_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
const RELAYER_PRIVATE_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"

function approvedHashSignature(owner: string): string {
  // Safe's "v == 1" signature type: r = owner address, s = 0, v = 1 -
  // valid whenever msg.sender == owner (GnosisSafe.sol checkNSignatures).
  const r = ethers.zeroPadValue(owner, 32)
  const s = ethers.ZeroHash
  const v = "01"
  return r + s.slice(2) + v
}

async function main() {
  const [deployer] = await ethers.getSigners()
  const owner = new ethers.Wallet(OWNER_PRIVATE_KEY, ethers.provider)
  const relayer = new ethers.Wallet(RELAYER_PRIVATE_KEY, ethers.provider)
  await deployer.sendTransaction({ to: owner.address, value: ethers.parseEther("100") })

  console.log("Deploying Safe singleton + proxy factory...")
  const singleton = await (await ethers.getContractFactory("GnosisSafe")).deploy()
  const factory = await (await ethers.getContractFactory("GnosisSafeProxyFactory")).deploy()

  const setupData = singleton.interface.encodeFunctionData("setup", [
    [owner.address],
    1,
    ethers.ZeroAddress,
    "0x",
    ethers.ZeroAddress,
    ethers.ZeroAddress,
    0,
    ethers.ZeroAddress,
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
  console.log("Safe deployed at", safeAddress)

  console.log("Deploying RiskRegistry + TripwireGuard...")
  const registry = await (
    await ethers.getContractFactory("RiskRegistry")
  ).deploy(owner.address, relayer.address)
  const guard = await (
    await ethers.getContractFactory("TripwireGuard")
  ).deploy(owner.address, await registry.getAddress(), relayer.address, safeAddress)

  console.log("Enabling the Guard on the Safe...")
  const safe = await ethers.getContractAt("GnosisSafe", safeAddress)
  const setGuardData = safe.interface.encodeFunctionData("setGuard", [await guard.getAddress()])
  await (
    await safe
      .connect(owner)
      .execTransaction(
        safeAddress,
        0,
        setGuardData,
        0,
        0,
        0,
        0,
        ethers.ZeroAddress,
        ethers.ZeroAddress,
        approvedHashSignature(owner.address),
      )
  ).wait()
  console.log("Guard enabled (verified below: the next execTransaction attempt should now revert via the Guard).")

  console.log("Funding the Safe (it holds nothing by default)...")
  await (await deployer.sendTransaction({ to: safeAddress, value: ethers.parseEther("10") })).wait()

  console.log("Deploying drainer demo contracts...")
  const nft = await (await ethers.getContractFactory("MockDrainableNFT")).deploy()
  const attacker = await (await ethers.getContractFactory("DrainerAttacker")).deploy()
  await (await nft.mint(safeAddress)).wait() // tokenId 0, "owned by the Safe"

  const deployment = {
    rpcUrl: "http://127.0.0.1:8545",
    chainId: 31337,
    safeAddress,
    guardAddress: await guard.getAddress(),
    riskRegistryAddress: await registry.getAddress(),
    nftAddress: await nft.getAddress(),
    attackerAddress: await attacker.getAddress(),
    ownerAddress: owner.address,
    ownerPrivateKey: OWNER_PRIVATE_KEY,
    relayerAddress: relayer.address,
    relayerPrivateKey: RELAYER_PRIVATE_KEY,
  }

  const outPath = path.join(__dirname, "..", "local-deployment.json")
  fs.writeFileSync(outPath, JSON.stringify(deployment, null, 2))
  console.log("\nWrote", outPath)
  console.log(deployment)
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
