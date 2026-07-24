import { BrowserWindow, ipcMain } from 'electron'
import {
  CPA_IPC,
  type CpaActionResult,
  type CpaOauthFlow,
  type CpaOauthStatus,
  type CpaProviderKind,
  type CpaState
} from '../../shared/cliproxy-types'
import { isTrustedUIRenderer } from '../ipc/ui'

const MIN_PUSH_INTERVAL_MS = 100
const PROVIDERS = new Set<CpaProviderKind>([
  'gemini',
  'antigravity',
  'codex',
  'claude',
  'xai',
  'kimi',
  'api-key',
  'openai-compat',
  'plugin'
])

export type CpaIpcHandlers = {
  getState(): Promise<CpaState> | CpaState
  loginStart(provider: CpaProviderKind): Promise<CpaOauthFlow | CpaActionResult>
  loginPoll(state: string): Promise<CpaOauthStatus>
  loginCancel(state: string): Promise<CpaActionResult>
  accountSetDisabled(payload: { name: string; disabled: boolean }): Promise<CpaActionResult>
  accountSetFields(payload: {
    name: string
    priority?: number
    note?: string
  }): Promise<CpaActionResult>
  accountDelete(payload: { name: string }): Promise<CpaActionResult>
  aliasSet(payload: { channel: string; aliases: Record<string, string> }): Promise<CpaActionResult>
  serviceStart(): Promise<CpaActionResult>
  serviceStop(): Promise<CpaActionResult>
  logsTail(cursor: string | null): Promise<{ lines: string[]; nextCursor: string | null }>
}

type InvokeHandler = (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown

export class CpaIpc {
  private readonly channels: string[] = []
  private pendingState: CpaState | null = null
  private stateTimer: NodeJS.Timeout | null = null
  private lastStateSentAt = 0
  private disposed = false

  constructor(handlers: CpaIpcHandlers) {
    this.register(CPA_IPC.stateGet, (_event, ...args) => {
      requireNoArgs(args)
      return handlers.getState()
    })
    this.register(CPA_IPC.loginStart, (_event, provider) =>
      handlers.loginStart(requireProvider(provider))
    )
    this.register(CPA_IPC.loginPoll, (_event, state) => handlers.loginPoll(requireState(state)))
    this.register(CPA_IPC.loginCancel, (_event, state) => handlers.loginCancel(requireState(state)))
    this.register(CPA_IPC.accountSetDisabled, (_event, payload) =>
      handlers.accountSetDisabled(requireAccountDisabled(payload))
    )
    this.register(CPA_IPC.accountSetFields, (_event, payload) =>
      handlers.accountSetFields(requireAccountFields(payload))
    )
    this.register(CPA_IPC.accountDelete, (_event, payload) =>
      handlers.accountDelete({ name: requireNamePayload(payload).name })
    )
    this.register(CPA_IPC.aliasSet, (_event, payload) =>
      handlers.aliasSet(requireAliasPayload(payload))
    )
    this.register(CPA_IPC.serviceStart, (_event, ...args) => {
      requireNoArgs(args)
      return handlers.serviceStart()
    })
    this.register(CPA_IPC.serviceStop, (_event, ...args) => {
      requireNoArgs(args)
      return handlers.serviceStop()
    })
    this.register(CPA_IPC.logsTail, (_event, cursor) => handlers.logsTail(requireCursor(cursor)))
  }

  pushState(state: CpaState): void {
    if (this.disposed) {
      return
    }
    this.pendingState = state
    if (this.stateTimer) {
      return
    }
    const delay = Math.max(0, MIN_PUSH_INTERVAL_MS - (Date.now() - this.lastStateSentAt))
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null
      this.flushState()
    }, delay)
    this.stateTimer.unref?.()
  }

  dispose(): void {
    this.disposed = true
    if (this.stateTimer) {
      clearTimeout(this.stateTimer)
      this.stateTimer = null
    }
    for (const channel of this.channels) {
      ipcMain.removeHandler(channel)
    }
    this.channels.length = 0
  }

  private register(channel: string, handler: InvokeHandler): void {
    ipcMain.handle(channel, (event, ...args) => {
      if (!isTrustedUIRenderer(event.sender)) {
        throw new Error(`Unauthorized CLIProxyAPI IPC sender for ${channel}`)
      }
      return handler(event, ...args)
    })
    this.channels.push(channel)
  }

  private flushState(): void {
    if (!this.pendingState) {
      return
    }
    const state = this.pendingState
    this.pendingState = null
    this.lastStateSentAt = Date.now()
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed()) {
        continue
      }
      const webContents = window.webContents
      if (webContents.isDestroyed() || !isTrustedUIRenderer(webContents)) {
        continue
      }
      webContents.send(CPA_IPC.state, state)
    }
  }
}

