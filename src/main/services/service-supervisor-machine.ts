/** Internal state-machine implementation behind the public supervisor factory. */
import { EventEmitter } from 'node:events'
import { ServiceSupervisorRecovery, ServiceTimerBag } from './service-supervisor-recovery'
import { ServiceProcessControl } from './service-supervisor-runtime'
import type {
  ServiceLifecycle,
  ServiceOwnershipMarker,
  ServiceProbeStatus,
  ServiceProfile,
  ServiceReason,
  ServiceSpawnCommand,
  ServiceSpawnResolution,
  ServiceStopOptions,
  ServiceSupervisorDeps,
  ServiceTransition,
  SpawnedServiceChild
} from './service-supervisor-types'

export class ServiceSupervisor extends EventEmitter {
  private lifecycle: ServiceLifecycle = 'probing'
  private isOwned = false
  private child: SpawnedServiceChild | null = null
  private ownedPid: number | null = null
  private isStopping = false
  private generation = 0
  private lastProbeStatus: ServiceProbeStatus = 'down'
  private readonly timers: ServiceTimerBag
  private readonly processControl: ServiceProcessControl
  private readonly recovery: ServiceSupervisorRecovery

  constructor(
    private readonly profile: ServiceProfile,
    private readonly deps: ServiceSupervisorDeps
  ) {
    super()
    this.timers = new ServiceTimerBag(deps.setTimeoutFn, deps.clearTimeoutFn)
    this.processControl = new ServiceProcessControl(profile, deps)
    this.recovery = new ServiceSupervisorRecovery(profile, deps, this.timers, this.processControl, {
      generation: () => this.generation,
      stopping: () => this.isStopping,
      owned: () => this.isOwned,
      lifecycle: () => this.lifecycle,
      ownedPid: () => this.child?.pid ?? this.ownedPid,
      clearOwnedProcess: () => {
        this.child = null
        this.ownedPid = null
      },
      probe: () => this.probe(),
      routeLive: (status) => this.routeLiveStatus(status),
      reclaim: (marker, status) => this.reclaim(marker, status),
      spawn: () => this.spawnFlow(),
      terminateOwned: () => this.terminateOwnedForRestart(),
      transition: (lifecycle, reasonKey, detail) => this.transition(lifecycle, reasonKey, detail),
      reasonDetail: (reason, fallback) => this.reasonDetail(reason, fallback)
    })
  }

  get state(): ServiceLifecycle {
    return this.lifecycle
  }

  get owned(): boolean {
    return this.isOwned
  }

  async start(): Promise<void> {
    this.isStopping = false
    this.generation++
    this.timers.clearAll()
    await this.probeAndRoute()
  }

  async retry(): Promise<void> {
    this.recovery.resetForRetry()
    await this.start()
  }

  async reAdoptHealthyListener(status: Exclude<ServiceProbeStatus, 'down'>): Promise<void> {
    if (
      this.isStopping ||
      this.child ||
      (this.lifecycle !== 'setup-needed' && this.lifecycle !== 'offline')
    ) {
      return
    }
    if (this.profile.adoptionPolicy === 'owned-only') {
      const marker = this.processControl.readMarker()
      if (!(await this.processControl.provesOwnership(marker))) {
        return
      }
      this.generation++
      this.timers.clearAll()
      this.reclaim(marker!, status)
      return
    }
    this.generation++
    this.timers.clearAll()
    await this.routeLiveStatus(status)
  }

  async stop(options?: ServiceStopOptions): Promise<void> {
    this.isStopping = true
    this.generation++
    this.timers.clearAll()
    const killOwned = options?.killOwned ?? this.profile.stopPolicy.killOnQuitDefault
    if (killOwned && this.isOwned) {
      await this.processControl.stop(this.child)
    }
    this.child = null
    this.ownedPid = null
  }

  private async probeAndRoute(): Promise<void> {
    const generation = this.generation
    this.transition('probing', null, null)
    if (this.profile.adoptionPolicy === 'owned-only') {
      const marker = this.processControl.readMarker()
      const proven = await this.processControl.provesOwnership(marker)
      if (generation !== this.generation) {
        return
      }
      if (!proven) {
        if (marker) {
          this.processControl.clearMarker()
        }
        await this.spawnFlow()
        return
      }
      const status = await this.probe()
      if (generation === this.generation) {
        this.reclaim(marker!, status)
      }
      return
    }

    const status = await this.probe()
    if (generation !== this.generation) {
      return
    }
    if (status !== 'down') {
      await this.routeLiveStatus(status)
      return
    }
    if (this.processControl.readMarker()) {
      this.processControl.clearMarker()
    }
    await this.spawnFlow()
  }

