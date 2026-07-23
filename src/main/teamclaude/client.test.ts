import { describe, it, expect } from 'vitest'
import { ActivityDeduper, LiveStreamDeduper, deriveReadiness, type TcRawEvent } from './client'
import { parseStatus, parseRoutes } from './client-mapping'

const ALL_CAPS = [
  'routes.rw',
  'account.write',
  'certs.ensure',
  'status.identity',
  'events.durationMs',
  'log.bootId'
]

const evt = (id: number, extra: Partial<TcRawEvent> = {}): TcRawEvent => ({
  id,
  type: 'request-end',
  ts: 1_000 + id,
  durationMs: 42,
  ...extra
})

describe('ActivityDeduper', () => {
  it('emits each event once and drops replayed ids on reconnect', () => {
    const d = new ActivityDeduper()
    const first = d.ingest('boot-A', [evt(1), evt(2), evt(3)])
    expect(first.map((r) => r.key)).toEqual(['boot-A:1', 'boot-A:2', 'boot-A:3'])

    // reconnect replays the ring (1..3) then delivers a new event (4)
    const second = d.ingest('boot-A', [evt(1), evt(2), evt(3), evt(4)])
    expect(second.map((r) => r.key)).toEqual(['boot-A:4'])
  })

  it('does NOT treat reset eventIds as duplicates across a bootId change', () => {
    const d = new ActivityDeduper()
    d.ingest('boot-A', [evt(1), evt(2), evt(3)])

    // proxy restarted: bootId changes, eventIds reset to 1 — must all be new
    const afterRestart = d.ingest('boot-B', [evt(1), evt(2)])
    expect(afterRestart.map((r) => r.key)).toEqual(['boot-B:1', 'boot-B:2'])
  })

  it('maps contract fields including durationMs latency', () => {
    const d = new ActivityDeduper()
    const [row] = d.ingest('boot-A', [
      evt(7, {
        at: 5000,
        model: 'claude-fable',
        account: 'alice',
        status: 200,
        path: '/v1/messages'
      })
    ])
    expect(row).toMatchObject({
      key: 'boot-A:7',
      at: 5000,
      model: 'claude-fable',
      account: 'alice',
      status: 200,
      durationMs: 42,
      path: '/v1/messages'
    })
  })

  it('keeps independent high-water marks per bootId', () => {
    const d = new ActivityDeduper()
    d.ingest('boot-A', [evt(10)])
    // boot-B is fresh; a low id is still new for it
    expect(d.ingest('boot-B', [evt(1)]).map((r) => r.key)).toEqual(['boot-B:1'])
    // boot-A still dedupes against its own high-water (10)
    expect(d.ingest('boot-A', [evt(5)])).toEqual([])
  })
})

describe('deriveReadiness', () => {
  it('derives per-surface readiness from the real server capability tokens', () => {
    expect(deriveReadiness(ALL_CAPS)).toEqual({
      usageReady: true,
      routingReady: true,
      controlReady: true
    })
  })

  it('is all-false for an empty capability set', () => {
    expect(deriveReadiness([])).toEqual({
      usageReady: false,
      routingReady: false,
      controlReady: false
    })
  })

  it('usageReady ← status.identity', () => {
    expect(deriveReadiness(['status.identity'])).toEqual({
      usageReady: true,
      routingReady: false,
      controlReady: false
    })
  })

  it('routingReady requires BOTH routes.rw and certs.ensure', () => {
    expect(deriveReadiness(['routes.rw']).routingReady).toBe(false)
    expect(deriveReadiness(['certs.ensure']).routingReady).toBe(false)
    expect(deriveReadiness(['routes.rw', 'certs.ensure']).routingReady).toBe(true)
  })

  it('controlReady ← account.write', () => {
    expect(deriveReadiness(['account.write'])).toEqual({
      usageReady: false,
      routingReady: false,
      controlReady: true
    })
  })
})

