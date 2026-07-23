import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { prepareLocalCommitMessageAgentEnv } from './commit-message-agent-environment'

// Why: the host running these tests may itself have the TeamClaude PATH shim
// exporting HTTPS_PROXY/etc. Those would leak into cloneProcessEnv() and mask the
// seam's own additions. Clear them so assertions test THIS code, not the host.
const TEAMCLAUDE_PROXY_ENV_KEYS = [
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'https_proxy',
  'http_proxy',
  'ALL_PROXY',
  'all_proxy',
  'NO_PROXY',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
  'TEAMCLAUDE_RUN_GUARD',
  'ANTHROPIC_BASE_URL'
]

beforeEach(() => {
  for (const key of TEAMCLAUDE_PROXY_ENV_KEYS) {
    delete process.env[key]
  }
})

const { snapshotRef } = vi.hoisted(() => ({
  snapshotRef: {
    current: {
      proxyUp: false,
      port: 3456,
      caPath: null as string | null,
      knownPorts: [3456] as number[],
      orcaNetworkProxyConfigured: false
    }
  }
}))
vi.mock('../teamclaude/init', () => ({
  getTeamclaudeRoutingSnapshot: () => snapshotRef.current
}))

function setRoutedSnapshot(): void {
  snapshotRef.current = {
    proxyUp: true,
    port: 3456,
    caPath: 'C:\\certs\\tc-ca.pem',
    knownPorts: [3456],
    orcaNetworkProxyConfigured: false
  }
}

const originalEnv = { ...process.env }
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
const tempDirs: string[] = []

afterEach(() => {
  if (originalPlatform) {
    Object.defineProperty(process, 'platform', originalPlatform)
  }
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) {
      delete process.env[key]
    }
  }
  Object.assign(process.env, originalEnv)
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
  snapshotRef.current = {
    proxyUp: false,
    port: 3456,
    caPath: null,
    knownPorts: [3456],
    orcaNetworkProxyConfigured: false
  }
})

const claudePreparationResolvers = (
  spy?: (options?: { skipManagedTokenRotation?: boolean }) => void
) => ({
  prepareForClaudeLaunch: async (
    _target?: { runtime?: 'host' | 'wsl'; wslDistro?: string | null },
    options?: { skipManagedTokenRotation?: boolean }
  ) => {
    spy?.(options)
    return {
      configDir: '/home/tester/.claude',
      runtime: 'host' as const,
      wslDistro: null,
      wslLinuxConfigDir: null,
      envPatch: { CLAUDE_CONFIG_DIR: '/home/tester/.claude' },
      stripAuthEnv: true,
      provenance: 'managed:test'
    }
  }
})

function makeHome(): string {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
  const dir = mkdtempSync(join(tmpdir(), 'orca-commit-env-'))
  tempDirs.push(dir)
  process.env.HOME = dir
  process.env.SHELL = '/bin/zsh'
  delete process.env.ORCA_OPENCODE_SOURCE_CONFIG_DIR
  delete process.env.ORCA_PI_SOURCE_AGENT_DIR
  return dir
}

