import type { ServiceProcessControl } from './service-supervisor-runtime'
import type {
  ServiceLifecycle,
  ServiceOwnershipMarker,
  ServiceProbeStatus,
  ServiceProfile,
  ServiceReason,
  ServiceSupervisorDeps
} from './service-supervisor-types'

type RecoveryHost = {
  generation(): number
  stopping(): boolean
  owned(): boolean
  lifecycle(): ServiceLifecycle
  ownedPid(): number | null
  clearOwnedProcess(): void
  probe(): Promise<ServiceProbeStatus>
  routeLive(status: Exclude<ServiceProbeStatus, 'down'>): Promise<void>
  reclaim(marker: ServiceOwnershipMarker, status: ServiceProbeStatus): void
  spawn(): Promise<void>
  terminateOwned(): Promise<void>
  transition(lifecycle: ServiceLifecycle, reasonKey: string | null, detail: string | null): void
  reasonDetail(reason: ServiceReason, fallback: string): string
}

const DEFAULT_PROBE_ONLY_RECOVERY_MS = 10_000
const DEFAULT_ADOPTED_DEATH_WINDOW_MS = 10_000
const DEFAULT_ADOPTED_DEATH_BASE_MS = 2000
const DEFAULT_MAX_RESTART_ATTEMPTS = 5
const DEFAULT_BACKOFF_BASE_MS = 1000
const DEFAULT_BACKOFF_MAX_MS = 30_000
const DEFAULT_OWNED_UNREADY_THRESHOLD = 3

export class ServiceTimerBag {
  private readonly timers = new Set<NodeJS.Timeout>()
  private monitor: NodeJS.Timeout | null = null

  constructor(
    private readonly setFn: typeof setTimeout,
    private readonly clearFn: typeof clearTimeout
  ) {}

  set(ms: number, callback: () => void): void {
    const timer = this.setFn(() => {
      this.timers.delete(timer)
      callback()
    }, ms)
    this.track(timer)
  }

  wait(ms: number): Promise<void> {
    return new Promise((resolve) => this.set(ms, resolve))
  }

  setMonitor(ms: number, callback: () => void): void {
    this.clearMonitor()
    const timer = this.setFn(() => {
      this.timers.delete(timer)
      if (this.monitor === timer) {
        this.monitor = null
      }
      callback()
    }, ms)
    this.monitor = timer
    this.track(timer)
  }

  clearAll(): void {
    this.clearMonitor()
    for (const timer of this.timers) {
      this.clearFn(timer)
    }
    this.timers.clear()
  }

  private clearMonitor(): void {
    if (!this.monitor) {
      return
    }
    this.clearFn(this.monitor)
    this.timers.delete(this.monitor)
    this.monitor = null
  }

  private track(timer: NodeJS.Timeout): void {
    timer.unref?.()
    this.timers.add(timer)
  }
}

export class ServiceSupervisorRecovery {
  private restartAttempts = 0
  private ownedUnreadyFailures = 0

  constructor(
    private readonly profile: ServiceProfile,
    private readonly deps: ServiceSupervisorDeps,
    private readonly timers: ServiceTimerBag,
    private readonly processControl: ServiceProcessControl,
    private readonly host: RecoveryHost
  ) {}

  resetForRetry(): void {
    this.restartAttempts = 0
    this.ownedUnreadyFailures = 0
  }

  recordAdoptedLive(): void {
    this.resetForRetry()
  }

  recordOwnedStatus(status: ServiceProbeStatus): void {
    if (status === 'ready' || this.profile.onOwnedUnready === 'ignore') {
      this.restartAttempts = 0
    }
    if (status === 'ready') {
      this.ownedUnreadyFailures = 0
    }
  }

  resetOwnedUnready(): void {
    this.ownedUnreadyFailures = 0
  }

  startWatchdog(): void {
    const generation = this.host.generation()
    this.timers.setMonitor(this.deps.watchdogMs, () => {
      void this.watchdogProbe(generation)
    })
  }

  startProbeOnlyRecovery(): void {
    const generation = this.host.generation()
    this.timers.setMonitor(this.probeOnlyRecoveryMs(), () => {
      void this.probeOnlyRecovery(generation)
    })
  }

  scheduleBackoffRestart(reasonKey: string, detail: string): void {
    this.restartAttempts++
    if (this.restartAttempts > this.maxRestartAttempts()) {
      this.host.transition(
        'offline',
        this.profile.reasonKeys.offline,
        `${detail} (gave up after ${this.maxRestartAttempts()} tries)`
      )
      return
    }
    const delay = Math.min(
      this.backoffBaseMs() * 2 ** (this.restartAttempts - 1),
      this.backoffMaxMs()
    )
    this.host.transition('probing', reasonKey, detail)
    this.timers.set(delay, () => void this.host.spawn())
  }

