import { EventEmitter } from 'node:events'
import type { TcProxyLifecycle } from '../../../shared/teamclaude-types'
import type { RoutingSnapshot } from '../../teamclaude/routing-env'
import { resolverFailureDetail } from '../../teamclaude/supervisor-resolver-evidence'
import { SnapshotState } from '../../teamclaude/supervisor-support'
import {
  ADOPTED_DEATH_BASE_MS,
  ADOPTED_DEATH_WINDOW_MS,
  BACKOFF_CAP,
  NO_ACCOUNTS_EXIT_CODE,
  PORT_HISTORY,
  RESOLVER_RECOVERY_PROBE_MS,
  SNAPSHOT_TTL_MS,
  type EntrypointResolution,
  type ProbeResult,
  type SupervisorConfig,
  type SupervisorDeps,
  type SupervisorTransition
} from '../../teamclaude/supervisor-types'
import {
  createServiceSupervisor,
  type ServiceLifecycle,
  type ServiceOwnershipMarker,
  type ServiceProbeStatus,
  type ServiceProfile,
  type ServiceReason,
  type ServiceSupervisor,
  type ServiceSupervisorDeps,
  type ServiceTransition
} from '../service-supervisor'

export type TeamClaudeServiceProfileOptions = {
  port: number
  binPath: string | null
  markerPath: string
  probe: SupervisorDeps['probe']
  resolveEntrypoint: SupervisorDeps['resolveEntrypoint']
  isSupported: SupervisorDeps['isSupported']
  onProbe?(probe: ProbeResult, status: ServiceProbeStatus): void
}

export function createTeamClaudeServiceProfile(
  options: TeamClaudeServiceProfileOptions
): ServiceProfile {
  let latestProbe: ProbeResult | null = null
  return {
    id: 'teamclaude',
    displayName: 'TeamClaude',
    probe: async () => {
      const probe = await options.probe()
      latestProbe = probe
      const status = classifyProbe(probe, options.isSupported)
      options.onProbe?.(probe, status)
      return status
    },
    resolveSpawn: async () => {
      const result = await options.resolveEntrypoint(options.binPath)
      if (result.kind !== 'resolved') {
        const detail = resolverFailureDetail(result)
        console.warn('[teamclaude] entrypoint resolution failed', {
          kind: result.kind,
          foundPath: result.foundPath,
          attemptedCandidates: result.attemptedCandidates,
          nodeFallback: result.nodeFallback
        })
        return {
          kind: 'setup-needed',
          reasonKey:
            result.kind === 'not-found'
              ? 'tc.reason.teamclaudeNotFound'
              : 'tc.reason.shimUnresolvable',
          reasonDetail: detail
        }
      }
      return {
        kind: 'resolved',
        command: {
          executable: result.resolution.node,
          args: [result.resolution.entry, 'server', '--headless'],
          env: result.resolution.env,
          context: result.resolution
        }
      }
    },
    markerPath: options.markerPath,
    markerIdentity: markerIdentity(options.port),
    adoptionPolicy: 'foreign-or-owned',
    stopPolicy: { killOnQuitDefault: false, forceKillDelayMs: 0 },
    exitCodeMap: {
      [NO_ACCOUNTS_EXIT_CODE]: {
        kind: 'setup-needed',
        reasonKey: 'tc.reason.noAccounts',
        reasonDetail: 'run `teamclaude login`'
      }
    },
    // Why: D1 adds generic escalation, but changing TC restart semantics is deferred.
    onOwnedUnready: 'ignore',
    reasonKeys: {
      degraded: 'tc.reason.degraded',
      adoptedLost: 'tc.reason.adoptedLost',
      crashed: 'tc.reason.crashed',
      offline: 'tc.reason.offline',
      ownedUnready: 'tc.reason.crashed'
    },
    reasonDetail: (reason, context) => teamClaudeReasonDetail(reason, latestProbe, context)
  }
}

export class TeamClaudeSupervisor extends EventEmitter {
  private readonly core: ServiceSupervisor
  private readonly snap = new SnapshotState(SNAPSHOT_TTL_MS, PORT_HISTORY)
  private serverVersion: string | null = null
  private capabilities: string[] = []
  private bootId: string | null = null

  constructor(
    private readonly config: SupervisorConfig,
    private readonly deps: SupervisorDeps
  ) {
    super()
    const profile = createTeamClaudeServiceProfile({
      port: config.port,
      binPath: config.binPath,
      markerPath: config.markerPath ?? 'teamclaude-owned-proxy.json',
      probe: deps.probe,
      resolveEntrypoint: deps.resolveEntrypoint,
      isSupported: deps.isSupported,
      onProbe: (probe) => this.recordProbe(probe)
    })
    this.core = createServiceSupervisor(profile, this.createCoreDeps())
    this.core.on('transition', (transition: ServiceTransition) => {
      this.onCoreTransition(transition)
    })
  }

  get state(): TcProxyLifecycle {
    return toTeamClaudeLifecycle(this.core.state)
  }

