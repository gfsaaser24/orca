export type ServiceProbeStatus = 'ready' | 'alive-unready' | 'down'

export type ServiceLifecycle =
  | 'probing'
  | 'adopted'
  | 'adopted-degraded'
  | 'owned'
  | 'setup-needed'
  | 'offline'
  | 'restart-required'

export type ServiceOwnershipMarker = {
  pid: number
  startedAt: number
  identity: string
}

export type ServiceSpawnCommand = {
  executable: string
  args: string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  /** Adapter-owned data ignored by the generic process state machine. */
  context?: unknown
}

export type ServiceSpawnResolution =
  | { kind: 'resolved'; command: ServiceSpawnCommand }
  | {
      kind: 'setup-needed'
      reasonKey: string
      reasonDetail: string | null
    }

export type ServiceExitAction = {
  kind: 'restart' | 'setup-needed' | 'offline' | 'restart-required'
  reasonKey: string
  reasonDetail: string | null
}

export type ServiceReason =
  | 'alive-unready'
  | 'adopted-lost'
  | 'owned-lost'
  | 'owned-unready'
  | 'exit'

export type ServiceProfile = {
  id: string
  displayName: string
  probe(): Promise<ServiceProbeStatus>
  resolveSpawn(): Promise<ServiceSpawnResolution>
  markerPath: string
  markerIdentity: string
  adoptionPolicy: 'foreign-or-owned' | 'owned-only'
  stopPolicy: {
    killOnQuitDefault: boolean
    forceKillDelayMs: number
  }
  exitCodeMap: Readonly<Partial<Record<number, ServiceExitAction>>>
  onOwnedUnready: 'restart' | 'ignore'
  reasonKeys: {
    degraded: string
    adoptedLost: string
    crashed: string
    offline: string
    ownedUnready: string
  }
  reasonDetail?(reason: ServiceReason, context?: { code: number | null }): string
}

export type SpawnedServiceChild = {
  pid: number | null
  onExit(callback: (code: number | null) => void): void
  kill(force?: boolean): void
}

export type ServiceSupervisorDeps = {
  spawn(command: ServiceSpawnCommand): SpawnedServiceChild
  readMarker(path: string): ServiceOwnershipMarker | null
  writeMarker(path: string, marker: ServiceOwnershipMarker): void
  clearMarker(path: string): void
  processAlive(pid: number): boolean
  processStartTime(pid: number): Promise<number | null>
  killPid(pid: number, force?: boolean): void
  now(): number
  random(): number
  setTimeoutFn: typeof setTimeout
  clearTimeoutFn: typeof clearTimeout
  watchdogMs: number
  probeOnlyRecoveryMs?: number
  adoptedDeathWindowMs?: number
  adoptedDeathBaseMs?: number
  maxRestartAttempts?: number
  backoffBaseMs?: number
  backoffMaxMs?: number
  ownedUnreadyThreshold?: number
}

export type ServiceTransition = {
  lifecycle: ServiceLifecycle
  reasonKey: string | null
  reasonDetail: string | null
  owned: boolean
  probeStatus: ServiceProbeStatus
}

export type ServiceStopOptions = { killOwned?: boolean }
