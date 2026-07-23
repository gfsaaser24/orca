/**
 * TeamClaude app-lifetime singleton. Spec §4 (module lifecycle).
 *
 * Wires config-watch → supervisor → client → control → IPC, assembles the
 * contract `TcState`, and owns the routing snapshot the seam wave reads. This is
 * a daemon-init-style singleton: it initializes ONCE from the app-lifetime path
 * in `index.ts` (NOT from window recreation, which would duplicate SSE
 * connections, spawns, and marker churn). Only the `tc:state` push target
 * rebinds per window, handled inside `TeamclaudeIpc` via `getAllWindows()`.
 *
 * On a config port/apiKey change the client + supervisor are torn down and
 * re-initialized; a port change stops the old owned process FIRST (teamclaude
 * binds once and /reload does not rebind — an orphan would squat the old port).
 */
import { app } from 'electron'
import { TeamclaudeConfigWatcher, type TcConnectionConfig } from './config'
import { Supervisor } from './supervisor'
import type { SupervisorConfig, SupervisorDeps, SupervisorTransition } from './supervisor-types'
import {
  resolveNodeEntrypoint,
  spawnServerProcess,
  readMarkerFile,
  writeMarkerFile,
  clearMarkerFile,
  markerPath,
  processAlive,
  processStartTime,
  killProcess
} from './supervisor-runtime'
import { TeamclaudeClient, deriveReadiness, type TcStatusSnapshot } from './client'
import { TeamclaudeControl } from './control'
import { TeamclaudeIpc } from './ipc'
import { applyRouting, type RoutingKind, type RoutingSnapshot } from './routing-env'
import type { TcAccount, TcReadiness, TcState } from '../../shared/teamclaude-types'

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
const ZERO_READINESS: TcReadiness = { usageReady: false, routingReady: false, controlReady: false }

class TeamclaudeService {
  private readonly watcher: TeamclaudeConfigWatcher
  private readonly ipc: TeamclaudeIpc
  private supervisor: Supervisor | null = null
  private client: TeamclaudeClient | null = null
  private control: TeamclaudeControl | null = null
  private config: TcConnectionConfig | null = null

  private state: TcState = emptyState(DEFAULT_PORT)

  constructor() {
    this.watcher = new TeamclaudeConfigWatcher()
    this.ipc = new TeamclaudeIpc({
      pin: (accountId) => this.control?.pin(accountId) ?? notReady(),
      setRoutes: (routes) => this.control?.setRoutes(routes) ?? notReady(),
      setAccount: (payload) => this.control?.setAccount(payload) ?? notReady(),
      proxyStart: async () => {
        await this.supervisor?.retry()
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
      logTail: () => this.client?.seedActivity() ?? Promise.resolve([])
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
    // Active-meter selection (spec §4): pinned, else first non-disabled, else first.
    const active =
      accounts.find((a) => a.pinned) ?? accounts.find((a) => a.status !== 'disabled') ?? accounts[0]
    return { connected, usageReady, accounts, activeAccountName: active?.name ?? null }
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
    this.state = { ...emptyState(config.port), snapshotAt: Date.now() }
    const client = new TeamclaudeClient({ port: config.port, apiKey: config.apiKey })
    const control = new TeamclaudeControl({ port: config.port, apiKey: config.apiKey })
    this.client = client
    this.control = control

    client.on('status', (snapshot) => this.onStatus(snapshot))
    client.on('activity', (rows) => this.ipc.pushActivity(rows))
    client.on('pollError', () => this.supervisor?.invalidateSnapshot())

    const supervisor = new Supervisor(toSupervisorConfig(config), buildDeps(client, config))
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
    const capabilities = snapshot.capabilities
    this.patchState({
      serverVersion: snapshot.serverVersion ?? this.state.serverVersion,
      bootId: snapshot.bootId ?? this.state.bootId,
      capabilities,
      accounts: snapshot.accounts,
      routes: snapshot.routes
    })
  }

  private patchState(patch: Partial<TcState>): void {
    const merged: TcState = { ...this.state, ...patch, snapshotAt: Date.now() }
    merged.readiness = CONNECTED.has(merged.lifecycle)
      ? deriveReadiness(merged.capabilities)
      : ZERO_READINESS
    this.state = merged
    this.ipc.pushState(merged)
  }

  async dispose(): Promise<void> {
    this.watcher.stop()
    await this.tearDown({ killOwned: false })
    this.ipc.dispose()
  }
}

function toSupervisorConfig(config: TcConnectionConfig): SupervisorConfig {
  return { port: config.port, apiKey: config.apiKey, binPath: config.binPath }
}

function buildDeps(client: TeamclaudeClient, config: TcConnectionConfig): SupervisorDeps {
  const userData = safeUserData()
  const marker = markerPath(userData)
  return {
    probe: async () => {
      try {
        const s = await client.fetchStatus()
        return {
          ok: true,
          version: s.serverVersion,
          capabilities: s.capabilities,
          bootId: s.bootId
        }
      } catch {
        return { ok: false, version: null, capabilities: [], bootId: null }
      }
    },
    spawnServer: (resolution) => spawnServerProcess(resolution, {}, userData),
    resolveEntrypoint: (binPath) => resolveNodeEntrypoint(binPath ?? config.binPath),
    readMarker: () => readMarkerFile(marker),
    writeMarker: (m) => writeMarkerFile(marker, m),
    clearMarker: () => clearMarkerFile(marker),
    processAlive,
    killPid: killProcess,
    processStartTime,
    isSupported: (capabilities) => deriveReadiness(capabilities).routingReady,
    now: Date.now,
    random: Math.random,
    setTimeoutFn: setTimeout,
    clearTimeoutFn: clearTimeout,
    watchdogMs: 4000
  }
}

function safeUserData(): string {
  try {
    return app.getPath('userData')
  } catch {
    return process.cwd()
  }
}

function emptyState(port: number): TcState {
  return {
    lifecycle: 'probing',
    readiness: ZERO_READINESS,
    reasonKey: null,
    reasonDetail: null,
    port,
    serverVersion: null,
    bootId: null,
    capabilities: [],
    owned: false,
    accounts: [],
    routes: [],
    snapshotAt: Date.now()
  }
}

function notReady(): Promise<{ ok: false; error: string }> {
  return Promise.resolve({ ok: false, error: 'TeamClaude is not connected' })
}

// --- module singleton -------------------------------------------------------

let singleton: TeamclaudeService | null = null

/**
 * Initialize the TeamClaude integration exactly once. Call from the app-lifetime
 * startup path in `index.ts` (alongside daemon/agent-hook startup), NEVER from a
 * window-recreation path. Idempotent: a second call is a no-op.
 */
export function initTeamclaude(): void {
  if (singleton) {
    return
  }
  singleton = new TeamclaudeService()
  void singleton.start()
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

export async function disposeTeamclaude(): Promise<void> {
  if (!singleton) {
    return
  }
  await singleton.dispose()
  singleton = null
}
