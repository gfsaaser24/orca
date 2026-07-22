// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import '@/i18n/i18n'
import type { TcAccount, TcReadiness, TcState } from '../../../../shared/teamclaude-types'
import type { TeamclaudeControls } from '@/hooks/useTeamclaude'
import { AccountsTab } from './panel/AccountsTab'
import { RoutesTab } from './panel/RoutesTab'

const controls: TeamclaudeControls = {
  pin: vi.fn(),
  setRoutes: vi.fn(),
  setAccount: vi.fn(),
  startProxy: vi.fn(),
  stopProxy: vi.fn()
}

function account(): TcAccount {
  return {
    id: 'a1',
    name: 'Alpha',
    email: 'alpha@example.com',
    status: 'active',
    priority: 1,
    pinned: false,
    orcaAccountId: null,
    buckets: { unified5h: null, unified7d: null, unified7dFable: null, unified7dSonnet: null }
  }
}

function makeState(readiness: TcReadiness, overrides: Partial<TcState> = {}): TcState {
  return {
    lifecycle: 'owned',
    readiness,
    reasonKey: null,
    reasonDetail: null,
    port: 8080,
    serverVersion: '1.0.0',
    bootId: 'boot',
    capabilities: [],
    owned: true,
    accounts: [account()],
    routes: [{ name: 'default', match: ['**/*'], accounts: ['a1'], bucket: null }],
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

function inputsDisabled(): boolean {
  const controlsEls = container.querySelectorAll('input, button')
  return [...controlsEls].every((el) => (el as HTMLInputElement | HTMLButtonElement).disabled)
}

describe('degradation gating — controls surface', () => {
  it('enables account controls when controlReady is true', () => {
    act(() =>
      root.render(
        <AccountsTab
          state={makeState({ usageReady: true, routingReady: true, controlReady: true })}
          controls={controls}
        />
      )
    )
    const priority = container.querySelector('input[type="number"]') as HTMLInputElement
    expect(priority.disabled).toBe(false)
  })

  it('disables account controls purely on controlReady (not lifecycle) — even adopted-degraded', () => {
    act(() =>
      root.render(
        <AccountsTab
          state={makeState(
            { usageReady: true, routingReady: true, controlReady: false },
            { lifecycle: 'adopted-degraded' }
          )}
          controls={controls}
        />
      )
    )
    const priority = container.querySelector('input[type="number"]') as HTMLInputElement
    expect(priority.disabled).toBe(true)
    expect(container.textContent).toContain('unavailable')
  })
})

describe('degradation gating — routing surface', () => {
  it('allows editing when routing and control are ready', () => {
    act(() =>
      root.render(
        <RoutesTab
          state={makeState({ usageReady: true, routingReady: true, controlReady: true })}
          controls={controls}
        />
      )
    )
    const nameInput = container.querySelector('input') as HTMLInputElement
    expect(nameInput.disabled).toBe(false)
  })

  it('locks the routes editor when routingReady is false', () => {
    act(() =>
      root.render(
        <RoutesTab
          state={makeState({ usageReady: true, routingReady: false, controlReady: true })}
          controls={controls}
        />
      )
    )
    expect(inputsDisabled()).toBe(true)
  })
})
