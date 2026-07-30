import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RoutingSnapshot } from '../teamclaude/routing-env'

const DOWN_SNAPSHOT: RoutingSnapshot = {
  proxyUp: false,
  port: 3456,
  caPath: null,
  knownPorts: [3456],
  orcaNetworkProxyConfigured: false
}

const { snapshotRef, markUnrouted } = vi.hoisted(() => ({
  snapshotRef: {
    current: {
      proxyUp: false,
      port: 3456,
      caPath: null as string | null,
      knownPorts: [3456] as number[],
      orcaNetworkProxyConfigured: false
    }
  },
  markUnrouted: vi.fn()
}))

vi.mock('../teamclaude/init', () => ({
  getTeamclaudeRoutingSnapshot: () => snapshotRef.current,
  noteTeamclaudeUnroutedLaunch: markUnrouted
}))

import {
  isClaudeLaunchCommand,
  isTeamclaudeClaudeFamilyLaunch,
  applyTeamclaudeSeamRouting,
  willTeamclaudeFleetRoute
} from './pty'

function setRouted(): void {
  snapshotRef.current = {
    proxyUp: true,
    port: 3456,
    caPath: 'C:\\certs\\tc-ca.pem',
    knownPorts: [3456],
    orcaNetworkProxyConfigured: false
  }
}

afterEach(() => {
  snapshotRef.current = { ...DOWN_SNAPSHOT }
  markUnrouted.mockClear()
})

describe('isTeamclaudeClaudeFamilyLaunch (spec §4 predicate)', () => {
  it('routes each claude-family agent id', () => {
    expect(isTeamclaudeClaudeFamilyLaunch('claude', undefined)).toBe(true)
    expect(isTeamclaudeClaudeFamilyLaunch('claude-agent-teams', undefined)).toBe(true)
    expect(isTeamclaudeClaudeFamilyLaunch('openclaude', undefined)).toBe(true)
  })

  it('does NOT route a non-claude agent id, and does not fall through to the command', () => {
    // launchAgent wins when present: codex never routes even if command says claude.
    expect(isTeamclaudeClaudeFamilyLaunch('codex', 'claude')).toBe(false)
    expect(isTeamclaudeClaudeFamilyLaunch('gemini', undefined)).toBe(false)
  })

  it('falls back to command detection when no agent id is present', () => {
    expect(isTeamclaudeClaudeFamilyLaunch(undefined, 'claude --resume')).toBe(true)
    expect(isTeamclaudeClaudeFamilyLaunch(undefined, '/usr/local/bin/claude')).toBe(true)
  })

  it('resolves ambiguity to NOT routed (fail-open == fail-direct)', () => {
    expect(isTeamclaudeClaudeFamilyLaunch(undefined, undefined)).toBe(false)
    expect(isTeamclaudeClaudeFamilyLaunch(undefined, 'bash')).toBe(false)
    // A non-TuiAgent string is not claude-family; falls back to command (none).
    expect(isTeamclaudeClaudeFamilyLaunch('not-an-agent', 'ls')).toBe(false)
  })
})

