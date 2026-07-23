import { describe, it, expect, vi } from 'vitest'
import { Supervisor } from './supervisor'
import {
  NO_ACCOUNTS_EXIT_CODE,
  type SupervisorConfig,
  type SupervisorDeps,
  type ProbeResult,
  type SpawnedChild,
  type EntrypointResolution,
  type EntrypointResolutionResult,
  type OwnershipMarker
} from './supervisor-types'

const flush = (): Promise<void> => new Promise((r) => setImmediate(r))

const upProbe = (caps: string[] = ['routing', 'usage', 'control']): ProbeResult => ({
  ok: true,
  version: '9.9.9',
  capabilities: caps,
  bootId: 'boot-1'
})
const downProbe = (): ProbeResult => ({ ok: false, version: null, capabilities: [], bootId: null })

const resolution: EntrypointResolution = {
  node: 'node',
  entry: '/pkg/teamclaude/src/index.js',
  foundPath: '/usr/local/bin/teamclaude'
}

const resolvedEntrypoint: EntrypointResolutionResult = {
  kind: 'resolved',
  resolution,
  foundPath: resolution.foundPath!,
  attemptedCandidates: [resolution.entry],
  nodeFallback: 'path-node'
}

type Harness = {
  supervisor: Supervisor
  deps: SupervisorDeps
  transitions: string[]
  scheduled: (() => void)[]
  fireNext: () => Promise<void>
  markerStore: { current: OwnershipMarker | null }
  child: { exit: (code: number | null) => void; kill: ReturnType<typeof vi.fn> } | null
  killPid: ReturnType<typeof vi.fn>
}

function makeHarness(
  overrides: Partial<SupervisorDeps> = {},
  initialMarker: OwnershipMarker | null = null
): Harness {
  const scheduled: (() => void)[] = []
  const markerStore = { current: initialMarker }
  const killPid = vi.fn()
  const harness: Harness = {
    supervisor: null as unknown as Supervisor,
    deps: null as unknown as SupervisorDeps,
    transitions: [],
    scheduled,
    fireNext: async () => {
      const cb = scheduled.shift()
      if (cb) {
        cb()
      }
      await flush()
    },
    markerStore,
    child: null,
    killPid
  }

  let exitCb: (code: number | null) => void = () => {}
  const kill = vi.fn()
  const spawnServer = vi.fn((_r: EntrypointResolution): SpawnedChild => {
    harness.child = { exit: (code) => exitCb(code), kill }
    return {
      pid: 4242,
      onExit: (cb) => (exitCb = cb),
      kill
    }
  })

  const deps: SupervisorDeps = {
    probe: vi.fn(async () => downProbe()),
    spawnServer,
    resolveEntrypoint: vi.fn(async () => resolvedEntrypoint),
    readMarker: () => markerStore.current,
    writeMarker: (m) => (markerStore.current = m),
    clearMarker: () => (markerStore.current = null),
    processAlive: () => true,
    killPid,
    processStartTime: async () => 1000,
    isSupported: (caps) => caps.includes('routing'),
    now: () => 5000,
    random: () => 0,
    setTimeoutFn: ((cb: () => void) => {
      scheduled.push(cb)
      return { unref() {} } as unknown as NodeJS.Timeout
    }) as unknown as typeof setTimeout,
    clearTimeoutFn: (() => {}) as unknown as typeof clearTimeout,
    watchdogMs: 4000,
    ...overrides
  }
  harness.deps = deps

  const config: SupervisorConfig = { port: 3456, apiKey: 'k', binPath: null }
  const supervisor = new Supervisor(config, deps)
  supervisor.on('transition', (t) => harness.transitions.push(t.lifecycle))
  harness.supervisor = supervisor
  return harness
}

