/**
 * The actual runnable entrypoint for the risk orchestrator HTTP server
 * (issue #45/#102). orchestratorHttp.ts only exports a factory
 * (`createOrchestratorHttpServer`) - it never calls `.listen()` or
 * constructs a real `RiskOrchestrator`, so `tsx src/orchestratorHttp.ts`
 * on its own imports the module and exits immediately without ever
 * binding a port. This file is what `npm run orchestrator` actually
 * starts.
 *
 * Wires the real production relayer (relayer.ts + riskRegistryClient.ts -
 * the same modules #13's pipeline uses), not a mock, so a verdict posted
 * here is genuinely written to RiskRegistry on-chain.
 *
 * Env (see backend/.env.example):
 *   RPC_URL, RISK_REGISTRY_ADDRESS, RELAYER_PRIVATE_KEY, CHAIN_ID (default 31337)
 *   ORCHESTRATOR_PORT (default 3001)
 */
import "dotenv/config"

import { defineChain } from "viem"

import { createOrchestratorHttpServer } from "./orchestratorHttp.js"
import { VerdictRelayer } from "./relayer.js"
import { createRiskRegistryClient } from "./riskRegistryClient.js"
import { type RelayerSlot, RiskOrchestrator, createMemoryStateStore } from "./riskOrchestrator.js"

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required env var: ${name}`)
  return value
}

const rpcUrl = process.env.RPC_URL ?? "http://127.0.0.1:8545"
const riskRegistryAddress = requireEnv("RISK_REGISTRY_ADDRESS") as `0x${string}`
const relayerPrivateKey = requireEnv("RELAYER_PRIVATE_KEY") as `0x${string}`
const chainId = Number(process.env.CHAIN_ID ?? 31337)
const port = Number(process.env.ORCHESTRATOR_PORT ?? 3001)

const chain = defineChain({
  id: chainId,
  name: `chain-${chainId}`,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
})

const registryClient = createRiskRegistryClient({ chain, rpcUrl, contractAddress: riskRegistryAddress, relayerPrivateKey })
const verdictRelayer = new VerdictRelayer(registryClient)

// Adapts VerdictRelayer's (txHash, RuleEngineResult) -> OnChainVerdict shape
// to the orchestrator's fire-and-forget RelayerSlot interface.
const relayerSlot: RelayerSlot = {
  async submit(txHash, verdict) {
    await verdictRelayer.submitFast(txHash as `0x${string}`, verdict)
  },
}

const orchestrator = RiskOrchestrator.create({
  relayer: relayerSlot,
  store: createMemoryStateStore(),
  onError: (err) => console.error("[orchestrator]", err),
})

const server = createOrchestratorHttpServer(orchestrator)
server.listen(port, () => {
  console.log(`[orchestrator] listening on http://localhost:${port} (RiskRegistry ${riskRegistryAddress} on chain ${chainId})`)
})
