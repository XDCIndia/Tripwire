/**
 * Manual demo for the natural-language policy compiler (#39) - not part of
 * the automated suite, but the fastest way to see the whole pipeline on the
 * issue's canonical example:
 *
 *   natural language -> compiled policy -> preview -> guard config ->
 *   per-transaction verdicts (no LLM anywhere past interpretation)
 *
 * Usage:
 *   npx tsx scripts/policyDemo.ts
 *   npx tsx scripts/policyDemo.ts "Freeze transactions above $1,000."
 *
 * USD amounts resolve at the rate given by POLICY_USD_PER_NATIVE (default 1,
 * i.e. the demo treats 1 native token as $1) - see the printed config.
 */
import { compilePolicy, compilePolicyFromJson } from "../src/policyCompiler.js"
import { explainPolicy, evaluatePolicy, resolvePolicy, verdictForEvaluation } from "../src/policyMapper.js"

const USAGE_HINT = "pass a policy as the first argument, or edit the DEFAULT_POLICY constant below"

const DEFAULT_POLICY = `Allow payments below $500 to previously used addresses.
Delay everything else for 1 hour.
Freeze transactions above $10,000.`

const WEI = 10n ** 18n

function main() {
  const policyText = process.argv[2] ?? DEFAULT_POLICY
  const usdPerNative = process.env.POLICY_USD_PER_NATIVE ?? "1"

  console.log("Policy (natural language):")
  console.log(policyText)
  console.log()

  const policy = compilePolicy(policyText)
  console.log("Compiled policy (structured):")
  console.log(JSON.stringify(policy, null, 2))
  console.log()

  console.log("Preview (human-readable):")
  console.log(explainPolicy(policy))
  console.log()

  // Machine/LLM path: an LLM would hand back JSON like this and get it
  // validated identically to natural language - no extra authority, ever.
  const llmDocument = {
    version: 1,
    source: policyText,
    rules: policy.rules.map((rule) => ({
      action: rule.action,
      amount: rule.amount ? { comparison: rule.amount.comparison, value: rule.amount.value, currency: rule.amount.currency } : undefined,
      recipient: rule.recipient,
      delaySeconds: rule.delaySeconds,
      fallback: rule.fallback,
    })),
  }
  const fromJson = compilePolicyFromJson(llmDocument)
  console.log(`Machine/LLM JSON path: accepted and validated (${fromJson.rules.length} rules)`)
  console.log()

  const resolved = resolvePolicy(policy, { usdPerNative })
  const { guardConfig } = resolved
  console.log(`Guard config (rate: 1 native token = $${usdPerNative}):`)
  console.log(`  perTxLimit       = ${guardConfig.perTxLimit} wei (${guardConfig.perTxLimit / WEI} tokens)`)
  console.log(`  rollingLimit     = ${guardConfig.rollingLimit} wei (0 = disabled)`)
  console.log(`  defaultDelay     = ${guardConfig.defaultDelaySeconds ?? "none"} seconds`)
  console.log()

  const samples: Array<{ label: string; value: bigint; recipientKnown: boolean }> = [
    { label: "$300 to a previously used address", value: 300n * WEI, recipientKnown: true },
    { label: "$300 to a brand-new address", value: 300n * WEI, recipientKnown: false },
    { label: "$700 to a previously used address", value: 700n * WEI, recipientKnown: true },
    { label: "$20,000 to anyone", value: 20_000n * WEI, recipientKnown: true },
  ]

  console.log("Enforcement (deterministic - the verdicts the relayer writes):")
  for (const sample of samples) {
    const evaluation = evaluatePolicy(policy, sample, { usdPerNative })
    const verdict = verdictForEvaluation(evaluation)
    const when = evaluation.releaseAt === null ? "" : `, releaseAt=${evaluation.releaseAt}`
    console.log(`  ${sample.label.padEnd(42)} -> ${evaluation.action.padEnd(6)} (status=${verdict.status}, score=${verdict.score}${when})`)
  }
  console.log()
  console.log("No LLM runs during enforcement: the compiled policy decides, and the")
  console.log("Guard fails closed if a transaction was never scored. " + USAGE_HINT + ".")
}

try {
  main()
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  console.error(USAGE_HINT + ".")
  process.exit(1)
}
