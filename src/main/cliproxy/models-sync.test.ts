import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CpaModel } from '../../shared/cliproxy-types'
import { createModelsSync } from './models-sync'

type Route = {
  name: string
  match: string[]
  accounts?: string[]
  bucket?: string
}

type SyncClient = {
  getModelsAuthed: ReturnType<typeof vi.fn<() => Promise<{ data: CpaModel[] }>>>
}

function model(id: string, alias: string | null = null): CpaModel {
  return {
    id,
    provider: 'codex',
    displayName: null,
    alias,
    routable: false
  }
}

function createControl(initialRoutes: Route[] = []): {
  getRoutes: ReturnType<typeof vi.fn<() => Promise<Route[]>>>
  setRoutes: ReturnType<typeof vi.fn<(routes: Route[]) => Promise<{ ok: true }>>>
  setAccount: ReturnType<
    typeof vi.fn<(payload: { id: string; models: string[] }) => Promise<{ ok: true }>>
  >
} {
  let routes = structuredClone(initialRoutes)
  return {
    getRoutes: vi.fn(async () => structuredClone(routes)),
    setRoutes: vi.fn(async (next) => {
      routes = structuredClone(next)
      return { ok: true }
    }),
    setAccount: vi.fn(async () => ({ ok: true }))
  }
}

async function settle<T>(promise: Promise<T>, ms = 2_000): Promise<T> {
  await vi.advanceTimersByTimeAsync(ms)
  return promise
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('createModelsSync', () => {
  it('writes the exclusive route before account ownership and preserves unrelated routes', async () => {
    vi.useFakeTimers()
    const client: SyncClient = {
      getModelsAuthed: vi.fn(async () => ({
        data: [model('gpt-5.4'), model('gpt-5.4-mini')]
      }))
    }
    const existing: Route = {
      name: 'fable',
      match: ['*fable*'],
      accounts: ['work'],
      bucket: 'unified7dFable'
    }
    const control = createControl([existing])
    const sync = createModelsSync(client as never, control)

    await settle(sync.forceSync())

    expect(control.setRoutes).toHaveBeenCalledWith([
      {
        name: 'cliproxy-backends',
        match: ['gpt-5.4', 'gpt-5.4-mini'],
        accounts: ['cliproxy']
      },
      existing
    ])
    expect(control.setAccount).toHaveBeenCalledWith({
      id: 'cliproxy',
      models: ['gpt-5.4', 'gpt-5.4-mini']
    })
    expect(control.setRoutes.mock.invocationCallOrder[0]).toBeLessThan(
      control.setAccount.mock.invocationCallOrder[0]
    )
  })

  it('keeps removed models exclusively routed during the ten-minute tombstone grace', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-24T12:00:00.000Z'))
    let current = [model('removed-model')]
    const client: SyncClient = {
      getModelsAuthed: vi.fn(async () => ({ data: current }))
    }
    const control = createControl()
    const sync = createModelsSync(client as never, control)
    await settle(sync.forceSync())

    current = []
    await settle(sync.forceSync())

    expect(control.setRoutes).toHaveBeenLastCalledWith([
      {
        name: 'cliproxy-backends',
        match: ['removed-model'],
        accounts: ['cliproxy']
      }
    ])
    expect(control.setAccount).toHaveBeenLastCalledWith({ id: 'cliproxy', models: [] })

    vi.setSystemTime(new Date('2026-07-24T12:10:10.000Z'))
    await settle(sync.forceSync())
    expect(control.setRoutes).toHaveBeenLastCalledWith([])
  })

  it('rejects a stale generation before it can write routes or ownership', async () => {
    vi.useFakeTimers()
    let resolveFirst!: (models: { data: CpaModel[] }) => void
    const firstRead = new Promise<{ data: CpaModel[] }>((resolve) => {
      resolveFirst = resolve
    })
    const client: SyncClient = {
      getModelsAuthed: vi
        .fn<() => Promise<{ data: CpaModel[] }>>()
        .mockReturnValueOnce(firstRead)
        .mockResolvedValue({ data: [model('fresh-model')] })
    }
    const control = createControl()
    const sync = createModelsSync(client as never, control)

    const stale = sync.forceSync()
    await vi.advanceTimersByTimeAsync(100)
    const fresh = sync.forceSync()
    resolveFirst({ data: [model('stale-model')] })
    await settle(Promise.all([stale, fresh]))

    const writtenMatches = control.setRoutes.mock.calls.flatMap(
      ([routes]) => routes.find((route) => route.name === 'cliproxy-backends')?.match ?? []
    )
    expect(writtenMatches).toEqual(['fresh-model'])
    expect(control.setAccount).toHaveBeenCalledTimes(1)
  })

  it('polls through CPA watcher lag until the model registry converges', async () => {
    vi.useFakeTimers()
    let reads = 0
    let reloading = false
    const client: SyncClient = {
      getModelsAuthed: vi.fn(async () => {
        reads += 1
        if (!reloading) {
          return { data: [model('old-model')] }
        }
        return { data: reads < 6 ? [model('old-model')] : [model('new-model')] }
      })
    }
    const control = createControl()
    const sync = createModelsSync(client as never, control)
    await settle(sync.forceSync())
    control.setRoutes.mockClear()
    control.setAccount.mockClear()

    reloading = true
    reads = 0
    await settle(sync.forceSync())

    expect(reads).toBeGreaterThanOrEqual(6)
    expect(control.setRoutes).toHaveBeenLastCalledWith([
      {
        name: 'cliproxy-backends',
        match: ['new-model', 'old-model'],
        accounts: ['cliproxy']
      }
    ])
    expect(control.setAccount).toHaveBeenLastCalledWith({
      id: 'cliproxy',
      models: ['new-model']
    })
  })

  it('does not expose a new model through ownership when the exclusive route write fails', async () => {
    vi.useFakeTimers()
    const client: SyncClient = {
      getModelsAuthed: vi.fn(async () => ({ data: [model('new-model')] }))
    }
    const control = createControl()
    control.setRoutes.mockResolvedValueOnce({
      ok: false
    } as never)
    const sync = createModelsSync(client as never, control)

    const failedSync = sync.forceSync()
    const rejection = expect(failedSync).rejects.toThrow('route')
    await vi.advanceTimersByTimeAsync(2_000)
    await rejection
    expect(control.setAccount).not.toHaveBeenCalled()
  })
})
