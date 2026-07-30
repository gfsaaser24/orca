/** App-lifetime TeamClaude singleton; window recreation only rebinds IPC push targets.
 * Config changes rebuild client/supervisor and kill an owned process before a port move. */
import { TeamclaudeConfigWatcher, type TcConnectionConfig } from './config'
import { TeamClaudeSupervisor as Supervisor } from '../services/profiles/teamclaude'
import type { SupervisorTransition } from './supervisor-types'
import { TeamclaudeClient, deriveReadiness, type TcStatusSnapshot } from './client'
import type { TcNativeAccountIdentity } from './client-mapping'
import { TeamclaudeControl } from './control'
import { TeamclaudeIpc } from './ipc'
import { createEffortHandlers } from './effort-handlers'
import { applyRouting, type RoutingKind, type RoutingSnapshot } from './routing-env'
import type { TcAccount, TcProxyStartResult, TcState } from '../../shared/teamclaude-types'
import { getProxyStartBlocker, getProxyStartCompletion } from './proxy-start-result'
import { createSupervisorProductionWiring } from './supervisor-production-wiring'
import { createEmptyTcState, ZERO_READINESS } from './teamclaude-state-defaults'

/** Read-only view of the fleet usage state for the rate-limit short-circuit
 *  (spec §4). Empty/nullable when not connected or usage capability is absent. */
export type TeamclaudeUsageSnapshot = {
  connected: boolean
  usageReady: boolean
  accounts: TcAccount[]
  activeAccountName: string | null
}

const DEFAULT_PORT = 3456
const CONNECTED: ReadonlySet<TcState['lifecycle']> = new Set([
  'adopted',
  'adopted-degraded',
  'owned'
])
export type TeamclaudeInitOptions = {
  nativeAccounts?: () => readonly TcNativeAccountIdentity[]
  onConnectionChange?: (connected: boolean) => void
}

class TeamclaudeService {
  private readonly watcher: TeamclaudeConfigWatcher
  private readonly ipc: TeamclaudeIpc
  private supervisor: Supervisor | null = null
  private client: TeamclaudeClient | null = null
  private control: TeamclaudeControl | null = null
  private config: TcConnectionConfig | null = null

  private state: TcState = createEmptyTcState(DEFAULT_PORT)

  constructor(private readonly options: TeamclaudeInitOptions = {}) {
    this.watcher = new TeamclaudeConfigWatcher()
    this.ipc = new TeamclaudeIpc({
      getState: () => this.state,
      pin: (accountId) => this.control?.pin(accountId) ?? notReady(),
      setRoutes: (routes) => this.control?.setRoutes(routes) ?? notReady(),
      setAccount: (payload) => this.control?.setAccount(payload) ?? notReady(),
      proxyStart: async (): Promise<TcProxyStartResult> => {
        const supervisor = this.supervisor
        const blocker = getProxyStartBlocker(this.config !== null, supervisor !== null)
        if (blocker) {
          return blocker
        }
        try {
          await supervisor!.retry()
          if (this.supervisor !== supervisor) {
            return getProxyStartBlocker(true, false)!
          }
          return getProxyStartCompletion(supervisor!.state)
        } catch (error) {
          return {
            ok: false,
            reason: 'start-failed',
            message: error instanceof Error ? error.message : 'TeamClaude could not be started.'
          }
        }
      },
      proxyStop: async (args) => {
        // D5 consent audit trail: the renderer's stop confirmation echoes how many
        // live sessions the user acknowledged would be cut. We DO proceed with the
        // stop (the user already confirmed in the dialog), but we record the
        // acknowledged count — in a log line and in the next pushed state's
        // reasonDetail — so the destructive stop is auditable after the fact.
        const confirmed = args?.confirmLiveSessions ?? 0
        console.log(`[teamclaude] proxy stop requested (confirmLiveSessions=${confirmed})`)
        await this.supervisor?.stop({ killOwned: true })
        this.patchState({
          lifecycle: 'offline',
          reasonKey: 'tc.reason.stopped',
          reasonDetail: `stopped by user (acknowledged ${confirmed} live session${confirmed === 1 ? '' : 's'})`
        })
      },
      logTail: () => this.client?.seedActivity() ?? Promise.resolve([]),
      ...createEffortHandlers(() => this.control)
    })
  }

