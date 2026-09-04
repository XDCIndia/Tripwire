/**
 * Issue #23: E2E test — attack caught live
 *
 * Deploys a real GnosisSafe with TripwireGuard enabled, attempts a
 * drainer attack (setApprovalForAll) through the Safe, and verifies the
 * Guard blocks it end-to-end:
 *   1. First attempt reverts (fail-closed, no verdict yet)
 *   2. Risk engine scores it HIGH_RISK
 *   3. Second attempt still reverts (blocked by HIGH_RISK verdict)
 *   4. NFT is never at risk — ownership unchanged
 *
 * Re-runnable: each test deploys fresh contracts, no shared state.
 */
import { expect } from "chai"
import { ethers } from "hardhat"

const Status = { UNSCORED: 0, LOW_RISK: 1, DELAYED: 2, HIGH_RISK: 3, FROZEN: 4 }

function approvedHashSignature(owner: string): string {
  const r = ethers.zeroPadValue(owner, 32)
  const s = ethers.ZeroHash
  return r + s.slice(2) + "01"
}

describe("E2E: attack caught through real Safe + Guard", function () {
  this.timeout(30_000)

  let safe: any
  let guard: any
  let registry: any
  let nft: any
  let attacker: any
  let owner: any
  let safeAddress: string
  let attackerAddress: string
  let nftAddress: string
  let approvalData: string
  let txHash: string

  const CALL = 0

  before(async function () {
    const signers = await ethers.getSigners()
    owner = signers[0]

    // 1. Deploy real GnosisSafe singleton + proxy factory.
    const SafeSingleton = await ethers.getContractFactory("GnosisSafe")
    const singleton = await SafeSingleton.deploy()

    const SafeProxyFactory = await ethers.getContractFactory("GnosisSafeProxyFactory")
    const factory = await SafeProxyFactory.deploy()

    // 2. Create a single-owner Safe.
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
      .map((log: any) => {
        try {
          return factory.interface.parseLog(log)
        } catch {
          return null
        }
      })
      .find((parsed: any) => parsed?.name === "ProxyCreation")
    safeAddress = creationEvent!.args.proxy
    safe = await ethers.getContractAt("GnosisSafe", safeAddress)

    // 3. Deploy RiskRegistry + TripwireGuard.
    const RiskRegistry = await ethers.getContractFactory("RiskRegistry")
    registry = await RiskRegistry.deploy(owner.address, owner.address)

    const TripwireGuard = await ethers.getContractFactory("TripwireGuard")
    guard = await TripwireGuard.deploy(
      owner.address,
      await registry.getAddress(),
      owner.address,
      safeAddress,
    )

    // 4. Enable Guard on Safe.
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

    // 5. Deploy drainer demo contracts and mint NFT to Safe.
    nft = await (await ethers.getContractFactory("MockDrainableNFT")).deploy()
    attacker = await (await ethers.getContractFactory("DrainerAttacker")).deploy()
    nftAddress = await nft.getAddress()
    attackerAddress = await attacker.getAddress()

    await (await nft.mint(safeAddress)).wait() // tokenId 0 owned by Safe

    // 6. Encode the malicious calldata.
    approvalData = nft.interface.encodeFunctionData("setApprovalForAll", [attackerAddress, true])
    txHash = await guard.txHashOf(nftAddress, 0, approvalData, CALL)
  })

  it("first attempt reverts (fail-closed, no verdict yet)", async function () {
    // Verify NFT is owned by Safe before the attempt.
    expect(await nft.ownerOf(0)).to.equal(safeAddress)

    // Submit the drainer's setApprovalForAll through the Safe — should revert.
    await expect(
      safe
        .connect(owner)
        .execTransaction(
          nftAddress,
          0,
          approvalData,
          CALL,
          0,
          0,
          0,
          ethers.ZeroAddress,
          ethers.ZeroAddress,
          approvedHashSignature(owner.address),
          { gasLimit: 500_000 },
        ),
    ).to.be.reverted

    // NFT still owned by Safe — attack didn't go through.
    expect(await nft.ownerOf(0)).to.equal(safeAddress)
  })

  it("risk engine scores HIGH_RISK and second attempt is still blocked", async function () {
    // Risk engine writes a HIGH_RISK verdict.
    await registry
      .connect(owner)
      .submitVerdict(txHash, { status: Status.HIGH_RISK, score: 92, releaseAt: 0 })

    // Second attempt — verdict is HIGH_RISK, should still revert.
    await expect(
      safe
        .connect(owner)
        .execTransaction(
          nftAddress,
          0,
          approvalData,
          CALL,
          0,
          0,
          0,
          ethers.ZeroAddress,
          ethers.ZeroAddress,
          approvedHashSignature(owner.address),
          { gasLimit: 500_000 },
        ),
    ).to.be.reverted

    // NFT is still owned by Safe — the attack was caught.
    expect(await nft.ownerOf(0)).to.equal(safeAddress)
  })

  it("is re-runnable: fresh deploy produces the same protection", async function () {
    // Deploy a completely fresh stack to prove re-runnability.
    const SafeSingleton = await ethers.getContractFactory("GnosisSafe")
    const singleton = await SafeSingleton.deploy()
    const SafeProxyFactory = await ethers.getContractFactory("GnosisSafeProxyFactory")
    const factory = await SafeProxyFactory.deploy()

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
      .map((log: any) => {
        try { return factory.interface.parseLog(log) } catch { return null }
      })
      .find((parsed: any) => parsed?.name === "ProxyCreation")
    const freshSafeAddress = creationEvent!.args.proxy
    const freshSafe = await ethers.getContractAt("GnosisSafe", freshSafeAddress)

    const RiskRegistry = await ethers.getContractFactory("RiskRegistry")
    const freshRegistry = await RiskRegistry.deploy(owner.address, owner.address)

    const TripwireGuard = await ethers.getContractFactory("TripwireGuard")
    const freshGuard = await TripwireGuard.deploy(
      owner.address,
      await freshRegistry.getAddress(),
      owner.address,
      freshSafeAddress,
    )

    // Enable Guard.
    const setGuardData = freshSafe.interface.encodeFunctionData("setGuard", [await freshGuard.getAddress()])
    await (
      await freshSafe
        .connect(owner)
        .execTransaction(
          freshSafeAddress,
          0,
          setGuardData,
          0, 0, 0, 0,
          ethers.ZeroAddress,
          ethers.ZeroAddress,
          approvedHashSignature(owner.address),
        )
    ).wait()

    // Mint NFT to fresh Safe.
    const freshNft = await (await ethers.getContractFactory("MockDrainableNFT")).deploy()
    await (await freshNft.mint(freshSafeAddress)).wait()

    const freshApprovalData = freshNft.interface.encodeFunctionData("setApprovalForAll", [attackerAddress, true])
    const freshTxHash = await freshGuard.txHashOf(await freshNft.getAddress(), 0, freshApprovalData, CALL)

    // First attempt: fail-closed.
    await expect(
      freshSafe.connect(owner).execTransaction(
        await freshNft.getAddress(), 0, freshApprovalData, CALL,
        0, 0, 0, ethers.ZeroAddress, ethers.ZeroAddress,
        approvedHashSignature(owner.address),
        { gasLimit: 500_000 },
      ),
    ).to.be.reverted

    // Score HIGH_RISK.
    await freshRegistry.connect(owner).submitVerdict(freshTxHash, { status: Status.HIGH_RISK, score: 95, releaseAt: 0 })

    // Second attempt: still blocked.
    await expect(
      freshSafe.connect(owner).execTransaction(
        await freshNft.getAddress(), 0, freshApprovalData, CALL,
        0, 0, 0, ethers.ZeroAddress, ethers.ZeroAddress,
        approvedHashSignature(owner.address),
        { gasLimit: 500_000 },
      ),
    ).to.be.reverted

    // NFT safe.
    expect(await freshNft.ownerOf(0)).to.equal(freshSafeAddress)
  })
})