  private async routeLiveStatus(status: Exclude<ServiceProbeStatus, 'down'>): Promise<void> {
    const marker = this.processControl.readMarker()
    if (await this.processControl.provesOwnership(marker)) {
      this.reclaim(marker!, status)
      return
    }
    if (marker) {
      this.processControl.clearMarker()
    }
    this.isOwned = false
    this.ownedPid = null
    this.recovery.recordAdoptedLive()
    if (status === 'ready') {
      this.transition('adopted', null, null)
    } else {
      this.transition(
        'adopted-degraded',
        this.profile.reasonKeys.degraded,
        this.reasonDetail('alive-unready', 'service is alive but not ready')
      )
    }
    this.recovery.startWatchdog()
  }

  private reclaim(marker: ServiceOwnershipMarker, status: ServiceProbeStatus): void {
    this.isOwned = true
    this.child = null
    this.ownedPid = marker.pid
    this.recovery.recordOwnedStatus(status)
    this.transition('owned', null, null)
    this.recovery.startWatchdog()
  }

  private async spawnFlow(): Promise<void> {
    const generation = this.generation
    let resolution: ServiceSpawnResolution
    try {
      resolution = await this.profile.resolveSpawn()
    } catch (error) {
      this.handleSpawnDeath(error instanceof Error ? error.message : String(error))
      return
    }
    if (generation !== this.generation) {
      return
    }
    if (resolution.kind === 'setup-needed') {
      this.transition('setup-needed', resolution.reasonKey, resolution.reasonDetail)
      this.recovery.startProbeOnlyRecovery()
      return
    }
    this.spawnChild(resolution.command)
  }

  private spawnChild(command: ServiceSpawnCommand): void {
    let child: SpawnedServiceChild
    try {
      child = this.deps.spawn(command)
    } catch (error) {
      this.handleSpawnDeath(error instanceof Error ? error.message : String(error))
      return
    }
    if (child.pid === null) {
      this.handleSpawnDeath('spawn produced no pid')
      return
    }
    this.child = child
    this.ownedPid = child.pid
    this.isOwned = true
    this.recovery.resetOwnedUnready()
    this.processControl.writeMarker({
      pid: child.pid,
      startedAt: this.deps.now(),
      identity: this.profile.markerIdentity
    })
    this.transition('owned', null, null)
    const generation = this.generation
    child.onExit((code) => {
      if (generation !== this.generation || this.child !== child) {
        return
      }
      this.generation++
      this.timers.clearAll()
      this.child = null
      this.ownedPid = null
      void this.onOwnedExit(code)
    })
    this.recovery.startWatchdog()
  }

  private async onOwnedExit(code: number | null): Promise<void> {
    if (this.isStopping) {
      return
    }
    const action = code === null ? undefined : this.profile.exitCodeMap[code]
    if (action && action.kind !== 'restart') {
      this.processControl.clearMarker()
      this.transition(action.kind, action.reasonKey, action.reasonDetail)
      return
    }

    // Why: a competing listener may have won the port after spawn but before bind.
    if (this.profile.adoptionPolicy === 'foreign-or-owned') {
      const status = await this.probe()
      if (status !== 'down') {
        this.processControl.clearMarker()
        this.isOwned = false
        await this.routeLiveStatus(status)
        return
      }
    }
    this.processControl.clearMarker()
    this.recovery.scheduleBackoffRestart(
      action?.reasonKey ?? this.profile.reasonKeys.crashed,
      action?.reasonDetail ??
        this.reasonDetail('exit', `server exited (code ${code ?? 'null'})`, { code })
    )
  }

  private handleSpawnDeath(detail: string): void {
    if (this.isStopping) {
      return
    }
    this.child = null
    this.ownedPid = null
    this.processControl.clearMarker()
    this.recovery.scheduleBackoffRestart(this.profile.reasonKeys.crashed, detail)
  }

  private async terminateOwnedForRestart(): Promise<void> {
    const child = this.child
    this.child = null
    this.ownedPid = null
    await this.processControl.terminateForRestart(child)
  }

  private async probe(): Promise<ServiceProbeStatus> {
    try {
      this.lastProbeStatus = await this.profile.probe()
    } catch {
      this.lastProbeStatus = 'down'
    }
    return this.lastProbeStatus
  }

  private transition(
    lifecycle: ServiceLifecycle,
    reasonKey: string | null,
    reasonDetail: string | null
  ): void {
    this.lifecycle = lifecycle
    this.emit('transition', {
      lifecycle,
      reasonKey,
      reasonDetail,
      owned: this.isOwned,
      probeStatus: this.lastProbeStatus
    } satisfies ServiceTransition)
  }

  private reasonDetail(
    reason: ServiceReason,
    fallback: string,
    context?: { code: number | null }
  ): string {
    return this.profile.reasonDetail?.(reason, context) ?? fallback
  }
}
