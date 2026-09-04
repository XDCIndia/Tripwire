// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.22;

// Hardhat only compiles what's actually reachable from our own contracts.
// This file exists purely so the real Safe singleton + proxy factory get
// compiled and get artifacts, for local end-to-end testing
// (scripts/localDeploy.ts) - deploying a real Safe rather than a mock.
//
// package.json pins @gnosis.pm/safe-contracts to 1.3.0, which still uses
// the GnosisSafe/GnosisSafeProxyFactory names (the Safe/SafeProxyFactory
// rename landed in v1.4.0, upstream, not in what this project has
// installed). scripts/localDeploy.ts, scripts/deployTestnet.ts, and both
// e2e tests all call getContractFactory("GnosisSafe") /
// getContractFactory("GnosisSafeProxyFactory") - importing the v1.4.0
// names here compiles fine on its own but produces artifacts under the
// wrong contract names, breaking every one of those. If this project ever
// upgrades the safe-contracts dependency to 1.4.0+, update this import
// and all four call sites together, not just this file.
import {GnosisSafe} from "@gnosis.pm/safe-contracts/contracts/GnosisSafe.sol";
import {GnosisSafeProxyFactory} from "@gnosis.pm/safe-contracts/contracts/proxies/GnosisSafeProxyFactory.sol";
