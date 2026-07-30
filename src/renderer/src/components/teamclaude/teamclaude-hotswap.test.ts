import { describe, expect, it } from 'vitest'

import {
  BACKEND_EFFORT_LEVELS,
  clampEffortLevel,
  CLAUDE_EFFORT_LEVELS,
  effortLevelsFor,
  hotSwapFamily,
  hotSwapGroups,
  hotSwapModelInventory,
  modelSwapKeystrokes
} from './teamclaude-hotswap'
import {
  isClaudeFamilyAgent,
  NO_HOT_SWAP_TARGET,
  selectTeamclaudeHotSwapTarget,
  type TcHotSwapTargetState
} from './teamclaude-hotswap-target'
import type { TerminalTab } from '../../../../shared/types'

function tab(overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id: 'tab-1',
    ptyId: 'pty-1',
    worktreeId: 'wt-1',
    title: 'claude',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    ...overrides
  }
}

function targetState(overrides: Partial<TcHotSwapTargetState> = {}): TcHotSwapTargetState {
  return {
    activeWorktreeId: 'wt-1',
    activeTabId: 'tab-1',
    tabsByWorktree: { 'wt-1': [tab({ launchAgent: 'claude' })] },
    terminalLayoutsByTabId: {},
    paneForegroundAgentByPaneKey: {},
    agentStatusByPaneKey: {},
    ...overrides
  } as TcHotSwapTargetState
}

describe('hot-swap model inventory', () => {
  it('places models by provider, falling back to the id', () => {
    expect(hotSwapFamily({ id: 'claude-opus-5' })).toBe('claude')
    expect(hotSwapFamily({ id: 'gpt-5-codex' })).toBe('codex')
    expect(hotSwapFamily({ id: 'grok-4' })).toBe('xai')
    expect(hotSwapFamily({ id: 'kimi-k2' })).toBe('kimi')
    expect(hotSwapFamily({ id: 'gemini-3-pro' })).toBe('gemini')
    expect(hotSwapFamily({ id: 'house-blend-1' })).toBe('other')
    // Provider wins: an aliased Anthropic-backed id is still the Claude family.
    expect(hotSwapFamily({ id: 'house-blend-1', provider: 'claude' })).toBe('claude')
  })

  it('merges the backend registry with models seen in live activity', () => {
    const models = hotSwapModelInventory({
      cpaModels: [{ id: 'grok-4', provider: 'xai' }],
      activityModels: ['claude-opus-5', null, 'grok-4', 'claude-opus-5', '  ']
    })
    expect(models.map((model) => model.id)).toEqual(['claude-opus-5', 'grok-4'])
    // The registry entry (with its provider) wins over the activity-only twin.
    expect(models.find((model) => model.id === 'grok-4')?.provider).toBe('xai')
  })

  it('groups models family-first and drops empty families', () => {
    const groups = hotSwapGroups([
      { id: 'grok-4', provider: 'xai' },
      { id: 'claude-sonnet-4-6' },
      { id: 'claude-opus-5' }
    ])
    expect(groups.map((group) => group.family)).toEqual(['claude', 'xai'])
    expect(groups[0].models.map((model) => model.id)).toEqual([
      'claude-opus-5',
      'claude-sonnet-4-6'
    ])
    expect(groups[1].labelFallback).toBe('Grok')
  })
})

describe('hot-swap effort levels', () => {
  it('never offers none for a Claude model and always offers it for a backend', () => {
    expect(CLAUDE_EFFORT_LEVELS).toEqual(['low', 'medium', 'high', 'max'])
    expect(CLAUDE_EFFORT_LEVELS).not.toContain('none')
    expect(BACKEND_EFFORT_LEVELS).toEqual(['none', 'low', 'high', 'max'])
    expect(effortLevelsFor(true)).toBe(CLAUDE_EFFORT_LEVELS)
    expect(effortLevelsFor(false)).toBe(BACKEND_EFFORT_LEVELS)
  })

  it('clamps a held level that the new model does not accept', () => {
    expect(clampEffortLevel('medium', CLAUDE_EFFORT_LEVELS)).toBe('medium')
    // `medium` is not offered on backends; `none` is not offered on Claude.
    expect(clampEffortLevel('medium', BACKEND_EFFORT_LEVELS)).toBe('high')
    expect(clampEffortLevel('none', CLAUDE_EFFORT_LEVELS)).toBe('high')
  })

  it('submits the CLI model command with a carriage return', () => {
    expect(modelSwapKeystrokes('claude-opus-5')).toBe('/model claude-opus-5\r')
  })
})

