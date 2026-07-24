import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parse, stringify } from 'yaml'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8')
  }
}))

import {
  CpaConfigOwner,
  CpaKeyStorageUnavailableError,
  CpaUnownedConfigError,
  DEFAULT_CLIPROXY_PORT,
  type CpaSafeStorage
} from './config-owner'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

function encryptedStorage(available = true): CpaSafeStorage {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (value) => Buffer.from(Buffer.from(value, 'utf8').toReversed()),
    decryptString: (value) => Buffer.from(Buffer.from(value).toReversed()).toString('utf8')
  }
}

async function harness(
  stopped = true,
  claudeDelegation?: () => Promise<{ apiKey: string; baseUrl: string } | null>
): Promise<{
  owner: CpaConfigOwner
  directory: string
  updates: { cliproxyPort?: number }[]
  setStopped(value: boolean): void
}> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'orca-cpa-config-'))
  directories.push(directory)
  const updates: { cliproxyPort?: number }[] = []
  let serviceStopped = stopped
  return {
    directory,
    updates,
    setStopped: (value) => {
      serviceStopped = value
    },
    owner: new CpaConfigOwner({
      userDataPath: directory,
      settings: {
        getSettings: () => updates.at(-1) ?? {},
        updateSettings: (update) => updates.push(update)
      },
      isServiceStopped: () => serviceStopped,
      storage: encryptedStorage(),
      claudeDelegation
    })
  }
}

describe('CpaConfigOwner', () => {
  it('generates the loopback-only manifest and persists the default port', async () => {
    const { owner, updates } = await harness()
    const result = await owner.ensure()
    const config = parse(await readFile(result.configPath, 'utf8'))

    expect(updates).toEqual([{ cliproxyPort: DEFAULT_CLIPROXY_PORT }])
    expect(config).toMatchObject({
      host: '127.0.0.1',
      port: 8319,
      'api-keys': [result.apiKey],
      'remote-management': {
        'allow-remote': false,
        'secret-key': result.managementKey,
        'disable-control-panel': true
      },
      'usage-statistics-enabled': true,
      'logging-to-file': true,
      'logs-max-total-size-mb': 50,
      'request-log': false
    })
    expect(config['auth-dir']).toBe(path.join(owner.directory, 'auth'))
    expect(await readFile(owner.keyPath, 'utf8')).not.toContain(result.managementKey)
  })

  it('compares only the semantic owned manifest and accepts CPA secret hashing', async () => {
    const { owner } = await harness()
    const generated = await owner.ensure()
    const config = parse(await readFile(generated.configPath, 'utf8'))
    config['oauth-model-alias'] = { codex: [{ name: 'upstream', alias: 'global' }] }
    config['remote-management']['secret-key'] =
      '$2a$10$abcdefghijklmnopqrstuvwxyz012345678901234567890123456'
    await writeFile(generated.configPath, stringify(config))

    expect(await owner.inspect()).toEqual({
      drifted: false,
      driftKeys: [],
      transientRead: false
    })

    config.host = '0.0.0.0'
    await writeFile(generated.configPath, stringify(config))
    expect(await owner.inspect()).toMatchObject({ drifted: true, driftKeys: ['host'] })
  })

  it('writes and drift-tracks the teamclaude claude delegation entry', async () => {
    let delegation: { apiKey: string; baseUrl: string } | null = {
      apiKey: 'tc-proxy-key',
      baseUrl: 'http://127.0.0.1:3456'
    }
    const { owner } = await harness(true, async () => delegation)
    const generated = await owner.ensure()
    const config = parse(await readFile(generated.configPath, 'utf8'))
    expect(config['claude-api-key']).toEqual([
      { 'api-key': 'tc-proxy-key', 'base-url': 'http://127.0.0.1:3456' }
    ])

    expect(await owner.inspect()).toMatchObject({ drifted: false })

    delegation = { apiKey: 'tc-proxy-key-2', baseUrl: 'http://127.0.0.1:3456' }
    expect(await owner.inspect()).toMatchObject({
      drifted: true,
      driftKeys: ['claude-api-key']
    })

    delegation = null
    expect(await owner.inspect()).toMatchObject({
      drifted: true,
      driftKeys: ['claude-api-key']
    })
  })

  it('ignores empty and truncated transient reads', async () => {
    const { owner } = await harness()
    await owner.ensure()
    await writeFile(owner.configPath, '')
    expect(await owner.inspect()).toMatchObject({ drifted: false, transientRead: true })

    await writeFile(owner.configPath, 'remote-management: [')
    expect(await owner.inspect()).toMatchObject({ drifted: false, transientRead: true })
  })

  it('requires a stopped service before regeneration and rotates both keys', async () => {
    const harnessResult = await harness(false)
    const original = await harnessResult.owner.ensure()
    await expect(harnessResult.owner.regenerate()).rejects.toThrow('must be stopped')

    harnessResult.setStopped(true)
    const regenerated = await harnessResult.owner.regenerate()
    expect(regenerated.apiKey).not.toBe(original.apiKey)
    expect(regenerated.managementKey).not.toBe(original.managementKey)
    const config = parse(await readFile(regenerated.configPath, 'utf8'))
    expect(config['api-keys']).toEqual([regenerated.apiKey])
  })

  it('warns and refuses first-time generation when safeStorage is unavailable', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'orca-cpa-config-'))
    directories.push(directory)
    const warn = vi.fn()
    const owner = new CpaConfigOwner({
      userDataPath: directory,
      settings: { getSettings: () => ({}), updateSettings: vi.fn() },
      isServiceStopped: () => true,
      storage: encryptedStorage(false),
      warn
    })

    await expect(owner.ensure()).rejects.toBeInstanceOf(CpaKeyStorageUnavailableError)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('safeStorage'))
    await expect(readFile(owner.configPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('never overwrites a config that has no Orca recovery envelope', async () => {
    const { owner } = await harness()
    const existing = 'host: 127.0.0.1\nport: 9000\n'
    await mkdir(owner.directory, { recursive: true })
    await writeFile(owner.configPath, existing)

    await expect(owner.ensure()).rejects.toBeInstanceOf(CpaUnownedConfigError)
    await expect(readFile(owner.configPath, 'utf8')).resolves.toBe(existing)
    await expect(readFile(owner.keyPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
