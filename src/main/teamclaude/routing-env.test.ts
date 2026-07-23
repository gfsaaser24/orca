import { describe, it, expect } from 'vitest'
import { applyRouting, type RoutingSnapshot } from './routing-env'

function snap(overrides: Partial<RoutingSnapshot> = {}): RoutingSnapshot {
  return {
    proxyUp: true,
    port: 3456,
    caPath: 'C:\\certs\\tc-ca.pem',
    knownPorts: [3456],
    orcaNetworkProxyConfigured: false,
    ...overrides
  }
}

describe('applyRouting', () => {
  it('sets the guard unconditionally when routed (up)', () => {
    const { env } = applyRouting({}, 'agent', snap())
    expect(env.TEAMCLAUDE_RUN_GUARD).toBe('1')
    expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:3456')
    expect(env.HTTP_PROXY).toBe('http://127.0.0.1:3456')
    expect(env.https_proxy).toBe('http://127.0.0.1:3456')
    expect(env.http_proxy).toBe('http://127.0.0.1:3456')
    expect(env.NO_PROXY).toBe('localhost,127.0.0.1,::1')
    expect(env.no_proxy).toBe('localhost,127.0.0.1,::1')
    expect(env.NODE_EXTRA_CA_CERTS).toBe('C:\\certs\\tc-ca.pem')
  })

  it('sets the guard even when the proxy is down (fallback still needs it)', () => {
    const { env } = applyRouting({}, 'agent', snap({ proxyUp: false }))
    expect(env.TEAMCLAUDE_RUN_GUARD).toBe('1')
    expect(env.HTTPS_PROXY).toBeUndefined()
    expect(env.NODE_EXTRA_CA_CERTS).toBeUndefined()
  })

  it('sets the guard even when routing logic cannot run (guard-always)', () => {
    // A null knownPorts would throw inside the base-URL check; guard must survive.
    const bad = snap({ knownPorts: null as unknown as number[] })
    const { env } = applyRouting({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:3456' }, 'agent', bad)
    expect(env.TEAMCLAUDE_RUN_GUARD).toBe('1')
  })

  it('routes when up: removes a TeamClaude base URL and reports the deletion', () => {
    const { env, envToDelete } = applyRouting(
      { ANTHROPIC_BASE_URL: 'http://127.0.0.1:3456/tc-acct/alice' },
      'agent',
      snap()
    )
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined()
    expect(envToDelete).toContain('ANTHROPIC_BASE_URL')
    expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:3456')
  })

  it('preserves a non-TeamClaude base URL and leaves the launch fully unrouted', () => {
    const input = { ANTHROPIC_BASE_URL: 'https://bedrock.example.com/v1' }
    const { env, envToDelete } = applyRouting(input, 'agent', snap())
    expect(env.ANTHROPIC_BASE_URL).toBe('https://bedrock.example.com/v1')
    expect(env.HTTPS_PROXY).toBeUndefined()
    expect(env.NODE_EXTRA_CA_CERTS).toBeUndefined()
    expect(env.TEAMCLAUDE_RUN_GUARD).toBe('1')
    expect(envToDelete).toEqual([])
  })

  it('down: removes a stale base URL pointing at a historical owned port (parsed origin)', () => {
    const { env, envToDelete } = applyRouting(
      // pinned path + query — string equality would miss it; parsed origin catches it
      { ANTHROPIC_BASE_URL: 'http://localhost:3999/tc-acct/bob?x=1' },
      'agent',
      snap({ proxyUp: false, port: 3456, knownPorts: [3456, 3999] })
    )
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined()
    expect(envToDelete).toContain('ANTHROPIC_BASE_URL')
    // still unrouted (proxy down) — only the deletion happens
    expect(env.HTTPS_PROXY).toBeUndefined()
  })

  it('does not remove a base URL on an unknown loopback port (not our proxy)', () => {
    const { env } = applyRouting(
      { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9999/' },
      'agent',
      snap({ knownPorts: [3456] })
    )
    // unknown loopback port → preserved (treated as foreign) → unrouted
    expect(env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:9999/')
    expect(env.HTTPS_PROXY).toBeUndefined()
  })

  it('leaves launch unrouted when Orca network proxy is configured', () => {
    const { env } = applyRouting({}, 'agent', snap({ orcaNetworkProxyConfigured: true }))
    expect(env.TEAMCLAUDE_RUN_GUARD).toBe('1')
    expect(env.HTTPS_PROXY).toBeUndefined()
    expect(env.NODE_EXTRA_CA_CERTS).toBeUndefined()
  })

  it('does not route when the CA path is unknown (would break TLS)', () => {
    const { env } = applyRouting({}, 'agent', snap({ caPath: null }))
    expect(env.HTTPS_PROXY).toBeUndefined()
    expect(env.TEAMCLAUDE_RUN_GUARD).toBe('1')
  })

  it('never mutates the caller-provided env object', () => {
    const input: NodeJS.ProcessEnv = { FOO: 'bar' }
    const { env } = applyRouting(input, 'textgen', snap())
    expect(input.HTTPS_PROXY).toBeUndefined()
    expect(input.TEAMCLAUDE_RUN_GUARD).toBeUndefined()
    expect(env).not.toBe(input)
    expect(env.FOO).toBe('bar')
  })

  it('ignores an unparseable base URL (origin-parse fail → treated as foreign)', () => {
    const { env } = applyRouting({ ANTHROPIC_BASE_URL: 'not a url' }, 'agent', snap())
    // unparseable → not a TeamClaude URL → preserved → unrouted
    expect(env.ANTHROPIC_BASE_URL).toBe('not a url')
    expect(env.HTTPS_PROXY).toBeUndefined()
  })
})
