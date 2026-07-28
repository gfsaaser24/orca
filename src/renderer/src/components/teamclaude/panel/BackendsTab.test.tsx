// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import '@/i18n/i18n'
import type { CpaAccount, CpaModel, CpaState } from '../../../../../shared/cliproxy-types'
import type { CliproxyControls } from '@/hooks/useCliproxy'
import { BackendsTab } from './BackendsTab'

function account(overrides: Partial<CpaAccount> = {}): CpaAccount {
  return {
    name: 'codex.json',
    authIndex: '1',
    provider: 'codex',
    label: 'Work Codex',
    email: 'dev@example.com',
    disabled: false,
    unavailable: false,
    priority: 10,
    note: null,
    cooling: true,
    recentSuccess: 4,
    recentFailure: 1,
    ...overrides
  }
}

function model(overrides: Partial<CpaModel> = {}): CpaModel {
  return {
    id: 'gpt-5.4',
    provider: 'codex',
    displayName: 'GPT 5.4',
    alias: 'work',
    routable: true,
    ...overrides
  }
}

function state(overrides: Partial<CpaState> = {}): CpaState {
  return {
    lifecycle: 'owned',
    readiness: { alive: true, modelsReady: true, managementReady: true, routingLinked: true },
    reasonKey: null,
    reasonDetail: null,
    port: 8319,
    version: '7.2.97',
    owned: true,
    accounts: [account()],
    models: [model()],
    usage: [],
    claudeDelegated: false,
    snapshotAt: 1_000,
    ...overrides
  }
}