  async start(): Promise<void> {
    this.config = await this.watcher.start()
    this.watcher.on('change', (next) => void this.onConfigChange(next))
    if (this.config) {
      await this.spinUp(this.config)
    } else {
      // D3: a missing/corrupt config file is "not set up yet", not a silent
      // no-op. Push a setup-needed state with a guidance reasonKey so the cockpit
      // renders the setup path instead of an indefinitely-blank surface. A config
      // that later appears fires the watcher → onConfigChange → spinUp.
      this.patchState({
        lifecycle: 'setup-needed',
        reasonKey: 'tc.reason.noConfig',
        reasonDetail:
          'TeamClaude is not configured yet — run `teamclaude` setup to create its config'
      })
    }
  }

  getRoutingSnapshot(): RoutingSnapshot {
    return (
      this.supervisor?.getRoutingSnapshot() ?? {
        proxyUp: false,
        port: this.config?.port ?? DEFAULT_PORT,
        caPath: null,
        knownPorts: [],
        orcaNetworkProxyConfigured: false
      }
    )
  }

  setOrcaNetworkProxyConfigured(configured: boolean): void {
    this.supervisor?.setOrcaNetworkProxyConfigured(configured)
  }

  getUsageSnapshot(): TeamclaudeUsageSnapshot {
    const connected = CONNECTED.has(this.state.lifecycle)
    const usageReady = connected && this.state.readiness.usageReady
    const accounts = usageReady ? this.state.accounts : []
    return {
      connected,
      usageReady,
      accounts,
      activeAccountName: usageReady ? this.state.currentAccount : null
    }
  }

  noteUnroutedLaunch(reason: string): void {
    this.patchState({
      reasonKey: 'launchedUnrouted',
      reasonDetail: `Claude launched unrouted (${reason})`
    })
  }

  private async onConfigChange(next: TcConnectionConfig | null): Promise<void> {
    const prev = this.config
    this.config = next
    const portChanged = (prev?.port ?? null) !== (next?.port ?? null)
    // Tear down the old client + supervisor; kill the old owned process first
    // when the port changed so it cannot squat the old port forever.
    await this.tearDown({ killOwned: portChanged })
    if (next) {
      await this.spinUp(next)
    } else {
      // Config disappeared/became unreadable at runtime → back to setup-needed
      // (D3), consistent with a missing config at startup.
      this.patchState({
        lifecycle: 'setup-needed',
        reasonKey: 'tc.reason.noConfig',
        reasonDetail: 'TeamClaude configuration was removed — run `teamclaude` setup to recreate it'
      })
    }
  }

  private async spinUp(config: TcConnectionConfig): Promise<void> {
    this.state = { ...createEmptyTcState(config.port), snapshotAt: Date.now() }
    const client = new TeamclaudeClient({
      port: config.port,
      apiKey: config.apiKey,
      nativeAccounts: this.options.nativeAccounts
    })
    const control = new TeamclaudeControl({ port: config.port, apiKey: config.apiKey })
    this.client = client
    this.control = control

    client.on('status', (snapshot) => this.onStatus(snapshot))
    client.on('activity', (rows) => this.ipc.pushActivity(rows))
    client.on('pollError', () => this.supervisor?.invalidateSnapshot())

    const supervisorWiring = createSupervisorProductionWiring(client, config)
    const supervisor = new Supervisor(supervisorWiring.config, supervisorWiring.deps)
    this.supervisor = supervisor
    supervisor.on('transition', (t) => void this.onTransition(t, control, supervisor))

    client.start()
    await supervisor.start()
  }

  private async tearDown(opts: { killOwned: boolean }): Promise<void> {
    this.client?.stop()
    this.client = null
    this.control = null
    if (this.supervisor) {
      await this.supervisor.stop({ killOwned: opts.killOwned })
      this.supervisor = null
    }
  }

  private async onTransition(
    t: SupervisorTransition,
    control: TeamclaudeControl,
    supervisor: Supervisor
  ): Promise<void> {
    this.patchState({
      lifecycle: t.lifecycle,
      reasonKey: t.reasonKey,
      reasonDetail: t.reasonDetail,
      owned: t.owned,
      serverVersion: t.serverVersion,
      capabilities: t.capabilities,
      bootId: t.bootId
    })
    // Cert preflight at adopt/owned: a routed launch needs the MITM CA. If the
    // server is too old to answer certs/ensure, caPath stays null → launches go
    // unrouted (spec §7), never a broken MITM launch.
    if (t.lifecycle === 'adopted' || t.lifecycle === 'owned') {
      const res = await control.ensureCerts()
      if (this.supervisor === supervisor) {
        supervisor.setCaPath(res.ok && res.caPath ? res.caPath : null)
      }
    } else if (t.lifecycle === 'setup-needed' || t.lifecycle === 'offline') {
      if (this.supervisor === supervisor) {
        supervisor.setCaPath(null)
      }
    }
  }

