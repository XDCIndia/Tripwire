/**
 * End-to-end proof of the enforcement path:
 *
 *   propose -> risk engine -> VerdictRelayer -> RiskRegistry (on-chain)
 *           -> TripwireGuard.checkTransaction -> allow / delay / block
 *
 *   LOCAL_E2E=true npx hardhat node                              # terminal 1
 *   npx hardhat run scripts/localDeploy.ts --network localhost   # terminal 2
 *   cd backend && npm run orchestrator                           # terminal 3
 *   cd backend && npm run e2e:enforcement                        # terminal 4
 *
 * For each case it reads the registry before and after, then calls the Guard
 * itself — impersonating the Safe, since checkTransaction is onlyAvatar — and
 * records whether the call passed or which error it reverted with. Reading the
 * registry proves the verdict landed; calling the Guard proves the verdict is
 * acted on.
 *
 * A note on the high-risk case. `RiskOrchestrator.process()` currently hardcodes
 * the contextual inputs (first-seen counterparty, contract reputation, p95) to
 * their neutral values, and only one selector matches any given calldata, so the
 * highest score reachable through POST /tx/propose today is 45 — medium. The
 * HIGH_RISK path is therefore exercised through the same VerdictRelayer the
 * orchestrator uses, with a verdict the rule engine would produce given those
 * signals. Same relayer, same registry, same Guard; only the score's origin
 * differs, and that is called out in the output rather than glossed.
 */
import { readFileSync } from "node:fs"

import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  http,
  keccak256,
  parseAbi,
  encodeFunctionData,
} from "viem"

import { VerdictRelayer } from "../src/relayer.js"
import { createRiskRegistryClient } from "../src/riskRegistryClient.js"

const ORCHESTRATOR = process.env.ORCHESTRATOR_URL ?? "http://localhost:3001"
const DEPLOYMENT = process.env.LOCAL_DEPLOYMENT_PATH ?? "../local-deployment.json"

const REGISTRY_ABI = parseAbi([
  "function verdictOf(bytes32 txHash) view returns ((uint8 status, uint8 score, uint256 releaseAt))",
])
const GUARD_ABI = parseAbi([
  "function checkTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures, address msgSender)",
  "function setLimits(uint256 perTxLimit, uint256 rollingLimit)",
  "function perTxLimit() view returns (uint256)",
])
const STATUS = ["UNSCORED", "LOW_RISK", "DELAYED", "HIGH_RISK", "FROZEN"] as const

const pad = (hex: string) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0")

const deployment = JSON.parse(readFileSync(DEPLOYMENT, "utf8")) as Record<string, string>
const chain = defineChain({
  id: Number(deployment.chainId),
  name: "local",
  nativeCurrency: { name: "Native", symbol: "NATIVE", decimals: 18 },
  rpcUrls: { default: { http: [deployment.rpcUrl] } },
})
const pub = createPublicClient({ chain, transport: http(deployment.rpcUrl) })
const registry = deployment.riskRegistryAddress as `0x${string}`
const guard = deployment.guardAddress as `0x${string}`
const safe = deployment.safeAddress as `0x${string}`

/** The exact hash TripwireGuard.txHashOf(to, value, data, operation) computes. */
function guardTxHash(to: `0x${string}`, value: bigint, data: `0x${string}`): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }, { type: "bytes" }, { type: "uint8" }],
      [to, value, data, 0],
    ),
  )
}

const readVerdict = (txHash: `0x${string}`) =>
  pub.readContract({ address: registry, abi: REGISTRY_ABI, functionName: "verdictOf", args: [txHash] })

/** Raw JSON-RPC, for the hardhat-only impersonation helpers. */
async function rpc(method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(deployment.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  })
  const body = (await res.json()) as { result?: unknown; error?: { message: string } }
  if (body.error) throw new Error(`${method}: ${body.error.message}`)
  return body.result
}

/**
 * The Guard's custom errors, by selector.
 *
 * These have to be decoded by hand rather than caught, because the demo chain
 * runs with LOCAL_E2E=true, which sets `throwOnCallFailures: false` in
 * hardhat.config.ts. Under that flag a reverting eth_call returns its revert
 * data as a *successful* result, so `try/catch` sees no error and a blocked
 * transaction looks allowed. Decoding the returned selector is the only
 * reading that is correct under both settings.
 */
const GUARD_ERRORS: Record<string, string> = {
  "0xb5fb6d61": "GuardIsFrozen",
  "0xbb2b5298": "AwaitingRiskScore",
  "0xaaa3a274": "BlockedHighRisk",
  "0xd031fbca": "InCoolingOffWindow",
  "0xbbad257c": "PerTxLimitExceeded",
  "0x87a448f5": "RollingLimitExceeded",
  "0x4e2faa53": "NotAvatar",
}

