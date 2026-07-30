// @vitest-environment happy-dom

import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import '@/i18n/i18n'
import type { TcEffortLevel, TcEffortState } from '../../../../shared/teamclaude-types'
import { TeamclaudeHotSwap, type TcEffortBridge } from './TeamclaudeHotSwap'
import type { TcHotSwapModel } from './teamclaude-hotswap'
import type { TcHotSwapTarget } from './teamclaude-hotswap-target'

const MODELS: TcHotSwapModel[] = [
  { id: 'claude-opus-5' },
  { id: 'claude-sonnet-4-6' },
  { id: 'grok-4', provider: 'xai' },
  { id: 'gpt-5-codex', provider: 'codex' }
]

const CLAUDE_PANE: TcHotSwapTarget = {
  ptyId: 'pty-1',
  tabTitle: 'claude',
  agent: 'claude',
  claudeFamily: true
}

const CODEX_PANE: TcHotSwapTarget = {
  ptyId: 'pty-2',
  tabTitle: 'codex',
  agent: 'codex',
  claudeFamily: false
}

function effortBridge(level: TcEffortLevel | null = null): {
  bridge: TcEffortBridge
  setEffort: ReturnType<typeof vi.fn>
} {
  const setEffort = vi.fn(
    async (next: TcEffortLevel | null): Promise<TcEffortState> =>
      next === null ? null : { level: next }
  )
  return {
    bridge: {
      getEffort: async (): Promise<TcEffortState> => (level === null ? null : { level }),
      setEffort
    },
    setEffort
  }
}

// Why: this suite drives real state updates through act(); React only accepts
// them silently when the act environment flag is set.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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

function render(node: ReactElement): void {
  act(() => root.render(node))
}

function buttonsByAriaPrefix(prefix: string): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>(`button[aria-label^="${prefix}"]`)]
}

function effortLabels(): string[] {
  return buttonsByAriaPrefix('Set reasoning effort to').map((button) => button.textContent ?? '')
}

function modelButton(id: string): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(
    `button[aria-label="Switch model to ${id}"]`
  )
  if (!button) {
    throw new Error(`missing model button for ${id}`)
  }
  return button
}

function click(button: HTMLButtonElement): void {
  act(() => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

function applyButton(): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.textContent === 'Apply'
  )
  if (!button) {
    throw new Error('missing Apply button')
  }
  return button
}

describe('TeamclaudeHotSwap level validity', () => {
  it('offers the Claude level list (never none) while a Claude pane is targeted', () => {
    const { bridge } = effortBridge()
    render(
      <TeamclaudeHotSwap
        models={MODELS}
        target={CLAUDE_PANE}
        effortEnabled
        effortBridge={bridge}
        writeToPty={vi.fn()}
      />
    )
    expect(effortLabels()).toEqual(['Low', 'Medium', 'High', 'Max'])
    expect(effortLabels()).not.toContain('None')
  })

  it('switches to the backend level list when a backend model is picked', () => {
    const { bridge } = effortBridge()
    render(
      <TeamclaudeHotSwap
        models={MODELS}
        target={CLAUDE_PANE}
        effortEnabled
        effortBridge={bridge}
        writeToPty={vi.fn()}
      />
    )
    click(modelButton('grok-4'))
    expect(effortLabels()).toEqual(['None', 'Low', 'High', 'Max'])
    expect(effortLabels()).not.toContain('Medium')
  })

  it('drops a held Claude-only level back to High on a backend model', () => {
    const { bridge, setEffort } = effortBridge()
    render(
      <TeamclaudeHotSwap
        models={MODELS}
        target={CLAUDE_PANE}
        effortEnabled
        effortBridge={bridge}
        writeToPty={vi.fn()}
      />
    )
    const medium = buttonsByAriaPrefix('Set reasoning effort to Medium')[0]
    click(medium)
    click(modelButton('gpt-5-codex'))
    click(applyButton())
    expect(setEffort).toHaveBeenCalledWith('high')
  })

  it('starts from the override the proxy already holds', async () => {
    const { bridge } = effortBridge('low')
    await act(async () => {
      root.render(
        <TeamclaudeHotSwap
          models={MODELS}
          target={CLAUDE_PANE}
          effortEnabled
          effortBridge={bridge}
          writeToPty={vi.fn()}
        />
      )
    })
    const pressed = buttonsByAriaPrefix('Set reasoning effort to').filter(
      (button) => button.getAttribute('aria-pressed') === 'true'
    )
    expect(pressed.map((button) => button.textContent)).toEqual(['Low'])
  })
})

