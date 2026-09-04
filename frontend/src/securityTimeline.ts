/**
 * Issue #87: Security Event Timeline with Causal Correlation
 *
 * Correlates every important security event into one chronological chain.
 * Connects: Transaction Detected → Risk Signal → Simulation Result →
 * Verdict → Relayer Action → On-Chain Confirmation.
 */

// ─── Types ───────────────────────────────────────────────────────────

export type EventType =
  | "transaction_detected"
  | "risk_signal"
  | "simulation_result"
  | "verdict"
  | "relayer_action"
  | "onchain_confirmation"
  | "guard_check"
  | "freeze_event"
  | "error"

export type EventSource = "watcher" | "rule_engine" | "simulator" | "relayer" | "onchain" | "guard" | "frontend"

export interface SecurityEvent {
  /** Unique event ID */
  id: string
  /** Event type */
  type: EventType
  /** Source system that produced this event */
  source: EventSource
  /** ISO timestamp */
  timestamp: string
  /** Block number (if available) */
  blockNumber?: number
  /** Transaction hash this event relates to */
  txHash: string
  /** Previous state before this event */
  previousState?: string
  /** New state after this event */
  newState: string
  /** What caused this event */
  cause?: string
  /** Supporting evidence or details */
  evidence?: string
  /** Severity level */
  severity?: "info" | "warning" | "critical"
}

export interface TimelineEntry {
  /** The event */
  event: SecurityEvent
  /** Whether this event caused a state transition */
  stateTransition: boolean
  /** Events that follow from this one (causal chain) */
  children: TimelineEntry[]
}

// ─── Event correlation ───────────────────────────────────────────────

/**
 * Normalize events by ensuring timestamps are consistent.
 * Handles conflicting timestamps by sorting by block number first,
 * then by timestamp.
 */
function normalizeTimestamps(events: SecurityEvent[]): SecurityEvent[] {
  return [...events].sort((a, b) => {
    // Prefer block number ordering when both are available
    if (a.blockNumber !== undefined && b.blockNumber !== undefined) {
      if (a.blockNumber !== b.blockNumber) return a.blockNumber - b.blockNumber
    }
    // Fall back to timestamp
    const timeA = new Date(a.timestamp).getTime()
    const timeB = new Date(b.timestamp).getTime()
    if (timeA !== timeB) return timeA - timeB
    // Tie-break by source priority
    const sourceOrder: Record<EventSource, number> = {
      watcher: 0,
      rule_engine: 1,
      simulator: 2,
      relayer: 3,
      onchain: 4,
      guard: 5,
      frontend: 6,
    }
    return sourceOrder[a.source] - sourceOrder[b.source]
  })
}

/**
 * Correlate events by transaction hash.
 * Returns events grouped by txHash, each group chronologically ordered.
 */
export function correlateByTransaction(events: SecurityEvent[]): Map<string, SecurityEvent[]> {
  const grouped = new Map<string, SecurityEvent[]>()

  for (const event of events) {
    const existing = grouped.get(event.txHash) ?? []
    existing.push(event)
    grouped.set(event.txHash, existing)
  }

  // Sort each group chronologically
  for (const [txHash, txEvents] of grouped) {
    grouped.set(txHash, normalizeTimestamps(txEvents))
  }

  return grouped
}

/**
 * Build a causal timeline from a chronologically ordered list of events.
 * Detects state transitions and links events to their causes.
 */
export function buildTimeline(events: SecurityEvent[]): TimelineEntry[] {
  const sorted = normalizeTimestamps(events)
  const entries: TimelineEntry[] = []
  const stateMap = new Map<string, SecurityEvent>()

  for (const event of sorted) {
    const stateTransition = event.previousState !== undefined && event.previousState !== event.newState

    // Find the event that caused this one
    let causeEvent: SecurityEvent | undefined
    if (event.cause) {
      // Look for an event whose newState matches the cause
      for (const [, prev] of stateMap) {
        if (prev.txHash === event.txHash && prev.newState === event.cause) {
          causeEvent = prev
          break
        }
      }
    }

    const entry: TimelineEntry = {
      event,
      stateTransition,
      children: [],
    }

    // If there's a cause event, link them
    if (causeEvent) {
      const causeEntry = entries.find((e) => e.event.id === causeEvent!.id)
      if (causeEntry) {
        causeEntry.children.push(entry)
      }
    }

    entries.push(entry)
    stateMap.set(event.id, event)
  }

  return entries
}

/**
 * Create a placeholder entry for a missing event in the timeline.
 */
export function createGap(eventType: EventType, afterTimestamp: string): SecurityEvent {
  return {
    id: `gap-${eventType}-${Date.now()}`,
    type: eventType,
    source: "frontend",
    timestamp: afterTimestamp,
    txHash: "",
    newState: "missing",
    evidence: `Expected ${eventType.replace(/_/g, " ")} event not received`,
    severity: "warning",
  }
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Build a complete correlated timeline from raw events.
 * Returns entries sorted chronologically with causal links.
 */
export function buildCorrelatedTimeline(events: SecurityEvent[]): TimelineEntry[] {
  return buildTimeline(events)
}

/**
 * Get the current state for a transaction from its event timeline.
 */
export function getCurrentState(events: SecurityEvent[]): string | undefined {
  const sorted = normalizeTimestamps(events)
  return sorted.length > 0 ? sorted[sorted.length - 1].newState : undefined
}

/**
 * Count state transitions in a timeline.
 */
export function countTransitions(entries: TimelineEntry[]): number {
  return entries.filter((e) => e.stateTransition).length
}
