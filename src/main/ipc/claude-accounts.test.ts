import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handlers, connectedRef } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  connectedRef: { current: false }
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    })
  }
}))

vi.mock('../teamclaude/init', () => ({
  getTeamclaudeUsageSnapshot: () => ({
    connected: connectedRef.current,
    usageReady: connectedRef.current,
    accounts: [],
    activeAccountName: null
  })
}))

import {
  CLAUDE_ACCOUNTS_MANAGED_BY_TEAMCLAUDE,
  registerClaudeAccountHandlers
} from './claude-accounts'

const invoke = (channel: string, args?: unknown): unknown => handlers.get(channel)?.({}, args)

describe('TeamClaude native Claude-account IPC gate', () => {
  beforeEach(() => {
    handlers.clear()
    connectedRef.current = false
  })

  it('rejects add, reauth, and switching with a typed error while connected', async () => {
    const service = {
      listAccounts: vi.fn(() => ({ accounts: [] })),
      addAccount: vi.fn(),
      cancelPendingLogin: vi.fn(() => false),
      reauthenticateAccount: vi.fn(),
      removeAccount: vi.fn(),
      selectAccount: vi.fn(),
      selectAccountForTarget: vi.fn()
    }
    registerClaudeAccountHandlers(service as never)
    connectedRef.current = true

    for (const [channel, args] of [
      ['claudeAccounts:add', undefined],
      ['claudeAccounts:reauthenticate', { accountId: 'a1' }],
      ['claudeAccounts:select', { accountId: 'a1', runtime: 'host' }]
    ] as const) {
      await expect(Promise.resolve().then(() => invoke(channel, args))).rejects.toMatchObject({
        code: CLAUDE_ACCOUNTS_MANAGED_BY_TEAMCLAUDE
      })
    }
    expect(service.addAccount).not.toHaveBeenCalled()
    expect(service.reauthenticateAccount).not.toHaveBeenCalled()
    expect(service.selectAccountForTarget).not.toHaveBeenCalled()
    expect(invoke('claudeAccounts:list')).toEqual({ accounts: [] })
    expect(invoke('claudeAccounts:cancelPendingLogin')).toBe(false)
  })

  it('keeps native handlers available when TeamClaude is disconnected', async () => {
    const service = {
      listAccounts: vi.fn(),
      addAccount: vi.fn(async () => 'added'),
      cancelPendingLogin: vi.fn(),
      reauthenticateAccount: vi.fn(async () => 'reauthenticated'),
      removeAccount: vi.fn(),
      selectAccount: vi.fn(async () => 'selected'),
      selectAccountForTarget: vi.fn()
    }
    registerClaudeAccountHandlers(service as never)

    await expect(invoke('claudeAccounts:add')).resolves.toBe('added')
    await expect(invoke('claudeAccounts:reauthenticate', { accountId: 'a1' })).resolves.toBe(
      'reauthenticated'
    )
    await expect(invoke('claudeAccounts:select', { accountId: null })).resolves.toBe('selected')
  })
})