describe('Supervisor state machine', () => {
  it('probe up + supported → adopted', async () => {
    const h = makeHarness({ probe: vi.fn(async () => upProbe()) })
    await h.supervisor.start()
    expect(h.supervisor.state).toBe('adopted')
    expect(h.transitions).toEqual(['probing', 'adopted'])
  })

  it('probe up + unsupported capabilities → adopted-degraded', async () => {
    const h = makeHarness({ probe: vi.fn(async () => upProbe(['legacy'])) })
    await h.supervisor.start()
    expect(h.supervisor.state).toBe('adopted-degraded')
  })

  it('resolver-caused setup-needed keeps probing and re-adopts without spawning', async () => {
    const probe = vi
      .fn<SupervisorDeps['probe']>()
      .mockResolvedValueOnce(downProbe())
      .mockResolvedValueOnce(downProbe())
      .mockResolvedValueOnce(upProbe())
    const h = makeHarness({
      probe,
      resolveEntrypoint: vi.fn<SupervisorDeps['resolveEntrypoint']>(async () => ({
        kind: 'shim-unresolvable',
        foundPath: 'C:\\npm\\teamclaude.cmd',
        attemptedCandidates: ['C:\\npm\\node_modules\\@karpeleslab\\teamclaude\\package.json'],
        nodeFallback: 'path-node'
      }))
    })
    await h.supervisor.start()
    expect(h.supervisor.state).toBe('setup-needed')
    expect(h.scheduled).toHaveLength(1)

    await h.fireNext()
    expect(h.supervisor.state).toBe('setup-needed')
    expect(h.deps.spawnServer).not.toHaveBeenCalled()
    expect(h.scheduled).toHaveLength(1)

    await h.fireNext()
    expect(h.supervisor.state).toBe('adopted')
    expect(h.deps.spawnServer).not.toHaveBeenCalled()
  })

  it('a successful client status re-adopts immediately from resolver setup-needed', async () => {
    const h = makeHarness({
      resolveEntrypoint: vi.fn<SupervisorDeps['resolveEntrypoint']>(async () => ({
        kind: 'not-found',
        foundPath: null,
        attemptedCandidates: ['C:\\npm\\teamclaude.cmd'],
        nodeFallback: 'electron-run-as-node'
      }))
    })
    await h.supervisor.start()
    expect(h.supervisor.state).toBe('setup-needed')

    await h.supervisor.reAdoptHealthyListener(upProbe())

    expect(h.supervisor.state).toBe('adopted')
    expect(h.deps.spawnServer).not.toHaveBeenCalled()
  })

  it('client status re-adopts after an owned exit leaves stale ownership behind', async () => {
    const resolveEntrypoint = vi
      .fn<SupervisorDeps['resolveEntrypoint']>()
      .mockResolvedValueOnce(resolvedEntrypoint)
      .mockResolvedValueOnce({
        kind: 'shim-unresolvable',
        foundPath: 'C:\\npm\\teamclaude.cmd',
        attemptedCandidates: ['C:\\npm\\node_modules\\@karpeleslab\\teamclaude'],
        nodeFallback: 'path-node'
      })
    const h = makeHarness({ resolveEntrypoint })
    await h.supervisor.start()
    h.child?.exit(1)
    await flush()
    await h.fireNext()
    await h.fireNext()
    expect(h.supervisor.state).toBe('setup-needed')

    await h.supervisor.reAdoptHealthyListener(upProbe())

    expect(h.supervisor.state).toBe('adopted')
    expect(h.deps.spawnServer).toHaveBeenCalledTimes(1)
  })

  it('probe down + resolvable → spawns owned and writes the marker', async () => {
    const h = makeHarness()
    await h.supervisor.start()
    expect(h.supervisor.state).toBe('owned')
    expect(h.deps.spawnServer).toHaveBeenCalledTimes(1)
    expect(h.markerStore.current).toEqual({ pid: 4242, port: 3456, startedAt: 5000 })
  })

  it('owned child exits with no-accounts code → setup-needed', async () => {
    const h = makeHarness()
    await h.supervisor.start()
    expect(h.supervisor.state).toBe('owned')
    h.child!.exit(NO_ACCOUNTS_EXIT_CODE)
    await flush()
    expect(h.supervisor.state).toBe('setup-needed')
    expect(h.markerStore.current).toBeNull()
  })

  it('owned child exit + healthy re-probe (TOCTOU port-in-use) → adopted', async () => {
    const probe = vi.fn(async () => downProbe())
    probe
      .mockResolvedValueOnce(downProbe()) // initial: nothing listening → we spawn
      .mockResolvedValue(upProbe()) // after our child exits, someone is listening
    const h = makeHarness({ probe })
    await h.supervisor.start()
    expect(h.supervisor.state).toBe('owned')
    h.child!.exit(1)
    await flush()
    expect(h.supervisor.state).toBe('adopted')
  })

  it('reclaims ownership when the marker is provably ours (start time ±2s)', async () => {
    const marker: OwnershipMarker = { pid: 777, port: 3456, startedAt: 1000 }
    const h = makeHarness(
      {
        probe: vi.fn(async () => upProbe()),
        processAlive: () => true,
        processStartTime: async () => 2500 // within 2s of startedAt=1000? |2500-1000|=1500 ≤ 2000
      },
      marker
    )
    await h.supervisor.start()
    expect(h.supervisor.state).toBe('owned')
    expect(h.deps.spawnServer).not.toHaveBeenCalled()
  })

  it('does NOT reclaim when the process start time is out of tolerance → adopted', async () => {
    const marker: OwnershipMarker = { pid: 777, port: 3456, startedAt: 1000 }
    const h = makeHarness(
      {
        probe: vi.fn(async () => upProbe()),
        processStartTime: async () => 9000 // |9000-1000| = 8000 > 2000 → impostor
      },
      marker
    )
    await h.supervisor.start()
    expect(h.supervisor.state).toBe('adopted')
  })

  it('does NOT reclaim when the marked pid is dead → adopted', async () => {
    const marker: OwnershipMarker = { pid: 777, port: 3456, startedAt: 1000 }
    const h = makeHarness(
      { probe: vi.fn(async () => upProbe()), processAlive: () => false },
      marker
    )
    await h.supervisor.start()
    expect(h.supervisor.state).toBe('adopted')
  })

  it('does NOT reclaim when the marked port differs → adopted', async () => {
    const marker: OwnershipMarker = { pid: 777, port: 9999, startedAt: 1000 }
    const h = makeHarness({ probe: vi.fn(async () => upProbe()) }, marker)
    await h.supervisor.start()
    expect(h.supervisor.state).toBe('adopted')
  })

  it('D1: reclaimed-owned server is killed by its marker pid on stop({killOwned})', async () => {
    const marker: OwnershipMarker = { pid: 777, port: 3456, startedAt: 1000 }
    // Same start time at reclaim AND at stop → provably ours both times.
    const h = makeHarness(
      { probe: vi.fn(async () => upProbe()), processStartTime: async () => 2500 },
      marker
    )
    await h.supervisor.start()
    expect(h.supervisor.state).toBe('owned')
    expect(h.deps.spawnServer).not.toHaveBeenCalled() // reclaimed: no child handle
    await h.supervisor.stop({ killOwned: true })
    expect(h.killPid).toHaveBeenCalledWith(777)
    expect(h.markerStore.current).toBeNull()
  })

  it('D1: reclaimed-owned + stale/mismatched start time on stop → NO kill', async () => {
    const marker: OwnershipMarker = { pid: 777, port: 3456, startedAt: 1000 }
    const startTime = vi.fn(async () => 2500)
    startTime.mockResolvedValueOnce(2500) // reclaim: |2500-1000| = 1500 ≤ 2000 → ours
    startTime.mockResolvedValueOnce(9000) // stop:    |9000-1000| = 8000 > 2000 → impostor
    const h = makeHarness(
      { probe: vi.fn(async () => upProbe()), processStartTime: startTime },
      marker
    )
    await h.supervisor.start()
    expect(h.supervisor.state).toBe('owned')
    await h.supervisor.stop({ killOwned: true })
    expect(h.killPid).not.toHaveBeenCalled()
  })

  it('gives up to offline after the backoff cap when spawns keep failing', async () => {
    // spawn yields no pid → spawn death → backoff restart, capped at 5 then offline
    const h = makeHarness({
      spawnServer: vi.fn((): SpawnedChild => ({ pid: null, onExit: () => {}, kill: () => {} }))
    })
    await h.supervisor.start()
    let guard = 0
    while (h.supervisor.state !== 'offline' && guard++ < 20) {
      await h.fireNext()
    }
    expect(h.supervisor.state).toBe('offline')
  })

  it('routing snapshot reflects liveness and decays after the TTL', async () => {
    let clock = 5000
    const h = makeHarness({ probe: vi.fn(async () => upProbe()), now: () => clock })
    await h.supervisor.start()
    expect(h.supervisor.getRoutingSnapshot().proxyUp).toBe(true)
    clock = 5000 + 3000 // > 2s TTL
    expect(h.supervisor.getRoutingSnapshot().proxyUp).toBe(false)
  })
})
