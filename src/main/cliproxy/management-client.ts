import { CpaHttpTransport, CpaManagementError } from './management-http-transport'

export { CpaManagementError } from './management-http-transport'

const MANAGEMENT_PREFIX = '/v0/management'
const MANAGEMENT_AUTH_FAILURE_BUDGET = 2

export type CpaAuthProvider = 'anthropic' | 'codex' | 'antigravity' | 'xai' | 'kimi'

export type CpaAuthFileSummary = Record<string, unknown> & {
  name: string
  auth_index?: string
  type?: string
  provider?: string
  label?: string
  email?: string
  disabled?: boolean
  unavailable?: boolean
  priority?: number
  note?: string
  success?: number
  failed?: number
  next_retry_after?: string
}

export type CpaAuthFilesResponse = { files: CpaAuthFileSummary[] }

export type CpaAuthFileModel = Record<string, unknown> & {
  id: string
  display_name?: string
  type?: string
  owned_by?: string
}

export type CpaAlias = {
  name: string
  alias: string
  fork?: boolean
  'display-name'?: string
}

export type CpaAliasMap = Record<string, CpaAlias[]>

export type CpaAuthUrlResponse = {
  status: string
  url: string
  state: string
  flow?: string
  user_code?: string
  expires_in?: number
}

export type CpaAuthStatusResponse = {
  status: 'wait' | 'ok' | 'error'
  error?: string
}

export type CpaProxyModel = Record<string, unknown> & {
  id: string
  owned_by?: string
  display_name?: string
}

export type CpaModelsResponse = {
  object?: string
  data: CpaProxyModel[]
}

export type ManagementClientOptions = {
  port: number
  managementKey: string
  apiKey: string
  timeoutMs?: number
  onKeyMismatch?: (error: CpaManagementError) => void
  onVersion?: (version: string) => void
}

export class ManagementClient {
  private readonly managementKey: string
  private readonly apiKey: string
  private readonly onKeyMismatch?: (error: CpaManagementError) => void
  private readonly transport: CpaHttpTransport
  private keyMismatch = false
  private authFailures = 0
  private managementQueue = Promise.resolve()
  private aliasWriteQueue = Promise.resolve()

  constructor(options: ManagementClientOptions) {
    this.managementKey = options.managementKey
    this.apiKey = options.apiKey
    this.onKeyMismatch = options.onKeyMismatch
    this.transport = new CpaHttpTransport(options)
  }

  getAuthFiles(): Promise<CpaAuthFilesResponse> {
    return this.managementJson('GET', '/auth-files')
  }

  getAuthFileModels(name: string): Promise<{ models: CpaAuthFileModel[] }> {
    return this.managementJson('GET', `/auth-files/models?name=${encodeURIComponent(name)}`)
  }

  patchAuthStatus(payload: {
    name: string
    authIndex?: string
    disabled: boolean
  }): Promise<{ status: string; disabled: boolean }> {
    return this.managementJson('PATCH', '/auth-files/status', {
      name: payload.name,
      ...(payload.authIndex ? { auth_index: payload.authIndex } : {}),
      disabled: payload.disabled
    })
  }

  patchAuthFields(payload: {
    name: string
    priority?: number
    note?: string
  }): Promise<{ status: string }> {
    return this.managementJson('PATCH', '/auth-files/fields', payload)
  }

  deleteAuthFile(name: string): Promise<{ status: string }> {
    return this.managementJson('DELETE', `/auth-files?name=${encodeURIComponent(name)}`)
  }

  importAuthFile(
    name: string,
    contents: string | Record<string, unknown>
  ): Promise<{ status: string }> {
    const body = typeof contents === 'string' ? contents : JSON.stringify(contents)
    return this.managementJson(
      'POST',
      `/auth-files?name=${encodeURIComponent(name)}`,
      body,
      'application/json'
    )
  }

  authUrl(
    provider: CpaAuthProvider,
    options: { noWebui: true } = { noWebui: true }
  ): Promise<CpaAuthUrlResponse> {
    if (options.noWebui !== true) {
      return Promise.reject(new Error('CLIProxyAPI OAuth must run without the WebUI forwarder'))
    }
    // D5: omitting is_webui keeps CPA on its local callback path and avoids the
    // all-interface WebUI callback forwarder.
    return this.managementJson('GET', `/${provider}-auth-url`)
  }

