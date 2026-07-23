import { useEffect, useMemo, useRef, useState } from 'react'

import type {
  TcAccountSetPayload,
  TcActivityRow,
  TcBridge as SharedTcBridge,
  TcProxyStartResult,
  TcRoute,
  TcState
} from '../../../shared/teamclaude-types'
import { mergeActivity } from '../components/teamclaude/teamclaude-model'

/**
 * Renderer view of the TeamClaude preload bridge. The main-process/preload team
 * exposes this object at `window.api.teamclaude`, matching the TC_IPC channels
 * in the frozen contract. This hook is the ONLY place that reads the bridge, so
 * tests mock a single seam (assign `window.api.teamclaude`).
 */
export type TcBridge = SharedTcBridge

export type TeamclaudeControls = {
  pin: (accountId: string | null) => Promise<void>
  setRoutes: (routes: TcRoute[]) => Promise<void>
  setAccount: (payload: TcAccountSetPayload) => Promise<void>
  startProxy: () => Promise<void>
  stopProxy: (confirmLiveSessions: number) => Promise<void>
}

export type TeamclaudeControlError = {
  action: 'getState' | 'logTail' | 'pin' | 'setRoutes' | 'setAccount' | 'startProxy' | 'stopProxy'
  message: string
  reason?: Exclude<TcProxyStartResult, { ok: true }>['reason']
}

export type UseTeamclaudeResult = {
  state: TcState | null
  activity: TcActivityRow[]
  controls: TeamclaudeControls
  controlError: TeamclaudeControlError | null
  /** False when the preload bridge is not present (e.g. web build, or the
   *  main-process module has not registered yet). */
  bridgeAvailable: boolean
}

/** Read the preload bridge without leaking `window.api` typing across the app. */
export function resolveTcBridge(): TcBridge | null {
  if (typeof window === 'undefined') {
    return null
  }
  const api = (window as unknown as { api?: { teamclaude?: TcBridge } }).api
  return api?.teamclaude ?? null
}

const NULL_CONTROLS: TeamclaudeControls = {
  pin: async () => {},
  setRoutes: async () => {},
  setAccount: async () => {},
  startProxy: async () => {},
  stopProxy: async () => {}
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Consume the TeamClaude cockpit bridge: subscribe to `tc:state` / `tc:activity`
 * pushes, seed activity from the log tail, and expose the invoke-side controls.
 * All bridge access is contained here.
 */
export function useTeamclaude(): UseTeamclaudeResult {
  const bridgeRef = useRef<TcBridge | null>(null)
  if (bridgeRef.current === null) {
    bridgeRef.current = resolveTcBridge()
  }
  const bridge = bridgeRef.current

  const [state, setState] = useState<TcState | null>(null)
  const [activity, setActivity] = useState<TcActivityRow[]>([])
  const [controlError, setControlError] = useState<TeamclaudeControlError | null>(null)

  useEffect(() => {
    if (!bridge) {
      return
    }
    let active = true
    const unsubscribeState = bridge.onState((next) => {
      if (active) {
        setState((current) => (current && current.snapshotAt > next.snapshotAt ? current : next))
      }
    })
    const unsubscribeActivity = bridge.onActivity((rows) => {
      if (active) {
        setActivity((previous) => mergeActivity(previous, rows))
      }
    })
    // Why: subscribe first so a window recreation cannot miss a transition
    // between reading the singleton and attaching the push listener.
    void bridge
      .getState()
      .then((next) => {
        if (active) {
          setState((current) => (current && current.snapshotAt >= next.snapshotAt ? current : next))
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setControlError({ action: 'getState', message: errorMessage(error) })
        }
      })
    // Seed the retained buffer from the proxy log so the Activity tab is
    // populated before the first incremental push arrives.
    void Promise.resolve(bridge.logTail())
      .then((rows) => {
        if (active && rows.length > 0) {
          setActivity((previous) => mergeActivity(previous, rows))
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setControlError({ action: 'logTail', message: errorMessage(error) })
        }
      })
    return () => {
      active = false
      unsubscribeState()
      unsubscribeActivity()
    }
  }, [bridge])

  const controls = useMemo<TeamclaudeControls>(() => {
    if (!bridge) {
      return NULL_CONTROLS
    }
    const run = async (
      action: TeamclaudeControlError['action'],
      invoke: () => Promise<unknown>
    ): Promise<void> => {
      setControlError(null)
      try {
        await invoke()
      } catch (error) {
        setControlError({ action, message: errorMessage(error) })
      }
    }
    return {
      pin: (accountId) => run('pin', () => bridge.pin(accountId)),
      setRoutes: (routes) => run('setRoutes', () => bridge.setRoutes(routes)),
      setAccount: (payload) => run('setAccount', () => bridge.setAccount(payload)),
      startProxy: async () => {
        setControlError(null)
        try {
          const result = await bridge.startProxy()
          if (!result.ok) {
            setControlError({
              action: 'startProxy',
              reason: result.reason,
              message: result.message
            })
          }
        } catch (error) {
          setControlError({ action: 'startProxy', message: errorMessage(error) })
        }
      },
      stopProxy: (confirmLiveSessions) =>
        run('stopProxy', () => bridge.stopProxy({ confirmLiveSessions }))
    }
  }, [bridge])

  return {
    state,
    activity,
    controls,
    controlError,
    bridgeAvailable: bridge !== null
  }
}
