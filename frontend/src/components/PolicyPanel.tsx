import { useState, type FormEvent } from "react"
import { formatEther, parseEther } from "viem"
import { useAccount, useReadContract, useWaitForTransactionReceipt, useWriteContract } from "wagmi"

import { activeChain, deployment } from "../config.js"
import { GUARD_ABI } from "../guardAbi.js"
import { RISK_REGISTRY_ABI } from "../riskRegistryAbi.js"
import { NotConfigured } from "./NotConfigured.js"

// Positive decimal amount ("0.5", "100", "1.25") or empty (meaning 0).
const AMOUNT_RE = /^\d*\.?\d*$/

function shortHash(hash: `0x${string}`): string {
  return `${hash.slice(0, 10)}…${hash.slice(-6)}`
}

function errorText(error: Error | null): string | null {
  if (!error) return null
  return (error as { shortMessage?: string }).shortMessage ?? error.message
}

function weiFromEthInput(value: string): bigint {
  const trimmed = value.trim()
  if (trimmed === "") return 0n
  return parseEther(trimmed)
}

function minutesFromInput(value: string): bigint {
  const trimmed = value.trim()
  if (trimmed === "") return 0n
  return BigInt(Math.round(Number(trimmed) * 60))
}

function formatMinutes(seconds: bigint): string {
  const minutes = Number(seconds) / 60
  return Number.isInteger(minutes) ? String(minutes) : minutes.toFixed(1)
}

function TxStatus({
  hash,
  isConfirming,
  isConfirmed,
  error,
}: {
  hash: `0x${string}` | undefined
  isConfirming: boolean
  isConfirmed: boolean
  error: Error | null
}) {
  const explorer = activeChain.blockExplorers?.default.url
  const message = errorText(error)
  if (!hash && !message) return null
  return (
    <p className="tx-status">
      {hash &&
        (explorer ? (
          <a href={`${explorer}/tx/${hash}`} target="_blank" rel="noreferrer">
            {shortHash(hash)}
          </a>
        ) : (
          <span className="mono">{shortHash(hash)}</span>
        ))}
      {hash && ` — ${isConfirming ? "confirming…" : isConfirmed ? "confirmed on-chain" : "pending"}`}
      {message && <span className="error"> {message}</span>}
    </p>
  )
}

function useGuardRead<T>(
  functionName: "owner" | "freezeAuthority" | "frozen" | "perTxLimit" | "rollingLimit",
) {
  const { guardAddress } = deployment
  return useReadContract({
    address: guardAddress,
    abi: GUARD_ABI,
    functionName,
    chainId: activeChain.id,
    // Poll so the panel reflects its own confirmed transactions.
    query: { enabled: Boolean(guardAddress), refetchInterval: 3000 },
  }) as { data: T | undefined; isLoading: boolean }
}

function useRegistryRead<T>(functionName: "defaultDelayWindow") {
  const { riskRegistryAddress } = deployment
  return useReadContract({
    address: riskRegistryAddress,
    abi: RISK_REGISTRY_ABI,
    functionName,
    chainId: activeChain.id,
    query: { enabled: Boolean(riskRegistryAddress), refetchInterval: 3000 },
  }) as { data: T | undefined; isLoading: boolean }
}

