/**
 * TeamClaude wire → contract mapping + activity dedupe. Split out of client.ts
 * to keep each unit focused (and under the file-size budget).
 *
 * The raw shapes here mirror the REAL teamclaude server (tc/p0-server):
 *  - /teamclaude/status → getStatus() + getStatusExtra(): version, bootId,
 *    capabilities (SERVER_CAPABILITIES), top-level `manualAccount` (pinned
 *    account NAME), and `accounts[]` with a FLAT `quota` object (0–1 fractions +
 *    epoch-ms reset fields) plus a SEPARATE `observedAt` map of ISO-8601 strings.
 *    Its `routes` field is the DISPLAY view ({name,eligible} account objects +
 *    ephemeral autocreated rows) — used here only as a read-only fallback.
 *  - GET /teamclaude/routes → { ok, routes:[{name,match[],accounts?[strings],
 *    bucket?}] }: the editable source of truth (accounts/bucket omitted when
 *    empty). Fetched by the client when routingReady and used to override the
 *    display fallback.
 */
import type {
  TcAccount,
  TcActivityRow,
  TcQuotaBucket,
  TcReadiness,
  TcRoute
} from '../../shared/teamclaude-types'
import { findOrcaAccountId, type TcNativeAccountIdentity } from './client-account-identity'

export type { TcNativeAccountIdentity } from './client-account-identity'

/** Parsed, contract-shaped result of a /status read. */
export type TcStatusSnapshot = {
  serverVersion: string | null
  bootId: string | null
  capabilities: string[]
  readiness: TcReadiness
  currentAccount: string | null
  accounts: TcAccount[]
  routes: TcRoute[]
}

// --- Raw wire shapes (mirror the tc/p0-server server) ----------------------

/** Flat quota object the server sends (account-manager getStatus): utilization
 *  fractions 0–1 + epoch-ms reset timestamps. Absent buckets are null. */
type RawQuota = {
  unified5h?: number | null
  unified7d?: number | null
  unified7dSonnet?: number | null
  unified7dFable?: number | null
  unified5hReset?: number | null
  unified7dReset?: number | null
  unified7dSonnetReset?: number | null
  unified7dFableReset?: number | null
}
type RawAccount = {
  id?: string
  name?: string
  email?: string | null
  type?: string
  orgName?: string | null
  priority?: number
  disabled?: boolean
  status?: string
  quota?: RawQuota | null
  /** Per-bucket last-observed times as ISO-8601 STRINGS (never HTTP receipt
   *  time). Keys mirror the bucket keys (unified5h, unified7d, …). */
  observedAt?: Record<string, string | null | undefined> | null
}

/** A route row as it appears on the DISPLAY view (/status.routes): account
 *  entries are {name,eligible} objects and ephemeral rows carry autocreated. */