describe('TeamclaudeHotSwap model swap safety', () => {
  it('disables the model swap and explains why for a non-Claude pane', () => {
    const { bridge } = effortBridge()
    render(
      <TeamclaudeHotSwap
        models={MODELS}
        target={CODEX_PANE}
        effortEnabled
        effortBridge={bridge}
        writeToPty={vi.fn()}
      />
    )
    expect(modelButton('claude-opus-5').disabled).toBe(true)
    expect(container.textContent).toContain('not running Claude')
  })

  it('disables the model swap when no terminal is open', () => {
    const { bridge } = effortBridge()
    render(
      <TeamclaudeHotSwap models={MODELS} effortEnabled effortBridge={bridge} writeToPty={vi.fn()} />
    )
    expect(modelButton('claude-opus-5').disabled).toBe(true)
    expect(container.textContent).toContain('No terminal is open')
  })

  it('never writes into a pane that is not running Claude', () => {
    const writeToPty = vi.fn()
    const { bridge, setEffort } = effortBridge()
    render(
      <TeamclaudeHotSwap
        models={MODELS}
        target={CODEX_PANE}
        effortEnabled
        effortBridge={bridge}
        writeToPty={writeToPty}
      />
    )
    click(applyButton())
    expect(writeToPty).not.toHaveBeenCalled()
    expect(setEffort).toHaveBeenCalledWith('high')
  })
})

describe('TeamclaudeHotSwap apply', () => {
  it('issues both the pty write and the setEffort call', async () => {
    const writeToPty = vi.fn()
    const { bridge, setEffort } = effortBridge()
    render(
      <TeamclaudeHotSwap
        models={MODELS}
        target={CLAUDE_PANE}
        effortEnabled
        effortBridge={bridge}
        writeToPty={writeToPty}
      />
    )
    click(modelButton('claude-opus-5'))
    click(buttonsByAriaPrefix('Set reasoning effort to Max')[0])
    await act(async () => {
      applyButton().dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(writeToPty).toHaveBeenCalledWith('pty-1', '/model claude-opus-5\r')
    expect(setEffort).toHaveBeenCalledWith('max')
    expect(container.textContent).toContain('Sent to the running session')
  })

  it('still swaps the model when the proxy has no effort endpoint yet', () => {
    const writeToPty = vi.fn()
    render(
      <TeamclaudeHotSwap
        models={MODELS}
        target={CLAUDE_PANE}
        effortEnabled
        effortBridge={null}
        writeToPty={writeToPty}
      />
    )
    expect(container.textContent).toContain('cannot change reasoning effort')
    expect(buttonsByAriaPrefix('Set reasoning effort to')[0].disabled).toBe(true)
    click(modelButton('claude-sonnet-4-6'))
    click(applyButton())
    expect(writeToPty).toHaveBeenCalledWith('pty-1', '/model claude-sonnet-4-6\r')
  })

  it('disables Apply when neither half can act', () => {
    render(
      <TeamclaudeHotSwap
        models={MODELS}
        target={CODEX_PANE}
        effortEnabled={false}
        effortBridge={null}
        writeToPty={vi.fn()}
      />
    )
    expect(applyButton().disabled).toBe(true)
  })

  it('groups the picker by provider family', () => {
    render(
      <TeamclaudeHotSwap
        models={MODELS}
        target={CLAUDE_PANE}
        effortEnabled
        effortBridge={null}
        writeToPty={vi.fn()}
      />
    )
    expect(container.textContent).toContain('Claude')
    expect(container.textContent).toContain('Grok')
    expect(container.textContent).toContain('Codex')
  })
})
