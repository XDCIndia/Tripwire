/**
 * One-command demo reset.
 *
 *   npm run demo:reset
 *
 * Rehearsing means tearing the whole stack down and redeploying, because every
 * deploy mints fresh contract addresses. Doing that by hand is four commands in
 * a fixed order with a wait in the middle - exactly the kind of sequencing you
 * do not want to be performing live. This does it as one:
 *
 *   1. kill anything holding 8545 / 3001 / 3002 / 3003 / 5173
 *   2. start `LOCAL_E2E=true hardhat node` and wait for it to answer
 *   3. run localDeploy.ts (which also writes frontend/.env)
 *   4. hand off to `npm run dev:all` in the foreground
 *
 * Ctrl+C stops dev:all and the hardhat node together, so a second run starts
 * from a genuinely clean slate rather than colliding with the first.
 *
 * Timings are printed per step: if the demo starts feeling slow, this says
 * which part actually got slower.
 */
import { spawn, spawnSync } from "node:child_process"
import { createWriteStream, mkdirSync } from "node:fs"
import { platform } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const RPC = "http://127.0.0.1:8545"
const PORTS = [8545, 3001, 3002, 3003, 5173]
const NODE_READY_TIMEOUT_MS = 60_000
const IS_WINDOWS = platform() === "win32"

const started = Date.now()
let mark = started

/** Prints the elapsed time for the step that just finished. */
function step(label) {
  const now = Date.now()
  console.log(`  ${label.padEnd(34)} ${((now - mark) / 1000).toFixed(1)}s`)
  mark = now
}

/** Anything still listening on our ports is a leftover from a previous run. */
function killPort(port) {
  if (IS_WINDOWS) {
    const found = spawnSync("netstat", ["-ano"], { encoding: "utf8" })
    const pids = new Set(
      (found.stdout ?? "")
        .split(/\r?\n/)
        .filter((line) => line.includes(`:${port} `) && line.includes("LISTENING"))
        .map((line) => line.trim().split(/\s+/).pop())
        .filter((pid) => pid && pid !== "0"),
    )
    for (const pid of pids) spawnSync("taskkill", ["/F", "/PID", pid], { stdio: "ignore" })
    return pids.size
  }
  const found = spawnSync("lsof", ["-ti", `:${port}`], { encoding: "utf8" })
  const pids = (found.stdout ?? "").split("\n").filter(Boolean)
  for (const pid of pids) spawnSync("kill", ["-9", pid], { stdio: "ignore" })
  return pids.length
}

async function rpcReady() {
  try {
    const res = await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "eth_chainId", id: 1 }),
    })
    return res.ok
  } catch {
    return false
  }
}

function run(command, args, label) {
  const res = spawnSync(command, args, { cwd: ROOT, stdio: "inherit", shell: IS_WINDOWS })
  if (res.status !== 0) {
    console.error(`\n${label} failed (exit ${res.status}). Stopping - the stack is not up.`)
    process.exit(res.status ?? 1)
  }
}

console.log("\nTripwire demo reset\n")

// 1. Clear the ports.
let killed = 0
for (const port of PORTS) killed += killPort(port)
step(`killed ${killed} leftover process(es)`)

// 2. Start the chain. LOCAL_E2E makes it mine failed transactions like a real
//    chain instead of throwing, which is what lets the Guard's revert be seen
//    as a blocked transaction rather than an exception.
mkdirSync(join(ROOT, ".demo"), { recursive: true })
const nodeLog = createWriteStream(join(ROOT, ".demo", "hardhat-node.log"))
const chain = spawn("npx", ["hardhat", "node"], {
  cwd: ROOT,
  env: { ...process.env, LOCAL_E2E: "true" },
  shell: IS_WINDOWS,
  detached: false,
})
chain.stdout.pipe(nodeLog)
chain.stderr.pipe(nodeLog)

const deadline = Date.now() + NODE_READY_TIMEOUT_MS
while (!(await rpcReady())) {
  if (Date.now() > deadline) {
    console.error(`\nhardhat node did not answer on ${RPC} within ${NODE_READY_TIMEOUT_MS / 1000}s.`)
    console.error("See .demo/hardhat-node.log")
    chain.kill()
    process.exit(1)
  }
  await new Promise((r) => setTimeout(r, 250))
}
step("hardhat node ready")

// Take the chain down with us, so a second run is not fighting the first.
const stopChain = () => {
  if (!chain.killed) chain.kill()
}
process.on("exit", stopChain)
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    stopChain()
    process.exit(0)
  })
}

// 3. Deploy. This also writes the addresses into frontend/.env.
run("npx", ["hardhat", "run", "scripts/localDeploy.ts", "--network", "localhost"], "localDeploy")
step("deployed + wrote frontend/.env")

// 4. Hand off. dev:all runs in the foreground so its logs are visible and
//    Ctrl+C tears everything down.
console.log(`\n  ready in ${((Date.now() - started) / 1000).toFixed(1)}s - starting dev:all\n`)
run("npm", ["run", "dev:all"], "dev:all")
