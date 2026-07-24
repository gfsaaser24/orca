import type { ManagementClient } from './management-client'

const EXCLUSIVE_ROUTE_NAME = 'cliproxy-backends'
const CLIPROXY_ACCOUNT_ID = 'cliproxy'
const TOMBSTONE_GRACE_MS = 10 * 60 * 1_000
const SYNC_DEBOUNCE_MS = 100
const MODEL_POLL_MS = 50
const MODEL_RELOAD_SETTLE_MS = 250
const MODEL_RELOAD_TIMEOUT_MS = 5_000
const PERIODIC_SYNC_MS = 5_000

export type TeamclaudeBackendRoute = {
  name: string
  match: string[]
  accounts?: string[]
  bucket?: string | null
}

type TeamclaudeMutationResult = {
  ok: boolean
  error?: string
}

export type ModelsSyncControl = {
  getRoutes(): Promise<TeamclaudeBackendRoute[] | { ok: boolean; routes: TeamclaudeBackendRoute[] }>
  setRoutes(routes: TeamclaudeBackendRoute[]): Promise<TeamclaudeMutationResult>
  setAccount(payload: {
    id: typeof CLIPROXY_ACCOUNT_ID
    models: string[]
  }): Promise<TeamclaudeMutationResult>
}

type ModelView = {
  id: string
  fingerprint: string
}

type SyncWaiter = {
  resolve: () => void
  reject: (error: unknown) => void
}

class StaleSyncGeneration extends Error {}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right))
}

function modelViews(
  response: Awaited<ReturnType<ManagementClient['getModelsAuthed']>>
): ModelView[] {
  const byId = new Map<string, ModelView>()
  for (const model of response.data) {
    const id = typeof model.id === 'string' ? model.id.trim() : ''
    if (!id) {
      continue
    }
    const safeFingerprint = {
      id,
      alias: typeof model.alias === 'string' ? model.alias : null,
      displayName: typeof model.display_name === 'string' ? model.display_name : null,
      owner: typeof model.owned_by === 'string' ? model.owned_by : null,
      provider: typeof model.provider === 'string' ? model.provider : null
    }
    byId.set(id, { id, fingerprint: JSON.stringify(safeFingerprint) })
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id))
}

function normalizeRoutes(
  response: Awaited<ReturnType<ModelsSyncControl['getRoutes']>>
): TeamclaudeBackendRoute[] {
  const routes = Array.isArray(response) ? response : response.ok ? response.routes : null
  if (!routes) {
    throw new Error('TeamClaude route read failed')
  }
  return routes.map((route) => ({
    name: route.name,
    match: [...route.match],
    ...(route.accounts ? { accounts: [...route.accounts] } : {}),
    ...(route.bucket != null ? { bucket: route.bucket } : {})
  }))
}

function requireMutation(result: TeamclaudeMutationResult, kind: 'route' | 'account'): void {
  if (!result.ok) {
    throw new Error(`TeamClaude ${kind} update failed`)
  }
}

