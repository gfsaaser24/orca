/**
 * TeamClaude IPC bridge. Spec §4 (ipc.ts) + contract TC_IPC.
 *
 * Channels are taken verbatim from `TC_IPC` in the frozen contract. `tc:state`
 * and `tc:activity` are main→renderer pushes, batched to ≤10 Hz (one send per
 * 100 ms) so a burst of transitions/events cannot flood the renderer. The
 * invoke channels (pin/routes/account/proxy start·stop/log tail) map to the
 * control plane and resolve to typed results; nothing throws into the caller.
 *
 * Only the push target rebinds per window (spec §4 module-lifecycle): the
 * handlers are registered once for the app lifetime, and pushes fan out to all
 * live windows.
 */
import { ipcMain, BrowserWindow } from 'electron'
import {
  TC_IPC,
  type TcAccountSetPayload,
  type TcActivityRow,
  type TcEffortLevel,
  type TcProxyStartResult,
  type TcRoute,
  type TcState
} from '../../shared/teamclaude-types'
import { TC_EFFORT_IPC } from '../../shared/teamclaude-effort-ipc'
import type { ControlResult } from './control'
import type { EffortHandlers } from './effort-handlers'

export type TeamclaudeIpcHandlers = {
  getState(): Promise<TcState> | TcState
  pin(accountId: string | null): Promise<ControlResult>
  setRoutes(routes: TcRoute[]): Promise<ControlResult>
  setAccount(payload: TcAccountSetPayload): Promise<ControlResult>
  proxyStart(): Promise<TcProxyStartResult>
  proxyStop(args: { confirmLiveSessions: number }): Promise<void>
  logTail(): Promise<TcActivityRow[]>
} & EffortHandlers

const MIN_PUSH_INTERVAL_MS = 100 // ≤10 Hz

export class TeamclaudeIpc {
  private readonly channels: string[] = []
  private pendingState: TcState | null = null
  private pendingActivity: TcActivityRow[] = []
  private stateTimer: NodeJS.Timeout | null = null
  private activityTimer: NodeJS.Timeout | null = null
  private lastStateSentAt = 0
  private lastActivitySentAt = 0
  private disposed = false

  constructor(handlers: TeamclaudeIpcHandlers) {
    this.register(TC_IPC.stateGet, () => handlers.getState())
    this.register(TC_IPC.pin, (_e, accountId: string | null) => handlers.pin(accountId ?? null))
    this.register(TC_IPC.routesSet, (_e, routes: TcRoute[]) => handlers.setRoutes(routes))
    this.register(TC_IPC.accountSet, (_e, payload: TcAccountSetPayload) =>
      handlers.setAccount(payload)
    )
    this.register(TC_IPC.proxyStart, () => handlers.proxyStart())
    this.register(TC_IPC.proxyStop, (_e, args: { confirmLiveSessions: number }) =>
      handlers.proxyStop(args)
    )
    this.register(TC_IPC.logTail, () => handlers.logTail())
    // Effort channels live in TC_EFFORT_IPC (additive to the frozen TC_IPC map).
    this.register(TC_EFFORT_IPC.get, () => handlers.getEffort())
    this.register(TC_EFFORT_IPC.set, (_e, level: TcEffortLevel | null) =>
      handlers.setEffort(level ?? null)
    )
  }

  private register(
    channel: string,
    handler: (event: Electron.IpcMainInvokeEvent, ...args: never[]) => unknown
  ): void {
    ipcMain.handle(channel, handler as Parameters<typeof ipcMain.handle>[1])
    this.channels.push(channel)
  }

  /** Push the latest full state, coalesced to ≤10 Hz (last write wins). */
  pushState(state: TcState): void {
    if (this.disposed) {
      return
    }
    this.pendingState = state
    this.scheduleState()
  }

  /** Push newly observed activity rows, coalesced to ≤10 Hz (accumulated). */
  pushActivity(rows: TcActivityRow[]): void {
    if (this.disposed || rows.length === 0) {
      return
    }
    this.pendingActivity.push(...rows)
    this.scheduleActivity()
  }

  private scheduleState(): void {
    if (this.stateTimer) {
      return
    }
    const elapsed = Date.now() - this.lastStateSentAt
    const delay = Math.max(0, MIN_PUSH_INTERVAL_MS - elapsed)
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null
      this.flushState()
    }, delay)
    this.stateTimer.unref?.()
  }

  private flushState(): void {
    if (!this.pendingState) {
      return
    }
    const state = this.pendingState
    this.pendingState = null
    this.lastStateSentAt = Date.now()
    this.broadcast(TC_IPC.state, state)
  }

  private scheduleActivity(): void {
    if (this.activityTimer) {
      return
    }
    const elapsed = Date.now() - this.lastActivitySentAt
    const delay = Math.max(0, MIN_PUSH_INTERVAL_MS - elapsed)
    this.activityTimer = setTimeout(() => {
      this.activityTimer = null
      this.flushActivity()
    }, delay)
    this.activityTimer.unref?.()
  }

  private flushActivity(): void {
    if (this.pendingActivity.length === 0) {
      return
    }
    const rows = this.pendingActivity
    this.pendingActivity = []
    this.lastActivitySentAt = Date.now()
    this.broadcast(TC_IPC.activity, rows)
  }

  private broadcast(channel: string, payload: unknown): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) {
        continue
      }
      const wc = win.webContents
      if (wc.isDestroyed()) {
        continue
      }
      wc.send(channel, payload)
    }
  }

  dispose(): void {
    this.disposed = true
    if (this.stateTimer) {
      clearTimeout(this.stateTimer)
    }
    if (this.activityTimer) {
      clearTimeout(this.activityTimer)
    }
    this.stateTimer = null
    this.activityTimer = null
    for (const channel of this.channels) {
      ipcMain.removeHandler(channel)
    }
    this.channels.length = 0
  }
}