export function PolicyPanel() {
  const { address, isConnected } = useAccount()
  const { guardAddress, riskRegistryAddress } = deployment

  const owner = useGuardRead<`0x${string}`>("owner")
  const freezeAuthority = useGuardRead<`0x${string}`>("freezeAuthority")
  const frozen = useGuardRead<boolean>("frozen")
  const perTxLimit = useGuardRead<bigint>("perTxLimit")
  const rollingLimit = useGuardRead<bigint>("rollingLimit")
  const delayWindow = useRegistryRead<bigint>("defaultDelayWindow")

  // Form state: null means "not edited yet", so the field shows the current
  // on-chain value (once the read lands) and an owner's edits are never
  // clobbered by a refetch.
  const [perTx, setPerTx] = useState<string | null>(null)
  const [rolling, setRolling] = useState<string | null>(null)
  const [delayMin, setDelayMin] = useState<string | null>(null)
  const perTxValue = perTx ?? (perTxLimit.data !== undefined ? formatEther(perTxLimit.data) : "")
  const rollingValue = rolling ?? (rollingLimit.data !== undefined ? formatEther(rollingLimit.data) : "")
  const delayMinValue = delayMin ?? (delayWindow.data !== undefined ? formatMinutes(delayWindow.data) : "")

  const {
    writeContract: writeLimits,
    isPending: limitsPending,
    data: limitsHash,
    error: limitsError,
    reset: resetLimits,
  } = useWriteContract()
  const {
    isLoading: limitsConfirming,
    isSuccess: limitsConfirmed,
    error: limitsReceiptError,
  } = useWaitForTransactionReceipt({ hash: limitsHash })
  const {
    writeContract: writeDelay,
    isPending: delayPending,
    data: delayHash,
    error: delayError,
    reset: resetDelay,
  } = useWriteContract()
  const {
    isLoading: delayConfirming,
    isSuccess: delayConfirmed,
    error: delayReceiptError,
  } = useWaitForTransactionReceipt({ hash: delayHash })
  const {
    writeContract: writeFreeze,
    isPending: freezePending,
    data: freezeHash,
    error: freezeError,
    reset: resetFreeze,
  } = useWriteContract()
  const {
    isLoading: freezeConfirming,
    isSuccess: freezeConfirmed,
    error: freezeReceiptError,
  } = useWaitForTransactionReceipt({ hash: freezeHash })
  const {
    writeContract: writeUnfreeze,
    isPending: unfreezePending,
    data: unfreezeHash,
    error: unfreezeError,
    reset: resetUnfreeze,
  } = useWriteContract()
  const {
    isLoading: unfreezeConfirming,
    isSuccess: unfreezeConfirmed,
    error: unfreezeReceiptError,
  } = useWaitForTransactionReceipt({ hash: unfreezeHash })

  const isOwner =
    isConnected &&
    address !== undefined &&
    owner.data !== undefined &&
    address.toLowerCase() === owner.data.toLowerCase()
  const canFreeze =
    isConnected &&
    address !== undefined &&
    (isOwner ||
      (freezeAuthority.data !== undefined && address.toLowerCase() === freezeAuthority.data.toLowerCase()))

  const perTxValid = AMOUNT_RE.test(perTxValue.trim())
  const rollingValid = AMOUNT_RE.test(rollingValue.trim())
  const delayValid = AMOUNT_RE.test(delayMinValue.trim())

  function submitLimits(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!guardAddress || !perTxValid || !rollingValid) return
    resetLimits()
    writeLimits({
      address: guardAddress,
      abi: GUARD_ABI,
      functionName: "setLimits",
      args: [weiFromEthInput(perTxValue), weiFromEthInput(rollingValue)],
      chainId: activeChain.id,
    })
  }

  function submitDelay(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!riskRegistryAddress || !delayValid) return
    resetDelay()
    writeDelay({
      address: riskRegistryAddress,
      abi: RISK_REGISTRY_ABI,
      functionName: "setDefaultDelayWindow",
      args: [minutesFromInput(delayMinValue)],
      chainId: activeChain.id,
    })
  }

  function tripFreeze() {
    if (!guardAddress || !canFreeze) return
    resetFreeze()
    writeFreeze({ address: guardAddress, abi: GUARD_ABI, functionName: "freeze", args: [], chainId: activeChain.id })
  }

  function liftFreeze() {
    if (!guardAddress || !isOwner) return
    resetUnfreeze()
    writeUnfreeze({
      address: guardAddress,
      abi: GUARD_ABI,
      functionName: "unfreeze",
      args: [],
      chainId: activeChain.id,
    })
  }

  return (
    <section className="card">
      <h2>Policy controls</h2>
      {!guardAddress ? (
        <NotConfigured label="The TripwireGuard" envVar="VITE_GUARD_ADDRESS" />
      ) : (
        <div className="policy">
          {!isConnected ? (
            <p className="hint">Connect the Guard owner's wallet to view and change policy.</p>
          ) : owner.isLoading ? (
            <p className="hint">Loading Guard owner…</p>
          ) : !isOwner ? (
            <p className="hint">Only the Guard owner can change policy — this wallet isn't the owner.</p>
          ) : null}

          {isOwner && (
            <>
              <form className="policy-form" onSubmit={submitLimits}>
                <label>
                  Per-tx limit (ETH)
                  <input
                    value={perTxValue}
                    onChange={(e) => setPerTx(e.target.value)}
                    inputMode="decimal"
                    placeholder="0 disables"
                  />
                </label>
                <label>
                  Rolling 24h limit (ETH)
                  <input
                    value={rollingValue}
                    onChange={(e) => setRolling(e.target.value)}
                    inputMode="decimal"
                    placeholder="0 disables"
                  />
                </label>
                <p className="hint">A limit of 0 disables that check on-chain.</p>
                <button type="submit" disabled={limitsPending || limitsConfirming || !perTxValid || !rollingValid}>
                  {limitsPending ? "Signing…" : limitsConfirming ? "Confirming…" : "Save limits"}
                </button>
                <TxStatus
                  hash={limitsHash}
                  isConfirming={limitsConfirming}
                  isConfirmed={limitsConfirmed}
                  error={limitsError ?? limitsReceiptError}
                />
              </form>

              {riskRegistryAddress ? (
                <form className="policy-form" onSubmit={submitDelay}>
                  <label>
                    Delay window (minutes)
                    <input
                      value={delayMinValue}
                      onChange={(e) => setDelayMin(e.target.value)}
                      inputMode="decimal"
                      placeholder="0 = relayer default"
                    />
                  </label>
                  <p className="hint">
                    Delay length the relayer applies when it writes a DELAYED verdict (releaseAt = now + window).{" "}
                    {delayWindow.data === undefined
                      ? "Loading current value…"
                      : `Current: ${formatMinutes(delayWindow.data)} min — 0 means the relayer's default (10 min).`}
                  </p>
                  <button type="submit" disabled={delayPending || delayConfirming || !delayValid}>
                    {delayPending ? "Signing…" : delayConfirming ? "Confirming…" : "Save delay window"}
                  </button>
                  <TxStatus
                    hash={delayHash}
                    isConfirming={delayConfirming}
                    isConfirmed={delayConfirmed}
                    error={delayError ?? delayReceiptError}
                  />
                </form>
              ) : (
                <p className="hint">
                  The delay window lives on the RiskRegistry — set <code>VITE_RISK_REGISTRY_ADDRESS</code> to edit it.
                </p>
              )}

              <div className="freeze-row">
                <div className="freeze-info">
                  <strong>Circuit breaker</strong>
                  <p className="hint">
                    {frozen.data === undefined
                      ? "Loading…"
                      : frozen.data
                        ? "Frozen — every Safe transaction is blocked until the owner unfreezes."
                        : "Active — the Guard is enforcing as configured."}
                  </p>
                </div>
                {frozen.data ? (
                  <>
                    <button
                      type="button"
                      className="danger"
                      onClick={liftFreeze}
                      disabled={unfreezePending || unfreezeConfirming}
                    >
                      {unfreezePending ? "Signing…" : unfreezeConfirming ? "Confirming…" : "Unfreeze"}
                    </button>
                    <TxStatus
                      hash={unfreezeHash}
                      isConfirming={unfreezeConfirming}
                      isConfirmed={unfreezeConfirmed}
                      error={unfreezeError ?? unfreezeReceiptError}
                    />
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      className="danger"
                      onClick={tripFreeze}
                      disabled={freezePending || freezeConfirming || !canFreeze}
                    >
                      {freezePending ? "Signing…" : freezeConfirming ? "Confirming…" : "Freeze"}
                    </button>
                    <TxStatus
                      hash={freezeHash}
                      isConfirming={freezeConfirming}
                      isConfirmed={freezeConfirmed}
                      error={freezeError ?? freezeReceiptError}
                    />
                  </>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </section>
  )
}