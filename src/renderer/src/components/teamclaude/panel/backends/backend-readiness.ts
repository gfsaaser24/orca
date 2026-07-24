import type { CpaAccount, CpaProviderKind, CpaState } from '../../../../../../shared/cliproxy-types'

export type CpaSurfaceGates = {
  offline: boolean
  setupNeeded: boolean
  modelsVisible: boolean
  managementEnabled: boolean
  routingLinked: boolean
  greyLastKnown: boolean
}

export function cpaSurfaceGates(state: CpaState | null): CpaSurfaceGates {
  const setupNeeded = state?.lifecycle === 'setup-needed'
  const offline =
    !state || (!setupNeeded && (state.lifecycle === 'offline' || !state.readiness.alive))
  return {
    offline,
    setupNeeded: !!setupNeeded,
    modelsVisible: !offline && !setupNeeded && !!state?.readiness.modelsReady,
    managementEnabled: !offline && !setupNeeded && !!state?.readiness.managementReady,
    routingLinked: !offline && !!state?.readiness.routingLinked,
    greyLastKnown: offline && !!state && (state.accounts.length > 0 || state.models.length > 0)
  }
}

export type ProviderFamily = {
  id: string
  labelKey: string
  labelFallback: string
  providers: CpaProviderKind[]
}

export const OAUTH_PROVIDER_FAMILIES: ProviderFamily[] = [
  {
    id: 'gemini',
    labelKey: 'cliproxy.providers.geminiFamily',
    labelFallback: 'Gemini / Antigravity',
    providers: ['gemini', 'antigravity']
  },
  {
    id: 'codex',
    labelKey: 'cliproxy.providers.codex',
    labelFallback: 'Codex / ChatGPT',
    providers: ['codex']
  },
  {
    id: 'claude',
    labelKey: 'cliproxy.providers.claude',
    labelFallback: 'Claude',
    providers: ['claude']
  },
  {
    id: 'xai',
    labelKey: 'cliproxy.providers.xai',
    labelFallback: 'Grok',
    providers: ['xai']
  },
  {
    id: 'kimi',
    labelKey: 'cliproxy.providers.kimi',
    labelFallback: 'Kimi',
    providers: ['kimi']
  }
]

export function accountsForFamily(
  accounts: readonly CpaAccount[],
  family: ProviderFamily
): CpaAccount[] {
  return accounts.filter((account) => family.providers.includes(account.provider))
}

export function successRate(requests: number, failures: number): number {
  if (requests <= 0) {
    return 0
  }
  return Math.max(0, Math.min(100, ((requests - failures) / requests) * 100))
}
