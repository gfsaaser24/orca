import type {
  TcAccount,
  TcActivityRow,
  TcQuotaBucket,
  TcState
} from '../../../../shared/teamclaude-types'

// Why: pure, framework-free derivations shared by the widget, flyout, and panel.
// Keeping them here (not inline in components) makes the degradation matrix and
// the worst-bucket / staleness math directly unit-testable without a DOM.

export type BucketKey = 'unified5h' | 'unified7d' | 'unified7dFable' | 'unified7dSonnet'

/**
 * Minimum TeamClaude server version Orca TC's cockpit requires for full
 * routing/control capabilities (the Phase-0 status/hello envelope + mutation
 * endpoints — spec §3/§9 "version floor constant"). Attaching to an older
 * server lands in `adopted-degraded`, and the affected tabs surface an
 * "update teamclaude (have vX, need vY)" prompt built from this value and
 * `state.serverVersion`. Lives here (with the readiness derivation) rather than
 * in the frozen contract so it can move without a contract rev.
 */
export const TC_MIN_SERVER_VERSION = '1.5.0'

/** Render order for per-account quota bars. */
export const BUCKET_KEYS: readonly BucketKey[] = [
  'unified5h',
  'unified7d',
  'unified7dFable',
  'unified7dSonnet'
]

/** Localization key + English fallback for each bucket label. */
export const BUCKET_LABELS: Record<BucketKey, { key: string; fallback: string }> = {
  unified5h: { key: 'teamclaude.bucket.unified5h', fallback: '5h' },
  unified7d: { key: 'teamclaude.bucket.unified7d', fallback: '7d' },
  unified7dFable: { key: 'teamclaude.bucket.fable', fallback: 'Fable 7d' },
  unified7dSonnet: { key: 'teamclaude.bucket.sonnet', fallback: 'Sonnet 7d' }
}

export type WorstBucket = {
  key: BucketKey
  bucket: TcQuotaBucket
}

/** Highest-usage non-null bucket for an account, or null when none are known. */
export function worstBucket(account: TcAccount): WorstBucket | null {
  let worst: WorstBucket | null = null
  for (const key of BUCKET_KEYS) {
    const bucket = account.buckets[key]
    if (!bucket) {
      continue
    }
    if (!worst || bucket.usedPercent > worst.bucket.usedPercent) {
      worst = { key, bucket }
    }
  }
  return worst
}

/**
 * The account the compact widget represents: the pinned account if one is
 * pinned, otherwise the account closest to its limit (highest worst-bucket
 * usage), so the ambient indicator always surfaces the most at-risk account.
 */
export function primaryAccount(state: TcState | null): TcAccount | null {
  if (!state || state.accounts.length === 0) {
    return null
  }
  const pinned = state.accounts.find((account) => account.pinned)
  if (pinned) {
    return pinned
  }
  let best = state.accounts[0]
  let bestPct = worstBucket(best)?.bucket.usedPercent ?? -1
  for (const account of state.accounts.slice(1)) {
    const pct = worstBucket(account)?.bucket.usedPercent ?? -1
    if (pct > bestPct) {
      best = account
      bestPct = pct
    }
  }
  return best
}

export const DEFAULT_STALE_MS = 5 * 60 * 1000

/** A bucket is stale when never observed or observed longer ago than the window. */
export function isBucketStale(
  bucket: TcQuotaBucket,
  now: number,
  staleMs: number = DEFAULT_STALE_MS
): boolean {
  if (bucket.observedAt == null) {
    return true
  }
  return now - bucket.observedAt > staleMs
}

/** Milliseconds until a bucket resets, clamped to zero, or null when unknown. */
export function resetCountdownMs(resetsAt: number | null, now: number): number | null {
  if (resetsAt == null) {
    return null
  }
  return Math.max(0, resetsAt - now)
}

/** Compact "2h 5m" / "3m" / "45s" countdown; locale-neutral unit symbols. */
export function formatCountdown(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) {
    return `${hours}h ${minutes}m`
  }
  if (minutes > 0) {
    return `${minutes}m`
  }
  return `${seconds}s`
}

