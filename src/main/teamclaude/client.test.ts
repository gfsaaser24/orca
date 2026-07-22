import { describe, it, expect } from 'vitest'
import { ActivityDeduper, deriveReadiness, type TcRawEvent } from './client'

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
  it('derives per-surface readiness from capability tokens', () => {
    expect(deriveReadiness(['usage', 'routing', 'control'])).toEqual({
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

  it('gates each surface independently (degraded server)', () => {
    // an old server that can route but exposes no usage/control surface
    expect(deriveReadiness(['routing'])).toEqual({
      usageReady: false,
      routingReady: true,
      controlReady: false
    })
  })
})
