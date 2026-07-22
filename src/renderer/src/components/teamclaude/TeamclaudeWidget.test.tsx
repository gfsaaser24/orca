// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import '@/i18n/i18n'
import type {
  TcAccount,
  TcProxyLifecycle,
  TcReadiness,
  TcState
} from '../../../../shared/teamclaude-types'
import { TeamclaudeWidget } from './TeamclaudeWidget'

const READY: TcReadiness = { usageReady: true, routingReady: true, controlReady: true }

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
      unified5h: { usedPercent: 20, overage: false, resetsAt: null, observedAt: Date.now() },
      unified7d: { usedPercent: 72, overage: false, resetsAt: null, observedAt: Date.now() },
      unified7dFable: { usedPercent: 5, overage: false, resetsAt: null, observedAt: Date.now() },
      unified7dSonnet: { usedPercent: 5, overage: false, resetsAt: null, observedAt: Date.now() }
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

function render(state: TcState | null): void {
  act(() => root.render(<TeamclaudeWidget state={state} />))
}

describe('TeamclaudeWidget', () => {
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('renders the primary account name and worst-bucket percentage when usage is ready', () => {
    render(makeState('owned', READY))
    expect(container.textContent).toContain('Alpha')
    expect(container.textContent).toContain('72%')
    // A progressbar is present for the worst bucket.
    expect(container.querySelector('[role="progressbar"]')).not.toBeNull()
  })

  it('degrades to a status label (no bars) when usage is not ready', () => {
    render(makeState('owned', { usageReady: false, routingReady: true, controlReady: true }))
    expect(container.querySelector('[role="progressbar"]')).toBeNull()
    expect(container.textContent).not.toContain('72%')
  })

  it('shows a "direct" label when offline and no bars for null state', () => {
    render(makeState('offline', READY))
    // Offline degradation matrix (spec §5): grey dot + "direct", not "Offline".
    expect(container.textContent).toContain('direct')
    expect(container.textContent).not.toContain('Offline')
    render(null)
    expect(container.querySelector('[role="progressbar"]')).toBeNull()
  })

  it('renders the launched-unrouted chip only when the reason key is set', () => {
    render(makeState('owned', READY))
    expect(container.textContent).not.toContain('Unrouted')
    render(makeState('owned', READY, { reasonKey: 'launchedUnrouted' }))
    expect(container.textContent).toContain('Unrouted')
  })
})
