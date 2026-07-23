import { describe, expect, it } from 'vitest'
import { getProxyStartBlocker, getProxyStartCompletion } from './proxy-start-result'

describe('getProxyStartBlocker', () => {
  it('returns explicit typed failures for missing config and supervisor', () => {
    expect(getProxyStartBlocker(false, false)).toMatchObject({
      ok: false,
      reason: 'no-config'
    })
    expect(getProxyStartBlocker(true, false)).toMatchObject({
      ok: false,
      reason: 'supervisor-unavailable'
    })
    expect(getProxyStartBlocker(true, true)).toBeNull()
  })

  it('reports a terminal retry state as a typed start failure', () => {
    expect(getProxyStartCompletion('setup-needed')).toMatchObject({
      ok: false,
      reason: 'start-failed'
    })
    expect(getProxyStartCompletion('adopted')).toEqual({ ok: true })
  })
})