describe('LiveStreamDeduper (SSE hello bootId + bootId-less live events)', () => {
  // Live events carry NO bootId — only the hello does. Simulate a stream.
  const live = (id: number): TcRawEvent => ({ id, type: 'request-end', ts: 1_000 + id })

  it('reconnect same boot: replay is deduped and later live events do not duplicate', () => {
    const s = new LiveStreamDeduper(new ActivityDeduper())
    s.reset()
    expect(s.hello('boot-A', [live(1), live(2), live(3)]).map((r) => r.key)).toEqual([
      'boot-A:1',
      'boot-A:2',
      'boot-A:3'
    ])
    // a bootId-less live event is keyed under the hello's bootId
    expect(s.live(live(4)).map((r) => r.key)).toEqual(['boot-A:4'])

    // reconnect, SAME boot: hello replays 1..4 (all deduped), then live 5 is new
    s.reset()
    expect(s.hello('boot-A', [live(1), live(2), live(3), live(4)])).toEqual([])
    expect(s.live(live(5)).map((r) => r.key)).toEqual(['boot-A:5'])
  })

  it('restart new boot: reset eventIds are NOT dropped as duplicates', () => {
    const s = new LiveStreamDeduper(new ActivityDeduper())
    s.reset()
    s.hello('boot-A', [live(1), live(2)])
    s.live(live(3))

    // proxy restarted: new hello bootId, eventIds reset to 1 — all must be new,
    // and subsequent bootId-less live events key under the NEW boot.
    s.reset()
    expect(s.hello('boot-B', [live(1)]).map((r) => r.key)).toEqual(['boot-B:1'])
    expect(s.live(live(2)).map((r) => r.key)).toEqual(['boot-B:2'])
  })
})

describe('parseStatus — quota + pin mapping (real server shape)', () => {
  const OBSERVED = '2026-07-22T10:00:00.000Z'
  const status = {
    version: '1.2.3',
    bootId: 'boot-9',
    capabilities: ALL_CAPS,
    currentAccount: 'work',
    manualAccount: 'work',
    accounts: [
      {
        id: 'uuid-1:org-1',
        name: 'work',
        email: 'w@example.com',
        priority: 5,
        disabled: false,
        status: 'active',
        quota: {
          unified5h: 0.42,
          unified5hReset: 1_800_000_000_000,
          unified7d: 1.5, // >100% upstream → overage
          unified7dReset: 1_800_100_000_000,
          unified7dFable: 0
        },
        observedAt: { unified5h: OBSERVED, unified7d: OBSERVED }
      },
      { id: 'uuid-2:org-2', name: 'personal', status: 'throttled', quota: {}, observedAt: {} }
    ]
  }

  it('maps flat 0–1 fractions → clamped percent with an overage flag', () => {
    const snap = parseStatus(status)
    const work = snap.accounts[0]
    expect(work.buckets.unified5h).toEqual({
      usedPercent: 42,
      overage: false,
      resetsAt: 1_800_000_000_000,
      observedAt: Date.parse(OBSERVED)
    })
    // 1.5 → 150% clamps to 100 with overage:true
    expect(work.buckets.unified7d).toMatchObject({ usedPercent: 100, overage: true })
    // 0 fraction is a real observation → a bucket (0%), not null
    expect(work.buckets.unified7dFable).toMatchObject({ usedPercent: 0, overage: false })
    // absent bucket → null
    expect(work.buckets.unified7dSonnet).toBeNull()
  })

  it('Date.parses ISO observedAt strings (never HTTP receipt time)', () => {
    const snap = parseStatus(status)
    expect(snap.accounts[0].buckets.unified5h?.observedAt).toBe(Date.parse(OBSERVED))
    // no observedAt string → null
    expect(snap.accounts[1].buckets.unified5h).toBeNull()
  })

  it('maps top-level manualAccount onto each account.pinned by name', () => {
    const snap = parseStatus(status)
    expect(snap.accounts[0].pinned).toBe(true) // name === manualAccount
    expect(snap.accounts[1].pinned).toBe(false)
  })

  it('no pin (manualAccount null) → nobody pinned', () => {
    const snap = parseStatus({ ...status, manualAccount: null })
    expect(snap.accounts.every((a) => !a.pinned)).toBe(true)
  })

  it('carries the routing currentAccount and joins fleet identities to Orca accounts', () => {
    const snap = parseStatus(
      {
        ...status,
        accounts: [
          { ...status.accounts[0], id: 'uuid-1::org-1' },
          { ...status.accounts[1], id: 'uuid-2::org-2', email: 'fallback@example.com' }
        ]
      },
      [
        {
          id: 'orca-stable',
          accountUuid: 'uuid-1',
          organizationUuid: 'org-1',
          email: 'different@example.com'
        },
        {
          id: 'orca-email',
          accountUuid: null,
          organizationUuid: null,
          email: 'fallback@example.com'
        }
      ]
    )

    expect(snap.currentAccount).toBe('work')
    expect(snap.accounts.map((account) => account.orcaAccountId)).toEqual([
      'orca-stable',
      'orca-email'
    ])
  })

  it('does not use an ambiguous email fallback for the fleet/native join', () => {
    const snap = parseStatus(
      { accounts: [{ id: 'name:shared', name: 'shared', email: 'same@example.com' }] },
      [
        { id: 'orca-1', accountUuid: null, organizationUuid: null, email: 'same@example.com' },
        { id: 'orca-2', accountUuid: null, organizationUuid: null, email: 'same@example.com' }
      ]
    )
    expect(snap.accounts[0].orcaAccountId).toBeNull()
  })

  it('joins a stable UUID through an organization name or a unique legacy UUID', () => {
    const snap = parseStatus(
      {
        accounts: [
          { id: 'uuid-name::Acme', name: 'named-org' },
          { id: 'uuid-legacy::', name: 'legacy-org' }
        ]
      },
      [
        {
          id: 'orca-name',
          accountUuid: 'uuid-name',
          organizationName: 'Acme',
          email: 'named@example.com'
        },
        {
          id: 'orca-legacy',
          accountUuid: 'uuid-legacy',
          email: 'legacy@example.com'
        }
      ]
    )

    expect(snap.accounts.map((account) => account.orcaAccountId)).toEqual([
      'orca-name',
      'orca-legacy'
    ])
  })
})