export function createModelsSync(
  client: ManagementClient,
  tcControl: ModelsSyncControl
): {
  start(): void
  stop(): void
  forceSync(): Promise<void>
} {
  let requestedGeneration = 0
  let completedGeneration = 0
  let runner: Promise<void> | null = null
  let debounceTimer: NodeJS.Timeout | null = null
  let periodicTimer: NodeJS.Timeout | null = null
  let started = false
  let waiters: SyncWaiter[] = []
  let lastLiveModels = new Set<string>()
  const tombstones = new Map<string, number>()

  const assertCurrent = (generation: number): void => {
    if (generation !== requestedGeneration) {
      throw new StaleSyncGeneration()
    }
  }

  const readConvergedModels = async (generation: number): Promise<ModelView[]> => {
    const startedAt = Date.now()
    let previousFingerprint: string | null = null
    let stableReads = 0
    while (Date.now() - startedAt <= MODEL_RELOAD_TIMEOUT_MS) {
      const views = modelViews(await client.getModelsAuthed())
      assertCurrent(generation)
      const fingerprint = views.map((view) => view.fingerprint).join('\n')
      stableReads = fingerprint === previousFingerprint ? stableReads + 1 : 1
      previousFingerprint = fingerprint
      // Why: CPA acknowledges management writes before its 150ms watcher reload reaches /v1/models.
      if (Date.now() - startedAt >= MODEL_RELOAD_SETTLE_MS && stableReads >= 2) {
        return views
      }
      await delay(MODEL_POLL_MS)
      assertCurrent(generation)
    }
    throw new Error('CLIProxyAPI model registry did not converge after its reload')
  }

  // Claude-family models must never enter the teamclaude backend route: the
  // fleet already owns claude-* routing, and the delegated CPA Claude provider
  // forwards THROUGH teamclaude — routing claude ids back to the backend
  // account would loop requests (teamclaude -> CPA -> teamclaude).
  const isClaudeFamilyId = (id: string): boolean => /claude/i.test(id)

  const syncGeneration = async (generation: number): Promise<void> => {
    const models = await readConvergedModels(generation)
    const currentIds = new Set(
      models.map((model) => model.id).filter((id) => !isClaudeFamilyId(id))
    )
    const routes = normalizeRoutes(await tcControl.getRoutes())
    assertCurrent(generation)
    const existingExclusive = routes.find((route) => route.name === EXCLUSIVE_ROUTE_NAME)
    const previousIds = lastLiveModels.size > 0 ? lastLiveModels : new Set(existingExclusive?.match)
    const now = Date.now()

    for (const id of previousIds) {
      if (!currentIds.has(id) && !tombstones.has(id)) {
        tombstones.set(id, now + TOMBSTONE_GRACE_MS)
      }
    }
    for (const id of currentIds) {
      tombstones.delete(id)
    }
    for (const [id, expiresAt] of tombstones) {
      if (expiresAt <= now) {
        tombstones.delete(id)
      }
    }

    // Filter again after tombstone merge: a claude id inherited from a
    // pre-guard route must age out, never be re-routed.
    const routedIds = sortedUnique([...currentIds, ...tombstones.keys()]).filter(
      (id) => !isClaudeFamilyId(id)
    )
    const unrelatedRoutes = routes.filter((route) => route.name !== EXCLUSIVE_ROUTE_NAME)
    const nextRoutes: TeamclaudeBackendRoute[] =
      routedIds.length === 0
        ? unrelatedRoutes
        : [
            {
              name: EXCLUSIVE_ROUTE_NAME,
              match: routedIds,
              accounts: [CLIPROXY_ACCOUNT_ID]
            },
            ...unrelatedRoutes
          ]

    assertCurrent(generation)
    // Why: first-match routing is fail-open without this row, so it must precede ownership and catchalls.
    requireMutation(await tcControl.setRoutes(nextRoutes), 'route')
    assertCurrent(generation)
    requireMutation(
      await tcControl.setAccount({
        id: CLIPROXY_ACCOUNT_ID,
        models: sortedUnique(currentIds)
      }),
      'account'
    )
    assertCurrent(generation)
    lastLiveModels = currentIds
  }

  const runRequestedGenerations = async (): Promise<void> => {
    while (completedGeneration < requestedGeneration) {
      const generation = requestedGeneration
      try {
        await syncGeneration(generation)
        completedGeneration = generation
      } catch (error) {
        if (error instanceof StaleSyncGeneration) {
          continue
        }
        throw error
      }
    }
  }

  const beginRun = (): void => {
    if (runner) {
      return
    }
    runner = runRequestedGenerations()
    runner
      .then(
        () => {
          const completed = waiters
          waiters = []
          completed.forEach((waiter) => waiter.resolve())
        },
        (error) => {
          const failed = waiters
          waiters = []
          failed.forEach((waiter) => waiter.reject(error))
        }
      )
      .finally(() => {
        runner = null
        if (completedGeneration < requestedGeneration && waiters.length > 0) {
          beginRun()
        }
      })
  }

  const forceSync = (): Promise<void> => {
    requestedGeneration += 1
    if (debounceTimer) {
      clearTimeout(debounceTimer)
    }
    const promise = new Promise<void>((resolve, reject) => {
      waiters.push({ resolve, reject })
    })
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      beginRun()
    }, SYNC_DEBOUNCE_MS)
    debounceTimer.unref?.()
    return promise
  }

  const start = (): void => {
    if (started) {
      return
    }
    started = true
    void forceSync().catch(() => undefined)
    periodicTimer = setInterval(() => {
      void forceSync().catch(() => undefined)
    }, PERIODIC_SYNC_MS)
    periodicTimer.unref?.()
  }

  const stop = (): void => {
    started = false
    if (periodicTimer) {
      clearInterval(periodicTimer)
      periodicTimer = null
    }
    if (debounceTimer) {
      clearTimeout(debounceTimer)
      debounceTimer = null
      const cancelled = waiters
      waiters = []
      cancelled.forEach((waiter) => waiter.reject(new Error('CLIProxyAPI model sync stopped')))
    }
  }

  return { start, stop, forceSync }
}