  private onStatus(snapshot: TcStatusSnapshot): void {
    void this.supervisor?.reAdoptHealthyListener({
      ok: true,
      version: snapshot.serverVersion,
      capabilities: snapshot.capabilities,
      bootId: snapshot.bootId
    })
    const capabilities = snapshot.capabilities
    this.patchState({
      serverVersion: snapshot.serverVersion ?? this.state.serverVersion,
      bootId: snapshot.bootId ?? this.state.bootId,
      capabilities,
      currentAccount: snapshot.currentAccount,
      accounts: snapshot.accounts,
      routes: snapshot.routes
    })
  }

  private patchState(patch: Partial<TcState>): void {
    const wasConnected = CONNECTED.has(this.state.lifecycle)
    const merged: TcState = { ...this.state, ...patch, snapshotAt: Date.now() }
    merged.readiness = CONNECTED.has(merged.lifecycle)
      ? deriveReadiness(merged.capabilities)
      : ZERO_READINESS
    this.state = merged
    this.ipc.pushState(merged)
    const connected = CONNECTED.has(merged.lifecycle)
    if (connected !== wasConnected) {
      this.options.onConnectionChange?.(connected)
    }
  }

  async dispose(): Promise<void> {
    this.watcher.stop()
    await this.tearDown({ killOwned: false })
    this.ipc.dispose()
  }
}

function notReady(): Promise<{ ok: false; error: string }> {
  return Promise.resolve({ ok: false, error: 'TeamClaude is not connected' })
}

// --- module singleton -------------------------------------------------------

let singleton: TeamclaudeService | null = null
let initialStateReady: Promise<void> | null = null

/**
 * Initialize the TeamClaude integration exactly once. Call from the app-lifetime
 * startup path in `index.ts` (alongside daemon/agent-hook startup), NEVER from a
 * window-recreation path. Idempotent: a second call is a no-op.
 */
export function initTeamclaude(options: TeamclaudeInitOptions = {}): void {
  if (singleton) {
    return
  }
  singleton = new TeamclaudeService(options)
  initialStateReady = singleton.start().catch((error) => {
    console.warn(
      '[teamclaude] Initial state probe failed:',
      error instanceof Error ? error.message : String(error)
    )
  })
}

/** Native-auth mutations wait for the initial TeamClaude probe so app startup
 * cannot rotate credentials while an already-running proxy owns routing. */
export function waitForTeamclaudeInitialState(): Promise<void> {
  return initialStateReady ?? Promise.resolve()
}

/** Fleet usage snapshot for the rate-limit short-circuit (spec §4). Empty-safe:
 *  returns a disconnected snapshot when the module is not initialized. */
export function getTeamclaudeUsageSnapshot(): TeamclaudeUsageSnapshot {
  return (
    singleton?.getUsageSnapshot() ?? {
      connected: false,
      usageReady: false,
      accounts: [],
      activeAccountName: null
    }
  )
}

/** Routing snapshot for the seam wave: `applyRouting(env, kind, snapshot)`. */
export function getTeamclaudeRoutingSnapshot(): RoutingSnapshot {
  return (
    singleton?.getRoutingSnapshot() ?? {
      proxyUp: false,
      port: DEFAULT_PORT,
      caPath: null,
      knownPorts: [],
      orcaNetworkProxyConfigured: false
    }
  )
}

/** Convenience for the seams: apply routing using the live snapshot. */
export function applyTeamclaudeRouting(
  env: NodeJS.ProcessEnv,
  kind: RoutingKind
): ReturnType<typeof applyRouting> {
  return applyRouting(env, kind, getTeamclaudeRoutingSnapshot())
}

export function setOrcaNetworkProxyConfigured(configured: boolean): void {
  singleton?.setOrcaNetworkProxyConfigured(configured)
}

/** Persist the launch-time direct-fallback signal consumed by the cockpit. */
export function noteTeamclaudeUnroutedLaunch(reason: string): void {
  singleton?.noteUnroutedLaunch(reason)
}

export async function disposeTeamclaude(): Promise<void> {
  if (!singleton) {
    return
  }
  await waitForTeamclaudeInitialState()
  await singleton.dispose()
  singleton = null
  initialStateReady = null
}