describe('isClaudeLaunchCommand (claude-auth gate)', () => {
  it('detects the fleet-CLI wrapper used by local claude launches', () => {
    expect(isClaudeLaunchCommand('teamclaude run -- --dangerously-skip-permissions')).toBe(true)
    expect(isClaudeLaunchCommand('teamclaude run -- --resume abc')).toBe(true)
    expect(isClaudeLaunchCommand('teamclaude run --no-mitm -- --resume abc')).toBe(true)
    expect(isClaudeLaunchCommand('teamclaude.cmd run --')).toBe(true)
    expect(isClaudeLaunchCommand('C:\\bin\\teamclaude.exe run --')).toBe(true)
    expect(isClaudeLaunchCommand('teamclaude run')).toBe(true)
  })

  it('still detects a bare / path-qualified claude command', () => {
    expect(isClaudeLaunchCommand('claude')).toBe(true)
    expect(isClaudeLaunchCommand('claude --resume')).toBe(true)
    expect(isClaudeLaunchCommand('/usr/local/bin/claude')).toBe(true)
  })

  it('treats `--exec <non-claude>` as not a claude launch', () => {
    expect(isClaudeLaunchCommand('teamclaude run --exec openclaude --')).toBe(false)
    expect(isClaudeLaunchCommand('teamclaude run --exec "/usr/bin/codex"')).toBe(false)
    expect(isClaudeLaunchCommand('teamclaude run --exec claude -- --resume abc')).toBe(true)
  })

  it('does not detect other agents or incidental mentions', () => {
    expect(isClaudeLaunchCommand(undefined)).toBe(false)
    expect(isClaudeLaunchCommand('openclaude')).toBe(false)
    expect(isClaudeLaunchCommand('openclaude --prefill hi')).toBe(false)
    expect(isClaudeLaunchCommand('orca claude-teams')).toBe(false)
    expect(isClaudeLaunchCommand('codex')).toBe(false)
    // teamclaude must lead the command AND be followed by `run`.
    expect(isClaudeLaunchCommand('echo teamclaude')).toBe(false)
    expect(isClaudeLaunchCommand('teamclaude status')).toBe(false)
  })
})

describe('applyTeamclaudeSeamRouting (spec §4 seams 1/2)', () => {
  const baseCtx = {
    launchAgent: 'claude' as string | undefined,
    command: 'claude' as string | undefined,
    isRemote: false,
    isWsl: false,
    networkProxySettings: undefined
  }

  it('routes a host-local claude launch (guard + proxy + CA)', () => {
    setRouted()
    const env: Record<string, string> = {}
    const result = applyTeamclaudeSeamRouting(env, 'agent', { ...baseCtx })
    expect(env.TEAMCLAUDE_RUN_GUARD).toBe('1')
    expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:3456')
    expect(env.NODE_EXTRA_CA_CERTS).toBe('C:\\certs\\tc-ca.pem')
    expect(result.routed).toBe(true)
    expect(markUnrouted).not.toHaveBeenCalled()
  })

  it('propagates a stale TeamClaude base URL through envToDelete (daemon re-merge safety)', () => {
    setRouted()
    const env: Record<string, string> = { ANTHROPIC_BASE_URL: 'http://127.0.0.1:3456/tc-acct/x' }
    const result = applyTeamclaudeSeamRouting(env, 'agent', { ...baseCtx })
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined()
    expect(result.envToDelete).toContain('ANTHROPIC_BASE_URL')
  })

  it('rides envToDelete for a stale TC base URL living ONLY in the host process.env (daemon inherited-env resurrection)', () => {
    setRouted()
    const prev = process.env.ANTHROPIC_BASE_URL
    process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:3456'
    try {
      const env: Record<string, string> = {} // request env lacks the base URL
      const result = applyTeamclaudeSeamRouting(env, 'agent', { ...baseCtx })
      expect(result.routed).toBe(true)
      expect(result.envToDelete).toContain('ANTHROPIC_BASE_URL')
    } finally {
      if (prev === undefined) {
        delete process.env.ANTHROPIC_BASE_URL
      } else {
        process.env.ANTHROPIC_BASE_URL = prev
      }
    }
  })

  it('preserves a corporate base URL in the host process.env (no envToDelete entry)', () => {
    setRouted()
    const prev = process.env.ANTHROPIC_BASE_URL
    process.env.ANTHROPIC_BASE_URL = 'https://gateway.corp.example.com/v1'
    try {
      const env: Record<string, string> = {}
      const result = applyTeamclaudeSeamRouting(env, 'agent', { ...baseCtx })
      expect(result.envToDelete).not.toContain('ANTHROPIC_BASE_URL')
    } finally {
      if (prev === undefined) {
        delete process.env.ANTHROPIC_BASE_URL
      } else {
        process.env.ANTHROPIC_BASE_URL = prev
      }
    }
  })

  it('leaves a non-claude launch completely untouched (no guard)', () => {
    setRouted()
    const env: Record<string, string> = {}
    const result = applyTeamclaudeSeamRouting(env, 'agent', {
      ...baseCtx,
      launchAgent: 'codex',
      command: 'codex'
    })
    expect(env.TEAMCLAUDE_RUN_GUARD).toBeUndefined()
    expect(env.HTTPS_PROXY).toBeUndefined()
    expect(result).toEqual({ routed: false, envToDelete: [] })
  })

  it('skips WSL context', () => {
    setRouted()
    const env: Record<string, string> = {}
    const result = applyTeamclaudeSeamRouting(env, 'agent', { ...baseCtx, isWsl: true })
    expect(env.HTTPS_PROXY).toBeUndefined()
    expect(env.TEAMCLAUDE_RUN_GUARD).toBeUndefined()
    expect(result.routed).toBe(false)
  })

  it('skips SSH/remote context', () => {
    setRouted()
    const env: Record<string, string> = {}
    applyTeamclaudeSeamRouting(env, 'agent', { ...baseCtx, isRemote: true })
    expect(env.HTTPS_PROXY).toBeUndefined()
  })

  it('leaves the launch unrouted (guard only) when Orca Network Proxy is configured', () => {
    setRouted()
    const env: Record<string, string> = {}
    applyTeamclaudeSeamRouting(env, 'agent', {
      ...baseCtx,
      networkProxySettings: { httpProxyUrl: 'http://corp-proxy:8080' }
    })
    // Carve-out: guard set, but no TeamClaude proxy vars (cannot chain proxies).
    expect(env.TEAMCLAUDE_RUN_GUARD).toBe('1')
    expect(env.HTTPS_PROXY).toBeUndefined()
    expect(env.NODE_EXTRA_CA_CERTS).toBeUndefined()
  })

  it('sets only the guard when the proxy is down', () => {
    const env: Record<string, string> = {}
    applyTeamclaudeSeamRouting(env, 'agent', { ...baseCtx })
    expect(env.TEAMCLAUDE_RUN_GUARD).toBe('1')
    expect(env.HTTPS_PROXY).toBeUndefined()
    expect(markUnrouted).toHaveBeenCalledWith('proxy-down')
  })
})

