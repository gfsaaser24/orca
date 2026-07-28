import net from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOauthFlows } from './oauth-flows'

type OauthClient = {
  authUrl: ReturnType<
    typeof vi.fn<
      (
        provider: 'anthropic' | 'codex' | 'antigravity' | 'xai' | 'kimi',
        options: { noWebui: true }
      ) => Promise<{
        status: string
        url: string
        state: string
        flow?: string
        user_code?: string
        expires_in?: number
      }>
    >
  >
  authStatus: ReturnType<
    typeof vi.fn<(state: string) => Promise<{ status: 'wait' | 'ok' | 'error' }>>
  >
  cancelOauth: ReturnType<
    typeof vi.fn<(state: string) => Promise<{ status: string; cancelled: boolean }>>
  >
  completeOauthCallback: ReturnType<typeof vi.fn>
}

function createClient(): OauthClient {
  const starts = new Map<string, number>()
  return {
    authUrl: vi.fn(async (provider) => {
      const sequence = (starts.get(provider) ?? 0) + 1
      starts.set(provider, sequence)
      return provider === 'xai' || provider === 'kimi'
        ? {
            state: `${provider}-state-${sequence}`,
            status: 'ok',
            url: 'https://device.example',
            flow: 'device',
            user_code: 'ABCD-EFGH',
            expires_in: 600
          }
        : {
            state: `${provider}-state-${sequence}`,
            status: 'ok',
            url: 'https://login.example'
          }
    }),
    authStatus: vi.fn(async () => ({ status: 'wait' })),
    cancelOauth: vi.fn(async () => ({ status: 'ok', cancelled: true })),
    completeOauthCallback: vi.fn(async () => ({ status: 'ok' }))
  }
}

async function listen(port: number): Promise<net.Server> {
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  return server
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('createOauthFlows', () => {
  it('returns browser handoff flows without requesting web-ui forwarding', async () => {
    const client = createClient()
    const flows = createOauthFlows(client as never)

    await expect(flows.start('antigravity')).resolves.toEqual({
      kind: 'browser',
      state: 'antigravity-state-1',
      url: 'https://login.example'
    })
    expect(client.authUrl).toHaveBeenCalledWith('antigravity', { noWebui: true })
    expect(client.authUrl.mock.calls[0][1]).not.toHaveProperty('is_webui')
  })

  it('surfaces device codes and expiry for xAI and Kimi', async () => {
    const client = createClient()
    const flows = createOauthFlows(client as never)

    await expect(flows.start('xai')).resolves.toMatchObject({
      kind: 'device',
      userCode: 'ABCD-EFGH',
      expiresIn: 600
    })
  })

  it('rejects a browser flow when its callback port is busy', async () => {
    const server = await listen(1455)
    try {
      const client = createClient()
      const result = await createOauthFlows(client as never).start('codex')

      expect(result).toEqual({
        ok: false,
        reason: 'oauth_callback_port_busy',
        message: expect.stringContaining('1455')
      })
      expect(client.authUrl).not.toHaveBeenCalled()
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('allows only one active flow per provider', async () => {
    const client = createClient()
    const flows = createOauthFlows(client as never)

    await flows.start('kimi')
    await expect(flows.start('kimi')).resolves.toMatchObject({
      ok: false,
      reason: 'oauth_flow_active',
      message: expect.stringContaining('kimi')
    })
    expect(client.authUrl).toHaveBeenCalledTimes(1)
  })

  it('cancels the CPA session, releases the provider, and reports cancelled on poll', async () => {
    const client = createClient()
    const flows = createOauthFlows(client as never)
    const flow = await flows.start('xai')
    if (!('kind' in flow)) {
      throw new Error('expected an OAuth flow')
    }

    await expect(flows.cancel(flow.state)).resolves.toEqual({ ok: true })
    expect(client.cancelOauth).toHaveBeenCalledWith(flow.state)
    await expect(flows.poll(flow.state)).resolves.toBe('cancelled')
    await expect(flows.start('xai')).resolves.toMatchObject({ kind: 'device' })
  })

  it('releases the provider after a terminal poll status', async () => {
    const client = createClient()
    client.authStatus.mockResolvedValue({ status: 'ok' })
    const flows = createOauthFlows(client as never)
    const flow = await flows.start('kimi')
    if (!('kind' in flow)) {
      throw new Error('expected an OAuth flow')
    }

    await expect(flows.poll(flow.state)).resolves.toBe('ok')
    await expect(flows.start('kimi')).resolves.toMatchObject({ kind: 'device' })
  })

  it('captures the browser redirect on loopback and forwards it to CPA', async () => {
    const client = createClient()
    const flows = createOauthFlows(client as never)
    const flow = await flows.start('codex')
    if (!('kind' in flow)) {
      throw new Error('expected an OAuth flow')
    }

    // The provider redirects here; nothing was listening before this change.
    const response = await fetch(
      `http://127.0.0.1:1455/auth/callback?code=test-code&state=${flow.state}`
    )
    expect(response.status).toBe(200)

    expect(client.completeOauthCallback).toHaveBeenCalledWith({
      provider: 'codex',
      code: 'test-code',
      state: flow.state,
      error: ''
    })

    // Cancelling must free the port, or the next login fails its preflight.
    await flows.cancel(flow.state)
    const probe = await listen(1455)
    probe.close()
  })

  it('does not forward a redirect that carries neither code nor error', async () => {
    const client = createClient()
    const flows = createOauthFlows(client as never)
    const flow = await flows.start('codex')
    if (!('kind' in flow)) {
      throw new Error('expected an OAuth flow')
    }

    const response = await fetch('http://127.0.0.1:1455/favicon.ico')
    expect(response.status).toBe(204)
    expect(client.completeOauthCallback).not.toHaveBeenCalled()

    await flows.cancel(flow.state)
  })
})