describe('routes mapping (A5)', () => {
  it('parseRoutes reads the authoritative GET /routes shape (string accounts)', () => {
    const parsed = parseRoutes({
      ok: true,
      routes: [
        {
          name: 'fable',
          match: ['*fable*'],
          accounts: ['work', 'personal'],
          bucket: 'unified7dFable'
        },
        { name: 'default', match: ['*'] } // accounts/bucket omitted when empty
      ]
    })
    expect(parsed).toEqual([
      {
        name: 'fable',
        match: ['*fable*'],
        accounts: ['work', 'personal'],
        bucket: 'unified7dFable'
      },
      { name: 'default', match: ['*'], accounts: [], bucket: null }
    ])
  })

  it('display fallback coerces {name,eligible} account objects to name strings', () => {
    const snap = parseStatus({
      capabilities: ALL_CAPS,
      routes: [
        {
          name: 'sonnet',
          match: ['*sonnet*'],
          accounts: [
            { name: 'work', eligible: true },
            { name: 'personal', eligible: false }
          ],
          bucket: null
        }
      ]
    })
    expect(snap.routes).toEqual([
      { name: 'sonnet', match: ['*sonnet*'], accounts: ['work', 'personal'], bucket: null }
    ])
  })

  it('display fallback EXCLUDES ephemeral autocreated rows from the editable set', () => {
    const snap = parseStatus({
      capabilities: ALL_CAPS,
      routes: [
        { name: 'configured', match: ['*'], accounts: [{ name: 'work', eligible: true }] },
        {
          name: 'fable',
          match: ['*fable*'],
          accounts: [{ name: 'work', eligible: true }],
          autocreated: true
        }
      ]
    })
    expect(snap.routes.map((r) => r.name)).toEqual(['configured'])
  })
})