  private async watchdogProbe(generation: number): Promise<void> {
    if (generation !== this.host.generation() || this.host.stopping()) {
      return
    }
    const status = await this.host.probe()
    if (generation !== this.host.generation() || this.host.stopping()) {
      return
    }
    if (this.host.owned()) {
      const escalated = await this.handleOwnedProbe(status)
      if (!escalated && generation === this.host.generation() && !this.host.stopping()) {
        this.startWatchdog()
      }
      return
    }
    if (status !== 'down') {
      await this.host.routeLive(status)
      return
    }
    await this.onAdoptedLost(generation)
  }

  private async handleOwnedProbe(status: ServiceProbeStatus): Promise<boolean> {
    if (status === 'ready') {
      this.resetForRetry()
      if (this.host.lifecycle() !== 'owned') {
        this.host.transition('owned', null, null)
      }
      return false
    }
    if (status === 'down') {
      const pid = this.host.ownedPid()
      if (pid === null || !this.deps.processAlive(pid)) {
        this.host.clearOwnedProcess()
        this.processControl.clearMarker()
        this.scheduleBackoffRestart(
          this.profile.reasonKeys.crashed,
          this.host.reasonDetail('owned-lost', 'owned server stopped responding')
        )
        return true
      }
    }
    this.ownedUnreadyFailures++
    if (this.ownedUnreadyFailures < this.ownedUnreadyThreshold()) {
      return false
    }
    this.ownedUnreadyFailures = 0
    if (this.profile.onOwnedUnready === 'ignore') {
      this.restartAttempts = 0
      return false
    }
    await this.host.terminateOwned()
    this.scheduleBackoffRestart(
      this.profile.reasonKeys.ownedUnready,
      this.host.reasonDetail('owned-unready', 'owned service stayed alive but unready')
    )
    return true
  }

  private async onAdoptedLost(generation: number): Promise<void> {
    this.host.transition(
      'probing',
      this.profile.reasonKeys.adoptedLost,
      this.host.reasonDetail('adopted-lost', 'adopted service stopped; waiting for restart')
    )
    const deadline = this.deps.now() + this.adoptedDeathWindowMs()
    while (this.deps.now() < deadline) {
      const jitter = Math.floor(this.deps.random() * 500)
      await this.timers.wait(this.adoptedDeathBaseMs() + jitter)
      if (generation !== this.host.generation() || this.host.stopping()) {
        return
      }
      const status = await this.host.probe()
      if (status !== 'down') {
        await this.host.routeLive(status)
        return
      }
    }
    if (generation === this.host.generation() && !this.host.stopping()) {
      await this.host.spawn()
    }
  }

  private async probeOnlyRecovery(generation: number): Promise<void> {
    if (generation !== this.host.generation() || this.host.stopping()) {
      return
    }
    if (this.profile.adoptionPolicy === 'owned-only') {
      const marker = this.processControl.readMarker()
      if (await this.processControl.provesOwnership(marker)) {
        const status = await this.host.probe()
        if (generation === this.host.generation()) {
          this.host.reclaim(marker!, status)
        }
        return
      }
    } else {
      const status = await this.host.probe()
      if (status !== 'down') {
        await this.host.routeLive(status)
        return
      }
    }
    if (generation === this.host.generation() && !this.host.stopping()) {
      this.startProbeOnlyRecovery()
    }
  }

  private probeOnlyRecoveryMs(): number {
    return this.deps.probeOnlyRecoveryMs ?? DEFAULT_PROBE_ONLY_RECOVERY_MS
  }

  private adoptedDeathWindowMs(): number {
    return this.deps.adoptedDeathWindowMs ?? DEFAULT_ADOPTED_DEATH_WINDOW_MS
  }

  private adoptedDeathBaseMs(): number {
    return this.deps.adoptedDeathBaseMs ?? DEFAULT_ADOPTED_DEATH_BASE_MS
  }

  private maxRestartAttempts(): number {
    return this.deps.maxRestartAttempts ?? DEFAULT_MAX_RESTART_ATTEMPTS
  }

  private backoffBaseMs(): number {
    return this.deps.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS
  }

  private backoffMaxMs(): number {
    return this.deps.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS
  }

  private ownedUnreadyThreshold(): number {
    return this.deps.ownedUnreadyThreshold ?? DEFAULT_OWNED_UNREADY_THRESHOLD
  }
}
