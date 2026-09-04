import * as dotenv from "dotenv"
import * as fs from "fs"
import * as path from "path"
import { HardhatUserConfig } from "hardhat/types"

import "@nomicfoundation/hardhat-toolbox"
import "hardhat-gas-reporter"
import "solidity-coverage"
import "hardhat-deploy"

dotenv.config()

// ─── Guard against contracts/lib/ collision (issue #100) ──────────────
// When Foundry submodules are initialized inside contracts/, Hardhat
// tries to compile Foundry-only files (forge-std, openzeppelin test
// helpers, etc.) and fails with HH411. The fix is twofold:
//   1. foundry.toml lives at the ROOT (not in contracts/) so lib/
//      is always at the project root, never inside contracts/.
//   2. This guard detects a misconfigured contracts/lib/ and tells
//      the contributor exactly what to do.
const contractsLib = path.resolve(__dirname, "contracts", "lib")
if (fs.existsSync(contractsLib)) {
  console.error(
    "\n⚠️  contracts/lib/ exists — Foundry submodules are inside the Hardhat sources directory.\n" +
    "   This breaks 'npx hardhat compile'. Move foundry.toml to the project root\n" +
    "   (not inside contracts/) so lib/ lives at the root level instead.\n" +
    "   See: https://github.com/XDCIndia/Tripwire/issues/100\n",
  )
}

const config: HardhatUserConfig = {
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
  solidity: {
    version: "0.8.22",
    settings: {
      // Needed for local end-to-end testing against a real GnosisSafe -
      // it compiles over the 24576-byte contract-size limit without this.
      // Doesn't change contract behavior, only bytecode size/gas tradeoffs.
      optimizer: { enabled: true, runs: 200 },
    },
  },
  networks: {
    hardhat: {
      // Hardhat Network's dev-convenience default rejects a doomed
      // transaction before it's ever mined, instead of mining it with a
      // failed receipt like a real chain (or Anvil) does. That's the
      // opposite of what local end-to-end testing needs (see
      // LOCAL_TESTING.md): TripwireGuard's fail-closed design means a
      // rejected first attempt must still land on-chain for the watcher
      // to see and score it. But the *test suite*'s revert-matcher
      // assertions (`.to.be.revertedWithCustomError`, etc.) rely on the
      // default `true` behavior to detect a revert at all - flipping it
      // globally silently breaks every one of those. So this only flips
      // for `LOCAL_E2E=true npx hardhat node`, never for `npx hardhat test`.
      mining: { auto: true },
      throwOnTransactionFailures: process.env.LOCAL_E2E !== "true",
      throwOnCallFailures: process.env.LOCAL_E2E !== "true",
    },
    sepolia: {
      url: process.env.SEPOLIA_URL || "",
      accounts: process.env.PRIVATE_KEY !== undefined ? [process.env.PRIVATE_KEY] : [],
    },
    apothem: {
      url: "https://rpc.apothem.network",
      chainId: 51,
      accounts: process.env.PRIVATE_KEY !== undefined ? [process.env.PRIVATE_KEY] : [],
    },
  },
  namedAccounts: {
    deployer: 0,
    dependenciesDeployer: 1,
    tester: 2,
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS !== undefined,
    currency: "USD",
  },
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY,
  },
  soliditycoverage: {
    // Prevent solidity-coverage from walking into Foundry's lib/ if it
    // somehow ends up inside contracts/ (issue #100).
    skipFiles: ["lib/"],
  },
}

export default config
