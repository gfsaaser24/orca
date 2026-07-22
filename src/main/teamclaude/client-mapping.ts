/**
 * TeamClaude wire → contract mapping + activity dedupe. Split out of client.ts
 * to keep each unit focused (and under the file-size budget). The raw shapes are
 * best-effort: the server endpoints are built in parallel (spec §2/§3), so every
 * field is null-guarded and mapped to the FROZEN contract types.
 */
import type {
  TcAccount,
  TcActivityRow,
  TcQuotaBucket,
  TcReadiness,
  TcRoute
} from '../../shared/teamclaude-types'

/** Parsed, contract-shaped result of a /status read. */
export type TcStatusSnapshot = {
  serverVersion: string | null
  bootId: string | null
  capabilities: string[]
  readiness: TcReadiness
  accounts: TcAccount[]
  routes: TcRoute[]
}

// --- Raw wire shapes (best-effort; server built in parallel, spec §2/§3) ----

type RawQuotaBucket = {
  usedPercent?: number
  utilization?: number
  resetsAt?: number | null
  observedAt?: number | null
}
type RawAccount = {
  id?: string
  uuid?: string
  organizationUuid?: string
  organization?: string
  name?: string
  email?: string | null
  status?: string
  disabled?: boolean
  priority?: number
  pinned?: boolean
  orcaAccountId?: string | null
  buckets?: Record<string, RawQuotaBucket | null>
}
type RawRoute = {
  name?: string
  match?: string[]
  accounts?: string[]
  bucket?: string | null
}
export type RawStatus = {
  version?: string
  bootId?: string
  capabilities?: string[]
  accounts?: RawAccount[]
  routes?: RawRoute[]
}
export type RawEvent = {
  id?: number
  bootId?: string
  type?: string
  ts?: number
  at?: number
  model?: string | null
  account?: string | null
  status?: number | null
  durationMs?: number | null
  path?: string | null
}
export type RawLog = {
  bootId?: string
  events?: RawEvent[]
}
export type RawHello = {
  bootId?: string
  recent?: RawEvent[]
  events?: RawEvent[]
}

/** Raw event shape accepted by {@link ActivityDeduper} (spec §2/§3 wire). */
export type { RawEvent as TcRawEvent }

/**
 * Per-bootId high-water dedupe → contract activity rows. A reconnect replays the
 * ring (eventIds ≤ high-water are dropped); a proxy restart changes the bootId,
 * so its reset eventIds land under a fresh high-water and are NOT mistaken for
 * duplicates (spec §5, contract TcActivityRow.key = `${bootId}:${eventId}`).
 */
export class ActivityDeduper {
  private readonly highWater = new Map<string, number>()

  ingest(bootId: string | null, events: RawEvent[]): TcActivityRow[] {
    const key = bootId ?? 'unknown'
    let hw = this.highWater.get(key) ?? -1
    const out: TcActivityRow[] = []
    for (const e of events) {
      const id = typeof e.id === 'number' ? e.id : null
      if (id !== null && id <= hw) {
        continue
      }
      if (id !== null) {
        hw = id
      }
      out.push(toActivityRow(bootId, e))
    }
    this.highWater.set(key, hw)
    return out
  }
}

// --- Mapping ---------------------------------------------------------------

/** Derive per-surface readiness from the capability vocabulary. Accepts a few
 *  synonyms since the exact Phase-0 tokens are finalized in parallel. */
export function deriveReadiness(capabilities: string[]): TcReadiness {
  const has = (...tokens: string[]): boolean => tokens.some((t) => capabilities.includes(t))
  return {
    usageReady: has('usage', 'quota', 'status.quota'),
    routingReady: has('routing', 'routes'),
    controlReady: has('control', 'account', 'pin')
  }
}

export function parseStatus(raw: RawStatus): TcStatusSnapshot {
  const capabilities = Array.isArray(raw.capabilities) ? raw.capabilities.filter(isString) : []
  return {
    serverVersion: typeof raw.version === 'string' ? raw.version : null,
    bootId: typeof raw.bootId === 'string' ? raw.bootId : null,
    capabilities,
    readiness: deriveReadiness(capabilities),
    accounts: Array.isArray(raw.accounts) ? raw.accounts.map(toAccount) : [],
    routes: Array.isArray(raw.routes) ? raw.routes.map(toRoute) : []
  }
}

function toBucket(raw: RawQuotaBucket | null | undefined): TcQuotaBucket | null {
  if (!raw) {
    return null
  }
  const rawPct =
    typeof raw.usedPercent === 'number'
      ? raw.usedPercent
      : typeof raw.utilization === 'number'
        ? raw.utilization * 100
        : null
  if (rawPct === null) {
    return null
  }
  const overage = rawPct > 100
  return {
    usedPercent: Math.max(0, Math.min(100, rawPct)),
    overage,
    resetsAt: typeof raw.resetsAt === 'number' ? raw.resetsAt : null,
    observedAt: typeof raw.observedAt === 'number' ? raw.observedAt : null
  }
}

function toAccount(raw: RawAccount): TcAccount {
  const id =
    raw.id ??
    (raw.uuid ? `${raw.uuid}:${raw.organizationUuid ?? raw.organization ?? ''}` : (raw.name ?? ''))
  const status = normalizeStatus(raw.status, raw.disabled)
  const b = raw.buckets ?? {}
  return {
    id,
    name: raw.name ?? id,
    email: raw.email ?? null,
    status,
    priority: typeof raw.priority === 'number' ? raw.priority : 0,
    pinned: raw.pinned === true,
    orcaAccountId: raw.orcaAccountId ?? null,
    buckets: {
      unified5h: toBucket(b.unified5h),
      unified7d: toBucket(b.unified7d),
      unified7dFable: toBucket(b.unified7dFable),
      unified7dSonnet: toBucket(b.unified7dSonnet)
    }
  }
}

function normalizeStatus(
  status: string | undefined,
  disabled: boolean | undefined
): TcAccount['status'] {
  if (disabled) {
    return 'disabled'
  }
  switch (status) {
    case 'active':
    case 'throttled':
    case 'exhausted':
    case 'error':
    case 'disabled':
      return status
    default:
      return 'active'
  }
}

function toRoute(raw: RawRoute): TcRoute {
  return {
    name: raw.name ?? '',
    match: Array.isArray(raw.match) ? raw.match.filter(isString) : [],
    accounts: Array.isArray(raw.accounts) ? raw.accounts.filter(isString) : [],
    bucket: typeof raw.bucket === 'string' ? raw.bucket : null
  }
}

function toActivityRow(bootId: string | null, e: RawEvent): TcActivityRow {
  const id = typeof e.id === 'number' ? e.id : 0
  return {
    key: `${bootId ?? 'unknown'}:${id}`,
    at: typeof e.at === 'number' ? e.at : typeof e.ts === 'number' ? e.ts : Date.now(),
    model: e.model ?? null,
    account: e.account ?? null,
    status: typeof e.status === 'number' ? e.status : null,
    durationMs: typeof e.durationMs === 'number' ? e.durationMs : null,
    path: e.path ?? null
  }
}

function isString(v: unknown): v is string {
  return typeof v === 'string'
}
