import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CPA_IPC, type CpaState } from '../../shared/cliproxy-types'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  removeHandler: vi.fn(),
  send: vi.fn(),
  trusted: vi.fn(() => true),
  windows: [] as unknown[]
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      mocks.handlers.set(channel, handler),
    removeHandler: mocks.removeHandler
  },
  BrowserWindow: { getAllWindows: () => mocks.windows }
}))

vi.mock('../ipc/ui', () => ({ isTrustedUIRenderer: mocks.trusted }))

import { CpaIpc, type CpaIpcHandlers } from './ipc'

function state(snapshotAt: number): CpaState {
  return {
    lifecycle: 'owned',
    readiness: {
      alive: true,
      modelsReady: true,
      managementReady: true,
      routingLinked: true
    },
    reasonKey: null,
    reasonDetail: null,
    port: 8319,
    version: '7.2.97',
    owned: true,
    accounts: [],
    models: [],
    usage: [],
    claudeDelegated: false,
    snapshotAt
  }
}

function handlers(current: () => CpaState): CpaIpcHandlers {
  return {
    getState: current,
    loginStart: vi.fn(),
    loginPoll: vi.fn(),
    loginCancel: vi.fn(),
    accountSetDisabled: vi.fn(),
    accountSetFields: vi.fn(),
    accountDelete: vi.fn(),
    aliasSet: vi.fn(),
    serviceStart: vi.fn(),
    serviceStop: vi.fn(),
    logsTail: vi.fn()
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  mocks.handlers.clear()
  mocks.removeHandler.mockReset()
  mocks.send.mockReset()
  mocks.trusted.mockReset()
  mocks.trusted.mockReturnValue(true)
  mocks.windows.length = 0
})

describe('CpaIpc', () => {
  it('supports subscribe-then-get replay and coalesces pushes to at most 10 Hz', async () => {
    let current = state(1)
    const ipc = new CpaIpc(handlers(() => current))
    const webContents = { isDestroyed: () => false, send: mocks.send }
    mocks.windows.push({ isDestroyed: () => false, webContents })

    const stateGet = mocks.handlers.get(CPA_IPC.stateGet)!
    await expect(Promise.resolve(stateGet({ sender: webContents }))).resolves.toEqual(current)

    ipc.pushState(state(2))
    current = state(3)
    ipc.pushState(current)
    await vi.runAllTimersAsync()
    expect(mocks.send).toHaveBeenCalledTimes(1)
    expect(mocks.send).toHaveBeenCalledWith(CPA_IPC.state, current)
    ipc.dispose()
  })

  it('rejects untrusted senders before invoking a handler', () => {
    const ipcHandlers = handlers(() => state(1))
    new CpaIpc(ipcHandlers)
    mocks.trusted.mockReturnValue(false)

    const invoke = mocks.handlers.get(CPA_IPC.accountDelete)!
    expect(() => invoke({ sender: {} }, { name: 'account.json' })).toThrow('Unauthorized')
    expect(ipcHandlers.accountDelete).not.toHaveBeenCalled()
  })

  it('runtime-validates payload shape and rejects extra fields', () => {
    const ipcHandlers = handlers(() => state(1))
    new CpaIpc(ipcHandlers)
    const sender = {}

    expect(() =>
      mocks.handlers.get(CPA_IPC.accountSetDisabled)!(
        { sender },
        { name: 'account.json', disabled: 'yes' }
      )
    ).toThrow('disabled')
    expect(() =>
      mocks.handlers.get(CPA_IPC.aliasSet)!(
        { sender },
        { channel: 'codex', aliases: [], raw: true }
      )
    ).toThrow('Unexpected')
    expect(() =>
      mocks.handlers.get(CPA_IPC.accountSetFields)!(
        { sender },
        { name: 'account.json', priority: Number.MAX_SAFE_INTEGER }
      )
    ).toThrow('priority')
    expect(ipcHandlers.accountSetDisabled).not.toHaveBeenCalled()
    expect(ipcHandlers.accountSetFields).not.toHaveBeenCalled()
    expect(ipcHandlers.aliasSet).not.toHaveBeenCalled()
  })
})
