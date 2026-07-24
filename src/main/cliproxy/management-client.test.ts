import http from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ManagementClient } from './management-client'

const servers: http.Server[] = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve())
        })
    )
  )
})

async function listen(
  handler: http.RequestListener
): Promise<{ port: number; server: http.Server }> {
  const server = http.createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('test server did not bind')
  }
  return { port: address.port, server }
}

function client(
  port: number,
  extra: { onKeyMismatch?: (error: Error) => void } = {}
): ManagementClient {
  return new ManagementClient({
    port,
    managementKey: 'management-secret',
    apiKey: 'proxy-secret',
    timeoutMs: 2_000,
    onKeyMismatch: extra.onKeyMismatch
  })
}

describe('ManagementClient', () => {
  it('serializes initial auth and stops after one 401, below the lifetime budget', async () => {
    let requests = 0
    const mismatch = vi.fn()
    const { port } = await listen((_request, response) => {
      requests++
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'unauthorized' }))
    })
    const api = client(port, { onKeyMismatch: mismatch })

    const results = await Promise.allSettled(Array.from({ length: 8 }, () => api.getAuthFiles()))
    expect(results.every((result) => result.status === 'rejected')).toBe(true)
    expect(requests).toBe(1)
    await expect(api.getAliases()).rejects.toMatchObject({ code: 'key-mismatch' })
    expect(requests).toBe(1)
    expect(mismatch).toHaveBeenCalledTimes(1)
  })

  it('has no methods for forbidden management endpoints', () => {
    const names = new Set(Object.getOwnPropertyNames(ManagementClient.prototype))
    expect(names.has('downloadAuthFile')).toBe(false)
    expect(names.has('getConfig')).toBe(false)
    expect(names.has('getConfigYaml')).toBe(false)
    expect(names.has('getProviderApiKeys')).toBe(false)
    expect(names.has('getApiKeyUsage')).toBe(false)
  })

  it('serializes alias read-modify-write operations and re-reads before each write', async () => {
    let aliases: Record<string, unknown[]> = {}
    const sequence: string[] = []
    const { port } = await listen((request, response) => {
      expect(request.headers['x-management-key']).toBe('management-secret')
      if (request.method === 'GET') {
        sequence.push(`GET:${Object.keys(aliases).join(',')}`)
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ 'oauth-model-alias': aliases }))
        return
      }
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk) => (body += chunk))
      request.on('end', () => {
        aliases = JSON.parse(body) as Record<string, unknown[]>
        sequence.push(`PUT:${Object.keys(aliases).join(',')}`)
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ status: 'ok' }))
      })
    })
    const api = client(port)

    await Promise.all([
      api.setAliases('codex', { upstream: 'codex-global' }),
      api.setAliases('antigravity', { gemini: 'gemini-global' })
    ])

    expect(sequence).toEqual(['GET:', 'PUT:codex', 'GET:codex', 'PUT:codex,antigravity'])
    expect(aliases).toMatchObject({
      codex: [{ name: 'upstream', alias: 'codex-global' }],
      antigravity: [{ name: 'gemini', alias: 'gemini-global' }]
    })
  })

  it('omits is_webui from OAuth and uses proxy auth only for /v1/models', async () => {
    const requests: { path: string; management?: string; authorization?: string }[] = []
    const { port } = await listen((request, response) => {
      requests.push({
        path: request.url ?? '',
        management: request.headers['x-management-key'] as string | undefined,
        authorization: request.headers.authorization
      })
      response.setHeader('content-type', 'application/json')
      response.end(
        request.url === '/v1/models'
          ? JSON.stringify({ object: 'list', data: [] })
          : JSON.stringify({ status: 'ok', url: 'https://example.test', state: 'state-1' })
      )
    })
    const api = client(port)

    await api.authUrl('codex', { noWebui: true })
    await api.getModelsAuthed()
    expect(requests).toEqual([
      {
        path: '/v0/management/codex-auth-url',
        management: 'management-secret',
        authorization: undefined
      },
      { path: '/v1/models', management: undefined, authorization: 'Bearer proxy-secret' }
    ])
  })
})
