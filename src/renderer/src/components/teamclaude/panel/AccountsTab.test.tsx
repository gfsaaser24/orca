// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import '@/i18n/i18n'
import type { TcAccount, TcState } from '../../../../../shared/teamclaude-types'
import type { TeamclaudeControls } from '@/hooks/useTeamclaude'
import { AccountsTab } from './AccountsTab'

function account(overrides: Partial<TcAccount> = {}): TcAccount {
  return {
    id: 'fleet',
    name: 'Anthropic fleet',
    email: null,
    status: 'active',
    priority: 10,
    pinned: false,
    orcaAccountId: null,
    buckets: {
      unified5h: null,
      unified7d: null,
      unified7dFable: null,
      unified7dSonnet: null
    },
    ...overrides
  }
}

const controls: TeamclaudeControls = {
  pin: vi.fn(),
  setRoutes: vi.fn(),
  setAccount: vi.fn(),
  startProxy: vi.fn(),
  stopProxy: vi.fn()
}

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement('div')
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  vi.restoreAllMocks()
})

describe('AccountsTab backend filtering', () => {
  it('keeps kind and legacy-name backend accounts out of the fleet', () => {
    const state: TcState = {
      lifecycle: 'owned',
      readiness: { usageReady: true, routingReady: true, controlReady: true },
      reasonKey: null,
      reasonDetail: null,
      port: 3456,
      serverVersion: '1.2.0',
      bootId: 'boot',
      capabilities: [],
      owned: true,
      currentAccount: null,
      accounts: [
        account(),
        account({ id: 'backend', kind: 'backend', name: 'cliproxy' }),
        account({ id: 'legacy', name: 'CLIProxy' })
      ],
      routes: [],
      snapshotAt: 1
    }
    act(() => root.render(<AccountsTab state={state} controls={controls} />))
    expect(container.textContent).toContain('Anthropic fleet')
    expect(container.textContent).not.toContain('cliproxy')
    expect(container.textContent).not.toContain('CLIProxy')
  })
})
