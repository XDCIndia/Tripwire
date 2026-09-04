import { parseAbi } from "viem"

// Full TripwireGuard.sol surface the dashboard needs. #16's read-only
// skeleton used a subset; #18 adds the owner-write calls (setLimits,
// freeze/unfreeze) so policy changes are real on-chain transactions signed
// by the connected wallet.
export const GUARD_ABI = parseAbi([
  "function owner() view returns (address)",
  "function avatar() view returns (address)",
  "function riskRegistry() view returns (address)",
  "function freezeAuthority() view returns (address)",
  "function frozen() view returns (bool)",
  "function perTxLimit() view returns (uint256)",
  "function rollingLimit() view returns (uint256)",
  "function windowSpent() view returns (uint256)",
  "function setLimits(uint256 perTxLimit, uint256 rollingLimit)",
  "function freeze()",
  "function unfreeze()",
])

// Read-only subset, kept for components that never write.
export const GUARD_READ_ABI = parseAbi([
  "function owner() view returns (address)",
  "function avatar() view returns (address)",
  "function riskRegistry() view returns (address)",
  "function freezeAuthority() view returns (address)",
  "function frozen() view returns (bool)",
  "function perTxLimit() view returns (uint256)",
  "function rollingLimit() view returns (uint256)",
  "function windowSpent() view returns (uint256)",
])

// Write ABI for Guard mutations (#18, #20).
export const GUARD_WRITE_ABI = parseAbi([
  "function setLimits(uint256 _perTxLimit, uint256 _rollingLimit)",
  "function freeze()",
  "function unfreeze()",
])
