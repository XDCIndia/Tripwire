// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.22;

// Hardhat only compiles what's actually reachable from our own contracts.
// This file exists purely so the real Safe singleton + proxy factory get
// compiled and get artifacts, for local end-to-end testing
// (scripts/localDeploy.ts) - deploying a real Safe rather than a mock.
//
// Artifact names follow the Safe rebrand: the contracts are `Safe` and
// `SafeProxyFactory` since safe-contracts v1.4.0 (the GnosisSafe aliases
// were dropped upstream).
import {Safe} from "@gnosis.pm/safe-contracts/contracts/Safe.sol";
import {SafeProxyFactory} from "@gnosis.pm/safe-contracts/contracts/proxies/SafeProxyFactory.sol";