/**
 * Asks the Guard what it would do, exactly as the Safe would ask. Calls rather
 * than sends: we want the decision, not a state change. `from` is the Safe
 * because checkTransaction is onlyAvatar.
 */
async function askGuard(
  to: `0x${string}`,
  value: bigint,
  data: `0x${string}`,
): Promise<{ allowed: boolean; error?: string }> {
  const calldata = encodeFunctionData({
    abi: GUARD_ABI,
    functionName: "checkTransaction",
    args: [to, value, data, 0, 0n, 0n, 0n, `0x${"0".repeat(40)}`, `0x${"0".repeat(40)}`, "0x", safe],
  })
  const result = (await rpc("eth_call", [{ from: safe, to: guard, data: calldata }, "latest"])) as string

  // checkTransaction returns nothing, so any returned data is revert data.
  if (!result || result === "0x") return { allowed: true }
  const selector = result.slice(0, 10)
  return { allowed: false, error: GUARD_ERRORS[selector] ?? `unknown revert ${selector}` }
}

interface Result {
  name: string
  pass: boolean
  detail: string
}

const results: Result[] = []

function record(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail })
  console.log(`   ${pass ? "PASS" : "FAIL"} — ${detail}\n`)
}

async function throughApi(
  name: string,
  to: `0x${string}`,
  value: bigint,
  data: `0x${string}`,
  expectStatus: (typeof STATUS)[number],
  expectGuard: string,
): Promise<void> {
  const txHash = guardTxHash(to, value, data)
  console.log(`── ${name}`)
  console.log(`   txHash  ${txHash}`)

  const before = await readVerdict(txHash)
  console.log(`   before  registry: ${STATUS[Number(before.status)]}`)

  const guardBefore = await askGuard(to, value, data)
  console.log(`   before  guard   : ${guardBefore.allowed ? "allowed" : guardBefore.error}`)

  const res = await fetch(`${ORCHESTRATOR}/tx/propose`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ txHash, to, value: value.toString(), data }),
  })
  console.log(`   propose : HTTP ${res.status}`)

  let state: { status?: string; canonical?: { score?: number; status?: string; action?: string }; history?: { note?: string }[] } = {}
  for (let i = 0; i < 60; i++) {
    state = (await (await fetch(`${ORCHESTRATOR}/tx/${txHash}/status`)).json()) as typeof state
    if (state.status === "submitted" || state.status === "submission_failed") break
    await new Promise((r) => setTimeout(r, 500))
  }
  console.log(`   engine  : ${state.canonical?.status} score ${state.canonical?.score} -> ${state.canonical?.action} (${state.status})`)
  if (state.status === "submission_failed") console.log(`   RELAYER ERROR: ${state.history?.at(-1)?.note}`)

  const after = await readVerdict(txHash)
  const onChain = STATUS[Number(after.status)]
  console.log(`   after   registry: ${onChain} score ${Number(after.score)} releaseAt ${Number(after.releaseAt)}`)

  const guardAfter = await askGuard(to, value, data)
  const guardSays = guardAfter.allowed ? "allowed" : guardAfter.error!
  console.log(`   after   guard   : ${guardSays}`)

  const ok =
    onChain === expectStatus &&
    Number(after.score) === state.canonical?.score &&
    guardSays === expectGuard
  record(name, ok, `registry ${onChain} (want ${expectStatus}), guard ${guardSays} (want ${expectGuard})`)
}

