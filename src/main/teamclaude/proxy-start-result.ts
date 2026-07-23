import type { TcProxyLifecycle, TcProxyStartResult } from '../../shared/teamclaude-types'

export function getProxyStartBlocker(
  hasConfig: boolean,
  hasSupervisor: boolean
): TcProxyStartResult | null {
  if (!hasConfig) {
    return {
      ok: false,
      reason: 'no-config',
      message: 'Configure TeamClaude before starting the proxy.'
    }
  }
  if (!hasSupervisor) {
    return {
      ok: false,
      reason: 'supervisor-unavailable',
      message: 'The TeamClaude supervisor is not ready yet. Try again shortly.'
    }
  }
  return null
}

export function getProxyStartCompletion(lifecycle: TcProxyLifecycle): TcProxyStartResult {
  if (lifecycle === 'setup-needed' || lifecycle === 'offline') {
    return {
      ok: false,
      reason: 'start-failed',
      message: 'TeamClaude did not start. Review the proxy status for setup guidance.'
    }
  }
  return { ok: true }
}
