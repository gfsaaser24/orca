/**
 * TeamClaude supervisor — the adopt-or-spawn state machine. Spec §4 (supervisor
 * state machine).
 *
 * States (contract TcProxyLifecycle): probing → adopted | adopted-degraded |
 * owned | setup-needed | offline.
 *
 * Key invariants:
 *  - We spawn the RESOLVED Node entrypoint DIRECTLY (never the `.cmd`/shim): a
 *    shell-wrapper PID makes the ownership marker meaningless and killing it
 *    orphans the real listener. The desktop app uses `shell:true`; we must not.
 *  - Detached spawn (`detached, stdio:'ignore', windowsHide, unref`) → the owned
 *    server outlives Orca TC by default; a relaunch RECLAIMS it via the marker.
 *  - Reclaim requires pid alive AND process start time within ±2s of the
 *    marker's `startedAt` AND port match — a PID-recycled impostor is adopted
 *    instead.
 *  - On owned-child exit we RE-PROBE (TOCTOU: teamclaude exits clean on
 *    port-in-use) — a healthy listener means adopt, not crash-loop.
 *  - The no-accounts exit code → setup-needed (never a backoff loop).
 *
 * Everything external (probe, spawn, marker IO, clocks, entrypoint resolution)
 * is injected so the machine is unit-testable with fakes.
 */
import { EventEmitter } from 'node:events'
import type { TcProxyLifecycle } from '../../shared/teamclaude-types'
import type { RoutingSnapshot } from './routing-env'
import {
  NO_ACCOUNTS_EXIT_CODE,
  BACKOFF_CAP,
  RECLAIM_TOLERANCE_MS,
  SNAPSHOT_TTL_MS,
  PORT_HISTORY
} from './supervisor-types'
import { TimerBag, SnapshotState, deriveMonitorTransition } from './supervisor-support'
import { LivenessMonitor } from './supervisor-monitor'
import type {
  EntrypointResolution,
  ProbeResult,
  SpawnedChild,
  SupervisorConfig,
  SupervisorDeps
} from './supervisor-types'

export class Supervisor extends EventEmitter {
  private readonly deps: SupervisorDeps
  private port: number
  private binPath: string | null

  private lifecycle: TcProxyLifecycle = 'probing'
  private owned = false
  private serverVersion: string | null = null
  private capabilities: string[] = []
  private bootId: string | null = null

  private child: SpawnedChild | null = null
  private stopping = false
  private restartAttempts = 0
  private generation = 0

  private readonly timers: TimerBag
  private readonly snap = new SnapshotState(SNAPSHOT_TTL_MS, PORT_HISTORY)
  private readonly liveness: LivenessMonitor

  constructor(config: SupervisorConfig, deps: SupervisorDeps) {
    super()
    this.deps = deps
    this.port = config.port
    this.binPath = config.binPath
    this.timers = new TimerBag(deps.setTimeoutFn, deps.clearTimeoutFn)
    this.liveness = new LivenessMonitor({
      timers: this.timers,
      watchdogMs: deps.watchdogMs,
      generation: () => this.generation,
      stopping: () => this.stopping,
      owned: () => this.owned,
      hasChild: () => this.child !== null,
      now: () => this.deps.now(),
      random: () => this.deps.random(),
      probe: () => this.deps.probe(),
      markUp: (p) => this.markUp(p),
      refreshFromProbe: (p) => this.refreshFromProbe(p),
      invalidateSnapshot: () => this.invalidateSnapshot(),
      transition: (l, k, d) => this.transition(l, k, d),
      onProbeUp: (p) => this.onProbeUp(p),
      spawnFlow: () => this.spawnFlow(),
      clearMarker: () => this.deps.clearMarker(),
      setOwned: (v) => {
        this.owned = v
      },
      scheduleBackoffRestart: (k, d) => this.scheduleBackoffRestart(k, d)
    })
  }

  get state(): TcProxyLifecycle {
    return this.lifecycle
  }

  /** The CA path is set by init after certs/ensure at adopt/owned transition. */
  setCaPath(caPath: string | null): void {
    this.snap.setCaPath(caPath)
  }

  /** Seam-supplied flag (the seam wave provides the real settings value). */
  setOrcaNetworkProxyConfigured(configured: boolean): void {
    this.snap.setNetworkProxyConfigured(configured)
  }

  /** Cached routing snapshot for the seams (owned here; seams stay sync). */
  getRoutingSnapshot(): RoutingSnapshot {
    return this.snap.build(this.deps.now(), this.port)
  }

  /** Synchronous snapshot invalidation on any observed liveness change. */
  invalidateSnapshot(): void {
    this.snap.invalidate()
  }

  async start(): Promise<void> {
    this.stopping = false
    this.generation++
    await this.probeAndRoute()
  }

  /** Manual retry from offline / setup-needed. */
  async retry(): Promise<void> {
    this.restartAttempts = 0
    await this.start()
  }

  /**
   * Stop supervision. By default the detached owned server is LEFT RUNNING
   * (reclaimed on next launch). `killOwned` (quit-with-stop toggle, or a
   * port-change migration) terminates the owned child first — teamclaude binds
   * once and /reload does not rebind, so an orphan would squat the port.
   */
  async stop(opts?: { killOwned?: boolean }): Promise<void> {
    this.stopping = true
    this.generation++
    this.timers.clearAll()
    this.invalidateSnapshot()
    if (opts?.killOwned && this.owned && this.child) {
      try {
        this.child.kill()
      } catch {
        /* best-effort */
      }
      this.deps.clearMarker()
    }
    this.child = null
  }

  // --- core flow ----------------------------------------------------------