async function main(): Promise<void> {
  console.log(`RiskRegistry ${registry}`)
  console.log(`TripwireGuard ${guard}`)
  console.log(`Safe ${safe} on ${deployment.rpcUrl}\n`)

  // ---- 1. LOW RISK -> ALLOW
  await throughApi(
    "low risk -> ALLOW",
    `0x${"11".repeat(20)}`,
    0n,
    "0x",
    "LOW_RISK",
    "allowed",
  )

  // ---- 2. MEDIUM RISK -> DELAY
  await throughApi(
    "medium risk (setApprovalForAll) -> DELAY",
    `0x${"22".repeat(20)}`,
    0n,
    `0xa22cb465${pad("0x" + "ab".repeat(20))}${pad("0x1")}`,
    "DELAYED",
    "InCoolingOffWindow",
  )

  // ---- 3. HIGH RISK -> BLOCK, through the same relayer.
  console.log("── high risk -> BLOCK")
  console.log("   NOTE: score reachable via POST /tx/propose caps at 45, because")
  console.log("         process() hardcodes the contextual signals. Driving the")
  console.log("         same VerdictRelayer directly instead.")
  const hTo = `0x${"33".repeat(20)}` as `0x${string}`
  const hData = `0xa22cb465${pad("0x" + "cd".repeat(20))}${pad("0x1")}` as `0x${string}`
  const hHash = guardTxHash(hTo, 0n, hData)
  console.log(`   txHash  ${hHash}`)
  console.log(`   before  registry: ${STATUS[Number((await readVerdict(hHash)).status)]}`)

  const relayer = new VerdictRelayer(
    createRiskRegistryClient({
      chain,
      rpcUrl: deployment.rpcUrl,
      contractAddress: registry,
      relayerPrivateKey: deployment.relayerPrivateKey as `0x${string}`,
    }),
  )
  const submitted = await relayer.submitFinal(
    hHash,
    {
      score: 90,
      label: "high_risk",
      matchedSignals: [
        "setApprovalForAll: grants blanket control over an entire NFT collection",
        "counterparty is flagged as malicious by the GoPlus Security blacklist",
      ],
    },
    undefined,
  )
  console.log(`   relayer : submitted status ${submitted.status} score ${submitted.score}`)

  const hAfter = await readVerdict(hHash)
  const hStatus = STATUS[Number(hAfter.status)]
  console.log(`   after   registry: ${hStatus} score ${Number(hAfter.score)}`)
  const hGuard = await askGuard(hTo, 0n, hData)
  const hSays = hGuard.allowed ? "allowed" : hGuard.error!
  console.log(`   after   guard   : ${hSays}`)
  record(
    "high risk -> BLOCK",
    hStatus === "HIGH_RISK" && Number(hAfter.score) === 90 && hSays === "BlockedHighRisk",
    `registry ${hStatus} score ${Number(hAfter.score)}, guard ${hSays} (want BlockedHighRisk)`,
  )

  // ---- 4. Spending limit, independent of any verdict.
  console.log("── spending limit, with a LOW_RISK verdict already recorded")
  const lTo = `0x${"44".repeat(20)}` as `0x${string}`
  const lValue = 5n * 10n ** 18n
  const lHash = guardTxHash(lTo, lValue, "0x")
  await relayer.submitFinal(lHash, { score: 0, label: "low_risk", matchedSignals: [] }, undefined)
  console.log(`   registry: ${STATUS[Number((await readVerdict(lHash)).status)]} (cleared by the risk engine)`)

  const allowedBefore = await askGuard(lTo, lValue, "0x")
  console.log(`   guard, no limit set     : ${allowedBefore.allowed ? "allowed" : allowedBefore.error}`)

  // Set a per-tx limit below the value, as the Guard owner.
  const owner = deployment.ownerAddress as `0x${string}`
  await rpc("hardhat_impersonateAccount", [owner])
  await rpc("hardhat_setBalance", [owner, "0x56BC75E2D63100000"])
  const ownerWallet = createWalletClient({ account: owner, chain, transport: http(deployment.rpcUrl) })
  const setHash = await ownerWallet.writeContract({
    address: guard,
    abi: GUARD_ABI,
    functionName: "setLimits",
    args: [1n * 10n ** 18n, 0n],
  })
  await pub.waitForTransactionReceipt({ hash: setHash })
  await rpc("hardhat_stopImpersonatingAccount", [owner])
  console.log(`   perTxLimit now          : ${await pub.readContract({ address: guard, abi: GUARD_ABI, functionName: "perTxLimit" })}`)

  const blockedAfter = await askGuard(lTo, lValue, "0x")
  const lSays = blockedAfter.allowed ? "allowed" : blockedAfter.error!
  console.log(`   guard, limit 1 < value 5: ${lSays}`)
  record(
    "spending limit blocks a LOW_RISK transaction",
    allowedBefore.allowed && lSays === "PerTxLimitExceeded",
    `allowed before limit: ${allowedBefore.allowed}, after: ${lSays} (want PerTxLimitExceeded)`,
  )

  // Restore, so a second run starts from the same place.
  await rpc("hardhat_impersonateAccount", [owner])
  const resetHash = await ownerWallet.writeContract({
    address: guard, abi: GUARD_ABI, functionName: "setLimits", args: [0n, 0n],
  })
  await pub.waitForTransactionReceipt({ hash: resetHash })
  await rpc("hardhat_stopImpersonatingAccount", [owner])

  console.log("─".repeat(64))
  for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}`)
  const failed = results.filter((r) => !r.pass).length
  console.log(failed === 0 ? "\nAll enforcement cases passed." : `\n${failed} case(s) FAILED.`)
  process.exitCode = failed === 0 ? 0 : 1
}

await main()