function controls(overrides: Partial<CliproxyControls> = {}): CliproxyControls {
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

function render(
  cpaState: CpaState | null,
  cpaControls = controls(),
  localLaunchAvailable = true,
  onSaveBinaryPath?: (path: string) => Promise<void>
): void {
  act(() =>
    root.render(
      <BackendsTab
        state={cpaState}
        controls={cpaControls}
        localLaunchAvailable={localLaunchAvailable}
        now={301_000}
        onSaveBinaryPath={onSaveBinaryPath}
      />
    )
  )
}

function providerButton(providerName: string): HTMLButtonElement {
  const section = [...container.querySelectorAll('section')].find((entry) =>
    entry.textContent?.includes(providerName)
  )
  const button = section?.querySelector('button')
  if (!button) {
    throw new Error(`Add button for ${providerName} not found`)
  }
  return button
}

describe('BackendsTab degradation matrix', () => {
  it('greys last-known data and shows snapshot age while offline', () => {
    render(
      state({
        lifecycle: 'offline',
        readiness: {
          alive: false,
          modelsReady: false,
          managementReady: false,
          routingLinked: false
        }
      })
    )
    expect(container.textContent).toContain('Showing last-known data')
    expect(container.textContent).toContain('5m')
    expect(container.textContent).toContain('Work Codex')
    expect(container.querySelector('.opacity-60')).not.toBeNull()
  })

  it('shows binary-path setup guidance before offline guidance', () => {
    render(
      state({
        lifecycle: 'setup-needed',
        readiness: {
          alive: false,
          modelsReady: false,
          managementReady: false,
          routingLinked: false
        },
        accounts: [],
        models: []
      })
    )
    expect(container.textContent).toContain('binary path')
    expect(container.textContent).not.toContain('is offline')
  })

  it('saves the binary path from the setup card and starts the service', async () => {
    const cpaControls = controls()
    const onSaveBinaryPath = vi.fn(async () => {})
    render(
      state({
        lifecycle: 'setup-needed',
        readiness: {
          alive: false,
          modelsReady: false,
          managementReady: false,
          routingLinked: false
        },
        accounts: [],
        models: []
      }),
      cpaControls,
      true,
      onSaveBinaryPath
    )
    const input = container.querySelector<HTMLInputElement>(
      'input[aria-label="CLIProxyAPI binary path"]'
    )
    if (!input) {
      throw new Error('binary path input not found')
    }
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        input,
        'C:\\bin\\cli-proxy-api.exe'
      )
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const button = [...container.querySelectorAll('button')].find((entry) =>
      entry.textContent?.includes('Save & start')
    )
    if (!button) {
      throw new Error('save button not found')
    }
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onSaveBinaryPath).toHaveBeenCalledWith('C:\\bin\\cli-proxy-api.exe')
    expect(cpaControls.serviceStart).toHaveBeenCalled()
  })

  it('keeps the full provider UI active when ready with zero backends', () => {
    render(state({ accounts: [], models: [] }))
    expect(container.textContent).toContain('Gemini / Antigravity')
    expect(container.textContent).toContain('No accounts connected')
    expect(providerButton('Codex / ChatGPT').disabled).toBe(false)
  })

  it('deletes an account through a two-step confirm', async () => {
    const cpaControls = controls()
    render(state(), cpaControls)
    const remove = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Remove Work Codex"]'
    )
    if (!remove) {
      throw new Error('delete button not found')
    }
    // First click only arms the confirm — it must not delete outright.
    await act(async () => {
      remove.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(cpaControls.accountDelete).not.toHaveBeenCalled()

    const confirm = [...container.querySelectorAll('button')].find(
      (entry) => entry.textContent === 'Delete'
    )
    if (!confirm) {
      throw new Error('confirm button not found')
    }
    await act(async () => {
      confirm.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(cpaControls.accountDelete).toHaveBeenCalledWith({ name: 'codex.json' })
  })

  it('explains the delegated Claude card instead of reading as empty', () => {
    render(state({ accounts: [], models: [], claudeDelegated: true }))
    const claudeCard = [...container.querySelectorAll('section')].find(
      (entry) => entry.textContent?.includes('Claude') && !entry.textContent?.includes('Codex')
    )
    expect(claudeCard?.textContent).toContain('Served by your TeamClaude accounts')
    // Other providers still report an honest empty state.
    const codexCard = [...container.querySelectorAll('section')].find((entry) =>
      entry.textContent?.includes('Codex / ChatGPT')
    )
    expect(codexCard?.textContent).toContain('No accounts connected')
  })

  it('gates management and routing independently from model inventory', () => {
    render(
      state({
        readiness: {
          alive: true,
          modelsReady: true,
          managementReady: false,
          routingLinked: false
        }
      })
    )
    expect(container.textContent).toContain('gpt-5.4')
    expect(container.textContent).toContain('Routing unavailable')
    expect(providerButton('Codex / ChatGPT').disabled).toBe(true)
    expect(
      (container.querySelector('input[aria-label="Global alias for gpt-5.4"]') as HTMLInputElement)
        .disabled
    ).toBe(true)
  })

  it('renders API-key attribution as read-only v2 presence', () => {
    render(
      state({
        models: [model({ id: 'vendor-model', provider: 'openai-compat', alias: null })]
      })
    )
    expect(container.textContent).toContain('OpenAI compatible')
    expect(container.textContent).toContain('Managed outside Orca (v2)')
  })

  it('hides local launch commands in remote contexts', () => {
    render(state(), controls(), false)
    expect(container.querySelector('button[aria-label^="Copy launch command"]')).toBeNull()
    expect(container.textContent).not.toContain('Launch commands are for local sessions')
  })
})

describe('BackendsTab login and alias flows', () => {
  it('shows and cancels a browser login pending state', async () => {
    const loginCancel = vi.fn(async () => ({ ok: true as const }))
    const cpaControls = controls({
      loginStart: vi.fn(async () => ({
        kind: 'browser' as const,
        state: 'browser-flow',
        url: 'https://provider.example/login'
      })),
      loginCancel
    })
    render(state(), cpaControls)
    await act(async () => providerButton('Codex / ChatGPT').click())
    expect(container.textContent).toContain('Waiting for sign-in in your browser')
    const cancel = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Cancel')
    ) as HTMLButtonElement
    await act(async () => cancel.click())
    expect(loginCancel).toHaveBeenCalledWith('browser-flow')
  })

  it('renders a device code modal and polls the flow', async () => {
    const loginPoll = vi.fn(async () => 'ok' as const)
    const cpaControls = controls({
      loginStart: vi.fn(async () => ({
        kind: 'device' as const,
        state: 'device-flow',
        url: 'https://device.example',
        userCode: 'KIMI-123',
        expiresIn: 600
      })),
      loginPoll
    })
    render(state(), cpaControls)
    await act(async () => providerButton('Grok').click())
    expect(document.body.textContent).toContain('KIMI-123')
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement
    const check = [...dialog.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Check status')
    ) as HTMLButtonElement
    await act(async () => check.click())
    expect(loginPoll).toHaveBeenCalledWith('device-flow')
  })

  it('writes a full-channel global alias map', async () => {
    const aliasSet = vi.fn(async () => ({ ok: true as const }))
    const cpaControls = controls({ aliasSet })
    render(
      state({
        models: [model(), model({ id: 'gpt-mini', alias: 'fast' })]
      }),
      cpaControls
    )
    const input = container.querySelector(
      'input[aria-label="Global alias for gpt-5.4"]'
    ) as HTMLInputElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        input,
        'primary'
      )
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const save = container.querySelector(
      'button[aria-label="Save alias for gpt-5.4"]'
    ) as HTMLButtonElement
    await act(async () => save.click())
    expect(aliasSet).toHaveBeenCalledWith({
      channel: 'codex',
      aliases: { 'gpt-5.4': 'primary', 'gpt-mini': 'fast' }
    })
  })
})
