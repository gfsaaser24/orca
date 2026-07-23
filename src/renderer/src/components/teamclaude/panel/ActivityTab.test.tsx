// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import '@/i18n/i18n'
import type { TcActivityRow } from '../../../../../shared/teamclaude-types'
import { ActivityTab } from './ActivityTab'

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

describe('ActivityTab offline banner', () => {
  it('keeps history (table, not the empty state) and shows the offline banner when offline', () => {
    act(() => root.render(<ActivityTab activity={[row()]} offline />))
    expect(container.textContent).toContain('Proxy offline')
    // History retained: the virtualized table renders (column headers present),
    // not the "No activity yet" empty state. (Row bodies are virtualized and do
    // not lay out under happy-dom's zero-height scroll element.)
    expect(container.querySelector('[role="table"]')).not.toBeNull()
    expect(container.textContent).not.toContain('No activity yet.')
  })

  it('shows the banner even with empty history when offline', () => {
    act(() => root.render(<ActivityTab activity={[]} offline />))
    expect(container.textContent).toContain('Proxy offline')
    expect(container.textContent).toContain('No activity yet.')
  })

  it('omits the banner when online', () => {
    act(() => root.render(<ActivityTab activity={[row()]} offline={false} />))
    expect(container.textContent).not.toContain('Proxy offline')
  })
})
