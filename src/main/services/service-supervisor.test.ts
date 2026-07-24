import { describe, expect, it, vi } from 'vitest'
import {
  createServiceSupervisor,
  type ServiceOwnershipMarker,
  type ServiceProfile,
  type ServiceSpawnCommand,
  type ServiceSpawnResolution,
  type ServiceSupervisorDeps,
  type SpawnedServiceChild
} from './service-supervisor'

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

const command: ServiceSpawnCommand = {
  executable: 'service-bin',
  args: ['--serve']
}
const resolved: ServiceSpawnResolution = { kind: 'resolved', command }

type Scheduled = { ms: number; callback: () => void }
type FakeChild = {
  pid: number | null
  exit(code: number | null): void
  kill: ReturnType<typeof vi.fn>
}

type Harness = {
  profile: ServiceProfile
  deps: ServiceSupervisorDeps
  supervisor: ReturnType<typeof createServiceSupervisor>
  marker: { current: ServiceOwnershipMarker | null }
  scheduled: Scheduled[]
  children: FakeChild[]
  fireNext(): Promise<number | null>
}

function makeHarness(
  profileOverrides: Partial<ServiceProfile> = {},
  depOverrides: Partial<ServiceSupervisorDeps> = {},
  initialMarker: ServiceOwnershipMarker | null = null
): Harness {
  const marker = { current: initialMarker }
  const scheduled: Scheduled[] = []
  const children: FakeChild[] = []
  let nextPid = 4000

  const profile: ServiceProfile = {
    id: 'example',
    displayName: 'Example Service',
    probe: vi.fn<ServiceProfile['probe']>(async () => 'down'),
    resolveSpawn: vi.fn<ServiceProfile['resolveSpawn']>(async () => resolved),
    markerPath: 'C:\\state\\example-owned.json',
    markerIdentity: 'example:1234',
    adoptionPolicy: 'foreign-or-owned',
    stopPolicy: { killOnQuitDefault: false, forceKillDelayMs: 0 },
    exitCodeMap: {},
    onOwnedUnready: 'restart',
    reasonKeys: {
      degraded: 'example.degraded',
      adoptedLost: 'example.adoptedLost',
      crashed: 'example.crashed',
      offline: 'example.offline',
      ownedUnready: 'example.ownedUnready'
    },
    ...profileOverrides
  }

  const deps: ServiceSupervisorDeps = {
    spawn: vi.fn((_spawnCommand): SpawnedServiceChild => {
      let exitCallback: (code: number | null) => void = () => {}
      const kill = vi.fn()
      const child: FakeChild = {
        pid: nextPid++,
        exit: (code) => exitCallback(code),
        kill
      }
      children.push(child)
      return {
        pid: child.pid,
        onExit: (callback) => {
          exitCallback = callback
        },
        kill
      }
    }),
    readMarker: () => marker.current,
    writeMarker: (_path, value) => {
      marker.current = value
    },
    clearMarker: () => {
      marker.current = null
    },
    processAlive: () => true,
    processStartTime: async () => 5000,
    killPid: vi.fn(),
    now: () => 5000,
    random: () => 0,
    setTimeoutFn: ((callback: () => void, ms: number) => {
      scheduled.push({ ms, callback })
      return { unref() {} } as unknown as NodeJS.Timeout
    }) as unknown as typeof setTimeout,
    clearTimeoutFn: (() => {}) as unknown as typeof clearTimeout,
    watchdogMs: 100,
    probeOnlyRecoveryMs: 250,
    adoptedDeathWindowMs: 1000,
    adoptedDeathBaseMs: 100,
    maxRestartAttempts: 5,
    backoffBaseMs: 10,
    backoffMaxMs: 100,
    ownedUnreadyThreshold: 2,
    ...depOverrides
  }

  const supervisor = createServiceSupervisor(profile, deps)
  return {
    profile,
    deps,
    supervisor,
    marker,
    scheduled,
    children,
    fireNext: async () => {
      const timer = scheduled.shift()
      timer?.callback()
      await flush()
      return timer?.ms ?? null
    }
  }
}

