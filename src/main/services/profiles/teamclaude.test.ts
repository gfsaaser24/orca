import { describe, expect, it, vi } from 'vitest'
import { NO_ACCOUNTS_EXIT_CODE } from '../../teamclaude/supervisor-types'
import { createTeamClaudeServiceProfile } from './teamclaude'

describe('TeamClaude service profile', () => {
  it('preserves owned-unready behavior while mapping exit 3 to setup-needed', () => {
    const profile = createTeamClaudeServiceProfile({
      port: 3456,
      binPath: null,
      markerPath: 'teamclaude-owned-proxy.json',
      probe: vi.fn(async () => ({
        ok: false,
        version: null,
        capabilities: [],
        bootId: null
      })),
      resolveEntrypoint: vi.fn(),
      isSupported: vi.fn(() => false)
    })

    // Why: D1 closes the generic gap, but TeamClaude intentionally keeps its old semantics.
    expect(profile.onOwnedUnready).toBe('ignore')
    expect(profile.exitCodeMap[NO_ACCOUNTS_EXIT_CODE]).toEqual({
      kind: 'setup-needed',
      reasonKey: 'tc.reason.noAccounts',
      reasonDetail: 'run `teamclaude login`'
    })
  })
})
