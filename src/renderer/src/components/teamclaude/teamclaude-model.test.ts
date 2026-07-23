import { describe, expect, it } from 'vitest'

import type {
  TcAccount,
  TcActivityRow,
  TcProxyLifecycle,
  TcQuotaBucket,
  TcReadiness,
  TcState
} from '../../../../shared/teamclaude-types'
import {
  hasLaunchedUnrouted,
  inFlightRequestCount,
  isActivityRowPending,
  isBucketStale,
  mergeActivity,
  primaryAccount,
  resetCountdownMs,
  surfaceGates,
  worstBucket
} from './teamclaude-model'

const NOW = 1_000_000_000

function bucket(overrides: Partial<TcQuotaBucket> = {}): TcQuotaBucket {
  return { usedPercent: 10, overage: false, resetsAt: null, observedAt: NOW, ...overrides }
}

function account(overrides: Partial<TcAccount> = {}): TcAccount {
  return {
    id: 'a1',
    name: 'Alpha',
    email: null,
    status: 'active',
    priority: 0,
    pinned: false,
    orcaAccountId: null,
    buckets: {
      unified5h: bucket({ usedPercent: 20 }),
      unified7d: bucket({ usedPercent: 40 }),
      unified7dFable: bucket({ usedPercent: 10 }),
      unified7dSonnet: bucket({ usedPercent: 5 })
    },
    ...overrides
  }
}

function state(
  lifecycle: TcProxyLifecycle,
  readiness: TcReadiness,
  overrides: Partial<TcState> = {}
): TcState {
  return {
    lifecycle,
    readiness,
    reasonKey: null,
    reasonDetail: null,
    port: 8080,
    serverVersion: '1.0.0',
    bootId: 'boot',
    capabilities: [],
    owned: true,
    currentAccount: null,
    accounts: [account()],
    routes: [],
    snapshotAt: NOW,
    ...overrides
  }
}

const READY: TcReadiness = { usageReady: true, routingReady: true, controlReady: true }

describe('worstBucket', () => {
  it('picks the highest-usage non-null bucket', () => {
    const worst = worstBucket(account())
    expect(worst?.key).toBe('unified7d')
    expect(worst?.bucket.usedPercent).toBe(40)
  })

  it('returns null when all buckets are null', () => {
    const empty = account({
      buckets: {
        unified5h: null,
        unified7d: null,
        unified7dFable: null,
        unified7dSonnet: null
      }
    })
    expect(worstBucket(empty)).toBeNull()
  })
})

describe('primaryAccount', () => {
  it('prefers a pinned account', () => {
    const s = state('owned', READY, {
      accounts: [
        account({ id: 'a1', name: 'Alpha' }),
        account({ id: 'a2', name: 'Bravo', pinned: true })
      ]
    })
    expect(primaryAccount(s)?.id).toBe('a2')
  })

  it('otherwise selects the account closest to its limit', () => {
    const s = state('owned', READY, {
      accounts: [
        account({ id: 'a1', buckets: account().buckets }),
        account({
          id: 'a2',
          buckets: {
            unified5h: bucket({ usedPercent: 90 }),
            unified7d: null,
            unified7dFable: null,
            unified7dSonnet: null
          }
        })
      ]
    })
    expect(primaryAccount(s)?.id).toBe('a2')
  })

  it('returns null for empty state', () => {
    expect(primaryAccount(null)).toBeNull()
    expect(primaryAccount(state('owned', READY, { accounts: [] }))).toBeNull()
  })
})

describe('isBucketStale', () => {
  it('is stale when never observed', () => {
    expect(isBucketStale(bucket({ observedAt: null }), NOW)).toBe(true)
  })

  it('is stale when older than the window', () => {
    expect(isBucketStale(bucket({ observedAt: NOW - 10 * 60 * 1000 }), NOW)).toBe(true)
  })

  it('is fresh within the window', () => {
    expect(isBucketStale(bucket({ observedAt: NOW - 1000 }), NOW)).toBe(false)
  })
})

