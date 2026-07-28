import { describe, expect, it, vi } from 'vitest'
import { CpaProvisioning, exactLoopbackUpstream } from './provisioning'

describe('CpaProvisioning', () => {
  it('gates on account.backend and exposes the update-TeamClaude reason', async () => {
    const upsertBackendAccount = vi.fn()
    const provisioning = new CpaProvisioning(
      { fetchStatus: vi.fn().mockResolvedValue({ capabilities: [], accounts: [] }) },
      { upsertBackendAccount }
    )

    await expect(provisioning.ensure('proxy-key', 8319)).resolves.toEqual({
      linked: false,
      reasonKey: 'cpa.reason.updateTeamclaude',
      reasonDetail: 'Update TeamClaude to enable the account.backend capability.'
    })
    expect(upsertBackendAccount).not.toHaveBeenCalled()
  })

  it('upserts the apikey account with the exact upstream and verifies status readback', async () => {
    const fetchStatus = vi
      .fn()
      .mockResolvedValueOnce({ capabilities: ['account.backend'], accounts: [] })
      .mockResolvedValueOnce({
        capabilities: ['account.backend'],
        accounts: [{ name: 'cliproxy' }]
      })
    const upsertBackendAccount = vi.fn().mockResolvedValue({ ok: true })
    const provisioning = new CpaProvisioning({ fetchStatus }, { upsertBackendAccount })

    await expect(provisioning.ensure('proxy-key', 8319)).resolves.toEqual({
      linked: true,
      reasonKey: null,
      reasonDetail: null
    })
    // The server keys this endpoint on `id` (dual-accepting a stable id or a
    // name) and rejects a payload without one: "id (string) is required".
    // Verified against a live proxy — do not "simplify" this back to `name`.
    expect(upsertBackendAccount).toHaveBeenCalledWith({
      id: 'cliproxy',
      type: 'apikey',
      apiKey: 'proxy-key',
      upstream: 'http://127.0.0.1:8319',
      priority: 100
    })
    expect(fetchStatus).toHaveBeenCalledTimes(2)
  })

  it('normalizes to a path-free loopback URL with no trailing slash', () => {
    expect(exactLoopbackUpstream(8319)).toBe('http://127.0.0.1:8319')
    expect(() => exactLoopbackUpstream(0)).toThrow('port is invalid')
  })
})
