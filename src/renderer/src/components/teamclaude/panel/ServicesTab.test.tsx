// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import '@/i18n/i18n'
import type { CpaState } from '../../../../../shared/cliproxy-types'
import type { TcState } from '../../../../../shared/teamclaude-types'
import type { CliproxyControls } from '@/hooks/useCliproxy'
import type { TeamclaudeControls } from '@/hooks/useTeamclaude'
import { ServicesTab } from './ServicesTab'

function tcState(): TcState {
  return {
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
    accounts: [],
    routes: [],
    snapshotAt: 1
  }
}

function cpaState(overrides: Partial<CpaState> = {}): CpaState {
  return {
    lifecycle: 'owned',
    readiness: { alive: true, modelsReady: true, managementReady: true, routingLinked: true },
    reasonKey: null,
    reasonDetail: null,
    port: 8319,
    version: '7.2.97',
    owned: true,
    accounts: [],
    models: [],
    usage: [],
    claudeDelegated: false,
    snapshotAt: 1,
    ...overrides
  }
}

const tcControls: TeamclaudeControls = {
  pin: vi.fn(),
  setRoutes: vi.fn(),
  setAccount: vi.fn(),
  startProxy: vi.fn(),
  stopProxy: vi.fn()
}

function cpaControls(overrides: Partial<CliproxyControls> = {}): CliproxyControls {
  return {
    loginStart: vi.fn(async () => ({ ok: true as const })),
    loginPoll: vi.fn(async () => 'wait' as const),
    loginCancel: vi.fn(async () => ({ ok: true as const })),
    accountSetDisabled: vi.fn(async () => ({ ok: true as const })),
    accountSetFields: vi.fn(async () => ({ ok: true as const })),
    accountDelete: vi.fn(async () => ({ ok: true as const })),
    aliasSet: vi.fn(async () => ({ ok: true as const })),
    serviceStart: vi.fn(async () => ({ ok: true as const })),
    serviceStop: vi.fn(async () => ({ ok: true as const })),
    logsTail: vi.fn(async () => ({ lines: [], nextCursor: null })),
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
  vi.restoreAllMocks()
})

function render(cpa: CpaState, controls = cpaControls()): void {
  act(() =>
    root.render(
      <ServicesTab
        state={tcState()}
        activity={[]}
        controls={tcControls}
        controlError={null}
        cpaState={cpa}
        cpaControls={controls}
        cpaControlError={null}
      />
    )
  )
}

describe('ServicesTab shared service cards', () => {
  it('renders TeamClaude and CLIProxyAPI lifecycle cards', () => {
    render(cpaState())
    expect(container.textContent).toContain('TeamClaude')
    expect(container.textContent).toContain('CLIProxyAPI')
    expect(container.textContent).toContain('7.2.97')
    expect(container.textContent).toContain('1.2.0')
  })

  it('plain-confirms CLIProxyAPI stop and invokes the CPA bridge', async () => {
    const serviceStop = vi.fn(async () => ({ ok: true as const }))
    render(cpaState(), cpaControls({ serviceStop }))
    const trigger = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Stop service')
    ) as HTMLButtonElement
    act(() => trigger.click())
    expect(document.body.textContent).toContain('Backend model requests will fail')
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement
    const confirm = [...dialog.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Stop service')
    ) as HTMLButtonElement
    await act(async () => confirm.click())
    expect(serviceStop).toHaveBeenCalledTimes(1)
  })

  it('shows restart-required and keeps reason detail secondary', () => {
    render(
      cpaState({
        lifecycle: 'restart-required',
        reasonKey: 'cpa.reason.topologyChanged',
        reasonDetail: 'port changed from 8319 to 8320'
      })
    )
    expect(container.textContent).toContain('Restart required to apply changes')
    expect(container.querySelector('[data-teamclaude-reason-detail]')?.textContent).toContain(
      'port changed'
    )
  })

  it('renders port-busy start failures with recovery guidance', async () => {
    const serviceStart = vi.fn(async () => ({
      ok: false as const,
      reason: 'port-busy',
      message: 'Port 8319 is held by pid 42.'
    }))
    render(
      cpaState({
        lifecycle: 'offline',
        readiness: {
          alive: false,
          modelsReady: false,
          managementReady: false,
          routingLinked: false
        }
      }),
      cpaControls({ serviceStart })
    )
    const start = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Start service')
    ) as HTMLButtonElement
    await act(async () => start.click())
    expect(container.textContent).toContain('Choose another CLIProxyAPI port')
    expect(container.textContent).toContain('pid 42')
  })
})
