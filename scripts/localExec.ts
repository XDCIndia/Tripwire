/**
 * Submits one execTransaction attempt against the locally-deployed Safe, as
 * its owner. Since the Guard is active, a fresh (to, value, data) tuple
 * will revert the first time (fail-closed) - that's expected. Run the
 * backend orchestrator (backend/scripts/localWatcherLoop.ts) to get it scored,
 * then run this again with the same ACTION to retry.
 *
 *   ACTION=transfer npx hardhat run scripts/localExec.ts --network localhost
 *   ACTION=approve  npx hardhat run scripts/localExec.ts --network localhost
 *   ACTION=drain    npx hardhat run scripts/localExec.ts --network localhost   # not through the Safe - the actual theft attempt
 */
import fs from "node:fs"
import path from "node:path"

import { ethers } from "hardhat"

function loadDeployment() {
  const p = path.join(__dirname, "..", "local-deployment.json")
  return JSON.parse(fs.readFileSync(p, "utf8"))
}

function approvedHashSignature(owner: string): string {
  const r = ethers.zeroPadValue(owner, 32)
  const s = ethers.ZeroHash
  return r + s.slice(2) + "01"
}

async function main() {
  const d = loadDeployment()
  const owner = new ethers.Wallet(d.ownerPrivateKey, ethers.provider)
  const safe = await ethers.getContractAt("GnosisSafe", d.safeAddress)
  const action = process.env.ACTION ?? "transfer"

  if (action === "drain") {
    const attacker = await ethers.getContractAt("DrainerAttacker", d.attackerAddress)
    console.log("Attempting to drain tokenId 0 from the Safe (not via execTransaction)...")
    const nft = await ethers.getContractAt("MockDrainableNFT", d.nftAddress)
    try {
      await (await attacker.drain(d.nftAddress, d.safeAddress, 0)).wait()
      console.log("Drain succeeded. New owner:", await nft.ownerOf(0))
    } catch (err) {
      console.log("Drain reverted - no approval was ever granted.", (err as Error).message.slice(0, 200))
    }
    return
  }

  let to: string
  let value = 0n
  let data = "0x"

  if (action === "transfer") {
    to = process.env.TO ?? d.ownerAddress
    value = ethers.parseEther(process.env.AMOUNT ?? "0.01")
    console.log(`Attempting a plain transfer of ${ethers.formatEther(value)} ETH to ${to}`)
  } else if (action === "approve") {
    const nft = await ethers.getContractAt("MockDrainableNFT", d.nftAddress)
    to = d.nftAddress
    data = nft.interface.encodeFunctionData("setApprovalForAll", [d.attackerAddress, true])
    console.log(`Attempting setApprovalForAll(${d.attackerAddress}, true) on the NFT ${to}`)
  } else {
    throw new Error(`Unknown ACTION: ${action}`)
  }

  try {
    // Explicit gasLimit deliberately skips ethers' own automatic
    // eth_estimateGas preflight - a doomed-by-design transaction (nothing
    // is ever scored on its first attempt) always fails that estimate, so
    // skipping it here mirrors what a real wallet's manual gas override
    // does. This is exactly the real UX gap worth flagging: a typical
    // wallet's *default* flow (MetaMask, etc.) would refuse to let a user
    // submit at all, since it estimates gas before allowing a send - see
    // the note in local-deployment docs / the PR for this script.
    const tx = await safe
      .connect(owner)
      .execTransaction(
        to,
        value,
        data,
        0,
        0,
        0,
        0,
        ethers.ZeroAddress,
        ethers.ZeroAddress,
        approvedHashSignature(owner.address),
        { gasLimit: 500_000 },
      )
    // Got here => broadcast succeeded and has a real tx hash, regardless of
    // whether it ultimately succeeds or reverts.
    console.log("Broadcast. Tx hash:", tx.hash)
    try {
      await tx.wait()
      console.log("execTransaction SUCCEEDED.")
    } catch {
      console.log("execTransaction MINED BUT REVERTED (fail-closed) - this is expected on a first attempt.")
    }
  } catch (err) {
    console.log("execTransaction REJECTED BEFORE BROADCAST:", (err as Error).message.slice(0, 300))
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
