import type { TcState } from '../../../../shared/teamclaude-types'

export type TeamclaudeStatusIdentity = {
  connected: boolean
  label: string | null
}

export function resolveTeamclaudeStatusIdentity(state: TcState | null): TeamclaudeStatusIdentity {
  const connected =
    state?.lifecycle === 'adopted' ||
    state?.lifecycle === 'adopted-degraded' ||
    state?.lifecycle === 'owned'

  return {
    connected,
    label: connected ? state.currentAccount : null
  }
}