  authStatus(state: string): Promise<CpaAuthStatusResponse> {
    return this.managementJson('GET', `/get-auth-status?state=${encodeURIComponent(state)}`)
  }

  cancelOauth(state: string): Promise<{ status: string; cancelled: boolean }> {
    return this.managementJson('DELETE', `/oauth-session?state=${encodeURIComponent(state)}`)
  }

  getAliases(): Promise<CpaAliasMap> {
    return this.managementJson<{ 'oauth-model-alias'?: CpaAliasMap }>(
      'GET',
      '/oauth-model-alias'
    ).then((response) => response['oauth-model-alias'] ?? {})
  }

  setAliases(channel: string, aliases: Record<string, string>): Promise<void> {
    const operation = this.aliasWriteQueue.then(async () => {
      const current = await this.getAliases()
      const next: CpaAliasMap = { ...current }
      const entries = Object.entries(aliases).map(([name, alias]) => ({ name, alias }))
      if (entries.length === 0) {
        delete next[channel]
      } else {
        next[channel] = entries
      }
      await this.managementJson('PUT', '/oauth-model-alias', next)
    })
    this.aliasWriteQueue = operation.then(
      () => undefined,
      () => undefined
    )
    return operation
  }

  logsTail(cursor: string | null): Promise<{ lines: string[]; nextCursor: string | null }> {
    const query = new URLSearchParams({ limit: '500' })
    if (cursor) {
      query.set('cursor', cursor)
    }
    return this.managementJson<Record<string, unknown>>('GET', `/logs?${query}`).then(
      (response) => ({
        lines: Array.isArray(response.lines)
          ? response.lines.filter((line): line is string => typeof line === 'string')
          : [],
        nextCursor:
          typeof response['next-cursor'] === 'string'
            ? response['next-cursor']
            : typeof response.nextCursor === 'string'
              ? response.nextCursor
              : null
      })
    )
  }

  usageQueuePop(count: number): Promise<Record<string, unknown>[]> {
    if (!Number.isInteger(count) || count <= 0) {
      return Promise.reject(new RangeError('usage queue count must be a positive integer'))
    }
    return this.managementJson<unknown>('GET', `/usage-queue?count=${count}`).then((response) =>
      Array.isArray(response) ? response.filter(isRecord) : []
    )
  }

  async getModelsAuthed(): Promise<CpaModelsResponse> {
    const response = await this.transport.request('GET', '/v1/models', {
      authorization: `Bearer ${this.apiKey}`
    })
    return this.transport.parseJson<CpaModelsResponse>(response, '/v1/models')
  }

  async healthz(): Promise<boolean> {
    try {
      const response = await this.transport.request('HEAD', '/healthz')
      return response.status >= 200 && response.status < 300
    } catch {
      return false
    }
  }

  private managementJson<T>(
    method: string,
    route: string,
    body?: unknown,
    contentType = 'application/json'
  ): Promise<T> {
    return this.serializeManagement(async () => {
      if (this.keyMismatch || this.authFailures >= MANAGEMENT_AUTH_FAILURE_BUDGET) {
        throw new CpaManagementError(
          'CLIProxyAPI management calls are disabled until key recovery',
          this.keyMismatch ? 'key-mismatch' : 'auth-budget-exhausted'
        )
      }
      const payload =
        body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
      const response = await this.transport.request(
        method,
        `${MANAGEMENT_PREFIX}${route}`,
        {
          'x-management-key': this.managementKey,
          ...(payload
            ? {
                'content-type': contentType,
                'content-length': String(Buffer.byteLength(payload))
              }
            : {})
        },
        payload
      )
      if (response.status === 401 || response.status === 403) {
        this.authFailures++
        this.keyMismatch = true
        const error = new CpaManagementError(
          'CLIProxyAPI rejected Orca’s management key; calls are stopped until recovery',
          'key-mismatch',
          response.status
        )
        this.onKeyMismatch?.(error)
        throw error
      }
      return this.transport.parseJson<T>(response, route)
    })
  }

  private serializeManagement<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.managementQueue.then(operation, operation)
    this.managementQueue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
