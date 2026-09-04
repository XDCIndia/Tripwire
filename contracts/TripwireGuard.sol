// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.22;

import {Enum} from "@gnosis.pm/safe-contracts/contracts/common/Enum.sol";
import {BaseGuard} from "@gnosis-guild/zodiac-core/contracts/guard/BaseGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {IRiskRegistry} from "./interfaces/IRiskRegistry.sol";

/// @title TripwireGuard
/// @notice A Zodiac Guard enabled on a Safe that vetoes transactions based on
/// an off-chain-computed, on-chain-recorded risk verdict.
///
/// Enforcement is fail-closed: a transaction with no verdict yet recorded is
/// blocked, never allowed. This is deliberate — the off-chain risk engine has
/// a window (a Safe transaction sits pending, unsigned, before it can
/// execute) in which to score it and write a verdict; if that hasn't
/// happened yet, the safe default is "not yet", not "sure, go ahead".
///
/// This issue (#1) ships the skeleton and the freeze switch. Limits (#2) and
/// the delay queue (#3) build on top of `checkTransaction` here.
contract TripwireGuard is BaseGuard, Ownable {
    IRiskRegistry public riskRegistry;
    bool public frozen;

    event RiskRegistryUpdated(address indexed riskRegistry);
    event GuardFrozen(address indexed by);
    event GuardUnfrozen(address indexed by);

    error GuardIsFrozen();
    error AwaitingRiskScore(bytes32 txHash);
    error BlockedHighRisk(bytes32 txHash, uint8 score);
    error InCoolingOffWindow(bytes32 txHash, uint256 releaseAt);

    constructor(address _owner, address _riskRegistry) Ownable(_owner) {
        riskRegistry = IRiskRegistry(_riskRegistry);
        emit RiskRegistryUpdated(_riskRegistry);
    }

    function setRiskRegistry(address _riskRegistry) external onlyOwner {
        riskRegistry = IRiskRegistry(_riskRegistry);
        emit RiskRegistryUpdated(_riskRegistry);
    }

    /// @notice Emergency circuit breaker: blocks every outgoing transaction
    /// from the Safe regardless of any recorded verdict.
    function freeze() external onlyOwner {
        frozen = true;
        emit GuardFrozen(msg.sender);
    }

    function unfreeze() external onlyOwner {
        frozen = false;
        emit GuardUnfrozen(msg.sender);
    }

    /// @dev Matches the exact hashing scheme the off-chain risk engine and
    /// the RiskRegistry both key their verdicts by.
    function txHashOf(address to, uint256 value, bytes memory data, Enum.Operation operation)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(to, value, data, operation));
    }

    function checkTransaction(
        address to,
        uint256 value,
        bytes memory data,
        Enum.Operation operation,
        uint256, /* safeTxGas */
        uint256, /* baseGas */
        uint256, /* gasPrice */
        address, /* gasToken */
        address payable, /* refundReceiver */
        bytes memory, /* signatures */
        address /* msgSender */
    ) external view override {
        if (frozen) revert GuardIsFrozen();

        bytes32 txHash = txHashOf(to, value, data, operation);
        IRiskRegistry.Verdict memory v = riskRegistry.verdictOf(txHash);

        if (v.status == IRiskRegistry.Status.UNSCORED) revert AwaitingRiskScore(txHash);
        if (v.status == IRiskRegistry.Status.FROZEN) revert GuardIsFrozen();
        if (v.status == IRiskRegistry.Status.HIGH_RISK) revert BlockedHighRisk(txHash, v.score);
        if (v.status == IRiskRegistry.Status.DELAYED && block.timestamp < v.releaseAt) {
            revert InCoolingOffWindow(txHash, v.releaseAt);
        }
        // Status.LOW_RISK, or Status.DELAYED past its releaseAt: allowed through.
        // Per-tx/velocity limit enforcement lands in issue #2.
    }

    function checkAfterExecution(bytes32, /* txHash */ bool /* success */ ) external pure override {
        // Nothing to do post-execution yet. Reserved for future use (e.g.
        // recording actual executed value for the rolling velocity limit
        // in issue #2, once that lands).
    }
}
