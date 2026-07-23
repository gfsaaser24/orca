import { ipcMain } from 'electron'
import type { ClaudeAccountAddTarget, ClaudeAccountService } from '../claude-accounts/service'
import type { ClaudeAccountSelectionTarget } from '../claude-accounts/runtime-selection'
import { getTeamclaudeUsageSnapshot } from '../teamclaude/init'

export const CLAUDE_ACCOUNTS_MANAGED_BY_TEAMCLAUDE =
  'CLAUDE_ACCOUNTS_MANAGED_BY_TEAMCLAUDE' as const

export class ClaudeAccountsManagedByTeamclaudeError extends Error {
  readonly code = CLAUDE_ACCOUNTS_MANAGED_BY_TEAMCLAUDE

  constructor() {
    super('Claude accounts are managed by TeamClaude while its proxy is connected.')
    this.name = 'ClaudeAccountsManagedByTeamclaudeError'
  }
}

function assertNativeClaudeAuthAllowed(): void {
  if (getTeamclaudeUsageSnapshot().connected) {
    throw new ClaudeAccountsManagedByTeamclaudeError()
  }
}

export function registerClaudeAccountHandlers(claudeAccounts: ClaudeAccountService): void {
  ipcMain.handle('claudeAccounts:list', () => claudeAccounts.listAccounts())
  ipcMain.handle('claudeAccounts:add', (_event, args?: ClaudeAccountAddTarget) => {
    assertNativeClaudeAuthAllowed()
    return claudeAccounts.addAccount(args)
  })
  ipcMain.handle('claudeAccounts:cancelPendingLogin', () => claudeAccounts.cancelPendingLogin())
  ipcMain.handle('claudeAccounts:reauthenticate', (_event, args: { accountId: string }) => {
    assertNativeClaudeAuthAllowed()
    return claudeAccounts.reauthenticateAccount(args.accountId)
  })
  ipcMain.handle('claudeAccounts:remove', (_event, args: { accountId: string }) =>
    claudeAccounts.removeAccount(args.accountId)
  )
  ipcMain.handle(
    'claudeAccounts:select',
    (_event, args: { accountId: string | null } & ClaudeAccountSelectionTarget) => {
      assertNativeClaudeAuthAllowed()
      if (!args.runtime) {
        return claudeAccounts.selectAccount(args.accountId)
      }
      return claudeAccounts.selectAccountForTarget(args.accountId, args)
    }
  )
}