describe('resetCountdownMs', () => {
  it('clamps negatives to zero and passes through unknown', () => {
    expect(resetCountdownMs(null, NOW)).toBeNull()
    expect(resetCountdownMs(NOW - 5, NOW)).toBe(0)
    expect(resetCountdownMs(NOW + 5000, NOW)).toBe(5000)
  })
})

describe('surfaceGates — degradation matrix', () => {
  it('gates every surface off when offline', () => {
    const gates = surfaceGates(state('offline', READY))
    expect(gates.offline).toBe(true)
    expect(gates.showUsage).toBe(false)
    expect(gates.routesEditable).toBe(false)
    expect(gates.controlsEnabled).toBe(false)
  })

  it('treats null state as offline', () => {
    expect(surfaceGates(null).offline).toBe(true)
  })

  it('gates per-surface on readiness, not on the adopted-degraded lifecycle', () => {
    // Old server: usage still ready, but routing/control capabilities missing.
    const gates = surfaceGates(
      state('adopted-degraded', { usageReady: true, routingReady: false, controlReady: false })
    )
    expect(gates.adoptedDegraded).toBe(true)
    expect(gates.showUsage).toBe(true) // usage NOT gated off by degraded lifecycle
    expect(gates.usageDegraded).toBe(false)
    expect(gates.routesEditable).toBe(false)
    expect(gates.routingDegraded).toBe(true)
    expect(gates.controlsEnabled).toBe(false)
    expect(gates.controlDegraded).toBe(true)
  })

  it('marks usage degraded when connected but usage not ready', () => {
    const gates = surfaceGates(
      state('owned', { usageReady: false, routingReady: true, controlReady: true })
    )
    expect(gates.showUsage).toBe(false)
    expect(gates.usageDegraded).toBe(true)
  })

  it('does not mark surfaces degraded while setup is still needed', () => {
    const gates = surfaceGates(
      state('setup-needed', { usageReady: false, routingReady: false, controlReady: false })
    )
    expect(gates.setupNeeded).toBe(true)
    expect(gates.usageDegraded).toBe(false)
    expect(gates.routingDegraded).toBe(false)
  })
})

describe('hasLaunchedUnrouted', () => {
  it('is true only for the launchedUnrouted reason key', () => {
    expect(hasLaunchedUnrouted(state('owned', READY, { reasonKey: 'launchedUnrouted' }))).toBe(true)
    expect(hasLaunchedUnrouted(state('owned', READY, { reasonKey: 'other' }))).toBe(false)
    expect(hasLaunchedUnrouted(null)).toBe(false)
  })
})

describe('activity helpers', () => {
  const row = (over: Partial<TcActivityRow>): TcActivityRow => ({
    key: 'boot:1',
    at: NOW,
    model: 'claude',
    account: 'Alpha',
    status: 200,
    durationMs: 120,
    path: '/v1/messages',
    ...over
  })

  it('flags rows with unknown status or duration as pending', () => {
    expect(isActivityRowPending(row({ status: null }))).toBe(true)
    expect(isActivityRowPending(row({ durationMs: null }))).toBe(true)
    expect(isActivityRowPending(row({}))).toBe(false)
  })

  it('counts in-flight requests from pending rows', () => {
    expect(
      inFlightRequestCount([
        row({ key: 'b:1', status: null }),
        row({ key: 'b:2' }),
        row({ key: 'b:3', durationMs: null })
      ])
    ).toBe(2)
  })

  it('merges by key (incoming wins), newest-first, capped', () => {
    const merged = mergeActivity(
      [row({ key: 'b:1', at: 1, status: null })],
      [row({ key: 'b:1', at: 2, status: 200 }), row({ key: 'b:2', at: 3 })]
    )
    expect(merged).toHaveLength(2)
    expect(merged[0].key).toBe('b:2') // newest first
    expect(merged.find((r) => r.key === 'b:1')?.status).toBe(200) // completed row wins
  })

  it('caps the retained buffer', () => {
    const rows = Array.from({ length: 10 }, (_, i) => row({ key: `b:${i}`, at: i }))
    expect(mergeActivity([], rows, 5)).toHaveLength(5)
  })
})
