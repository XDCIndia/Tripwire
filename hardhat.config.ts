import * as dotenv from "dotenv"
import { HardhatUserConfig } from "hardhat/types"

import "@nomicfoundation/hardhat-toolbox"
import "hardhat-gas-reporter"
import "solidity-coverage"
import "hardhat-deploy"

dotenv.config()

const config: HardhatUserConfig = {
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
}

export default config
