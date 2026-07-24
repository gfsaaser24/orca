/**
 * CLIProxyAPI "Backends" integration — FROZEN contract between the main-process
 * module (src/main/cliproxy/) and the renderer Backends/Services surfaces.
 * Spec: docs/superpowers/specs/2026-07-24-cliproxyapi-backends-design.md.
 * Foreman-owned during the initial build; workers consume, never edit.
 */

export type CpaLifecycle =
  | 'probing'
  | 'adopted'
  | 'owned'
  | 'setup-needed'
  | 'offline'
  | 'restart-required'

/** Per-surface readiness — never gate UI on transport alone. */
export type CpaReadiness = {
  /** /healthz answered (process liveness only). */
  alive: boolean
  /** Authenticated /v1/models succeeded (model registry usable). */
  modelsReady: boolean
  /** Management API reachable+authorized (auth-files probe). */
  managementReady: boolean
  /** teamclaude account provisioned + sync capability present (routing works). */
  routingLinked: boolean
}

export type CpaProviderKind =
  | 'gemini'
  | 'antigravity'
  | 'codex'
  | 'claude'
  | 'xai'
  | 'kimi'
  | 'api-key'
  | 'openai-compat'
  | 'plugin'

export type CpaAccount = {
  /** auth-file name (stable handle for status/fields ops). */
  name: string
  authIndex: string | null
  provider: CpaProviderKind
  label: string
  email: string | null
  disabled: boolean
  unavailable: boolean
  priority: number | null
  note: string | null
  /** Cooling/cooldown indicator from auth-file summaries. */
  cooling: boolean
  /** Recent success/failure counts from summaries (accounting, not quota). */
  recentSuccess: number | null
  recentFailure: number | null
}

export type CpaModel = {
  id: string
  provider: CpaProviderKind | string
  displayName: string | null
  alias: string | null
  /** True when the id is currently in the teamclaude `cliproxy` ownership list. */
  routable: boolean
}

/** Windowed accounting per provider or account — NEVER presented as quota. */
export type CpaUsageAggregate = {
  key: string
  requests: number
  failures: number
  tokensIn: number
  tokensOut: number
  p50LatencyMs: number | null
  windowStart: number
  windowEnd: number
}

export type CpaOauthFlow =
  | {
      kind: 'browser'
      state: string
      url: string
    }
  | {
      kind: 'device'
      state: string
      url: string
      userCode: string | null
      expiresIn: number | null
    }

export type CpaOauthStatus = 'wait' | 'ok' | 'error' | 'cancelled'

export type CpaState = {
  lifecycle: CpaLifecycle
  readiness: CpaReadiness
  reasonKey: string | null
  reasonDetail: string | null
  port: number
  version: string | null
  owned: boolean
  accounts: CpaAccount[]
  models: CpaModel[]
  usage: CpaUsageAggregate[]
  snapshotAt: number
}

export type CpaActionResult = { ok: true } | { ok: false; reason: string; message: string }

/** IPC channels (main → renderer push; renderer → main invoke). */
export const CPA_IPC = {
  /** push: CpaState (batched ≤10 Hz) */
  state: 'cpa:state',
  /** invoke: () => CpaState — subscribe-then-fetch replay */
  stateGet: 'cpa:state:get',
  /** invoke: (provider: CpaProviderKind) => CpaOauthFlow | CpaActionResult */
  loginStart: 'cpa:login:start',
  /** invoke: (state: string) => CpaOauthStatus */
  loginPoll: 'cpa:login:poll',
  /** invoke: (state: string) => CpaActionResult */
  loginCancel: 'cpa:login:cancel',
  /** invoke: ({name, disabled}) => CpaActionResult */
  accountSetDisabled: 'cpa:account:set-disabled',
  /** invoke: ({name, priority?, note?}) => CpaActionResult */
  accountSetFields: 'cpa:account:set-fields',
  /** invoke: ({name}) => CpaActionResult */
  accountDelete: 'cpa:account:delete',
  /** invoke: ({channel, aliases}) => CpaActionResult — oauth-model-alias write */
  aliasSet: 'cpa:alias:set',
  /** invoke: () => CpaActionResult */
  serviceStart: 'cpa:service:start',
  /** invoke: () => CpaActionResult */
  serviceStop: 'cpa:service:stop',
  /** invoke: (cursor: string | null) => { lines: string[]; nextCursor: string | null } */
  logsTail: 'cpa:logs:tail'
} as const

/** Shape of the preload bridge exposed at window.api.cliproxy. */
export type CpaBridge = {
  onState(cb: (state: CpaState) => void): () => void
  getState(): Promise<CpaState>
  loginStart(provider: CpaProviderKind): Promise<CpaOauthFlow | CpaActionResult>
  loginPoll(state: string): Promise<CpaOauthStatus>
  loginCancel(state: string): Promise<CpaActionResult>
  accountSetDisabled(payload: { name: string; disabled: boolean }): Promise<CpaActionResult>
  accountSetFields(payload: {
    name: string
    priority?: number
    note?: string
  }): Promise<CpaActionResult>
  accountDelete(payload: { name: string }): Promise<CpaActionResult>
  aliasSet(payload: { channel: string; aliases: Record<string, string> }): Promise<CpaActionResult>
  serviceStart(): Promise<CpaActionResult>
  serviceStop(): Promise<CpaActionResult>
  logsTail(cursor: string | null): Promise<{ lines: string[]; nextCursor: string | null }>
}