describe('service supervisor generic core', () => {
  it('stays probe-only after setup-needed and re-adopts a later healthy listener', async () => {
    const probe = vi
      .fn<ServiceProfile['probe']>()
      .mockResolvedValueOnce('down')
      .mockResolvedValueOnce('down')
      .mockResolvedValueOnce('ready')
    const h = makeHarness({
      probe,
      resolveSpawn: vi.fn<ServiceProfile['resolveSpawn']>(async () => ({
        kind: 'setup-needed',
        reasonKey: 'example.missing',
        reasonDetail: 'install the service'
      }))
    })

    await h.supervisor.start()
    expect(h.supervisor.state).toBe('setup-needed')

    await h.fireNext()
    expect(h.supervisor.state).toBe('setup-needed')
    await h.fireNext()

    expect(h.supervisor.state).toBe('adopted')
    expect(h.deps.spawn).not.toHaveBeenCalled()
  })

  it.each([
    { deltaMs: 2000, lifecycle: 'owned' },
    { deltaMs: 2001, lifecycle: 'adopted' }
  ] as const)(
    'reclaims only when process start time is within ±2s ($deltaMs ms)',
    async ({ deltaMs, lifecycle }) => {
      const marker: ServiceOwnershipMarker = {
        pid: 777,
        startedAt: 1000,
        identity: 'example:1234'
      }
      const h = makeHarness(
        { probe: vi.fn<ServiceProfile['probe']>(async () => 'ready') },
        { processStartTime: async () => 1000 + deltaMs },
        marker
      )

      await h.supervisor.start()

      expect(h.supervisor.state).toBe(lifecycle)
      expect(h.deps.spawn).not.toHaveBeenCalled()
    }
  )

  it('re-probes an owned child exit before restarting to close the port-in-use TOCTOU', async () => {
    const probe = vi
      .fn<ServiceProfile['probe']>()
      .mockResolvedValueOnce('down')
      .mockResolvedValueOnce('ready')
    const h = makeHarness({ probe })

    await h.supervisor.start()
    h.children[0].exit(1)
    await flush()

    expect(h.supervisor.state).toBe('adopted')
    expect(h.deps.spawn).toHaveBeenCalledTimes(1)
    expect(h.marker.current).toBeNull()
  })

  it('does not probe a dedicated port without a provable ownership marker', async () => {
    const probe = vi.fn<ServiceProfile['probe']>(async () => 'ready')
    const h = makeHarness({ probe, adoptionPolicy: 'owned-only' })

    await h.supervisor.start()

    expect(probe).not.toHaveBeenCalled()
    expect(h.supervisor.state).toBe('owned')
    expect(h.deps.spawn).toHaveBeenCalledTimes(1)
  })

  it('restarts repeatedly unready owned children with bounded escalation to offline', async () => {
    const probe = vi
      .fn<ServiceProfile['probe']>()
      .mockResolvedValueOnce('down')
      .mockResolvedValue('alive-unready')
    const h = makeHarness(
      { probe, onOwnedUnready: 'restart' },
      { maxRestartAttempts: 2, ownedUnreadyThreshold: 2 }
    )

    await h.supervisor.start()
    for (let step = 0; step < 8; step++) {
      await h.fireNext()
    }

    expect(h.supervisor.state).toBe('offline')
    expect(h.deps.spawn).toHaveBeenCalledTimes(3)
    expect(h.children.every((child) => child.kill.mock.calls.length === 1)).toBe(true)
  })

  it('preserves owned state when repeated unready probes are explicitly ignored', async () => {
    const probe = vi
      .fn<ServiceProfile['probe']>()
      .mockResolvedValueOnce('down')
      .mockResolvedValue('alive-unready')
    const h = makeHarness({ probe, onOwnedUnready: 'ignore' })

    await h.supervisor.start()
    for (let step = 0; step < 6; step++) {
      await h.fireNext()
    }

    expect(h.supervisor.state).toBe('owned')
    expect(h.deps.spawn).toHaveBeenCalledTimes(1)
    expect(h.children[0].kill).not.toHaveBeenCalled()
  })

  it('caps exponential restart backoff before the retry budget is exhausted', async () => {
    const h = makeHarness(
      {},
      {
        spawn: vi.fn(
          (): SpawnedServiceChild => ({
            pid: null,
            onExit: () => {},
            kill: () => {}
          })
        ),
        maxRestartAttempts: 3,
        backoffBaseMs: 10,
        backoffMaxMs: 25
      }
    )

    await h.supervisor.start()
    const delays = [await h.fireNext(), await h.fireNext(), await h.fireNext()]

    expect(delays).toEqual([10, 20, 25])
    expect(h.supervisor.state).toBe('offline')
  })
})