describe('willTeamclaudeFleetRoute (spec §4 auth-preparation gate)', () => {
  const ctx = {
    launchAgent: 'claude' as string | undefined,
    command: 'claude' as string | undefined,
    isRemote: false,
    isWsl: false,
    networkProxySettings: undefined
  }

  it('is true for a routed host-local claude launch', () => {
    setRouted()
    expect(willTeamclaudeFleetRoute({}, 'agent', { ...ctx })).toBe(true)
  })

  it('is not fooled by an inherited HTTPS_PROXY on the host env', () => {
    setRouted()
    // Even if the host env already carries the shim's proxy, a preserved
    // corporate base URL must force "not routed".
    expect(
      willTeamclaudeFleetRoute(
        { HTTPS_PROXY: 'http://127.0.0.1:3456', ANTHROPIC_BASE_URL: 'https://bedrock.example/v1' },
        'agent',
        { ...ctx }
      )
    ).toBe(false)
  })

  it('is false for WSL, network-proxy, and proxy-down', () => {
    setRouted()
    expect(willTeamclaudeFleetRoute({}, 'agent', { ...ctx, isWsl: true })).toBe(false)
    expect(
      willTeamclaudeFleetRoute({}, 'agent', {
        ...ctx,
        networkProxySettings: { httpProxyUrl: 'http://corp:8080' }
      })
    ).toBe(false)
    snapshotRef.current = { ...DOWN_SNAPSHOT }
    expect(willTeamclaudeFleetRoute({}, 'agent', { ...ctx })).toBe(false)
  })
})
