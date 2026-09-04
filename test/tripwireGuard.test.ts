import { expect } from "chai"
import { ethers } from "hardhat"
import { time } from "@nomicfoundation/hardhat-network-helpers"

// Mirrors IRiskRegistry.Status: UNSCORED, LOW_RISK, DELAYED, HIGH_RISK, FROZEN
const Status = { UNSCORED: 0, LOW_RISK: 1, DELAYED: 2, HIGH_RISK: 3, FROZEN: 4 }
const CALL = 0 // Enum.Operation.Call

async function setup() {
  const [owner, target, freezeAuthority] = await ethers.getSigners()

  const MockRiskRegistry = await ethers.getContractFactory("MockRiskRegistry")
  const registry = await MockRiskRegistry.deploy()

  const TripwireGuard = await ethers.getContractFactory("TripwireGuard")
  const guard = await TripwireGuard.deploy(owner.address, await registry.getAddress(), freezeAuthority.address)

  const to = target.address
  const value = 0n
  const data = "0x"
  const txHash = await guard.txHashOf(to, value, data, CALL)

  const check = () =>
    guard.checkTransaction(
      to,
      value,
      data,
      CALL,
      0,
      0,
      0,
      ethers.ZeroAddress,
      ethers.ZeroAddress,
      "0x",
      owner.address,
    )

  return { owner, freezeAuthority, registry, guard, to, value, data, txHash, check }
}

describe("TripwireGuard", function () {
  it("blocks a transaction with no recorded verdict (fail-closed default)", async function () {
    const { guard, txHash, check } = await setup()
    await expect(check()).to.be.revertedWithCustomError(guard, "AwaitingRiskScore").withArgs(txHash)
  })

  it("allows a transaction with a LOW_RISK verdict", async function () {
    const { registry, txHash, check } = await setup()
    await registry.submitVerdict(txHash, { status: Status.LOW_RISK, score: 5, releaseAt: 0 })
    await expect(check()).to.not.be.reverted
  })

  it("blocks a transaction with a HIGH_RISK verdict", async function () {
    const { guard, registry, txHash, check } = await setup()
    await registry.submitVerdict(txHash, { status: Status.HIGH_RISK, score: 92, releaseAt: 0 })
    await expect(check()).to.be.revertedWithCustomError(guard, "BlockedHighRisk").withArgs(txHash, 92)
  })

  it("blocks a DELAYED transaction until its releaseAt, then allows it", async function () {
    const { guard, registry, txHash, check } = await setup()
    const releaseAt = (await time.latest()) + 600
    await registry.submitVerdict(txHash, { status: Status.DELAYED, score: 40, releaseAt })

    await expect(check()).to.be.revertedWithCustomError(guard, "InCoolingOffWindow").withArgs(txHash, releaseAt)

    await time.increaseTo(releaseAt)
    await expect(check()).to.not.be.reverted
  })

  it("blocks everything while frozen, even a LOW_RISK verdict", async function () {
    const { guard, registry, txHash, check } = await setup()
    await registry.submitVerdict(txHash, { status: Status.LOW_RISK, score: 0, releaseAt: 0 })
    await guard.freeze()
    await expect(check()).to.be.revertedWithCustomError(guard, "GuardIsFrozen")
  })

  it("only the owner can unfreeze or update the risk registry", async function () {
    const { guard, registry } = await setup()
    const [, , , other] = await ethers.getSigners()
    await guard.freeze()
    await expect(guard.connect(other).unfreeze()).to.be.revertedWithCustomError(guard, "OwnableUnauthorizedAccount")
    await expect(
      guard.connect(other).setRiskRegistry(await registry.getAddress()),
    ).to.be.revertedWithCustomError(guard, "OwnableUnauthorizedAccount")
  })

  it("lets the freeze authority (risk engine relayer) trip the breaker, but not lift it", async function () {
    const { guard, freezeAuthority } = await setup()
    await expect(guard.connect(freezeAuthority).freeze()).to.not.be.reverted
    expect(await guard.frozen()).to.equal(true)
    await expect(guard.connect(freezeAuthority).unfreeze()).to.be.revertedWithCustomError(
      guard,
      "OwnableUnauthorizedAccount",
    )
  })

  it("rejects freeze() from an address that is neither owner nor freeze authority", async function () {
    const { guard } = await setup()
    const [, , , other] = await ethers.getSigners()
    await expect(guard.connect(other).freeze())
      .to.be.revertedWithCustomError(guard, "NotOwnerOrFreezeAuthority")
      .withArgs(other.address)
  })

  it("only the owner can rotate the freeze authority", async function () {
    const { guard } = await setup()
    const [, , , other] = await ethers.getSigners()
    await expect(guard.connect(other).setFreezeAuthority(other.address)).to.be.revertedWithCustomError(
      guard,
      "OwnableUnauthorizedAccount",
    )
    await expect(guard.setFreezeAuthority(other.address)).to.not.be.reverted
    await expect(guard.connect(other).freeze()).to.not.be.reverted
  })
})
