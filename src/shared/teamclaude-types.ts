/**
 * TeamClaude integration — FROZEN contract between the main-process module
 * (src/main/teamclaude/) and the renderer cockpit. Spec:
 * docs/superpowers/specs/2026-07-22-teamclaude-integration-design.md (v2.2).
 *
 * Change control: this file is owned by the foreman during the initial build.
 * Workers consume it; they do not edit it. Additions require a new contract rev.
 */

/** Supervisor lifecycle. `adopted-degraded` = connected to an older server
 * missing required capabilities (per-surface readiness below). */
export type TcProxyLifecycle =
  | 'probing'
  | 'adopted'
  | 'adopted-degraded'
  | 'owned'
  | 'setup-needed'
  | 'offline'

/** Derived per-surface readiness (never gate UI on transport alone). */
export interface TcReadiness {
  usageReady: boolean
  routingReady: boolean
  controlReady: boolean
}

export interface TcQuotaBucket {
  /** 0–100, clamped; may have been >100 upstream (overage flag set). */
  usedPercent: number
  overage: boolean
  /** Epoch ms when the bucket window resets, if known. */
  resetsAt: number | null
  /** Epoch ms when this bucket was last actually observed upstream (Phase-0
   * `observedAt`) — NEVER HTTP receipt time. Null = unknown/never. */
  observedAt: number | null
}

export interface TcAccount {
  /** Stable ID: teamclaude account UUID + organization (Phase-0 field). */
  id: string
  name: string
  email: string | null
  status: 'active' | 'throttled' | 'exhausted' | 'error' | 'disabled'
  priority: number
  pinned: boolean
  /** Matching Orca managed-account id (join by stable ID, email fallback), if any. */
  orcaAccountId: string | null
  buckets: {
    unified5h: TcQuotaBucket | null
    unified7d: TcQuotaBucket | null
    unified7dFable: TcQuotaBucket | null
    unified7dSonnet: TcQuotaBucket | null
  }
}

export interface TcRoute {
  name: string
  match: string[]
  /** Stable account IDs (names only during Phase-0 deprecation window). */
  accounts: string[]
  bucket: string | null
}

export interface TcActivityRow {
  /** `${bootId}:${eventId}` — stable dedupe key across proxy restarts. */
  key: string
  at: number
  model: string | null
  account: string | null
  status: number | null
  durationMs: number | null
  path: string | null
}

export interface TcState {
  lifecycle: TcProxyLifecycle
  readiness: TcReadiness
  /** Why setup is needed / spawn failed / degraded — user-facing, localized key + detail. */
  reasonKey: string | null
  reasonDetail: string | null
  port: number
  serverVersion: string | null
  bootId: string | null
  capabilities: string[]
  /** True when this Orca TC instance spawned (owns) the server. */
  owned: boolean
  accounts: TcAccount[]
  routes: TcRoute[]
  /** Epoch ms of the snapshot this state was built from. */
  snapshotAt: number
}

/** IPC channels (main → renderer push; renderer → main invoke). */
export const TC_IPC = {
  /** push: TcState (batched ≤10 Hz) */
  state: 'tc:state',
  /** push: TcActivityRow[] (batched) */
  activity: 'tc:activity',
  /** invoke: (accountId: string | null) => void — null unpins */
  pin: 'tc:pin',
  /** invoke: (routes: TcRoute[]) => void */
  routesSet: 'tc:routes:set',
  /** invoke: ({id, disabled?, priority?}) => void */
  accountSet: 'tc:account:set',
  /** invoke: () => void */
  proxyStart: 'tc:proxy:start',
  /** invoke: ({confirmLiveSessions: number}) => void — count echoed back as consent */
  proxyStop: 'tc:proxy:stop',
  /** invoke: () => TcActivityRow[] — seed from /log */
  logTail: 'tc:log:tail',
} as const

export type TcAccountSetPayload = { id: string; disabled?: boolean; priority?: number }
