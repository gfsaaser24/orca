import path from 'node:path'
import type { CpaState } from '../../shared/cliproxy-types'
import { getCanonicalUserDataPath, type Store } from '../persistence'
import { createCliProxyApiProfile } from '../services/profiles/cliproxyapi'
import {
  createServiceSupervisor,
  type ServiceSupervisor,
  type ServiceTransition
} from '../services/service-supervisor'
import { readConnectionConfig } from '../teamclaude/config'
import { CpaConfigOwner } from './config-owner'
import { CpaIpc } from './ipc'
import { ManagementClient } from './management-client'
import { createModelsSync } from './models-sync'
import { createOauthFlows } from './oauth-flows'
import { CpaProvisioning } from './provisioning'
import { createCpaServiceActions } from './service-actions'
import { createCpaSupervisorDeps } from './service-runtime'
import {
  deriveCpaReadiness,
  emptyCpaState,
  messageOf,
  publicCpaLifecycle,
  validCpaPort,
  type CpaStatePatch
} from './state-derivation'
import { refreshCpaState } from './state-refresh'
import { CpaTeamclaudeConnector } from './teamclaude-backend-connector'
import { createUsageAggregator } from './usage-aggregator'

const REFRESH_INTERVAL_MS = 5_000

export class CpaService {
  private state: CpaState
  private readonly configOwner: CpaConfigOwner
  private readonly ipc: CpaIpc
  private supervisor: ServiceSupervisor | null = null
  private client: ManagementClient | null = null
  private oauth: ReturnType<typeof createOauthFlows> | null = null
  private usage: ReturnType<typeof createUsageAggregator> | null = null
  private modelsSync: ReturnType<typeof createModelsSync> | null = null
  private provisioning: CpaProvisioning | null = null
  private refreshTimer: NodeJS.Timeout | null = null
  private refreshPending: Promise<void> | null = null
  private usageStarted = false
  private modelsStarted = false
  private keyMismatch = false
  private configDrift: string[] = []
  private apiKey: string | null = null
  private serviceStopped = true
  private supervisorReason: Pick<CpaState, 'reasonKey' | 'reasonDetail'> = {
    reasonKey: null,
    reasonDetail: null
  }
  private lastSyncedModels = ''

  constructor(private readonly store: Store) {
    this.state = emptyCpaState(validCpaPort(store.getSettings().cliproxyPort))
    this.configOwner = new CpaConfigOwner({
      userDataPath: getCanonicalUserDataPath(),
      settings: store,
      isServiceStopped: () => this.serviceStopped,
      // Fleet delegation: CPA's Claude provider forwards through the local
      // teamclaude proxy instead of holding its own copies of the fleet's
      // OAuth tokens (refresh-token rotation would race the two holders).
      claudeDelegation: async () => {
        const config = await readConnectionConfig()
        if (!config?.apiKey || !config.port) {
          return null
        }
        return { apiKey: config.apiKey, baseUrl: `http://127.0.0.1:${config.port}` }
      }
    })
    const actions = createCpaServiceActions({
      client: () => this.client,
      oauth: () => this.oauth,
      modelsSync: () => this.modelsSync,
      supervisor: () => this.supervisor,
      refresh: () => this.refresh(),
      stopModules: () => this.stopModules(),
      invalidateModels: () => {
        this.lastSyncedModels = ''
      },
      markStopped: () => this.markStopped(),
      restart: () => this.start()
    })
    this.ipc = new CpaIpc({ getState: () => this.state, ...actions })
  }

  async start(): Promise<void> {
    // Re-entrant: serviceStart() calls this to recover from a startup that
    // bailed before building modules. Tear down anything a prior attempt left
    // behind so a retry cannot leak a second supervisor, client, or timer.
    if (this.supervisor || this.refreshTimer) {
      await this.dispose({ keepIpc: true })
    }
    const ownedConfig = await this.ensureOwnedConfig()
    if (!ownedConfig) {
      return
    }
    this.state = { ...emptyCpaState(ownedConfig.port), snapshotAt: Date.now() }
    const profile = createCliProxyApiProfile({
      getBinaryPath: () =>
        this.store.getSettings().cliproxyBinaryPath?.trim() ||
        process.env.CLIPROXYAPI_BIN?.trim() ||
        null,
      getConfigPath: () => ownedConfig.configPath,
      getApiKey: () => ownedConfig.apiKey,
      markerPath: path.join(this.configOwner.directory, 'owned-process.json'),
      port: ownedConfig.port
    })
    this.supervisor = createServiceSupervisor(profile, createCpaSupervisorDeps())
    this.client = new ManagementClient({
      port: ownedConfig.port,
      managementKey: ownedConfig.managementKey,
      apiKey: ownedConfig.apiKey,
      onKeyMismatch: () => {
        this.keyMismatch = true
        this.patchState({
          reasonKey: 'cpa.reason.managementKeyMismatch',
          reasonDetail: 'Management calls are stopped until config-key recovery.'
        })
      },
      onVersion: (version) => this.patchState({ version })
    })
    this.apiKey = ownedConfig.apiKey

    const teamclaude = new CpaTeamclaudeConnector()
    this.provisioning = new CpaProvisioning(teamclaude, teamclaude)
    this.oauth = createOauthFlows(this.client)
    this.usage = createUsageAggregator(
      this.client,
      path.join(this.configOwner.directory, 'usage.json')
    )
    this.modelsSync = createModelsSync(this.client, teamclaude)
    this.supervisor.on('transition', (transition: ServiceTransition) => {
      this.onSupervisorTransition(transition)
    })

    await this.supervisor.start()
    await this.refresh()
    this.refreshTimer = setInterval(() => void this.refresh(), REFRESH_INTERVAL_MS)
    this.refreshTimer.unref?.()
  }