/** Compact "5m" / "2h" age string for stale-since annotations. */
export function formatAge(ms: number): string {
  return formatCountdown(ms)
}

export type TcSurfaceGates = {
  /** Quota bars are renderable with real numbers. */
  showUsage: boolean
  /** Connected but usage snapshot not yet ready (show degraded placeholder). */
  usageDegraded: boolean
  /** Routes tab may be edited. */
  routesEditable: boolean
  /** Connected but routing capability missing (read-only / unavailable). */
  routingDegraded: boolean
  /** Pin / disable / priority / proxy controls may be invoked. */
  controlsEnabled: boolean
  /** Connected but control capability missing. */
  controlDegraded: boolean
  offline: boolean
  /** Attached to an older server missing capabilities (banner only). */
  adoptedDegraded: boolean
  setupNeeded: boolean
}

/**
 * Derive per-surface gates from readiness flags — NEVER from raw lifecycle
 * (transport). `adopted-degraded` is surfaced only as a banner flag; the actual
 * surface enabling still flows through readiness, so an old server that reports
 * `routingReady: false` disables routing while leaving usage live if
 * `usageReady: true`.
 */
export function surfaceGates(state: TcState | null): TcSurfaceGates {
  const offline = !state || state.lifecycle === 'offline'
  const setupNeeded = state?.lifecycle === 'setup-needed'
  const readiness = state?.readiness
  const degradedBase = !offline && !setupNeeded
  return {
    showUsage: !!readiness?.usageReady && !offline,
    usageDegraded: degradedBase && !readiness?.usageReady,
    routesEditable: !!readiness?.routingReady && !!readiness?.controlReady && !offline,
    routingDegraded: degradedBase && !readiness?.routingReady,
    controlsEnabled: !!readiness?.controlReady && !offline,
    controlDegraded: degradedBase && !readiness?.controlReady,
    offline,
    adoptedDegraded: state?.lifecycle === 'adopted-degraded',
    setupNeeded: !!setupNeeded
  }
}

/** Recognized reasonKeys the cockpit renders as dedicated affordances. */
export const TC_REASON = {
  launchedUnrouted: 'launchedUnrouted'
} as const

/** True when the state reports a Claude CLI launched without proxy routing. */
export function hasLaunchedUnrouted(state: TcState | null): boolean {
  return state?.reasonKey === TC_REASON.launchedUnrouted
}

/**
 * Incomplete activity rows (request still in flight upstream) — status/duration
 * not yet known. Rendered with pending styling and excluded from timing stats.
 */
export function isActivityRowPending(row: TcActivityRow): boolean {
  return row.status === null || row.durationMs === null
}

/**
 * Count of in-flight (pending) requests — a request-level heuristic derived from
 * activity rows whose status/duration are not yet known. Named honestly: this is
 * NOT a session count. The frozen v2.2 contract carries no explicit live-session
 * field, so the stop-proxy confirmation echoes THIS request count as consent and
 * its copy speaks of "in-flight requests", never sessions. The IPC payload field
 * stays `confirmLiveSessions` (frozen); only the human-facing framing is truthful.
 */
export function inFlightRequestCount(activity: readonly TcActivityRow[]): number {
  return activity.reduce((count, row) => (isActivityRowPending(row) ? count + 1 : count), 0)
}

/**
 * Merge freshly pushed activity rows into the retained buffer: dedupe by the
 * stable `${bootId}:${eventId}` key (incoming wins so a completing row replaces
 * its pending twin), newest-first, capped to bound renderer memory.
 */
export function mergeActivity(
  existing: readonly TcActivityRow[],
  incoming: readonly TcActivityRow[],
  cap = 500
): TcActivityRow[] {
  const byKey = new Map<string, TcActivityRow>()
  for (const row of existing) {
    byKey.set(row.key, row)
  }
  for (const row of incoming) {
    byKey.set(row.key, row)
  }
  return [...byKey.values()].sort((a, b) => b.at - a.at).slice(0, cap)
}
