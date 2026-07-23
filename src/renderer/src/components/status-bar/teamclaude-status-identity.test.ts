import { describe, expect, it } from 'vitest'
import type { TcState } from '../../../../shared/teamclaude-types'
import { resolveTeamclaudeStatusIdentity } from './teamclaude-status-identity'

const state = (lifecycle: TcState['lifecycle']): TcState => ({
  lifecycle,
  readiness: { usageReady: true, routingReady: true, controlReady: true },
  reasonKey: null,
  reasonDetail: null,
  port: 3456,
  serverVersion: '1.0.0',
  bootId: 'boot',
  capabilities: [],
  owned: false,
  currentAccount: 'fleet@example.com (Acme)',
  accounts: [],
  routes: [],
  snapshotAt: 1
})

describe('resolveTeamclaudeStatusIdentity', () => {
  it.each(['adopted', 'adopted-degraded', 'owned'] as const)(
    'uses the TeamClaude routing identity while %s',
    (lifecycle) => {
      expect(resolveTeamclaudeStatusIdentity(state(lifecycle))).toEqual({
        connected: true,
        label: 'fleet@example.com (Acme)'
      })
    }
  )

  it('allows the native status identity only while disconnected', () => {
    expect(resolveTeamclaudeStatusIdentity(state('offline'))).toEqual({
      connected: false,
      label: null
    })
  })
})
