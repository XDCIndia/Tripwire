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

    /// @notice A second address, distinct from the owner, allowed to trip
    /// the freeze switch. Meant for the off-chain risk engine's relayer, so
    /// a critical-score verdict can halt the Safe immediately rather than
    /// waiting on an owner to notice an alert. Deliberately one-directional:
    /// only the owner can unfreeze, so the automated system that can trigger
    /// a freeze can never also be the one that lifts it.
    address public freezeAuthority;

    event RiskRegistryUpdated(address indexed riskRegistry);
    event FreezeAuthorityUpdated(address indexed freezeAuthority);
    event GuardFrozen(address indexed by);
    event GuardUnfrozen(address indexed by);

    error GuardIsFrozen();
    error AwaitingRiskScore(bytes32 txHash);
    error BlockedHighRisk(bytes32 txHash, uint8 score);
    error InCoolingOffWindow(bytes32 txHash, uint256 releaseAt);
    error NotOwnerOrFreezeAuthority(address caller);

    modifier onlyOwnerOrFreezeAuthority() {
        if (msg.sender != owner() && msg.sender != freezeAuthority) {
            revert NotOwnerOrFreezeAuthority(msg.sender);
        }
        _;
    }

    constructor(address _owner, address _riskRegistry, address _freezeAuthority) Ownable(_owner) {
        riskRegistry = IRiskRegistry(_riskRegistry);
        emit RiskRegistryUpdated(_riskRegistry);
        freezeAuthority = _freezeAuthority;
        emit FreezeAuthorityUpdated(_freezeAuthority);
    }

    function setRiskRegistry(address _riskRegistry) external onlyOwner {
        riskRegistry = IRiskRegistry(_riskRegistry);
        emit RiskRegistryUpdated(_riskRegistry);
    }

    function setFreezeAuthority(address _freezeAuthority) external onlyOwner {
        freezeAuthority = _freezeAuthority;
        emit FreezeAuthorityUpdated(_freezeAuthority);
    }

    /// @notice Emergency circuit breaker: blocks every outgoing transaction
    /// from the Safe regardless of any recorded verdict. Callable by the
    /// owner directly, or by the freeze authority (the risk engine relayer)
    /// when a verdict crosses a critical score threshold off-chain.
    function freeze() external onlyOwnerOrFreezeAuthority {
        frozen = true;
        emit GuardFrozen(msg.sender);
    }

    /// @notice Owner-only, deliberately: whoever can trip the breaker should
    /// never be the same party that can silently reset it.
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