describe('hot-swap active pane resolution', () => {
  it('resolves the active single-pane tab from its launch metadata', () => {
    const target = selectTeamclaudeHotSwapTarget(targetState())
    expect(target).toEqual({
      ptyId: 'pty-1',
      tabTitle: 'claude',
      agent: 'claude',
      claudeFamily: true
    })
  })

  it('returns an empty target when no terminal tab is active', () => {
    expect(selectTeamclaudeHotSwapTarget(targetState({ activeTabId: null }))).toEqual(
      NO_HOT_SWAP_TARGET
    )
    expect(selectTeamclaudeHotSwapTarget(targetState({ tabsByWorktree: {} }))).toEqual(
      NO_HOT_SWAP_TARGET
    )
  })

  it('prefers per-pane process evidence and its leaf PTY inside a split', () => {
    const target = selectTeamclaudeHotSwapTarget(
      targetState({
        terminalLayoutsByTabId: {
          'tab-1': {
            root: {
              type: 'split',
              direction: 'horizontal',
              ratio: 0.5,
              first: { type: 'leaf', leafId: 'leaf-a' },
              second: { type: 'leaf', leafId: 'leaf-b' }
            },
            activeLeafId: 'leaf-b',
            expandedLeafId: null,
            ptyIdsByLeafId: { 'leaf-a': 'pty-a', 'leaf-b': 'pty-b' }
          }
        },
        paneForegroundAgentByPaneKey: {
          'tab-1:leaf-b': { agent: 'codex', shellForeground: false }
        }
      })
    )
    expect(target.ptyId).toBe('pty-b')
    expect(target.agent).toBe('codex')
    expect(target.claudeFamily).toBe(false)
  })

  it('treats a pane proven back at the shell as running nothing', () => {
    const target = selectTeamclaudeHotSwapTarget(
      targetState({
        terminalLayoutsByTabId: {
          'tab-1': {
            root: { type: 'leaf', leafId: 'leaf-a' },
            activeLeafId: 'leaf-a',
            expandedLeafId: null,
            ptyIdsByLeafId: { 'leaf-a': 'pty-a' }
          }
        },
        paneForegroundAgentByPaneKey: {
          'tab-1:leaf-a': { agent: null, shellForeground: true }
        }
      })
    )
    expect(target.ptyId).toBe('pty-a')
    expect(target.agent).toBeNull()
    expect(target.claudeFamily).toBe(false)
  })

  it('falls back to hook rows for the pane agent', () => {
    const target = selectTeamclaudeHotSwapTarget(
      targetState({
        tabsByWorktree: { 'wt-1': [tab()] },
        terminalLayoutsByTabId: {
          'tab-1': {
            root: { type: 'leaf', leafId: 'leaf-a' },
            activeLeafId: 'leaf-a',
            expandedLeafId: null,
            ptyIdsByLeafId: { 'leaf-a': 'pty-a' }
          }
        },
        agentStatusByPaneKey: {
          'tab-1:leaf-a': {
            state: 'working',
            prompt: '',
            updatedAt: 0,
            stateStartedAt: 0,
            paneKey: 'tab-1:leaf-a',
            stateHistory: [],
            agentType: 'claude'
          }
        }
      })
    )
    expect(target.agent).toBe('claude')
    expect(target.claudeFamily).toBe(true)
  })

  it('recognizes only the Claude-family agent ids', () => {
    expect(isClaudeFamilyAgent('claude')).toBe(true)
    expect(isClaudeFamilyAgent('claude-agent-teams')).toBe(true)
    expect(isClaudeFamilyAgent('openclaude')).toBe(true)
    expect(isClaudeFamilyAgent('codex')).toBe(false)
    expect(isClaudeFamilyAgent(null)).toBe(false)
  })
})