  private async probeAndRoute(): Promise<void> {
    const gen = this.generation
    this.transition('probing', null, null)
    const probe = await this.deps.probe()
    if (gen !== this.generation) {
      return
    }

    if (probe.ok) {
      await this.onProbeUp(probe)
      return
    }
    // No listener → any marker is stale.
    const marker = this.deps.readMarker()
    if (marker) {
      this.deps.clearMarker()
    }
    await this.spawnFlow()
  }

  private async onProbeUp(probe: ProbeResult): Promise<void> {
    this.markUp(probe)
    const reclaimed = await this.tryReclaim()
    if (reclaimed) {
      this.owned = true
      this.child = null // reclaimed: the detached process has no child handle
      this.transition('owned', null, null)
      this.liveness.start(this.child !== null)
      return
    }
    this.owned = false
    if (this.deps.isSupported(probe.capabilities, probe.version)) {
      this.transition('adopted', null, null)
    } else {
      this.transition(
        'adopted-degraded',
        'tc.reason.degraded',
        `have ${probe.version ?? '?'}, missing required capabilities`
      )
    }
    this.liveness.start(this.child !== null)
  }

  /** Reclaim only if the live listener is provably our previously-owned one. */
  private async tryReclaim(): Promise<boolean> {
    const marker = this.deps.readMarker()
    if (!marker) {
      return false
    }
    if (marker.port !== this.port) {
      return false
    }
    if (!this.deps.processAlive(marker.pid)) {
      return false
    }
    const started = await this.deps.processStartTime(marker.pid)
    if (started === null) {
      return false
    }
    return Math.abs(started - marker.startedAt) <= RECLAIM_TOLERANCE_MS
  }

  private async spawnFlow(): Promise<void> {
    const gen = this.generation
    const resolution = await this.deps.resolveEntrypoint(this.binPath)
    if (gen !== this.generation) {
      return
    }
    if (!resolution) {
      this.transition(
        'setup-needed',
        'tc.reason.setupNeeded',
        'teamclaude not found or its Node entrypoint could not be resolved'
      )
      return
    }
    this.spawnChild(resolution)
  }

  private spawnChild(resolution: EntrypointResolution): void {
    let child: SpawnedChild
    try {
      child = this.deps.spawnServer(resolution)
    } catch (error) {
      this.handleSpawnDeath(null, (error as Error).message)
      return
    }
    if (child.pid == null) {
      this.handleSpawnDeath(null, 'spawn produced no pid')
      return
    }
    this.child = child
    this.owned = true
    this.deps.writeMarker({ pid: child.pid, port: this.port, startedAt: this.deps.now() })
    this.snap.rememberPort(this.port)
    this.transition('owned', null, null)
    const gen = this.generation
    child.onExit((code) => {
      if (gen !== this.generation || this.child !== child) {
        return
      }
      this.child = null
      void this.onOwnedExit(code)
    })
    // Confirm the listener comes up; refreshes capabilities/version + snapshot.
    this.liveness.start(true, true)
  }

  private async onOwnedExit(code: number | null): Promise<void> {
    if (this.stopping) {
      return
    }
    this.invalidateSnapshot()
    if (code === NO_ACCOUNTS_EXIT_CODE) {
      this.deps.clearMarker()
      this.transition('setup-needed', 'tc.reason.noAccounts', 'run `teamclaude login`')
      return
    }
    // TOCTOU: teamclaude exits clean on port-in-use — re-probe before restarting.
    const probe = await this.deps.probe()
    if (probe.ok) {
      this.deps.clearMarker()
      this.owned = false
      await this.onProbeUp(probe)
      return
    }
    this.deps.clearMarker()
    this.scheduleBackoffRestart('tc.reason.crashed', `server exited (code ${code ?? 'null'})`)
  }

  private handleSpawnDeath(code: number | null, detail: string): void {
    if (this.stopping) {
      return
    }
    this.child = null
    this.deps.clearMarker()
    this.scheduleBackoffRestart('tc.reason.crashed', detail || `code ${code ?? 'null'}`)
  }

  private scheduleBackoffRestart(reasonKey: string, detail: string): void {
    this.restartAttempts++
    if (this.restartAttempts > BACKOFF_CAP) {
      this.transition(
        'offline',
        'tc.reason.offline',
        `${detail} (gave up after ${BACKOFF_CAP} tries)`
      )
      return
    }
    const backoff = Math.min(1000 * 2 ** (this.restartAttempts - 1), 30_000)
    this.transition('probing', reasonKey, detail)
    this.timers.set(backoff, () => void this.spawnFlow())
  }

  // --- helpers ------------------------------------------------------------

  private markUp(probe: ProbeResult): void {
    this.snap.recordUp(this.deps.now())
    this.serverVersion = probe.version
    this.capabilities = probe.capabilities
    this.bootId = probe.bootId
    this.restartAttempts = 0
  }

  private refreshFromProbe(probe: ProbeResult): void {
    const supported = this.deps.isSupported(probe.capabilities, probe.version)
    const next = deriveMonitorTransition(this.owned, supported, probe.version, this.lifecycle)
    if (next) {
      this.transition(next[0], next[1], next[2])
    }
  }

  private transition(
    lifecycle: TcProxyLifecycle,
    reasonKey: string | null,
    reasonDetail: string | null
  ): void {
    this.lifecycle = lifecycle
    if (lifecycle === 'probing' || lifecycle === 'setup-needed' || lifecycle === 'offline') {
      this.invalidateSnapshot()
    }
    this.emit('transition', {
      lifecycle,
      reasonKey,
      reasonDetail,
      owned: this.owned,
      serverVersion: this.serverVersion,
      capabilities: this.capabilities,
      bootId: this.bootId
    })
  }
}
