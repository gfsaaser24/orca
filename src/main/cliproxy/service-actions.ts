import type {
  CpaActionResult,
  CpaOauthFlow,
  CpaOauthStatus,
  CpaProviderKind
} from '../../shared/cliproxy-types'
import type { ServiceSupervisor } from '../services/service-supervisor'
import type { CpaIpcHandlers } from './ipc'
import { CpaManagementError, type ManagementClient } from './management-client'
import type { createModelsSync } from './models-sync'
import type { createOauthFlows } from './oauth-flows'
import { cpaFailure, messageOf } from './state-derivation'

type ActionHandlers = Omit<CpaIpcHandlers, 'getState'>

type CpaServiceActionContext = {
  client(): ManagementClient | null
  oauth(): ReturnType<typeof createOauthFlows> | null
  modelsSync(): ReturnType<typeof createModelsSync> | null
  supervisor(): ServiceSupervisor | null
  refresh(): Promise<void>
  stopModules(): void
  invalidateModels(): void
  markStopped(): void
  /** Re-runs the full startup sequence (config ensure + module construction).
   * Startup bails before building the supervisor whenever the owned config or
   * secure storage is not usable yet, so "Finish setup" must be able to retry
   * that sequence rather than fail on a supervisor that never existed. */
  restart(): Promise<void>
  /** Opens a provider authorize URL in the user's default browser. */
  openExternal(url: string): Promise<void>
}

export function createCpaServiceActions(context: CpaServiceActionContext): ActionHandlers {
  const mutate = async (
    operation: (client: ManagementClient) => Promise<void>
  ): Promise<CpaActionResult> => {
    const client = context.client()
    if (!client) {
      return cpaFailure('management-unavailable', 'CLIProxyAPI management is unavailable.')
    }
    try {
      await operation(client)
      await context.refresh()
      return { ok: true }
    } catch (error) {
      return cpaFailure(
        error instanceof CpaManagementError ? error.code : 'management-failed',
        messageOf(error)
      )
    }
  }

  return {
    async loginStart(provider: CpaProviderKind): Promise<CpaOauthFlow | CpaActionResult> {
      const flow = await (context.oauth()?.start(provider) ?? unavailableFlow())
      // A `browser` flow only returns the authorize URL — something has to open
      // it. Without this the UI sat on "Waiting for sign-in in your browser…"
      // while no browser ever appeared. Device flows show their URL + code in
      // the dialog instead, so they must not be auto-opened.
      if ('kind' in flow && flow.kind === 'browser' && flow.url) {
        void context.openExternal(flow.url)
      }
      return flow
    },
    loginPoll(state: string): Promise<CpaOauthStatus> {
      return context.oauth()?.poll(state) ?? Promise.resolve('error')
    },
    loginCancel(state: string): Promise<CpaActionResult> {
      return context.oauth()?.cancel(state) ?? unavailableAction()
    },
    accountSetDisabled: (payload) =>
      mutate((client) => client.patchAuthStatus(payload).then(() => undefined)),
    accountSetFields: (payload) =>
      mutate((client) => client.patchAuthFields(payload).then(() => undefined)),
    accountDelete: (payload) =>
      mutate((client) => client.deleteAuthFile(payload.name).then(() => undefined)),
    aliasSet: (payload) =>
      mutate(async (client) => {
        await client.setAliases(payload.channel, payload.aliases)
        await context.modelsSync()?.forceSync()
        context.invalidateModels()
      }),
    async serviceStart(): Promise<CpaActionResult> {
      // No supervisor means startup bailed before constructing one (drifted or
      // missing config, secure storage unavailable). Re-run startup first: it
      // self-heals an owned config, so the retry usually succeeds outright.
      if (!context.supervisor()) {
        try {
          await context.restart()
        } catch (error) {
          return cpaFailure('start-failed', messageOf(error))
        }
      }
      const supervisor = context.supervisor()
      if (!supervisor) {
        return cpaFailure('supervisor-unavailable', 'CLIProxyAPI setup is incomplete.')
      }
      try {
        await supervisor.retry()
        await context.refresh()
        return { ok: true }
      } catch (error) {
        return cpaFailure('start-failed', messageOf(error))
      }
    },
    async serviceStop(): Promise<CpaActionResult> {
      try {
        await context.supervisor()?.stop({ killOwned: true })
        context.stopModules()
        context.markStopped()
        return { ok: true }
      } catch (error) {
        return cpaFailure('stop-failed', messageOf(error))
      }
    },
    logsTail(cursor) {
      return context.client()?.logsTail(cursor) ?? Promise.resolve({ lines: [], nextCursor: null })
    }
  }
}

function unavailableFlow(): Promise<CpaOauthFlow | CpaActionResult> {
  return Promise.resolve(
    cpaFailure('management-unavailable', 'CLIProxyAPI management is unavailable.')
  )
}

function unavailableAction(): Promise<CpaActionResult> {
  return Promise.resolve(
    cpaFailure('management-unavailable', 'CLIProxyAPI management is unavailable.')
  )
}
