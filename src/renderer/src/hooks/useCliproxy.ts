import { useEffect, useMemo, useRef, useState } from 'react'

import type {
  CpaActionResult,
  CpaBridge as SharedCpaBridge,
  CpaOauthFlow,
  CpaOauthStatus,
  CpaProviderKind,
  CpaState
} from '../../../shared/cliproxy-types'

/** Renderer view of the frozen preload bridge. This is the only bridge seam. */
export type CpaBridge = SharedCpaBridge

export type CliproxyControls = {
  loginStart: (provider: CpaProviderKind) => Promise<CpaOauthFlow | CpaActionResult>
  loginPoll: (state: string) => Promise<CpaOauthStatus>
  loginCancel: (state: string) => Promise<CpaActionResult>
  accountSetDisabled: (payload: { name: string; disabled: boolean }) => Promise<CpaActionResult>
  accountSetFields: (payload: {
    name: string
    priority?: number
    note?: string
  }) => Promise<CpaActionResult>
  accountDelete: (payload: { name: string }) => Promise<CpaActionResult>
  aliasSet: (payload: {
    channel: string
    aliases: Record<string, string>
  }) => Promise<CpaActionResult>
  serviceStart: () => Promise<CpaActionResult>
  serviceStop: () => Promise<CpaActionResult>
  logsTail: (cursor: string | null) => Promise<{ lines: string[]; nextCursor: string | null }>
}

export type CliproxyControlError = {
  action: keyof CliproxyControls | 'getState'
  message: string
}

export type UseCliproxyResult = {
  state: CpaState | null
  controls: CliproxyControls
  controlError: CliproxyControlError | null
  bridgeAvailable: boolean
}

export function resolveCpaBridge(): CpaBridge | null {
  if (typeof window === 'undefined') {
    return null
  }
  const api = (window as unknown as { api?: { cliproxy?: CpaBridge } }).api
  return api?.cliproxy ?? null
}

const BRIDGE_UNAVAILABLE: CpaActionResult = {
  ok: false,
  reason: 'bridge-unavailable',
  message: ''
}

const NULL_CONTROLS: CliproxyControls = {
  loginStart: async () => BRIDGE_UNAVAILABLE,
  loginPoll: async () => 'error',
  loginCancel: async () => BRIDGE_UNAVAILABLE,
  accountSetDisabled: async () => BRIDGE_UNAVAILABLE,
  accountSetFields: async () => BRIDGE_UNAVAILABLE,
  accountDelete: async () => BRIDGE_UNAVAILABLE,
  aliasSet: async () => BRIDGE_UNAVAILABLE,
  serviceStart: async () => BRIDGE_UNAVAILABLE,
  serviceStop: async () => BRIDGE_UNAVAILABLE,
  logsTail: async () => ({ lines: [], nextCursor: null })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function useCliproxy(): UseCliproxyResult {
  const bridgeRef = useRef<CpaBridge | null>(null)
  if (bridgeRef.current === null) {
    bridgeRef.current = resolveCpaBridge()
  }
  const bridge = bridgeRef.current
  const [state, setState] = useState<CpaState | null>(null)
  const [controlError, setControlError] = useState<CliproxyControlError | null>(null)

  useEffect(() => {
    if (!bridge) {
      return
    }
    let active = true
    const unsubscribe = bridge.onState((next) => {
      if (active) {
        setState((current) => (current && current.snapshotAt > next.snapshotAt ? current : next))
      }
    })
    // Why: subscribe first so renderer recreation cannot miss a singleton transition.
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
    return () => {
      active = false
      unsubscribe()
    }
  }, [bridge])

  const controls = useMemo<CliproxyControls>(() => {
    if (!bridge) {
      return NULL_CONTROLS
    }
    const invoke = async <T>(
      actionName: CliproxyControlError['action'],
      call: () => Promise<T>,
      onError: (message: string) => T
    ): Promise<T> => {
      setControlError(null)
      try {
        return await call()
      } catch (error) {
        const message = errorMessage(error)
        setControlError({ action: actionName, message })
        return onError(message)
      }
    }
    const action = (
      name: CliproxyControlError['action'],
      call: () => Promise<CpaActionResult>
    ): Promise<CpaActionResult> =>
      invoke(name, call, (message) => ({ ok: false, reason: 'invoke-failed', message }))
    return {
      loginStart: (provider) =>
        invoke(
          'loginStart',
          () => bridge.loginStart(provider),
          (message) => ({
            ok: false,
            reason: 'invoke-failed',
            message
          })
        ),
      loginPoll: (flowState) =>
        invoke(
          'loginPoll',
          () => bridge.loginPoll(flowState),
          () => 'error'
        ),
      loginCancel: (flowState) => action('loginCancel', () => bridge.loginCancel(flowState)),
      accountSetDisabled: (payload) =>
        action('accountSetDisabled', () => bridge.accountSetDisabled(payload)),
      accountSetFields: (payload) =>
        action('accountSetFields', () => bridge.accountSetFields(payload)),
      accountDelete: (payload) => action('accountDelete', () => bridge.accountDelete(payload)),
      aliasSet: (payload) => action('aliasSet', () => bridge.aliasSet(payload)),
      serviceStart: () => action('serviceStart', () => bridge.serviceStart()),
      serviceStop: () => action('serviceStop', () => bridge.serviceStop()),
      logsTail: (cursor) =>
        invoke(
          'logsTail',
          () => bridge.logsTail(cursor),
          () => ({ lines: [], nextCursor: null })
        )
    }
  }, [bridge])

  return {
    state,
    controls,
    controlError,
    bridgeAvailable: bridge !== null
  }
}
