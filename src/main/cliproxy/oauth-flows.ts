import net from 'node:net'
import type {
  CpaActionResult,
  CpaOauthFlow,
  CpaOauthStatus,
  CpaProviderKind
} from '../../shared/cliproxy-types'
import type { CpaAuthProvider, ManagementClient } from './management-client'

const CALLBACK_PORTS: Partial<Record<CpaProviderKind, number>> = {
  claude: 54545,
  codex: 1455,
  antigravity: 51121
}

const AUTH_PROVIDERS: Partial<Record<CpaProviderKind, CpaAuthProvider>> = {
  claude: 'anthropic',
  codex: 'codex',
  antigravity: 'antigravity',
  xai: 'xai',
  kimi: 'kimi'
}

type FlowState = {
  provider: CpaProviderKind
  terminal: CpaOauthStatus | null
}

function failure(reason: string, message: string): CpaActionResult {
  return { ok: false, reason, message }
}

function probeCallbackPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer()
    let settled = false
    const finish = (available: boolean): void => {
      if (settled) {
        return
      }
      settled = true
      server.removeAllListeners()
      resolve(available)
    }
    server.once('error', () => finish(false))
    server.once('listening', () => {
      server.close(() => finish(true))
    })
    server.unref()
    server.listen({ host: '127.0.0.1', port, exclusive: true })
  })
}

export function createOauthFlows(client: ManagementClient): {
  start(provider: CpaProviderKind): Promise<CpaOauthFlow | CpaActionResult>
  poll(state: string): Promise<CpaOauthStatus>
  cancel(state: string): Promise<CpaActionResult>
} {
  const activeByProvider = new Map<CpaProviderKind, string | null>()
  const states = new Map<string, FlowState>()

  const release = (state: string, terminal: CpaOauthStatus): void => {
    const entry = states.get(state)
    if (!entry) {
      return
    }
    entry.terminal = terminal
    if (activeByProvider.get(entry.provider) === state) {
      activeByProvider.delete(entry.provider)
    }
  }

  const start = async (provider: CpaProviderKind): Promise<CpaOauthFlow | CpaActionResult> => {
    const authProvider = AUTH_PROVIDERS[provider]
    if (!authProvider) {
      return failure(
        'oauth_provider_unsupported',
        `${provider} account login is not supported by CLIProxyAPI.`
      )
    }
    if (activeByProvider.has(provider)) {
      return failure('oauth_flow_active', `A ${provider} login is already in progress.`)
    }

    // Why: reserve before the async preflight so concurrent starts cannot create two CPA sessions.
    activeByProvider.set(provider, null)
    const callbackPort = CALLBACK_PORTS[provider]
    if (callbackPort !== undefined && !(await probeCallbackPort(callbackPort))) {
      activeByProvider.delete(provider)
      return failure(
        'oauth_callback_port_busy',
        `OAuth callback port ${callbackPort} is already in use. Close the listener and try again.`
      )
    }

    try {
      // Why: CPA's WebUI forwarder binds all interfaces; noWebui omits is_webui entirely (D5).
      const response = await client.authUrl(authProvider, { noWebui: true })
      const state = response.state.trim()
      const url = response.url.trim()
      if (!state || !url) {
        activeByProvider.delete(provider)
        return failure('oauth_start_invalid', `CLIProxyAPI returned an invalid ${provider} login.`)
      }
      if (states.has(state)) {
        activeByProvider.delete(provider)
        return failure('oauth_state_reused', `CLIProxyAPI reused a ${provider} login state.`)
      }

      states.set(state, { provider, terminal: null })
      activeByProvider.set(provider, state)
      if (provider === 'xai' || provider === 'kimi') {
        return {
          kind: 'device',
          state,
          url,
          userCode: response.user_code?.trim() || null,
          expiresIn:
            typeof response.expires_in === 'number' && Number.isFinite(response.expires_in)
              ? response.expires_in
              : null
        }
      }
      return { kind: 'browser', state, url }
    } catch {
      activeByProvider.delete(provider)
      return failure('oauth_start_failed', `Could not start the ${provider} login.`)
    }
  }

  const poll = async (state: string): Promise<CpaOauthStatus> => {
    const entry = states.get(state)
    if (!entry) {
      return 'error'
    }
    if (entry.terminal) {
      return entry.terminal
    }
    try {
      const status = (await client.authStatus(state)).status
      if (status === 'ok' || status === 'error') {
        release(state, status)
      }
      return status
    } catch {
      release(state, 'error')
      return 'error'
    }
  }

  const cancel = async (state: string): Promise<CpaActionResult> => {
    const entry = states.get(state)
    if (!entry || entry.terminal) {
      return failure('oauth_state_unknown', 'The OAuth login is no longer active.')
    }
    try {
      const response = await client.cancelOauth(state)
      if (!response.cancelled) {
        release(state, 'cancelled')
        return failure('oauth_state_unknown', 'CLIProxyAPI no longer has this OAuth login.')
      }
      release(state, 'cancelled')
      return { ok: true }
    } catch {
      return failure('oauth_cancel_failed', 'Could not cancel the OAuth login.')
    }
  }

  return { start, poll, cancel }
}
