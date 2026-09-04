# Tripwire contracts

Guard + RiskRegistry, plus the Foundry test suite from issue #6.

## Layout

- `TripwireGuard.sol` - Zodiac guard enforcing verdicts (fail-closed),
  per-tx and rolling 24h limits, and the freeze switch.
- `RiskRegistry.sol` - on-chain verdict record, relayer-only writes.
- `interfaces/` - `IRiskRegistry`.
- `MyModule.sol` - starter-kit example module.
- `test/` - Foundry suite + mocks (`TripwireGuard.t.sol` is the issue #6
  end-to-end suite; `SafeImports.sol` is a hardhat-era artifact stub and is
  excluded from the Foundry build - see `foundry.toml`).

## Running the tests

```sh
forge install   # once: pulls lib/ submodules
forge test      # fully local, anvil-backed, no testnet needed
```

Toolchain notes: solc 0.8.28 via IR (`via_ir = true`) - two upstream files
(OZ `P256.sol`, the guard's 13-parameter `checkTransaction` override) hit
Yul stack limits on the legacy pipeline. Post-build linting is off
(`forge lint` still works when touching Solidity); dependency test/example
trees are excluded from compilation because `src = "."` would otherwise
make forge treat every file in `lib/` as a build root.