type RawDisplayRoute = {
  name?: string
  match?: string[]
  accounts?: (string | { name?: string; eligible?: boolean })[]
  bucket?: string | null
  autocreated?: boolean
}
/** A route row from the editable source of truth (GET /teamclaude/routes):
 *  account entries are plain strings; accounts/bucket omitted when empty. */
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
  currentAccount?: string | null
  /** Top-level pinned-account NAME (or null) — mapped onto each account's
   *  `pinned` flag (the server has no per-account pinned field). */
  manualAccount?: string | null
  accounts?: RawAccount[]
  routes?: RawDisplayRoute[]
}
/** GET /teamclaude/routes response — the editable route table (source of truth). */
export type RawRoutesResponse = {
  ok?: boolean
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

/** Raw event shape accepted by {@link ActivityDeduper} (SSE / /log wire). */
export type { RawEvent as TcRawEvent }

/**
 * Per-bootId high-water dedupe → contract activity rows. A reconnect replays the
 * ring (eventIds ≤ high-water are dropped); a proxy restart changes the bootId,
 * so its reset eventIds land under a fresh high-water and are NOT mistaken for
 * duplicates (contract TcActivityRow.key = `${bootId}:${eventId}`).
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

/**
 * SSE live-stream dedupe. The hello frame carries the connection's bootId; the
 * LIVE events that follow carry NO bootId. We remember the hello's bootId for
 * the connection and key every subsequent live event under it, so:
 *  - reconnect-same-boot: the new hello replays the ring (deduped by high-water)
 *    and live events keep the same bootId (no duplicates), and
 *  - restart-new-boot: the new hello arms a fresh bootId, so reset eventIds land
 *    under a new high-water and are NOT dropped.
 * Shares the caller's {@link ActivityDeduper} so /log seed + SSE never
 * double-emit the same ring.
 */
export class LiveStreamDeduper {
  private connectionBootId: string | null = null
  constructor(private readonly deduper: ActivityDeduper) {}

  /** Start of a new SSE connection: forget the last hello's bootId until the
   *  next hello arms it (a stray pre-hello event keys as `unknown`). */
  reset(): void {
    this.connectionBootId = null
  }

  /** Hello frame: arm the connection bootId and ingest the replay ring. */
  hello(bootId: string | null, events: RawEvent[]): TcActivityRow[] {
    this.connectionBootId = bootId
    return this.deduper.ingest(bootId, events)
  }

  /** A live event (no bootId) — keyed under the connection's hello bootId. */
  live(event: RawEvent): TcActivityRow[] {
    return this.deduper.ingest(this.connectionBootId, [event])
  }
}

// --- Mapping ---------------------------------------------------------------

/**
 * Derive per-surface readiness from the server's real capability vocabulary
 * (SERVER_CAPABILITIES): usage gates on identity/quota exposure, routing needs
 * both the route RW endpoint and cert preflight, control needs account writes.
 * Each cockpit surface gates on its own readiness, never mere connectivity.
 */
export function deriveReadiness(capabilities: string[]): TcReadiness {
  const has = (token: string): boolean => capabilities.includes(token)
  return {
    usageReady: has('status.identity'),
    routingReady: has('routes.rw') && has('certs.ensure'),
    controlReady: has('account.write')
  }
}

export function parseStatus(
  raw: RawStatus,
  nativeAccounts: readonly TcNativeAccountIdentity[] = []
): TcStatusSnapshot {
  const capabilities = Array.isArray(raw.capabilities) ? raw.capabilities.filter(isString) : []
  const manualAccount = typeof raw.manualAccount === 'string' ? raw.manualAccount : null
  return {
    serverVersion: typeof raw.version === 'string' ? raw.version : null,
    bootId: typeof raw.bootId === 'string' ? raw.bootId : null,
    capabilities,
    readiness: deriveReadiness(capabilities),
    currentAccount: typeof raw.currentAccount === 'string' ? raw.currentAccount : null,
    accounts: Array.isArray(raw.accounts)
      ? raw.accounts.map((a) => toAccount(a, manualAccount, nativeAccounts))
      : [],
    // Display fallback only (read-only). Authoritative routes come from GET
    // /teamclaude/routes when routingReady (the client overrides this).
    routes: parseDisplayRoutes(raw)
  }
}

/** Build one contract quota bucket from a fraction (0–1), epoch-ms reset, and an
 *  ISO-8601 observedAt string. Fraction → percent (×100, clamped 0–100), with an
 *  overage flag when the raw value exceeded 100%. */
function buildBucket(
  fraction: number | null | undefined,
  reset: number | null | undefined,
  observedIso: string | null | undefined
): TcQuotaBucket | null {
  if (typeof fraction !== 'number' || !Number.isFinite(fraction)) {
    return null
  }
  const pct = fraction * 100
  return {
    usedPercent: Math.max(0, Math.min(100, pct)),
    overage: pct > 100,
    resetsAt: typeof reset === 'number' && Number.isFinite(reset) ? reset : null,
    observedAt: parseIsoMs(observedIso)
  }
}

/** Parse an ISO-8601 observedAt string to epoch ms, or null. */
function parseIsoMs(v: string | null | undefined): number | null {
  if (typeof v !== 'string') {
    return null
  }
  const t = Date.parse(v)
  return Number.isFinite(t) ? t : null
}

function toAccount(
  raw: RawAccount,
  manualAccount: string | null,
  nativeAccounts: readonly TcNativeAccountIdentity[]
): TcAccount {
  const id = raw.id ?? raw.name ?? ''
  const q = raw.quota ?? {}
  const obs = raw.observedAt ?? {}
  return {
    id,
    name: raw.name ?? id,
    email: raw.email ?? null,
    status: normalizeStatus(raw.status, raw.disabled),
    priority: typeof raw.priority === 'number' ? raw.priority : 0,
    // The server exposes a single top-level `manualAccount` (pinned account
    // NAME); there is no per-account pinned field. Map it onto each account.
    pinned: manualAccount != null && raw.name === manualAccount,
    orcaAccountId: findOrcaAccountId(raw, nativeAccounts),
    buckets: {
      unified5h: buildBucket(q.unified5h, q.unified5hReset, obs.unified5h),
      unified7d: buildBucket(q.unified7d, q.unified7dReset, obs.unified7d),
      unified7dFable: buildBucket(q.unified7dFable, q.unified7dFableReset, obs.unified7dFable),
      unified7dSonnet: buildBucket(q.unified7dSonnet, q.unified7dSonnetReset, obs.unified7dSonnet)
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
  if (status === undefined) {
    return 'active'
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

/**
 * Read-only display fallback from /status.routes. The display view carries
 * {name,eligible} account OBJECTS (coerced here to their `.name` strings) and
 * ephemeral `autocreated` rows that are never persisted — those are EXCLUDED so
 * the editor never round-trips a non-persistable row (the contract TcRoute has
 * no autocreated flag). When routingReady, the client replaces this with the
 * authoritative GET /teamclaude/routes table.
 */
function parseDisplayRoutes(raw: RawStatus): TcRoute[] {
  const rows = Array.isArray(raw.routes) ? raw.routes : []
  return rows.filter((r) => r?.autocreated !== true).map(toDisplayRoute)
}

function toDisplayRoute(raw: RawDisplayRoute): TcRoute {
  return {
    name: raw.name ?? '',
    match: Array.isArray(raw.match) ? raw.match.filter(isString) : [],
    accounts: Array.isArray(raw.accounts)
      ? raw.accounts.map(coerceAccountRef).filter((s): s is string => s !== null)
      : [],
    bucket: typeof raw.bucket === 'string' ? raw.bucket : null
  }
}

/** Coerce a display route account entry (string OR {name,eligible}) to its
 *  stable-name string. */
function coerceAccountRef(entry: string | { name?: string; eligible?: boolean }): string | null {
  if (typeof entry === 'string') {
    return entry
  }
  if (entry && typeof entry === 'object' && typeof entry.name === 'string') {
    return entry.name
  }
  return null
}

/** Parse the authoritative GET /teamclaude/routes response (source of truth).
 *  accounts/bucket are omitted when empty; both are null-guarded. */
export function parseRoutes(raw: RawRoutesResponse): TcRoute[] {
  return Array.isArray(raw.routes) ? raw.routes.map(toRoute) : []
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