  markStartupFailure(error: unknown): void {
    this.patchState({
      lifecycle: 'offline',
      reasonKey: 'cpa.reason.startFailed',
      reasonDetail: messageOf(error)
    })
  }

  async dispose(options: { keepIpc?: boolean } = {}): Promise<void> {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer)
      this.refreshTimer = null
    }
    this.stopModules()
    await this.supervisor?.stop({ killOwned: false })
    // A restart reuses the same IPC surface (its channels are registered once
    // per app lifetime); only a real teardown disposes it.
    if (options.keepIpc) {
      this.supervisor = null
      this.client = null
      this.oauth = null
      this.usage = null
      this.modelsSync = null
      this.provisioning = null
      return
    }
    this.ipc.dispose()
  }

  private async ensureOwnedConfig() {
    try {
      const config = await this.configOwner.ensure()
      if (config.drifted) {
        this.patchState({
          lifecycle: 'setup-needed',
          reasonKey: 'cpa.reason.configDrift',
          reasonDetail: `Orca-owned config keys changed: ${config.driftKeys.join(', ')}`,
          port: config.port
        })
        return null
      }
      return config
    } catch (error) {
      this.patchState({
        lifecycle: 'setup-needed',
        reasonKey: 'cpa.reason.secureSetupUnavailable',
        reasonDetail: messageOf(error)
      })
      return null
    }
  }

  private onSupervisorTransition(transition: ServiceTransition): void {
    this.supervisorReason = {
      reasonKey: transition.reasonKey,
      reasonDetail: transition.reasonDetail
    }
    this.serviceStopped = transition.probeStatus === 'down'
    const connected =
      transition.lifecycle === 'owned' ||
      transition.lifecycle === 'adopted' ||
      transition.lifecycle === 'adopted-degraded'
    if (connected) {
      this.startModules()
    }
    this.patchState({
      lifecycle: publicCpaLifecycle(transition.lifecycle),
      owned: transition.owned,
      reasonKey: transition.reasonKey,
      reasonDetail: transition.reasonDetail,
      readiness: {
        alive: transition.probeStatus !== 'down',
        modelsReady: transition.probeStatus === 'ready',
        managementReady: this.state.readiness.managementReady,
        routingLinked: this.state.readiness.routingLinked
      }
    })
    if (connected) {
      void this.refresh()
    }
  }

  private startModules(): void {
    if (this.usage && !this.usageStarted) {
      this.usageStarted = true
      void Promise.resolve(this.usage.start()).catch(() => {
        this.usageStarted = false
      })
    }
  }

  private startModelsSync(): void {
    if (this.modelsSync && !this.modelsStarted) {
      this.modelsStarted = true
      this.modelsSync.start()
    }
  }

  private stopModules(): void {
    this.usage?.stop()
    this.modelsSync?.stop()
    this.usageStarted = false
    this.modelsStarted = false
  }

  private refresh(): Promise<void> {
    if (this.refreshPending) {
      return this.refreshPending
    }
    const pending = this.refreshState().finally(() => {
      if (this.refreshPending === pending) {
        this.refreshPending = null
      }
    })
    this.refreshPending = pending
    return pending
  }

  private async refreshState(): Promise<void> {
    if (!this.client || !this.apiKey) {
      return
    }
    const outcome = await refreshCpaState({
      state: this.state,
      client: this.client,
      configOwner: this.configOwner,
      provisioning: this.provisioning,
      modelsSync: this.modelsSync,
      apiKey: this.apiKey,
      keyMismatch: this.keyMismatch,
      configDrift: this.configDrift,
      lastSyncedModels: this.lastSyncedModels,
      supervisorReason: this.supervisorReason,
      usage: this.usage?.snapshot() ?? this.state.usage,
      startModelsSync: () => this.startModelsSync()
    })
    this.keyMismatch = outcome.keyMismatch
    this.configDrift = outcome.configDrift
    this.lastSyncedModels = outcome.lastSyncedModels
    this.patchState(outcome.patch)
  }

  private markStopped(): void {
    this.serviceStopped = true
    this.patchState({
      lifecycle: 'offline',
      reasonKey: 'cpa.reason.stopped',
      reasonDetail: 'CLIProxyAPI was stopped by the user.',
      readiness: {
        alive: false,
        modelsReady: false,
        managementReady: false,
        routingLinked: false
      }
    })
  }

  private patchState(patch: CpaStatePatch): void {
    this.state = {
      ...this.state,
      ...patch,
      readiness: patch.readiness ? deriveCpaReadiness(patch.readiness) : this.state.readiness,
      snapshotAt: Date.now()
    }
    this.ipc.pushState(this.state)
  }
}
