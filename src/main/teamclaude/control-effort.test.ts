import http from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TeamclaudeControl, effortOrNull } from './control'
import { createEffortHandlers } from './effort-handlers'

const servers: http.Server[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve())
        })
    )
  )
})

type Seen = {
  method?: string
  url?: string
  apiKey?: string | string[]
  contentType?: string | string[]
  body: string
}

/** Records what the proxy actually received so the api-key rules are asserted on
 *  the wire, not on a mock. */
async function listen(
  respond: (seen: Seen, response: http.ServerResponse) => void
): Promise<{ port: number; seen: Seen[] }> {
  const seen: Seen[] = []
  const server = http.createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => (body += chunk))
    request.on('end', () => {
      const row: Seen = {
        method: request.method,
        url: request.url,
        apiKey: request.headers['x-api-key'],
        contentType: request.headers['content-type'],
        body
      }
      seen.push(row)
      respond(row, response)
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('test server did not bind')
  }
  return { port: address.port, seen }
}

function json(response: http.ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(payload))
}

function control(port: number): TeamclaudeControl {
  return new TeamclaudeControl({ port, apiKey: 'proxy-secret', timeoutMs: 2_000 })
}

/** A closed port on loopback: nothing is listening, so the request ECONNREFUSEDs
 *  exactly like a proxy that is not running. */
async function deadPort(): Promise<number> {
  const server = http.createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('test server did not bind')
  }
  const { port } = address
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

describe('TeamclaudeControl.getEffort', () => {
  it('reads the override from GET /teamclaude/effort WITHOUT an api key', async () => {
    const { port, seen } = await listen((_row, response) =>
      json(response, 200, { effort: { level: 'high' } })
    )

    await expect(control(port).getEffort()).resolves.toEqual({
      ok: true,
      effort: { level: 'high' }
    })
    expect(seen).toHaveLength(1)
    expect(seen[0].method).toBe('GET')
    expect(seen[0].url).toBe('/teamclaude/effort')
    // The GET is unauthenticated by contract — the header must be absent entirely.
    expect(seen[0].apiKey).toBeUndefined()
    expect(seen[0].body).toBe('')
  })

  it('reads a cleared override as null', async () => {
    const { port } = await listen((_row, response) => json(response, 200, { effort: null }))
    await expect(control(port).getEffort()).resolves.toEqual({ ok: true, effort: null })
  })

  it('treats an unknown level as no override rather than trusting the wire', async () => {
    const { port } = await listen((_row, response) =>
      json(response, 200, { effort: { level: 'ludicrous' } })
    )
    await expect(control(port).getEffort()).resolves.toEqual({ ok: true, effort: null })
  })

  it('never throws when the proxy is offline', async () => {
    const port = await deadPort()
    const result = await control(port).getEffort()
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toBeTruthy()
  })

  it('reports a non-2xx status as a failure, not as a cleared override', async () => {
    const { port } = await listen((_row, response) => json(response, 500, { boom: true }))
    await expect(control(port).getEffort()).resolves.toEqual({
      ok: false,
      error: 'Proxy /teamclaude/effort responded 500'
    })
  })
})

describe('TeamclaudeControl.setEffort', () => {
  it('POSTs the level WITH the api key and returns the echoed state', async () => {
    const { port, seen } = await listen((_row, response) =>
      json(response, 200, { ok: true, effort: { level: 'xhigh' } })
    )

    await expect(control(port).setEffort('xhigh')).resolves.toEqual({
      ok: true,
      effort: { level: 'xhigh' }
    })
    expect(seen).toHaveLength(1)
    expect(seen[0].method).toBe('POST')
    expect(seen[0].url).toBe('/teamclaude/effort')
    expect(seen[0].apiKey).toBe('proxy-secret')
    expect(seen[0].contentType).toBe('application/json')
    expect(JSON.parse(seen[0].body)).toEqual({ level: 'xhigh' })
  })

  it('sends an explicit null level to clear the override', async () => {
    const { port, seen } = await listen((_row, response) =>
      json(response, 200, { ok: true, effort: null })
    )

    await expect(control(port).setEffort(null)).resolves.toEqual({ ok: true, effort: null })
    expect(JSON.parse(seen[0].body)).toEqual({ level: null })
    expect(seen[0].apiKey).toBe('proxy-secret')
  })

  it('surfaces the proxy error body on {ok:false}', async () => {
    const { port } = await listen((_row, response) =>
      json(response, 200, { ok: false, error: 'effort injection unsupported by this backend' })
    )
    await expect(control(port).setEffort('max')).resolves.toEqual({
      ok: false,
      error: 'effort injection unsupported by this backend'
    })
  })

  it('surfaces a 401 (missing/rotated key) instead of throwing', async () => {
    const { port } = await listen((_row, response) =>
      json(response, 401, { error: 'unauthorized' })
    )
    await expect(control(port).setEffort('low')).resolves.toEqual({
      ok: false,
      error: 'unauthorized'
    })
  })

  it('never throws when the proxy is offline', async () => {
    const port = await deadPort()
    const result = await control(port).setEffort('medium')
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toBeTruthy()
  })
})

describe('effortOrNull', () => {
  it('passes a successful read through and collapses everything else to null', () => {
    expect(effortOrNull({ ok: true, effort: { level: 'high' } })).toEqual({ level: 'high' })
    expect(effortOrNull({ ok: true, effort: null })).toBeNull()
    expect(effortOrNull({ ok: false, error: 'ECONNREFUSED' })).toBeNull()
    expect(effortOrNull(undefined)).toBeNull()
  })
})

describe('createEffortHandlers', () => {
  it('resolves to the proxy state on success', async () => {
    const { port } = await listen((row, response) =>
      row.method === 'GET'
        ? json(response, 200, { effort: { level: 'medium' } })
        : json(response, 200, { ok: true, effort: { level: 'max' } })
    )
    const instance = control(port)
    const handlers = createEffortHandlers(() => instance)

    await expect(handlers.getEffort()).resolves.toEqual({ level: 'medium' })
    await expect(handlers.setEffort('max')).resolves.toEqual({ level: 'max' })
  })

  it('degrades to null (never rejects) when the control plane is not connected', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const handlers = createEffortHandlers(() => null)

    await expect(handlers.getEffort()).resolves.toBeNull()
    await expect(handlers.setEffort('high')).resolves.toBeNull()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('TeamClaude is not connected'))
  })

  it('degrades to null and logs when the proxy is offline', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const instance = control(await deadPort())
    const handlers = createEffortHandlers(() => instance)

    await expect(handlers.getEffort()).resolves.toBeNull()
    await expect(handlers.setEffort('low')).resolves.toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('re-reads the current control instance on every call', async () => {
    const first = await listen((_row, response) =>
      json(response, 200, { effort: { level: 'low' } })
    )
    const second = await listen((_row, response) =>
      json(response, 200, { effort: { level: 'high' } })
    )
    let current = control(first.port)
    const handlers = createEffortHandlers(() => current)

    await expect(handlers.getEffort()).resolves.toEqual({ level: 'low' })
    current = control(second.port)
    await expect(handlers.getEffort()).resolves.toEqual({ level: 'high' })
  })
})
