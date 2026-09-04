/**
 * Issue #22: E2E test — benign transaction passes instantly
 *
 * Deploys a real GnosisSafe with TripwireGuard enabled, submits a
 * normal small transfer, and verifies it executes end-to-end:
 *   1. First attempt reverts (fail-closed, no verdict yet)
 *   2. Risk engine scores it LOW_RISK
 *   3. Second attempt succeeds
 *   4. Safe's balance decreases, recipient's balance increases
 */
import { expect } from "chai"
import { ethers } from "hardhat"

const Status = { UNSCORED: 0, LOW_RISK: 1, DELAYED: 2, HIGH_RISK: 3, FROZEN: 4 }

function approvedHashSignature(owner: string): string {
  const r = ethers.zeroPadValue(owner, 32)
  const s = ethers.ZeroHash
  return r + s.slice(2) + "01"
}

describe("E2E: benign transfer passes through Guard", function () {
  // Increase timeout — deploying a real Safe + Guard takes a few seconds.
  this.timeout(30_000)

  let safe: any
  let guard: any
  let registry: any
  let owner: any
  let recipient: any
  let relayer: any
  let safeAddress: string

  const transferAmount = ethers.parseEther("0.01")

  before(async function () {
    const signers = await ethers.getSigners()
    owner = signers[0]
    recipient = signers[1]
    relayer = signers[2]

    // 1. Deploy real GnosisSafe singleton + proxy factory.
    const SafeSingleton = await ethers.getContractFactory("GnosisSafe")
    const singleton = await SafeSingleton.deploy()

    const SafeProxyFactory = await ethers.getContractFactory("GnosisSafeProxyFactory")
    const factory = await SafeProxyFactory.deploy()

    // 2. Create a single-owner Safe (threshold 1).
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
    registry = await RiskRegistry.deploy(owner.address, relayer.address)

    const TripwireGuard = await ethers.getContractFactory("TripwireGuard")
    guard = await TripwireGuard.deploy(
      owner.address,
      await registry.getAddress(),
      relayer.address,
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

    // 5. Fund the Safe.
    await (await owner.sendTransaction({ to: safeAddress, value: ethers.parseEther("1") })).wait()
  })

  it("first attempt reverts (fail-closed, no verdict yet)", async function () {
    const safeBalanceBefore = await ethers.provider.getBalance(safeAddress)
    const recipientBalanceBefore = await ethers.provider.getBalance(recipient.address)

    // Submit a benign transfer — should revert because no verdict exists.
    await expect(
      safe
        .connect(owner)
        .execTransaction(
          recipient.address,
          transferAmount,
          "0x",
          0,
          0,
          0,
          0,
          ethers.ZeroAddress,
          ethers.ZeroAddress,
          approvedHashSignature(owner.address),
          { gasLimit: 500_000 },
        ),
    ).to.be.reverted

    // Verify nothing moved.
    const safeBalanceAfter = await ethers.provider.getBalance(safeAddress)
    const recipientBalanceAfter = await ethers.provider.getBalance(recipient.address)
    expect(safeBalanceAfter).to.equal(safeBalanceBefore)
    expect(recipientBalanceAfter).to.equal(recipientBalanceBefore)
  })

  it("risk engine scores it LOW_RISK and second attempt succeeds", async function () {
    // Compute the txHash the same way the Guard does.
    const txHash = await guard.txHashOf(recipient.address, transferAmount, "0x", 0)

    // Risk engine writes a LOW_RISK verdict.
    await registry
      .connect(relayer)
      .submitVerdict(txHash, { status: Status.LOW_RISK, score: 5, releaseAt: 0 })

    const safeBalanceBefore = await ethers.provider.getBalance(safeAddress)
    const recipientBalanceBefore = await ethers.provider.getBalance(recipient.address)

    // Second attempt — verdict is LOW_RISK, should succeed.
    await (
      await safe
        .connect(owner)
        .execTransaction(
          recipient.address,
          transferAmount,
          "0x",
          0,
          0,
          0,
          0,
          ethers.ZeroAddress,
          ethers.ZeroAddress,
          approvedHashSignature(owner.address),
          { gasLimit: 500_000 },
        )
    ).wait()

    const safeBalanceAfter = await ethers.provider.getBalance(safeAddress)
    const recipientBalanceAfter = await ethers.provider.getBalance(recipient.address)

    // Safe lost the transfer amount, recipient gained it.
    expect(safeBalanceAfter).to.equal(safeBalanceBefore - transferAmount)
    expect(recipientBalanceAfter).to.equal(recipientBalanceBefore + transferAmount)
  })

})
