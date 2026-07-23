// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import '@/i18n/i18n'
import type {
  TcAccount,
  TcProxyLifecycle,
  TcReadiness,
  TcState
} from '../../../../shared/teamclaude-types'
import type { TeamclaudeControls } from '@/hooks/useTeamclaude'
import { TeamclaudeFlyout } from './TeamclaudeFlyout'

const controls: TeamclaudeControls = {
  pin: vi.fn(),
  setRoutes: vi.fn(),
  setAccount: vi.fn(),
  startProxy: vi.fn(),
  stopProxy: vi.fn()
}

const READY: TcReadiness = { usageReady: true, routingReady: true, controlReady: true }
const OFFLINE: TcReadiness = { usageReady: false, routingReady: false, controlReady: false }

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
      unified5h: { usedPercent: 30, overage: false, resetsAt: null, observedAt: 0 },
      unified7d: null,
      unified7dFable: null,
      unified7dSonnet: null
    },
    ...overrides
  }
}

function makeState(
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
    accounts: [account()],
    routes: [],
    snapshotAt: 0,
    ...overrides
  }
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('TeamclaudeFlyout offline degradation', () => {
  it('keeps the last-known fleet greyed with an age stamp when offline', () => {
    const snapshotAt = 1_000_000
    act(() =>
      root.render(
        <TeamclaudeFlyout
          state={makeState('offline', OFFLINE, { snapshotAt })}
          controls={controls}
          onOpenPanel={() => {}}
          now={snapshotAt + 5 * 60 * 1000}
        />
      )
    )
    // Fleet still rendered (not blanked to a bare message).
    expect(container.textContent).toContain('Alpha')
    // Age stamp derived from snapshotAt.
    expect(container.textContent).toContain('as of')
    expect(container.textContent).toContain('5m')
    // Greyed container present.
    expect(container.querySelector('.opacity-60')).not.toBeNull()
    // Pin control disabled while offline (controls not enabled).
    const pinButton = container.querySelector('button[aria-label^="Pin"]') as HTMLButtonElement
    expect(pinButton.disabled).toBe(true)
  })

  it('shows the bare offline message when there is no last-known fleet', () => {
    act(() =>
      root.render(
        <TeamclaudeFlyout
          state={makeState('offline', OFFLINE, { accounts: [] })}
          controls={controls}
          onOpenPanel={() => {}}
        />
      )
    )
    expect(container.textContent).toContain('offline')
    expect(container.querySelector('.opacity-60')).toBeNull()
  })

  it('renders the live fleet ungreyed when connected', () => {
    act(() =>
      root.render(
        <TeamclaudeFlyout
          state={makeState('owned', READY)}
          controls={controls}
          onOpenPanel={() => {}}
        />
      )
    )
    expect(container.textContent).toContain('Alpha')
    expect(container.textContent).not.toContain('as of')
    expect(container.querySelector('.opacity-60')).toBeNull()
  })
})
