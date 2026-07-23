// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { TcActivityRow, TcState } from '../../../shared/teamclaude-types'
import { useTeamclaude, type TcBridge, type UseTeamclaudeResult } from './useTeamclaude'

function makeState(overrides: Partial<TcState> = {}): TcState {
  return {
    lifecycle: 'owned',
    readiness: { usageReady: true, routingReady: true, controlReady: true },
    reasonKey: null,
    reasonDetail: null,
    port: 8080,
    serverVersion: '1.0.0',
    bootId: 'boot',
    capabilities: [],
    owned: true,
    currentAccount: null,
    accounts: [],
    routes: [],
    snapshotAt: 0,
    ...overrides
  }
}

function makeRow(over: Partial<TcActivityRow> = {}): TcActivityRow {
  return {
    key: 'boot:1',
    at: 1,
    model: 'claude',
    account: 'Alpha',
    status: 200,
    durationMs: 10,
    path: '/v1/messages',
    ...over
  }
}

type Harness = {
  bridge: {
    onState: ReturnType<typeof vi.fn>
    onActivity: ReturnType<typeof vi.fn>
    getState: ReturnType<typeof vi.fn>
    pin: ReturnType<typeof vi.fn>
    setRoutes: ReturnType<typeof vi.fn>
    setAccount: ReturnType<typeof vi.fn>
    startProxy: ReturnType<typeof vi.fn>
    stopProxy: ReturnType<typeof vi.fn>
    logTail: ReturnType<typeof vi.fn>
  }
  emitState: (state: TcState) => void
  emitActivity: (rows: TcActivityRow[]) => void
  stateUnsub: ReturnType<typeof vi.fn>
  activityUnsub: ReturnType<typeof vi.fn>
}

function installBridge(
  logTailRows: TcActivityRow[] = [],
  statePromise: Promise<TcState> = Promise.resolve(makeState({ snapshotAt: 1 }))
): Harness {
  let stateListener: ((s: TcState) => void) | null = null
  let activityListener: ((rows: TcActivityRow[]) => void) | null = null
  const stateUnsub = vi.fn()
  const activityUnsub = vi.fn()
  const bridge = {
    onState: vi.fn((listener: (s: TcState) => void) => {
      stateListener = listener
      return stateUnsub
    }),
    onActivity: vi.fn((listener: (rows: TcActivityRow[]) => void) => {
      activityListener = listener
      return activityUnsub
    }),
    getState: vi.fn(() => statePromise),
    pin: vi.fn(async () => {}),
    setRoutes: vi.fn(async () => {}),
    setAccount: vi.fn(async () => {}),
    startProxy: vi.fn(async () => ({ ok: true as const })),
    stopProxy: vi.fn(async () => {}),
    logTail: vi.fn(() => Promise.resolve(logTailRows))
  }
  ;(window as unknown as { api: { teamclaude: TcBridge } }).api = { teamclaude: bridge }
  return {
    bridge,
    emitState: (s) => stateListener?.(s),
    emitActivity: (rows) => activityListener?.(rows),
    stateUnsub,
    activityUnsub
  }
}

function renderHook(): { root: Root; result: () => UseTeamclaudeResult; unmount: () => void } {
  const container = document.createElement('div')
  const root = createRoot(container)
  let latest: UseTeamclaudeResult | null = null
  function Probe(): null {
    latest = useTeamclaude()
    return null
  }
  act(() => {
    root.render(<Probe />)
  })
  return {
    root,
    result: () => latest as UseTeamclaudeResult,
    unmount: () => act(() => root.unmount())
  }
}

describe('useTeamclaude', () => {
  beforeEach(() => {
    ;(window as unknown as { api?: unknown }).api = undefined
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('reports the bridge as unavailable when none is installed', () => {
    const { result, unmount } = renderHook()
    expect(result().bridgeAvailable).toBe(false)
    unmount()
  })

  it('subscribes to state and activity and reflects pushes', async () => {
    const h = installBridge()
    const { result, unmount } = renderHook()
    expect(h.bridge.onState).toHaveBeenCalledTimes(1)
    expect(h.bridge.onActivity).toHaveBeenCalledTimes(1)
    expect(result().bridgeAvailable).toBe(true)

    act(() => h.emitState(makeState({ port: 9999 })))
    expect(result().state?.port).toBe(9999)

    act(() => h.emitActivity([makeRow({ key: 'boot:2' })]))
    expect(result().activity.map((r) => r.key)).toContain('boot:2')
    unmount()
  })

  it('subscribes before fetching current state and ignores a stale replay', async () => {
    let resolveState!: (state: TcState) => void
    const statePromise = new Promise<TcState>((resolve) => {
      resolveState = resolve
    })
    const h = installBridge([], statePromise)
    const { result, unmount } = renderHook()
    expect(h.bridge.onState.mock.invocationCallOrder[0]).toBeLessThan(
      h.bridge.getState.mock.invocationCallOrder[0]
    )

    act(() => h.emitState(makeState({ port: 9000, snapshotAt: 20 })))
    await act(async () => {
      resolveState(makeState({ port: 8000, snapshotAt: 10 }))
      await statePromise
    })
    expect(result().state?.port).toBe(9000)
    unmount()
  })

  it('seeds activity from the log tail', async () => {
    installBridge([makeRow({ key: 'boot:seed' })])
    const { result, unmount } = renderHook()
    // Flush the logTail() promise microtask.
    await act(async () => {
      await Promise.resolve()
    })
    expect(result().activity.map((r) => r.key)).toContain('boot:seed')
    unmount()
  })

  it('routes controls through the bridge with contract-shaped payloads', async () => {
    const h = installBridge()
    const { result, unmount } = renderHook()
    await act(() => result().controls.pin('a1'))
    await act(() => result().controls.stopProxy(3))
    await act(() => result().controls.setAccount({ id: 'a1', disabled: true }))
    expect(h.bridge.pin).toHaveBeenCalledWith('a1')
    expect(h.bridge.stopProxy).toHaveBeenCalledWith({ confirmLiveSessions: 3 })
    expect(h.bridge.setAccount).toHaveBeenCalledWith({ id: 'a1', disabled: true })
    unmount()
  })

  it('surfaces invoke rejections and typed proxy-start failures', async () => {
    const h = installBridge()
    h.bridge.pin.mockRejectedValueOnce(new Error('pin transport failed'))
    h.bridge.startProxy.mockResolvedValueOnce({
      ok: false,
      reason: 'no-config',
      message: 'Configure TeamClaude first.'
    })
    const { result, unmount } = renderHook()

    await act(() => result().controls.pin('a1'))
    expect(result().controlError).toMatchObject({ action: 'pin', message: 'pin transport failed' })
    await act(() => result().controls.startProxy())
    expect(result().controlError).toMatchObject({
      action: 'startProxy',
      reason: 'no-config',
      message: 'Configure TeamClaude first.'
    })
    unmount()
  })

  it('unsubscribes both channels on unmount', () => {
    const h = installBridge()
    const { unmount } = renderHook()
    unmount()
    expect(h.stateUnsub).toHaveBeenCalledTimes(1)
    expect(h.activityUnsub).toHaveBeenCalledTimes(1)
  })
})
