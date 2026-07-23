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
    // The disabled reason now rides a per-control tooltip with a native `title`
    // accessible fallback (not a single inline banner). For an adopted-degraded
    // server it names the concrete have/need versions.
    const reasonEl = container.querySelector('span[title]')
    expect(reasonEl?.getAttribute('title')).toContain('Update teamclaude')
    expect(reasonEl?.getAttribute('title')).toContain('v1.0.0')
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

// Why: `fromDraft` used to hardcode `bucket: null`, so any Apply silently wiped
// the routing bucket off every existing route (data loss). The draft model must
// carry `bucket` verbatim even though the editor does not expose it.
function setNativeInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function clickButtonByText(text: string): void {
  const button = [...container.querySelectorAll('button')].find((el) =>
    el.textContent?.includes(text)
  )
  if (!button) {
    throw new Error(`button with text ${text} not found`)
  }
  button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

describe('RoutesTab bucket preservation (regression)', () => {
  it('preserves an existing route bucket through an edit + apply round-trip', () => {
    const setRoutes = vi.fn()
    act(() =>
      root.render(
        <RoutesTab
          state={makeState(
            { usageReady: true, routingReady: true, controlReady: true },
            {
              routes: [
                { name: 'fable-route', match: ['**/*.md'], accounts: ['a1'], bucket: 'fable' }
              ]
            }
          )}
          controls={{ ...controls, setRoutes }}
        />
      )
    )

    const nameInput = container.querySelector('input') as HTMLInputElement
    act(() => setNativeInputValue(nameInput, 'renamed-route'))
    act(() => clickButtonByText('Apply'))

    expect(setRoutes).toHaveBeenCalledTimes(1)
    const applied = setRoutes.mock.calls[0][0] as { name: string; bucket: string | null }[]
    expect(applied).toHaveLength(1)
    expect(applied[0].name).toBe('renamed-route')
    expect(applied[0].bucket).toBe('fable') // NOT wiped to null
  })
})

describe('adopted-degraded update messaging', () => {
  it('routes: names have/need versions when adopted-degraded', () => {
    act(() =>
      root.render(
        <RoutesTab
          state={makeState(
            { usageReady: true, routingReady: false, controlReady: false },
            { lifecycle: 'adopted-degraded', serverVersion: '1.0.0' }
          )}
          controls={controls}
        />
      )
    )
    expect(container.textContent).toContain('Update teamclaude')
    expect(container.textContent).toContain('v1.0.0') // have
    expect(container.textContent).toContain('v1.5.0') // need (TC_MIN_SERVER_VERSION)
  })

  it('routes: keeps generic copy for plain offline (upgrade would not help)', () => {
    act(() =>
      root.render(
        <RoutesTab
          state={makeState(
            { usageReady: false, routingReady: false, controlReady: false },
            { lifecycle: 'offline' }
          )}
          controls={controls}
        />
      )
    )
    expect(container.textContent).not.toContain('Update teamclaude')
    expect(container.textContent).toContain('unavailable')
  })
})
