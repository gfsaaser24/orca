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

function installBridge(logTailRows: TcActivityRow[] = []): Harness {
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
    pin: vi.fn(),
    setRoutes: vi.fn(),
    setAccount: vi.fn(),
    startProxy: vi.fn(),
    stopProxy: vi.fn(),
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

  it('routes controls through the bridge with contract-shaped payloads', () => {
    const h = installBridge()
    const { result, unmount } = renderHook()
    act(() => result().controls.pin('a1'))
    act(() => result().controls.stopProxy(3))
    act(() => result().controls.setAccount({ id: 'a1', disabled: true }))
    expect(h.bridge.pin).toHaveBeenCalledWith('a1')
    expect(h.bridge.stopProxy).toHaveBeenCalledWith({ confirmLiveSessions: 3 })
    expect(h.bridge.setAccount).toHaveBeenCalledWith({ id: 'a1', disabled: true })
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