  setCaPath(caPath: string | null): void {
    this.snap.setCaPath(caPath)
  }

  setOrcaNetworkProxyConfigured(configured: boolean): void {
    this.snap.setNetworkProxyConfigured(configured)
  }

  getRoutingSnapshot(): RoutingSnapshot {
    return this.snap.build(this.deps.now(), this.config.port)
  }

  invalidateSnapshot(): void {
    this.snap.invalidate()
  }

  start(): Promise<void> {
    return this.core.start()
  }

  retry(): Promise<void> {
    return this.core.retry()
  }

  async reAdoptHealthyListener(probe: ProbeResult): Promise<void> {
    if (!probe.ok) {
      return
    }
    this.recordProbe(probe)
    const status = this.deps.isSupported(probe.capabilities, probe.version)
      ? 'ready'
      : 'alive-unready'
    await this.core.reAdoptHealthyListener(status)
  }

  stop(options?: { killOwned?: boolean }): Promise<void> {
    this.invalidateSnapshot()
    return this.core.stop(options)
  }

  private createCoreDeps(): ServiceSupervisorDeps {
    return {
      spawn: (command) => {
        const child = this.deps.spawnServer(command.context as EntrypointResolution)
        if (child.pid !== null) {
          this.snap.rememberPort(this.config.port)
        }
        return {
          pid: child.pid,
          onExit: (callback) => child.onExit(callback),
          kill: () => child.kill()
        }
      },
      readMarker: () => toServiceMarker(this.deps.readMarker()),
      writeMarker: (_path, marker) => {
        this.deps.writeMarker({
          pid: marker.pid,
          port: this.config.port,
          startedAt: marker.startedAt
        })
      },
      clearMarker: () => this.deps.clearMarker(),
      processAlive: this.deps.processAlive,
      processStartTime: this.deps.processStartTime,
      killPid: (pid) => this.deps.killPid(pid),
      now: this.deps.now,
      random: this.deps.random,
      setTimeoutFn: this.deps.setTimeoutFn,
      clearTimeoutFn: this.deps.clearTimeoutFn,
      watchdogMs: this.deps.watchdogMs,
      probeOnlyRecoveryMs: RESOLVER_RECOVERY_PROBE_MS,
      adoptedDeathWindowMs: ADOPTED_DEATH_WINDOW_MS,
      adoptedDeathBaseMs: ADOPTED_DEATH_BASE_MS,
      maxRestartAttempts: BACKOFF_CAP,
      backoffBaseMs: 1000,
      backoffMaxMs: 30_000,
      ownedUnreadyThreshold: 3
    }
  }

  private recordProbe(probe: ProbeResult): void {
    if (!probe.ok) {
      this.snap.invalidate()
      return
    }
    this.snap.recordUp(this.deps.now())
    this.serverVersion = probe.version
    this.capabilities = probe.capabilities
    this.bootId = probe.bootId
  }

  private onCoreTransition(transition: ServiceTransition): void {
    const lifecycle = toTeamClaudeLifecycle(transition.lifecycle)
    if (lifecycle === 'probing' || lifecycle === 'setup-needed' || lifecycle === 'offline') {
      this.snap.invalidate()
    }
    this.emit('transition', {
      lifecycle,
      reasonKey: transition.reasonKey,
      reasonDetail: transition.reasonDetail,
      owned: transition.owned,
      serverVersion: this.serverVersion,
      capabilities: this.capabilities,
      bootId: this.bootId
    } satisfies SupervisorTransition)
  }
}

function classifyProbe(
  probe: ProbeResult,
  isSupported: SupervisorDeps['isSupported']
): ServiceProbeStatus {
  if (!probe.ok) {
    return 'down'
  }
  return isSupported(probe.capabilities, probe.version) ? 'ready' : 'alive-unready'
}

function markerIdentity(port: number): string {
  return `teamclaude:${port}`
}

function toServiceMarker(
  marker: ReturnType<SupervisorDeps['readMarker']>
): ServiceOwnershipMarker | null {
  if (!marker) {
    return null
  }
  return {
    pid: marker.pid,
    startedAt: marker.startedAt,
    identity: markerIdentity(marker.port)
  }
}

function teamClaudeReasonDetail(
  reason: ServiceReason,
  latestProbe: ProbeResult | null,
  context?: { code: number | null }
): string {
  switch (reason) {
    case 'alive-unready':
      return `have ${latestProbe?.version ?? '?'}, missing required capabilities`
    case 'adopted-lost':
      return 'adopted proxy stopped; waiting for restart'
    case 'owned-lost':
      return 'owned server stopped responding'
    case 'owned-unready':
      return 'owned server stayed alive but unready'
    case 'exit':
      return `server exited (code ${context?.code ?? 'null'})`
  }
}

function toTeamClaudeLifecycle(lifecycle: ServiceLifecycle): TcProxyLifecycle {
  return lifecycle === 'restart-required' ? 'offline' : lifecycle
}
