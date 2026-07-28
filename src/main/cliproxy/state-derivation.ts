import type {
  CpaAccount,
  CpaActionResult,
  CpaLifecycle,
  CpaModel,
  CpaProviderKind,
  CpaReadiness,
  CpaState
} from '../../shared/cliproxy-types'
import { DEFAULT_CLIPROXY_PORT } from './config-owner'
import type { CpaAliasMap, CpaAuthFileSummary, CpaModelsResponse } from './management-client'

export type ReadinessSignals = {
  alive: boolean
  modelsReady: boolean
  managementReady: boolean
  routingLinked: boolean
}

export type CpaStatePatch = Partial<Omit<CpaState, 'readiness'>> & {
  readiness?: ReadinessSignals
}

export function deriveCpaReadiness(signals: ReadinessSignals): CpaReadiness {
  const alive = signals.alive
  const modelsReady = alive && signals.modelsReady
  const managementReady = alive && signals.managementReady
  return {
    alive,
    modelsReady,
    managementReady,
    routingLinked: modelsReady && signals.routingLinked
  }
}

export function emptyCpaState(port: number): CpaState {
  return {
    lifecycle: 'probing',
    readiness: deriveCpaReadiness({
      alive: false,
      modelsReady: false,
      managementReady: false,
      routingLinked: false
    }),
    reasonKey: null,
    reasonDetail: null,
    port,
    version: null,
    owned: false,
    accounts: [],
    models: [],
    usage: [],
    claudeDelegated: false,
    snapshotAt: Date.now()
  }
}

export function mapCpaAccount(raw: CpaAuthFileSummary): CpaAccount {
  const provider = providerKind(raw.provider ?? raw.type)
  const nextRetry =
    typeof raw.next_retry_after === 'string' ? Date.parse(raw.next_retry_after) : Number.NaN
  return {
    name: raw.name,
    authIndex: typeof raw.auth_index === 'string' ? raw.auth_index : null,
    provider,
    label:
      typeof raw.label === 'string' && raw.label.trim()
        ? raw.label
        : typeof raw.email === 'string' && raw.email.trim()
          ? raw.email
          : raw.name,
    email: typeof raw.email === 'string' ? raw.email : null,
    disabled: raw.disabled === true,
    unavailable: raw.unavailable === true,
    priority: typeof raw.priority === 'number' ? raw.priority : null,
    note: typeof raw.note === 'string' ? raw.note : null,
    cooling: Number.isFinite(nextRetry) && nextRetry > Date.now(),
    recentSuccess: typeof raw.success === 'number' ? raw.success : null,
    recentFailure: typeof raw.failed === 'number' ? raw.failed : null
  }
}

export function mapCpaModels(
  raw: CpaModelsResponse,
  aliases: CpaAliasMap,
  routable: boolean
): CpaModel[] {
  const aliasByModel = new Map<string, string>()
  for (const entries of Object.values(aliases)) {
    for (const entry of entries) {
      aliasByModel.set(entry.name, entry.alias)
    }
  }
  return raw.data.flatMap((model) => {
    if (typeof model.id !== 'string' || !model.id.trim()) {
      return []
    }
    return [
      {
        id: model.id,
        provider:
          typeof model.provider === 'string'
            ? model.provider
            : typeof model.owned_by === 'string'
              ? model.owned_by
              : 'unknown',
        displayName:
          typeof model.display_name === 'string'
            ? model.display_name
            : typeof model.name === 'string'
              ? model.name
              : null,
        alias: aliasByModel.get(model.id) ?? null,
        routable
      }
    ]
  })
}

export function publicCpaLifecycle(lifecycle: string): CpaLifecycle {
  return lifecycle === 'adopted-degraded' ? 'adopted' : (lifecycle as CpaLifecycle)
}

export function validCpaPort(port: number | undefined): number {
  return Number.isInteger(port) && port !== undefined && port >= 1024 && port <= 65_535
    ? port
    : DEFAULT_CLIPROXY_PORT
}

export function cpaFailure(reason: string, message: string): CpaActionResult {
  return { ok: false, reason, message }
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function providerKind(value: unknown): CpaProviderKind {
  const normalized = typeof value === 'string' ? value.toLowerCase() : ''
  if (normalized === 'gemini') {
    return 'gemini'
  }
  if (normalized === 'antigravity') {
    return 'antigravity'
  }
  if (normalized === 'codex') {
    return 'codex'
  }
  if (normalized === 'claude' || normalized === 'anthropic') {
    return 'claude'
  }
  if (normalized === 'xai' || normalized === 'grok') {
    return 'xai'
  }
  if (normalized === 'kimi') {
    return 'kimi'
  }
  if (normalized.includes('openai')) {
    return 'openai-compat'
  }
  if (normalized.includes('plugin')) {
    return 'plugin'
  }
  return 'api-key'
}
