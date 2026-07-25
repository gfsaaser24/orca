import { describe, expect, it, vi } from 'vitest'
import { createCpaServiceActions } from './service-actions'

type Supervisor = { retry: ReturnType<typeof vi.fn> }

function context(overrides: Partial<Parameters<typeof createCpaServiceActions>[0]> = {}): {
  actions: ReturnType<typeof createCpaServiceActions>
  restart: ReturnType<typeof vi.fn>
  supervisor: Supervisor
} {
  const supervisor: Supervisor = { retry: vi.fn(async () => undefined) }
  // Startup bailed: no supervisor until restart() re-runs the sequence.
  let built = false
  const restart = vi.fn(async () => {
    built = true
  })
  const actions = createCpaServiceActions({
    client: () => null,
    oauth: () => null,
    modelsSync: () => null,
    supervisor: () => (built ? (supervisor as never) : null),
    refresh: async () => undefined,
    stopModules: () => undefined,
    invalidateModels: () => undefined,
    markStopped: () => undefined,
    restart,
    openExternal: async () => undefined,
    ...overrides
  })
  return { actions, restart, supervisor }
}

describe('serviceStart', () => {
  it('re-runs startup when no supervisor exists, then starts the service', async () => {
    const { actions, restart, supervisor } = context()

    await expect(actions.serviceStart()).resolves.toEqual({ ok: true })

    expect(restart).toHaveBeenCalledTimes(1)
    expect(supervisor.retry).toHaveBeenCalledTimes(1)
  })

  it('reports the startup failure instead of a bare supervisor-unavailable', async () => {
    const { actions } = context({
      restart: vi.fn(async () => {
        throw new Error('secure storage unavailable')
      })
    })

    await expect(actions.serviceStart()).resolves.toEqual({
      ok: false,
      reason: 'start-failed',
      message: 'secure storage unavailable'
    })
  })

  it('does not re-run startup when the supervisor already exists', async () => {
    const supervisor: Supervisor = { retry: vi.fn(async () => undefined) }
    const restart = vi.fn(async () => undefined)
    const actions = createCpaServiceActions({
      client: () => null,
      oauth: () => null,
      modelsSync: () => null,
      supervisor: () => supervisor as never,
      refresh: async () => undefined,
      stopModules: () => undefined,
      invalidateModels: () => undefined,
      markStopped: () => undefined,
      restart,
      openExternal: async () => undefined
    })

    await expect(actions.serviceStart()).resolves.toEqual({ ok: true })

    expect(restart).not.toHaveBeenCalled()
    expect(supervisor.retry).toHaveBeenCalledTimes(1)
  })
})

describe('loginStart', () => {
  const oauthReturning = (flow: unknown) => (): never => ({ start: async () => flow }) as never

  it('opens the authorize URL for a browser flow', async () => {
    const openExternal = vi.fn(async () => undefined)
    const flow = { kind: 'browser', state: 's1', url: 'https://auth.example/login' }
    const { actions } = context({ oauth: oauthReturning(flow), openExternal })

    await expect(actions.loginStart('codex')).resolves.toEqual(flow)

    expect(openExternal).toHaveBeenCalledWith('https://auth.example/login')
  })

  it('does not auto-open a device flow — its dialog shows the URL and code', async () => {
    const openExternal = vi.fn(async () => undefined)
    const flow = {
      kind: 'device',
      state: 's2',
      url: 'https://auth.example/device',
      userCode: 'ABCD-1234',
      expiresIn: 600
    }
    const { actions } = context({ oauth: oauthReturning(flow), openExternal })

    await expect(actions.loginStart('kimi')).resolves.toEqual(flow)

    expect(openExternal).not.toHaveBeenCalled()
  })

  it('does not try to open anything when the flow could not start', async () => {
    const openExternal = vi.fn(async () => undefined)
    const { actions } = context({
      oauth: oauthReturning({ ok: false, reason: 'port-busy', message: 'busy' }),
      openExternal
    })

    await expect(actions.loginStart('codex')).resolves.toMatchObject({ ok: false })

    expect(openExternal).not.toHaveBeenCalled()
  })
})
