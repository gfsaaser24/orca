import { useShallow } from 'zustand/react/shallow'

import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/types'
import { useAppStore, type AppState } from '@/store'
import {
  isNativeChatTabWideFallbackSafe,
  resolveNativeChatActiveLayoutLeafId
} from '../native-chat/native-chat-leaf-routing'

// Why: typing `/model x` + CR into a pane that is NOT running a Claude-family
// CLI would execute nonsense in a shell, so the hot-swap control must resolve
// the pane it would write into and what is actually running there BEFORE it
// offers the swap. Pane evidence routing is already solved for the native-chat
// toggle; reusing its leaf resolution keeps both surfaces agreeing on which
// pane is "the one running the agent".

/**
 * Agent ids that route through the TeamClaude proxy and understand `/model`.
 * Mirrors TEAMCLAUDE_CLAUDE_FAMILY_AGENTS in src/main/ipc/pty.ts (main-process
 * module, not importable from the renderer) — keep the two in step.
 */
export const TC_CLAUDE_FAMILY_AGENTS: readonly string[] = [
  'claude',
  'claude-agent-teams',
  'openclaude'
]

export function isClaudeFamilyAgent(agent: string | null | undefined): boolean {
  return typeof agent === 'string' && TC_CLAUDE_FAMILY_AGENTS.includes(agent)
}

export type TcHotSwapTarget = {
  /** PTY the model command would be typed into; null when none is resolvable. */
  ptyId: string | null
  /** Human label of the owning terminal tab, for "which session is this?". */
  tabTitle: string | null
  /** Agent believed to hold the pane's foreground; null when unknown/shell. */
  agent: string | null
  /** True only when the resolved pane runs a Claude-family CLI. */
  claudeFamily: boolean
}

export const NO_HOT_SWAP_TARGET: TcHotSwapTarget = {
  ptyId: null,
  tabTitle: null,
  agent: null,
  claudeFamily: false
}

export type TcHotSwapTargetState = Pick<
  AppState,
  | 'activeWorktreeId'
  | 'activeTabId'
  | 'tabsByWorktree'
  | 'terminalLayoutsByTabId'
  | 'paneForegroundAgentByPaneKey'
  | 'agentStatusByPaneKey'
>

/**
 * Best available evidence for what holds the active pane's foreground:
 * process-table identity first (it also proves a return to the shell), then
 * hook rows, then the tab's launch metadata — and that last fallback only while
 * the tab is a single pane, since `launchAgent` describes the original pane and
 * is no evidence about a split sibling.
 */
function resolvePaneAgent(
  state: TcHotSwapTargetState,
  tabId: string,
  tab: TerminalTab,
  layout: TerminalLayoutSnapshot | null | undefined,
  leafId: string | null
): string | null {
  if (leafId) {
    const paneKey = `${tabId}:${leafId}`
    const foreground = state.paneForegroundAgentByPaneKey[paneKey]
    if (foreground?.shellForeground) {
      return null
    }
    if (foreground?.agent) {
      return foreground.agent
    }
    const hooked = state.agentStatusByPaneKey[paneKey]?.agentType
    if (hooked) {
      return hooked
    }
  }
  return isNativeChatTabWideFallbackSafe(layout) ? (tab.launchAgent ?? null) : null
}

/** Resolve the pane a model swap would target, or a fully-null target. */
export function selectTeamclaudeHotSwapTarget(state: TcHotSwapTargetState): TcHotSwapTarget {
  const worktreeId = state.activeWorktreeId
  const tabId = state.activeTabId
  if (!worktreeId || !tabId) {
    return NO_HOT_SWAP_TARGET
  }
  const tab = (state.tabsByWorktree[worktreeId] ?? []).find((candidate) => candidate.id === tabId)
  if (!tab) {
    return NO_HOT_SWAP_TARGET
  }
  const layout = state.terminalLayoutsByTabId[tabId]
  const leafId = resolveNativeChatActiveLayoutLeafId(layout)
  const leafPtyId = leafId ? (layout?.ptyIdsByLeafId?.[leafId] ?? null) : null
  // Why: the tab-level ptyId belongs to the tab's original pane. Once a split
  // exists it may address a sibling, so only trust it while the tab is one pane.
  const ptyId = leafPtyId ?? (isNativeChatTabWideFallbackSafe(layout) ? tab.ptyId : null)
  const agent = resolvePaneAgent(state, tabId, tab, layout, leafId)
  return {
    ptyId,
    tabTitle: tab.customTitle ?? tab.title ?? null,
    agent,
    claudeFamily: isClaudeFamilyAgent(agent)
  }
}

/** Live view of the pane the hot-swap control would write into. */
export function useTeamclaudeHotSwapTarget(): TcHotSwapTarget {
  return useAppStore(useShallow(selectTeamclaudeHotSwapTarget))
}
