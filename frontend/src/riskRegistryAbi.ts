import { parseAbi } from "viem"

// The on-chain delay-window surface of RiskRegistry.sol. The backend
// relayer reads `defaultDelayWindow` when it writes DELAYED verdicts
// (releaseAt = now + window), so changing it from the panel is a real
// on-chain policy change that enforcement honors - it is not stored here
// just for display.
export const RISK_REGISTRY_ABI = parseAbi([
  "function defaultDelayWindow() view returns (uint256)",
  "function setDefaultDelayWindow(uint256 defaultDelayWindow)",
])