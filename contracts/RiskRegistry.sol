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

    event VerdictSubmitted(bytes32 indexed txHash, Status status, uint8 score, uint256 releaseAt);
    event RelayerUpdated(address indexed relayer);

    error NotRelayer(address caller);

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
        relayer = _relayer;
        emit RelayerUpdated(_relayer);
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
