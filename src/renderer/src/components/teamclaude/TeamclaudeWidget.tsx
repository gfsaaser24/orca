import React from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle } from 'lucide-react'

import { cn } from '@/lib/utils'
import type { TcState } from '../../../../shared/teamclaude-types'
import { QuotaBar, STATUS_LABELS, StateDot, lifecycleDotColor } from './teamclaude-atoms'
import { hasLaunchedUnrouted, primaryAccount, surfaceGates, worstBucket } from './teamclaude-model'

// Why: the compact ambient indicator. Shows the primary account name, its
// worst-bucket bar, and a state dot — degrading to a connection-state label
// when usage is not ready (never gated on raw transport; see surfaceGates).

/** Chip warning that a Claude CLI was launched without proxy routing. */
function UnroutedChip(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400"
      title={t(
        'teamclaude.widget.unroutedHint',
        'A Claude session is running without proxy routing.'
      )}
    >
      <AlertTriangle className="size-2.5" aria-hidden="true" />
      {t('teamclaude.widget.unrouted', 'Unrouted')}
    </span>
  )
}

export type TeamclaudeWidgetProps = {
  state: TcState | null
  onClick?: () => void
  className?: string
}

export const TeamclaudeWidget = React.forwardRef<HTMLButtonElement, TeamclaudeWidgetProps>(
  function TeamclaudeWidget({ state, onClick, className }, ref): React.JSX.Element {
    const { t } = useTranslation()
    const gates = surfaceGates(state)
    const account = primaryAccount(state)
    const worst = account ? worstBucket(account) : null

    const statusLabel = gates.offline
      ? t('teamclaude.lifecycle.offline', 'Offline')
      : gates.setupNeeded
        ? t('teamclaude.lifecycle.setupNeeded', 'Setup needed')
        : gates.adoptedDegraded
          ? t('teamclaude.lifecycle.adoptedDegraded', 'Degraded')
          : t('teamclaude.widget.connecting', 'Connecting…')

    return (
      <button
        ref={ref}
        type="button"
        onClick={onClick}
        className={cn(
          'inline-flex items-center gap-2 rounded-md border border-border bg-background/80 px-2 py-1 text-xs shadow-xs transition-colors hover:bg-accent',
          className
        )}
        aria-label={t('teamclaude.widget.label', 'TeamClaude usage')}
      >
        <span
          className={cn(
            'inline-flex size-2 shrink-0 rounded-full',
            state ? lifecycleDotColor(state.lifecycle) : 'bg-neutral-500/40'
          )}
          aria-hidden="true"
        />
        {gates.showUsage && account ? (
          <span className="flex min-w-0 items-center gap-2">
            <span className="max-w-[10rem] truncate font-medium">{account.name}</span>
            {worst ? (
              <span className="flex w-16 items-center gap-1">
                <QuotaBar
                  usedPercent={worst.bucket.usedPercent}
                  overage={worst.bucket.overage}
                  label={t('teamclaude.widget.worstBucketLabel', '{{value0}} usage', {
                    value0: account.name
                  })}
                />
                <span className="tabular-nums text-muted-foreground">
                  {Math.round(worst.bucket.usedPercent)}%
                </span>
              </span>
            ) : null}
            <StateDot
              state={account.status}
              label={t(STATUS_LABELS[account.status].key, STATUS_LABELS[account.status].fallback)}
            />
          </span>
        ) : (
          <span className="text-muted-foreground">{statusLabel}</span>
        )}
        {hasLaunchedUnrouted(state) ? <UnroutedChip /> : null}
      </button>
    )
  }
)
