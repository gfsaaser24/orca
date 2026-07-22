import { useEffect, useMemo, useRef, useState } from 'react'

import type {
  TcAccountSetPayload,
  TcActivityRow,
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
export type TcBridge = {
  /** Subscribe to batched `tc:state` pushes. Returns an unsubscribe fn. */
  onState(listener: (state: TcState) => void): () => void
  /** Subscribe to batched `tc:activity` pushes. Returns an unsubscribe fn. */
  onActivity(listener: (rows: TcActivityRow[]) => void): () => void
  /** `tc:pin` — pass null to unpin. */
  pin(accountId: string | null): Promise<void> | void
  /** `tc:routes:set` */
  setRoutes(routes: TcRoute[]): Promise<void> | void
  /** `tc:account:set` */
  setAccount(payload: TcAccountSetPayload): Promise<void> | void
  /** `tc:proxy:start` */
  startProxy(): Promise<void> | void
  /** `tc:proxy:stop` — count echoed back as consent. */
  stopProxy(payload: { confirmLiveSessions: number }): Promise<void> | void
  /** `tc:log:tail` — seed activity from /log. */
  logTail(): Promise<TcActivityRow[]>
}

export type TeamclaudeControls = {
  pin: (accountId: string | null) => void
  setRoutes: (routes: TcRoute[]) => void
  setAccount: (payload: TcAccountSetPayload) => void
  startProxy: () => void
  stopProxy: (confirmLiveSessions: number) => void
}

export type UseTeamclaudeResult = {
  state: TcState | null
  activity: TcActivityRow[]
  controls: TeamclaudeControls
  /** False when the preload bridge is not present (e.g. web build, or the
   *  main-process module has not registered yet). */
  bridgeAvailable: boolean
}

/** Read the preload bridge without leaking `window.api` typing across the app. */
export function resolveTcBridge(): TcBridge | null {
  const api = (window as unknown as { api?: { teamclaude?: TcBridge } }).api
  return api?.teamclaude ?? null
}

const NULL_CONTROLS: TeamclaudeControls = {
  pin: () => {},
  setRoutes: () => {},
  setAccount: () => {},
  startProxy: () => {},
  stopProxy: () => {}
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

  useEffect(() => {
    if (!bridge) {
      return
    }
    let active = true
    const unsubscribeState = bridge.onState((next) => {
      if (active) {
        setState(next)
      }
    })
    const unsubscribeActivity = bridge.onActivity((rows) => {
      if (active) {
        setActivity((previous) => mergeActivity(previous, rows))
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
      .catch(() => {
        // Why: a missing/failed seed is non-fatal — live pushes still populate
        // the buffer. Swallow so a cold proxy does not surface a console error.
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
    return {
      pin: (accountId) => void bridge.pin(accountId),
      setRoutes: (routes) => void bridge.setRoutes(routes),
      setAccount: (payload) => void bridge.setAccount(payload),
      startProxy: () => void bridge.startProxy(),
      stopProxy: (confirmLiveSessions) => void bridge.stopProxy({ confirmLiveSessions })
    }
  }, [bridge])

  return {
    state,
    activity,
    controls,
    bridgeAvailable: bridge !== null
  }
}
