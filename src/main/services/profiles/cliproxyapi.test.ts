import { describe, expect, it, vi } from 'vitest'
import { createCliProxyApiProfile, type CliProxyApiProfileDeps } from './cliproxyapi'

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })

function makeDeps(overrides: Partial<CliProxyApiProfileDeps> = {}): CliProxyApiProfileDeps {
  return {
    getBinaryPath: () => 'C:\\tools\\cliproxyapi.exe',
    getConfigPath: () => 'C:\\state\\cliproxyapi.yaml',
    getApiKey: () => 'orca-client-key',
    markerPath: 'C:\\state\\cliproxyapi-owned.json',
    port: 8319,
    isFile: () => true,
    fetchFn: vi.fn(async () => new Response(null, { status: 200 })),
    ...overrides
  }
}

describe('CLIProxyAPI service profile', () => {
  it('maps live health plus an authenticated models response to ready', async () => {
    const fetchFn = vi
      .fn<NonNullable<CliProxyApiProfileDeps['fetchFn']>>()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(jsonResponse(200, { data: [{ id: 'gemini-3.1-pro' }] }))
    const profile = createCliProxyApiProfile(makeDeps({ fetchFn }))

    await expect(profile.probe()).resolves.toBe('ready')
    expect(fetchFn).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:8319/healthz',
      expect.objectContaining({ method: 'HEAD' })
    )
    expect(fetchFn).toHaveBeenNthCalledWith(
      2,
      'http://127.0.0.1:8319/v1/models',
      expect.objectContaining({
        method: 'GET',
        headers: { Authorization: 'Bearer orca-client-key' }
      })
    )
  })

  it('treats an empty authenticated model list as ready-with-zero-backends', async () => {
    const fetchFn = vi
      .fn<NonNullable<CliProxyApiProfileDeps['fetchFn']>>()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(jsonResponse(200, { data: [] }))
    const profile = createCliProxyApiProfile(makeDeps({ fetchFn }))

    await expect(profile.probe()).resolves.toBe('ready')
  })

  it('maps model auth failure to alive-unready without retrying', async () => {
    const fetchFn = vi
      .fn<NonNullable<CliProxyApiProfileDeps['fetchFn']>>()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(jsonResponse(401, { error: 'unauthorized' }))
    const profile = createCliProxyApiProfile(makeDeps({ fetchFn }))

    await expect(profile.probe()).resolves.toBe('alive-unready')
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('maps live health with no available client key to alive-unready', async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 200 }))
    const profile = createCliProxyApiProfile(makeDeps({ fetchFn, getApiKey: () => null }))

    await expect(profile.probe()).resolves.toBe('alive-unready')
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('maps an unreachable liveness endpoint to down', async () => {
    const profile = createCliProxyApiProfile(
      makeDeps({
        fetchFn: vi.fn(async () => {
          throw new Error('ECONNREFUSED')
        })
      })
    )

    await expect(profile.probe()).resolves.toBe('down')
  })

  it('resolves the settings binary directly with the injected config path', async () => {
    const profile = createCliProxyApiProfile(makeDeps())

    await expect(profile.resolveSpawn()).resolves.toEqual({
      kind: 'resolved',
      command: {
        executable: 'C:\\tools\\cliproxyapi.exe',
        args: ['--config', 'C:\\state\\cliproxyapi.yaml']
      }
    })
  })

  it.each([
    { binaryPath: null, isFile: () => false },
    { binaryPath: 'C:\\missing\\cliproxyapi.exe', isFile: () => false }
  ])('returns setup-needed for a missing or invalid binary', async ({ binaryPath, isFile }) => {
    const profile = createCliProxyApiProfile(makeDeps({ getBinaryPath: () => binaryPath, isFile }))

    await expect(profile.resolveSpawn()).resolves.toMatchObject({
      kind: 'setup-needed',
      reasonKey: 'cpa.reason.binaryMissing'
    })
  })

  it('declares dedicated ownership, hard Windows stop, restart escalation, and exit recovery', () => {
    const profile = createCliProxyApiProfile(makeDeps())

    expect(profile.adoptionPolicy).toBe('owned-only')
    expect(profile.stopPolicy).toEqual({ killOnQuitDefault: false, forceKillDelayMs: 30_000 })
    expect(profile.onOwnedUnready).toBe('restart')
    expect(profile.exitCodeMap[0]).toMatchObject({ kind: 'restart' })
  })
})
