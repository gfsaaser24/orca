import React from 'react'
import { useTranslation } from 'react-i18next'
import { Pin, PinOff } from 'lucide-react'

import { Button } from '../../ui/button'
import { Input } from '../../ui/input'
import { Label } from '../../ui/label'
import { Checkbox } from '../../ui/checkbox'
import type { TcAccount, TcState } from '../../../../../shared/teamclaude-types'
import type { TeamclaudeControls } from '@/hooks/useTeamclaude'
import { ErrorBadge, STATUS_LABELS, StateDot, ThrottleBadge } from '../teamclaude-atoms'
import { surfaceGates } from '../teamclaude-model'

// Why: account administration — pin, disable, and priority. All mutations flow
// through the injected controls (tc:pin / tc:account:set) and are disabled when
// the control surface is not ready (never gated on raw transport).

function AccountRow({
  account,
  controls,
  enabled
}: {
  account: TcAccount
  controls: TeamclaudeControls
  enabled: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const disabled = account.status === 'disabled'
  const statusLabel = t(STATUS_LABELS[account.status].key, STATUS_LABELS[account.status].fallback)
  return (
    <div className="flex items-center gap-3 border-b border-border py-2 last:border-b-0">
      <StateDot state={account.status} label={statusLabel} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{account.name}</span>
          {account.status === 'throttled' ? <ThrottleBadge /> : null}
          {account.status === 'error' ? <ErrorBadge /> : null}
        </div>
        {account.email ? (
          <span className="truncate text-xs text-muted-foreground">{account.email}</span>
        ) : null}
      </div>

      <div className="flex items-center gap-1.5">
        <Label htmlFor={`tc-priority-${account.id}`} className="text-xs text-muted-foreground">
          {t('teamclaude.accounts.priority', 'Priority')}
        </Label>
        <Input
          id={`tc-priority-${account.id}`}
          type="number"
          value={account.priority}
          disabled={!enabled}
          className="h-7 w-16"
          onChange={(event) => {
            const priority = Number.parseInt(event.target.value, 10)
            if (!Number.isNaN(priority)) {
              controls.setAccount({ id: account.id, priority })
            }
          }}
        />
      </div>

      <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Checkbox
          checked={disabled}
          disabled={!enabled}
          onCheckedChange={(checked) =>
            controls.setAccount({ id: account.id, disabled: checked === true })
          }
          aria-label={t('teamclaude.accounts.disable', 'Disable {{value0}}', {
            value0: account.name
          })}
        />
        {t('teamclaude.accounts.disabled', 'Disabled')}
      </label>

      <Button
        size="icon-sm"
        variant={account.pinned ? 'secondary' : 'ghost'}
        disabled={!enabled}
        onClick={() => controls.pin(account.pinned ? null : account.id)}
        aria-label={
          account.pinned
            ? t('teamclaude.flyout.unpin', 'Unpin {{value0}}', { value0: account.name })
            : t('teamclaude.flyout.pin', 'Pin {{value0}}', { value0: account.name })
        }
      >
        {account.pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
      </Button>
    </div>
  )
}

export function AccountsTab({
  state,
  controls
}: {
  state: TcState | null
  controls: TeamclaudeControls
}): React.JSX.Element {
  const { t } = useTranslation()
  const gates = surfaceGates(state)
  const accounts = state?.accounts ?? []

  if (accounts.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        {t('teamclaude.accounts.empty', 'No accounts configured.')}
      </p>
    )
  }

  return (
    <div className="flex flex-col">
      {!gates.controlsEnabled ? (
        <p className="mb-2 rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">
          {t('teamclaude.accounts.readOnly', 'Account controls are unavailable in this state.')}
        </p>
      ) : null}
      {accounts.map((account) => (
        <AccountRow
          key={account.id}
          account={account}
          controls={controls}
          enabled={gates.controlsEnabled}
        />
      ))}
    </div>
  )
}