describe('prepareLocalCommitMessageAgentEnv', () => {
  it('hydrates OpenCode config dir from shell startup files for headless generation', async () => {
    const home = makeHome()
    delete process.env.OPENCODE_CONFIG_DIR
    writeFileSync(join(home, '.zshrc'), 'export OPENCODE_CONFIG_DIR="$HOME/company/opencode"\n')

    const result = await prepareLocalCommitMessageAgentEnv('opencode', undefined)

    expect(result).toEqual({
      ok: true,
      env: expect.objectContaining({
        OPENCODE_CONFIG_DIR: `${home}/company/opencode`
      })
    })
  })

  it('prefers the original OpenCode config root over inherited PTY overlays', async () => {
    process.env.OPENCODE_CONFIG_DIR = '/tmp/orca-opencode-overlay'
    process.env.ORCA_OPENCODE_SOURCE_CONFIG_DIR = '/Users/tester/company/opencode'

    const result = await prepareLocalCommitMessageAgentEnv('opencode', undefined)

    expect(result).toEqual({
      ok: true,
      env: expect.objectContaining({
        OPENCODE_CONFIG_DIR: '/Users/tester/company/opencode'
      })
    })
  })

  it('hydrates Pi agent dir from shell startup files for headless generation', async () => {
    const home = makeHome()
    delete process.env.PI_CODING_AGENT_DIR
    writeFileSync(join(home, '.zshrc'), 'export PI_CODING_AGENT_DIR="$HOME/.config/pi-agent"\n')

    const result = await prepareLocalCommitMessageAgentEnv('pi', undefined)

    expect(result).toEqual({
      ok: true,
      env: expect.objectContaining({
        PI_CODING_AGENT_DIR: `${home}/.config/pi-agent`
      })
    })
  })

  it('prefers the original Pi agent root over inherited PTY overlays', async () => {
    process.env.PI_CODING_AGENT_DIR = '/tmp/orca-pi-overlay'
    process.env.ORCA_PI_SOURCE_AGENT_DIR = '/Users/tester/.pi/agent'

    const result = await prepareLocalCommitMessageAgentEnv('pi', undefined)

    expect(result).toEqual({
      ok: true,
      env: expect.objectContaining({
        PI_CODING_AGENT_DIR: '/Users/tester/.pi/agent'
      })
    })
  })

  it('does not synthesize env for agents without shell-scoped auth or config roots', async () => {
    makeHome()

    await expect(prepareLocalCommitMessageAgentEnv('cursor', undefined)).resolves.toEqual({
      ok: true
    })
  })

  it('falls back to inherited env when managed account resolvers are unavailable', async () => {
    await expect(prepareLocalCommitMessageAgentEnv('codex', undefined)).resolves.toEqual({
      ok: true
    })
    await expect(prepareLocalCommitMessageAgentEnv('claude', undefined)).resolves.toEqual({
      ok: true
    })
  })

  it('sets CODEX_HOME for host managed Codex accounts', async () => {
    const result = await prepareLocalCommitMessageAgentEnv('codex', {
      prepareForCodexLaunch: () =>
        'C:\\Users\\tester\\AppData\\Roaming\\Orca\\codex-accounts\\a\\home'
    })

    expect(result).toEqual({
      ok: true,
      env: expect.objectContaining({
        CODEX_HOME: 'C:\\Users\\tester\\AppData\\Roaming\\Orca\\codex-accounts\\a\\home'
      })
    })
  })

  it('does not pass WSL managed Codex homes to host-local commit generation', async () => {
    process.env.CODEX_HOME = 'C:\\Users\\tester\\.codex'

    const result = await prepareLocalCommitMessageAgentEnv('codex', {
      prepareForCodexLaunch: () =>
        '\\\\wsl.localhost\\Ubuntu\\home\\tester\\.local\\share\\orca\\codex-accounts\\a\\home'
    })

    expect(result).toEqual({ ok: true })
  })

  it('passes WSL managed Codex homes as Linux paths for WSL-local commit generation', async () => {
    const result = await prepareLocalCommitMessageAgentEnv(
      'codex',
      {
        prepareForCodexLaunch: (target) => {
          expect(target).toEqual({ runtime: 'wsl', wslDistro: 'Ubuntu' })
          return '\\\\wsl.localhost\\Ubuntu\\home\\tester\\.codex'
        }
      },
      { runtime: 'wsl', wslDistro: 'Ubuntu' }
    )

    expect(result).toEqual({
      ok: true,
      env: expect.objectContaining({
        CODEX_HOME: '/home/tester/.codex'
      })
    })
  })

  it('does not hydrate host shell config roots for WSL-local commit generation', async () => {
    process.env.OPENCODE_CONFIG_DIR = 'C:\\Users\\tester\\opencode'

    const result = await prepareLocalCommitMessageAgentEnv('opencode', undefined, {
      runtime: 'wsl',
      wslDistro: 'Ubuntu'
    })

    expect(result).toEqual({ ok: true })
  })

  describe('TeamClaude text-generation routing seam (spec §4)', () => {
    it('routes host claude text-gen through the proxy when connected', async () => {
      setRoutedSnapshot()
      const result = await prepareLocalCommitMessageAgentEnv('claude', claudePreparationResolvers())
      expect(result.ok).toBe(true)
      const env = (result as { ok: true; env?: NodeJS.ProcessEnv }).env
      expect(env?.TEAMCLAUDE_RUN_GUARD).toBe('1')
      expect(env?.HTTPS_PROXY).toBe('http://127.0.0.1:3456')
      expect(env?.NODE_EXTRA_CA_CERTS).toBe('C:\\certs\\tc-ca.pem')
      expect(env?.CLAUDE_CONFIG_DIR).toBe('/home/tester/.claude')
    })

    it('sets only the guard (no proxy) when the proxy is down', async () => {
      const result = await prepareLocalCommitMessageAgentEnv('claude', claudePreparationResolvers())
      const env = (result as { ok: true; env?: NodeJS.ProcessEnv }).env
      expect(env?.TEAMCLAUDE_RUN_GUARD).toBe('1')
      expect(env?.HTTPS_PROXY).toBeUndefined()
    })

    it('skips WSL text-gen entirely (remote out-of-scope)', async () => {
      setRoutedSnapshot()
      const result = await prepareLocalCommitMessageAgentEnv(
        'claude',
        claudePreparationResolvers(),
        { runtime: 'wsl', wslDistro: 'Ubuntu' }
      )
      const env = (result as { ok: true; env?: NodeJS.ProcessEnv }).env
      expect(env?.HTTPS_PROXY).toBeUndefined()
      expect(env?.TEAMCLAUDE_RUN_GUARD).toBeUndefined()
    })

    it('does not touch non-claude (codex) text-gen', async () => {
      setRoutedSnapshot()
      const result = await prepareLocalCommitMessageAgentEnv('codex', {
        prepareForCodexLaunch: () => 'C:\\codex-home'
      })
      const env = (result as { ok: true; env?: NodeJS.ProcessEnv }).env
      expect(env?.HTTPS_PROXY).toBeUndefined()
      expect(env?.TEAMCLAUDE_RUN_GUARD).toBeUndefined()
    })

    it('auth gate: skips managed-token-rotation when routed', async () => {
      setRoutedSnapshot()
      const seen: ({ skipManagedTokenRotation?: boolean } | undefined)[] = []
      await prepareLocalCommitMessageAgentEnv(
        'claude',
        claudePreparationResolvers((options) => seen.push(options))
      )
      expect(seen).toHaveLength(1)
      expect(seen[0]?.skipManagedTokenRotation).toBe(true)
    })

    it('auth gate: keeps managed-token-rotation when not routed', async () => {
      const seen: ({ skipManagedTokenRotation?: boolean } | undefined)[] = []
      await prepareLocalCommitMessageAgentEnv(
        'claude',
        claudePreparationResolvers((options) => seen.push(options))
      )
      expect(seen[0]?.skipManagedTokenRotation).toBe(false)
    })
  })
})
