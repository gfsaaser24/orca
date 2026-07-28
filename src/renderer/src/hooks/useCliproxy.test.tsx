// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CpaState } from '../../../shared/cliproxy-types'
import { useCliproxy, type CpaBridge, type UseCliproxyResult } from './useCliproxy'

function makeState(overrides: Partial<CpaState> = {}): CpaState {
  return {
    lifecycle: 'owned',
    readiness: { alive: true, modelsReady: true, managementReady: true, routingLinked: true },
    reasonKey: null,
    reasonDetail: null,
    port: 8319,
    version: '7.2.97',
    owned: true,
    accounts: [],
    models: [],
    usage: [],
    claudeDelegated: false,
    snapshotAt: 1,
    ...overrides
  }
}

function installBridge(statePromise: Promise<CpaState> = Promise.resolve(makeState())) {
  let listener: ((state: CpaState) => void) | null = null
  const unsubscribe = vi.fn()
  const bridge = {
    onState: vi.fn((next: (state: CpaState) => void) => {
      listener = next
      return unsubscribe
    }),
    getState: vi.fn(() => statePromise),
    loginStart: vi.fn(async () => ({
      kind: 'browser' as const,
      state: 'flow',
      url: 'https://login'
    })),
    loginPoll: vi.fn(async () => 'wait' as const),
    loginCancel: vi.fn(async () => ({ ok: true as const })),
    accountSetDisabled: vi.fn(async () => ({ ok: true as const })),
    accountSetFields: vi.fn(async () => ({ ok: true as const })),
    accountDelete: vi.fn(async () => ({ ok: true as const })),
    aliasSet: vi.fn(async () => ({ ok: true as const })),
    serviceStart: vi.fn(async () => ({ ok: true as const })),
    serviceStop: vi.fn(async () => ({ ok: true as const })),
    logsTail: vi.fn(async () => ({ lines: [], nextCursor: null }))
  }
  ;(window as unknown as { api: { cliproxy: CpaBridge } }).api = { cliproxy: bridge }
  return { bridge, unsubscribe, emit: (state: CpaState) => listener?.(state) }
}

function renderHook(): { result: () => UseCliproxyResult; unmount: () => void } {
  const root: Root = createRoot(document.createElement('div'))
  let latest: UseCliproxyResult | null = null
  function Probe(): null {
    latest = useCliproxy()
    return null
  }
  act(() => root.render(<Probe />))
  return {
    result: () => latest as UseCliproxyResult,
    unmount: () => act(() => root.unmount())
  }
}

describe('useCliproxy', () => {
  beforeEach(() => {
    ;(window as unknown as { api?: unknown }).api = undefined
  })
  afterEach(() => vi.restoreAllMocks())

  it('is null-safe when the preload bridge is absent', async () => {
    const { result, unmount } = renderHook()
    expect(result().bridgeAvailable).toBe(false)
    expect(result().state).toBeNull()
    await expect(result().controls.serviceStart()).resolves.toMatchObject({ ok: false })
    unmount()
  })

  it('subscribes before getState and keeps a newer pushed snapshot', async () => {
    let resolveState!: (state: CpaState) => void
    const statePromise = new Promise<CpaState>((resolve) => {
      resolveState = resolve
    })
    const harness = installBridge(statePromise)
    const { result, unmount } = renderHook()
    expect(harness.bridge.onState.mock.invocationCallOrder[0]).toBeLessThan(
      harness.bridge.getState.mock.invocationCallOrder[0]
    )
    act(() => harness.emit(makeState({ port: 9000, snapshotAt: 20 })))
    await act(async () => {
      resolveState(makeState({ port: 8000, snapshotAt: 10 }))
      await statePromise
    })
    expect(result().state?.port).toBe(9000)
    unmount()
  })

  it('routes contract-shaped controls through the single bridge seam', async () => {
    const harness = installBridge()
    const { result, unmount } = renderHook()
    await act(() => result().controls.accountSetDisabled({ name: 'codex.json', disabled: true }))
    await act(() => result().controls.aliasSet({ channel: 'codex', aliases: { gpt: 'work' } }))
    await act(() => result().controls.logsTail('cursor-1'))
    expect(harness.bridge.accountSetDisabled).toHaveBeenCalledWith({
      name: 'codex.json',
      disabled: true
    })
    expect(harness.bridge.aliasSet).toHaveBeenCalledWith({
      channel: 'codex',
      aliases: { gpt: 'work' }
    })
    expect(harness.bridge.logsTail).toHaveBeenCalledWith('cursor-1')
    unmount()
  })

  it('unsubscribes from state on unmount', () => {
    const harness = installBridge()
    const { unmount } = renderHook()
    unmount()
    expect(harness.unsubscribe).toHaveBeenCalledTimes(1)
  })
})
