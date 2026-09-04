import { type ForkClient, type SimulateTxInput, type SimulationDiff, simulateTransaction } from "./simulate.js"

/**
 * Turns a raw `SimulationDiff` into the boolean risk signals the rule
 * engine consumes (issue #44: "feed simulation results into the risk
 * engine"). The interesting cases are the ones where the simulation
 * contradicts the calldata's face value - this module does that
 * comparison so the rule engine stays a pure combiner.
 *
 * The fail-safe contract (issue #44 acceptance criterion): a simulation
 * that could not run must NEVER smooth over into "looks fine". When the
 * fork is unreachable or errors mid-flight, `simulateSafely` returns
 * `simulationFailed: true`, which the rule engine scores as elevated
 * risk. Automatic approval is unreachable through a failed simulation.
 */

export interface SimulationSignals {
  /** The fork client threw - no ground truth was obtained. Elevated risk, never "clean". */
  simulationFailed: boolean
  /** The inner call reverted on the fork: the calldata doesn't do what it claims. */
  callReverted: boolean
  /** Native balance dropped by MORE than the transaction's stated value - a hidden outflow. */
  hiddenNativeOutflow: boolean
  /** An allowance grew on a token:spender pair the calldata never mentions - a concealed permission. */
  unexpectedAllowanceIncrease: boolean
  /** A watched NFT left the wallet during simulation - an asset transfer hidden in benign-looking calldata. */
  ownershipTransferDetected: boolean
}

export const NO_SIMULATION_SIGNALS: SimulationSignals = {
  simulationFailed: false,
  callReverted: false,
  hiddenNativeOutflow: false,
  unexpectedAllowanceIncrease: false,
  ownershipTransferDetected: false,
}

const SELECTOR_APPROVE = "0x095ea7b3" // approve(address,uint256)
const SELECTOR_SET_APPROVAL_FOR_ALL = "0xa22cb465" // setApprovalForAll(address,bool)

/** The `index`-th 32-byte ABI word after the 4-byte selector, lowercased. */
function wordAt(data: string, index: number): string {
  const start = 10 + index * 64
  return data.slice(start, start + 64).toLowerCase()
}

function selectorOf(data: string): string {
  return data.slice(0, 10).toLowerCase()
}

/**
 * Compares the simulation's ground truth against what the calldata claims,
 * plus the wallet's watched assets. Pure and synchronous - all chain I/O
 * already happened inside `simulateTransaction`.
 */
export function analyzeSimulation(
  input: Pick<SimulateTxInput, "from" | "to" | "value" | "data">,
  diff: SimulationDiff,
): SimulationSignals {
  const signals: SimulationSignals = { ...NO_SIMULATION_SIGNALS }

  signals.callReverted = !diff.success
  signals.hiddenNativeOutflow = diff.balanceBefore - diff.balanceAfter > input.value

  // An allowance increase is "expected" only when the calldata itself is an
  // approve/setApprovalForAll targeting exactly that token (`to`) and that
  // spender (word 0). Anything else - an allowance appearing on a different
  // token, a different spender, or inside transfer-like calldata - is the
  // concealed-permission pattern issue #44's example calls out.
  const selector = selectorOf(input.data)
  const claimsToken = selector === SELECTOR_APPROVE || selector === SELECTOR_SET_APPROVAL_FOR_ALL
  const claimedSpender = claimsToken ? wordAt(input.data, 0).slice(24) : undefined

  signals.unexpectedAllowanceIncrease = diff.newAllowances.some((change) => {
    if (change.after <= change.before) return false // decreases are revocations, not drainer grants
    const token = change.token.toLowerCase()
    const spender = change.spender.toLowerCase().slice(2) // strip 0x to match the word's last 40 hex chars
    return !(claimsToken && token === input.to.toLowerCase() && claimedSpender === spender)
  })

  signals.ownershipTransferDetected = diff.ownershipChanges.some(
    (change) => change.ownerBefore.toLowerCase() === input.from.toLowerCase(),
  )

  return signals
}

export interface SafeSimulationResult {
  /** The raw diff, or undefined when the fork call failed. */
  diff: SimulationDiff | undefined
  /** Always present - `simulationFailed: true` when `diff` is undefined. */
  signals: SimulationSignals
}

/**
 * `simulateTransaction` that honors issue #44's fail-safe: the fork
 * throwing resolves to `{ diff: undefined, signals: { simulationFailed: true } }`
 * instead of rejecting. The pipeline can then score conservatively
 * ("couldn't verify - treat as elevated") and structurally cannot take a
 * simulation failure as evidence of safety.
 */
export async function simulateSafely(client: ForkClient, input: SimulateTxInput): Promise<SafeSimulationResult> {
  try {
    const diff = await simulateTransaction(client, input)
    return { diff, signals: analyzeSimulation(input, diff) }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    console.warn(`[simulate] fork simulation failed (${reason}) - scoring as unverified, never as safe`)
    return { diff: undefined, signals: { ...NO_SIMULATION_SIGNALS, simulationFailed: true } }
  }
}
