// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {Enum} from "@gnosis.pm/safe-contracts/contracts/common/Enum.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {RiskRegistry} from "../RiskRegistry.sol";
import {TripwireGuard} from "../TripwireGuard.sol";
import {IRiskRegistry} from "../interfaces/IRiskRegistry.sol";
import {Button} from "./Button.sol";

/**
 * Issue #6: consolidated Guard + RiskRegistry end-to-end suite.
 *
 * Exercises the real RiskRegistry (not the mock) so the full
 * relayer-authorization path is under test: verdicts are written as the
 * authorized relayer, read back by the Guard at execution time, and the
 * rolling-limit accounting across checkTransaction/checkAfterExecution
 * behaves the way a Safe would drive it.
 *
 * `this` contract plays the Safe: the Guard's avatar is set to
 * address(this), so calling checkTransaction/checkAfterExecution here
 * mirrors exactly what Safe.execTransaction does around a real execution
 * (guards - then run - then checkAfterExecution).
 */
contract TripwireGuardTest is Test {
    RiskRegistry registry;
    TripwireGuard guard;
    Button button;

    address owner = makeAddr("owner");
    address relayer = makeAddr("relayer");
    address freezeAuthority = makeAddr("freezeAuthority");
    address beneficiary = makeAddr("beneficiary");

    function setUp() public {
        registry = new RiskRegistry(owner, relayer);
        guard = new TripwireGuard(owner, address(registry), freezeAuthority, address(this));
        button = new Button();
        // The starter Button is OZ-Ownable to its deployer (this test
        // contract); hand it to the owner so the Safe can push it.
        button.transferOwnership(address(this));
    }

    // -- helpers ------------------------------------------------------------

    function _verdict(
        IRiskRegistry.Status status,
        uint8 score,
        uint256 releaseAt
    ) internal pure returns (IRiskRegistry.Verdict memory) {
        return IRiskRegistry.Verdict({status: status, score: score, releaseAt: releaseAt});
    }

    function _submit(bytes32 txHash, IRiskRegistry.Verdict memory v) internal {
        vm.prank(relayer);
        registry.submitVerdict(txHash, v);
    }

    /// @dev Mirrors Safe.execTransaction: guard checks, run, post-check.
    ///     The tx hash must be computed BEFORE vm.expectRevert is armed -
    ///     expectRevert binds to the very next call, and the txHashOf
    ///     staticcall would otherwise consume it.
    function _execWithGuard(address to, uint256 value, bytes memory data, bytes32 txHash) internal {
        guard.checkTransaction(
            to, value, data, Enum.Operation.Call, 0, 0, 0, address(0), payable(address(0)), bytes(""), address(0)
        );
        bool success = true;
        if (to == address(button)) {
            button.pushButton();
        } else if (value > 0) {
            (success,) = payable(to).call{value: value}("");
        }
        guard.checkAfterExecution(txHash, success);
    }

    /// @dev The guard check alone, for paths expected to revert. The body
    ///     must contain exactly one external call: vm.expectRevert catches
    ///     the revert but execution then resumes right after it, so any
    ///     code following the call inside the same helper would still run.
    function _checkOnly(address to, uint256 value, bytes memory data) internal {
        guard.checkTransaction(
            to, value, data, Enum.Operation.Call, 0, 0, 0, address(0), payable(address(0)), bytes(""), address(0)
        );
    }

    // -- 1. benign LOW_RISK executes ----------------------------------------

    function test_BenignLowRiskExecutes() public {
        bytes memory data = abi.encodeCall(Button.pushButton, ());
        bytes32 txHash = guard.txHashOf(address(button), 0, data, Enum.Operation.Call);
        _submit(txHash, _verdict(IRiskRegistry.Status.LOW_RISK, 5, 0));

        _execWithGuard(address(button), 0, data, txHash);
        assertEq(button.pushes(), 1);
    }

    // -- 2. over-limit auto-routes to DELAYED --------------------------------

    /// @dev The Guard's hard backstop: an over-limit tx reverts even with a
    /// clean verdict - the EVM cannot persist a "come back later" record
    /// across a revert, so routing an over-limit tx through the DELAYED
    /// queue is the off-chain engine's job. Both halves are covered here.
    function test_OverLimitRevertsEvenWithLowRiskVerdict() public {
        vm.prank(owner);
        guard.setLimits(1 ether, 0);

        bytes32 txHash = guard.txHashOf(beneficiary, 2 ether, "", Enum.Operation.Call);
        _submit(txHash, _verdict(IRiskRegistry.Status.LOW_RISK, 0, 0));

        vm.deal(address(this), 3 ether);
        vm.expectRevert(
            abi.encodeWithSelector(
                TripwireGuard.PerTxLimitExceeded.selector, txHash, uint256(2 ether), uint256(1 ether)
            )
        );
        _checkOnly(beneficiary, 2 ether, "");
    }

    /// @dev The delay-queue half: a DELAYED verdict blocks until its own
    /// releaseAt, then executes - and the engine can cancel mid-window by
    /// overwriting to HIGH_RISK.
    function test_DelayedVerdictBlocksUntilReleaseThenExecutes() public {
        bytes memory data = abi.encodeCall(Button.pushButton, ());
        bytes32 txHash = guard.txHashOf(address(button), 0, data, Enum.Operation.Call);
        _submit(txHash, _verdict(IRiskRegistry.Status.DELAYED, 40, block.timestamp + 1 days));

        vm.expectRevert(
            abi.encodeWithSelector(TripwireGuard.InCoolingOffWindow.selector, txHash, block.timestamp + 1 days)
        );
        _checkOnly(address(button), 0, data);
        assertEq(button.pushes(), 0);

        vm.warp(block.timestamp + 1 days + 1);
        _execWithGuard(address(button), 0, data, txHash);
        assertEq(button.pushes(), 1);
    }

    function test_DelayedVerdictCanBeCancelledMidWindow() public {
        bytes32 txHash = guard.txHashOf(beneficiary, 0, "", Enum.Operation.Call);
        _submit(txHash, _verdict(IRiskRegistry.Status.DELAYED, 40, block.timestamp + 1 days));
        _submit(txHash, _verdict(IRiskRegistry.Status.HIGH_RISK, 90, 0)); // engine escalates

        vm.expectRevert(abi.encodeWithSelector(TripwireGuard.BlockedHighRisk.selector, txHash, uint8(90)));
        _checkOnly(beneficiary, 0, "");
    }

    // -- 3. HIGH_RISK blocks unconditionally ---------------------------------

    function test_HighRiskBlocksUnconditionally() public {
        // Zero value, empty calldata, no limits set: nothing else could
        // object - the verdict alone must carry the block.
        bytes32 txHash = guard.txHashOf(beneficiary, 0, "", Enum.Operation.Call);
        _submit(txHash, _verdict(IRiskRegistry.Status.HIGH_RISK, 85, 0));

        vm.expectRevert(abi.encodeWithSelector(TripwireGuard.BlockedHighRisk.selector, txHash, uint8(85)));
        _checkOnly(beneficiary, 0, "");
    }

    // -- 4. frozen Safe blocks everything regardless of verdict --------------

    function test_FrozenSafeBlocksEverythingRegardlessOfVerdict() public {
        bytes memory data = abi.encodeCall(Button.pushButton, ());
        bytes32 txHash = guard.txHashOf(address(button), 0, data, Enum.Operation.Call);
        _submit(txHash, _verdict(IRiskRegistry.Status.LOW_RISK, 0, 0));

        vm.prank(freezeAuthority); // the relayer-side authority can trip it
        guard.freeze();

        vm.expectRevert(TripwireGuard.GuardIsFrozen.selector);
        _checkOnly(address(button), 0, data);
        assertEq(button.pushes(), 0);

        vm.prank(owner); // ...but only the owner can lift it
        guard.unfreeze();
        _execWithGuard(address(button), 0, data, txHash);
        assertEq(button.pushes(), 1);
    }

    /// @dev A per-verdict FROZEN status blocks too, even when the guard
    /// switch itself is not tripped.
    function test_FrozenVerdictStatusBlocksWithoutGuardFreeze() public {
        bytes32 txHash = guard.txHashOf(beneficiary, 0, "", Enum.Operation.Call);
        _submit(txHash, _verdict(IRiskRegistry.Status.FROZEN, 100, 0));

        vm.expectRevert(TripwireGuard.GuardIsFrozen.selector);
        _checkOnly(beneficiary, 0, "");
    }

    // -- 5. no-verdict tx always fails closed --------------------------------

    function test_NoVerdictFailsClosed() public {
        bytes memory data = abi.encodeCall(Button.pushButton, ());
        bytes32 txHash = guard.txHashOf(address(button), 0, data, Enum.Operation.Call);
        // Deliberately never submit a verdict.

        vm.expectRevert(abi.encodeWithSelector(TripwireGuard.AwaitingRiskScore.selector, txHash));
        _checkOnly(address(button), 0, data);
        assertEq(button.pushes(), 0);
    }

    /// @dev An unset verdict must read back as UNSCORED, never as allowed.
    function test_UnsetVerdictReadsAsUnscored() public view {
        IRiskRegistry.Verdict memory v = registry.verdictOf(keccak256("never submitted"));
        assertEq(uint256(v.status), uint256(IRiskRegistry.Status.UNSCORED));
        assertEq(v.score, 0);
        assertEq(v.releaseAt, 0);
    }

    // -- rolling velocity limit (backstop detail) -----------------------------

    function test_RollingLimitCountsOnlySuccessfulExecutions() public {
        vm.prank(owner);
        guard.setLimits(0, 1 ether);
        vm.deal(address(this), 3 ether);

        bytes32 tx1 = guard.txHashOf(beneficiary, 0.6 ether, "", Enum.Operation.Call);
        _submit(tx1, _verdict(IRiskRegistry.Status.LOW_RISK, 0, 0));
        _execWithGuard(beneficiary, 0.6 ether, "", tx1);
        assertEq(guard.windowSpent(), 0.6 ether);

        // A reverted inner execution must not burn daily allowance.
        bytes32 txRevert = guard.txHashOf(address(button), 0, abi.encodeCall(Button.pushButton, ()), Enum.Operation.Call);
        _submit(txRevert, _verdict(IRiskRegistry.Status.LOW_RISK, 0, 0));
        button.transferOwnership(beneficiary); // pushButton now reverts (not owner)
        guard.checkTransaction(
            address(button),
            0,
            abi.encodeCall(Button.pushButton, ()),
            Enum.Operation.Call,
            0,
            0,
            0,
            address(0),
            payable(address(0)),
            bytes(""),
            address(0)
        );
        guard.checkAfterExecution(txRevert, false);
        assertEq(guard.windowSpent(), 0.6 ether);

        // 0.6 + 0.6 > 1.0 rolling cap: the third tx breaches the window.
        bytes32 tx2 = guard.txHashOf(beneficiary, 0.6 ether, "", Enum.Operation.Call);
        _submit(tx2, _verdict(IRiskRegistry.Status.LOW_RISK, 0, 0));
        vm.expectRevert(
            abi.encodeWithSelector(
                TripwireGuard.RollingLimitExceeded.selector, tx2, uint256(1.2 ether), uint256(1 ether)
            )
        );
        _checkOnly(beneficiary, 0.6 ether, "");

        // After the window rolls over, spending is available again.
        bytes32 tx3 = guard.txHashOf(beneficiary, 0.6 ether, "", Enum.Operation.Call);
        _submit(tx3, _verdict(IRiskRegistry.Status.LOW_RISK, 0, 0));
        vm.warp(block.timestamp + guard.ROLLING_WINDOW() + 1);
        _execWithGuard(beneficiary, 0.6 ether, "", tx3);
        assertEq(guard.windowSpent(), 0.6 ether);
    }

    // -- RiskRegistry authorization (the relayer path under test) -------------

    function test_OnlyRelayerCanSubmitVerdicts() public {
        bytes32 txHash = guard.txHashOf(beneficiary, 0, "", Enum.Operation.Call);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(RiskRegistry.NotRelayer.selector, owner));
        registry.submitVerdict(txHash, _verdict(IRiskRegistry.Status.LOW_RISK, 0, 0));
    }

    function test_OwnerCanRotateRelayer() public {
        address newRelayer = makeAddr("newRelayer");
        vm.prank(owner);
        registry.setRelayer(newRelayer);
        assertEq(registry.relayer(), newRelayer);

        bytes32 txHash = guard.txHashOf(beneficiary, 0, "", Enum.Operation.Call);
        vm.prank(newRelayer);
        registry.submitVerdict(txHash, _verdict(IRiskRegistry.Status.LOW_RISK, 0, 0));
        assertEq(uint256(registry.verdictOf(txHash).status), uint256(IRiskRegistry.Status.LOW_RISK));
    }
}
