// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import '@/i18n/i18n'
import type {
  TcActivityRow,
  TcProxyLifecycle,
  TcReadiness,
  TcState
} from '../../../../../shared/teamclaude-types'
import type { TeamclaudeControls } from '@/hooks/useTeamclaude'
import { ProxyTab } from './ProxyTab'

const READY: TcReadiness = { usageReady: true, routingReady: true, controlReady: true }

function row(overrides: Partial<TcActivityRow> = {}): TcActivityRow {
  return {
    key: 'boot:1',
    at: 1_000,
    model: 'claude',
    account: 'Alpha',
    status: 200,
    durationMs: 120,
    path: '/v1/messages',
    ...overrides
  }
}

function makeState(lifecycle: TcProxyLifecycle, overrides: Partial<TcState> = {}): TcState {
  return {
    lifecycle,
    readiness: READY,
    reasonKey: null,
    reasonDetail: null,
    port: 8080,
    serverVersion: '1.0.0',
    bootId: 'boot',
    capabilities: [],
    owned: true,
    accounts: [],
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

function clickButtonByText(text: string): void {
  const button = [...document.querySelectorAll('button')].find((el) =>
    el.textContent?.includes(text)
  )
  if (!button) {
    throw new Error(`button with text ${text} not found`)
  }
  button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

const controls: TeamclaudeControls = {
  pin: vi.fn(),
  setRoutes: vi.fn(),
  setAccount: vi.fn(),
  startProxy: vi.fn(),
  stopProxy: vi.fn()
}

describe('ProxyTab in-flight request framing (truthful consent copy)', () => {
  it('labels the count "In-flight requests", not sessions', () => {
    act(() =>
      root.render(
        <ProxyTab
          state={makeState('owned')}
          activity={[row({ key: 'b:1', status: null }), row({ key: 'b:2', durationMs: null })]}
          controls={controls}
        />
      )
    )
    expect(container.textContent).toContain('In-flight requests')
    expect(container.textContent).not.toContain('Live sessions')
  })

  it('stop confirmation speaks of in-flight requests and echoes the count as consent', () => {
    const stopProxy = vi.fn()
    act(() =>
      root.render(
        <ProxyTab
          state={makeState('owned')}
          activity={[row({ key: 'b:1', status: null }), row({ key: 'b:2', durationMs: null })]}
          controls={{ ...controls, stopProxy }}
        />
      )
    )
    act(() => clickButtonByText('Stop proxy'))
    // Dialog content is portalled to document.body.
    expect(document.body.textContent).toContain('in-flight request')
    expect(document.body.textContent).not.toContain('live session')
    // Confirm from inside the dialog (the trigger button shares its label).
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement
    const confirm = [...dialog.querySelectorAll('button')].find((el) =>
      el.textContent?.includes('Stop proxy')
    ) as HTMLButtonElement
    act(() => confirm.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(stopProxy).toHaveBeenCalledWith(2)
  })
})
