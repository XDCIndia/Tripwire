// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.22;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IRiskRegistry} from "./interfaces/IRiskRegistry.sol";

/// @title RiskRegistry
/// @notice On-chain record of risk verdicts, written by the off-chain risk
/// engine (via a single authorized relayer address) and read by
/// TripwireGuard at execution time.
///
/// An unset verdict reads back as `Status.UNSCORED` (the zero value of the
/// enum) purely because of how Solidity mappings default — there is no
/// separate "exists" flag to get wrong, so a transaction the relayer never
/// scored can never be mistaken for one that was scored and approved.
contract RiskRegistry is IRiskRegistry, Ownable, ReentrancyGuard {
    mapping(bytes32 => Verdict) private _verdicts;

    address public relayer;

    /// @notice Owner-configured default cooling-off window (seconds) that the
    /// off-chain relayer applies when it writes a DELAYED verdict, so the
    /// delay length is a policy the owner sets on-chain rather than a
    /// hardcoded backend constant. Stored here (not on the Guard) because a
    /// delay window only binds through the per-verdict `releaseAt` the
    /// relayer persists in its submitVerdict transaction: the Guard reverts
    /// to block and a revert unwinds any state it writes in the same call,
    /// so the Guard can never anchor a window itself. A value of 0 means the
    /// relayer falls back to its own default.
    uint256 public defaultDelayWindow;

    event VerdictSubmitted(bytes32 indexed txHash, Status status, uint8 score, uint256 releaseAt);
    event RelayerUpdated(address indexed relayer);
    event DefaultDelayWindowUpdated(uint256 defaultDelayWindow);

    error NotRelayer(address caller);
    error InvalidZeroAddress();

    modifier onlyRelayer() {
        if (msg.sender != relayer) revert NotRelayer(msg.sender);
        _;
    }

    constructor(address _owner, address _relayer) Ownable(_owner) {
        relayer = _relayer;
        emit RelayerUpdated(_relayer);
    }

    /// @notice Update the authorized relayer that can submit verdicts.
    /// @dev Only callable by the owner. Rejects address(0).
    function setRelayer(address _relayer) external onlyOwner {
        if (_relayer == address(0)) revert InvalidZeroAddress();
        relayer = _relayer;
        emit RelayerUpdated(_relayer);
    }

    /// @notice Owner-only, matching setRelayer: the delay policy is part of
    /// the same on-chain surface the owner manages (the dashboard panel
    /// writes this via a wallet-signed transaction).
    function setDefaultDelayWindow(uint256 _defaultDelayWindow) external onlyOwner {
        defaultDelayWindow = _defaultDelayWindow;
        emit DefaultDelayWindowUpdated(_defaultDelayWindow);
    }

    /// @notice Record a risk verdict for a Safe transaction.
    /// @dev Only callable by the authorized relayer. Overwrites any previous verdict for this txHash.
    ///      Uses a reentrancy guard to prevent concurrent writes from corrupting state.
    function submitVerdict(bytes32 txHash, Verdict calldata v) external override onlyRelayer nonReentrant {
        _verdicts[txHash] = v;
        emit VerdictSubmitted(txHash, v.status, v.score, v.releaseAt);
    }

    /// @notice Read the risk verdict for a Safe transaction.
    /// @dev Returns Status.UNSCORED (zero value) for any hash never submitted.
    function verdictOf(bytes32 txHash) external view override returns (Verdict memory) {
        return _verdicts[txHash];
    }
}