function requireNoArgs(args: unknown[]): void {
  if (args.length !== 0) {
    throw new TypeError('Unexpected CLIProxyAPI IPC payload')
  }
}

function requireProvider(value: unknown): CpaProviderKind {
  if (typeof value !== 'string' || !PROVIDERS.has(value as CpaProviderKind)) {
    throw new TypeError('Invalid CLIProxyAPI provider')
  }
  return value as CpaProviderKind
}

function requireState(value: unknown): string {
  return requireBoundedString(value, 'OAuth state', 1, 512)
}

function requireCursor(value: unknown): string | null {
  if (value === null) {
    return null
  }
  return requireBoundedString(value, 'log cursor', 1, 4096)
}

function requireNamePayload(value: unknown): { name: string } {
  const payload = requireRecord(value, 'account payload')
  requireOnlyKeys(payload, ['name'])
  return { name: requireBoundedString(payload.name, 'account name', 1, 512) }
}

function requireAccountDisabled(value: unknown): { name: string; disabled: boolean } {
  const payload = requireRecord(value, 'account status payload')
  requireOnlyKeys(payload, ['name', 'disabled'])
  if (typeof payload.disabled !== 'boolean') {
    throw new TypeError('Invalid disabled value')
  }
  return {
    name: requireBoundedString(payload.name, 'account name', 1, 512),
    disabled: payload.disabled
  }
}

function requireAccountFields(value: unknown): {
  name: string
  priority?: number
  note?: string
} {
  const payload = requireRecord(value, 'account fields payload')
  requireOnlyKeys(payload, ['name', 'priority', 'note'])
  const result: { name: string; priority?: number; note?: string } = {
    name: requireBoundedString(payload.name, 'account name', 1, 512)
  }
  if ('priority' in payload) {
    if (
      !Number.isSafeInteger(payload.priority) ||
      (payload.priority as number) < -1_000_000 ||
      (payload.priority as number) > 1_000_000
    ) {
      throw new TypeError('Invalid account priority')
    }
    result.priority = payload.priority as number
  }
  if ('note' in payload) {
    result.note = requireBoundedString(payload.note, 'account note', 0, 4096)
  }
  if (result.priority === undefined && result.note === undefined) {
    throw new TypeError('No account fields supplied')
  }
  return result
}

function requireAliasPayload(value: unknown): {
  channel: string
  aliases: Record<string, string>
} {
  const payload = requireRecord(value, 'alias payload')
  requireOnlyKeys(payload, ['channel', 'aliases'])
  const aliasesValue = requireRecord(payload.aliases, 'aliases')
  const entries = Object.entries(aliasesValue)
  if (entries.length > 2_000) {
    throw new TypeError('Too many aliases')
  }
  const aliases: Record<string, string> = Object.create(null) as Record<string, string>
  for (const [model, alias] of entries) {
    const safeModel = requireBoundedString(model, 'alias model', 1, 512)
    aliases[safeModel] = requireBoundedString(alias, 'alias value', 1, 512)
  }
  return {
    channel: requireBoundedString(payload.channel, 'alias channel', 1, 128),
    aliases
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`Invalid ${label}`)
  }
  return value as Record<string, unknown>
}

function requireOnlyKeys(value: Record<string, unknown>, allowed: string[]): void {
  const allowedSet = new Set(allowed)
  if (Object.keys(value).some((key) => !allowedSet.has(key))) {
    throw new TypeError('Unexpected CLIProxyAPI IPC field')
  }
}

function requireBoundedString(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number
): string {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum) {
    throw new TypeError(`Invalid ${label}`)
  }
  return value
}
