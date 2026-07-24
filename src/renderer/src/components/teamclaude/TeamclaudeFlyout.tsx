import React from 'react'
import { useTranslation } from 'react-i18next'
import { Pin, PinOff, Settings2 } from 'lucide-react'

import { cn } from '@/lib/utils'
import { Button } from '../ui/button'
import { Separator } from '../ui/separator'
import type { TcAccount, TcState } from '../../../../shared/teamclaude-types'
import type { TeamclaudeControls } from '@/hooks/useTeamclaude'
import {
  BucketBadges,
  ErrorBadge,
  QuotaBar,
  ResetCountdown,
  STATUS_LABELS,
  StateDot,
  ThrottleBadge
} from './teamclaude-atoms'
import {
  BUCKET_KEYS,
  BUCKET_LABELS,
  fleetAccounts,
  formatAge,
  surfaceGates
} from './teamclaude-model'

// Why: the expanded per-account view. Every bucket (including the Fable bucket)
// gets its own bar, reset countdown, and overage/stale badges; per-account
// throttle/error badges and a session-scoped pin control sit in the header.

function AccountBuckets({ account, now }: { account: TcAccount; now: number }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-1.5">
      {BUCKET_KEYS.map((key) => {
        const bucket = account.buckets[key]
        const label = t(BUCKET_LABELS[key].key, BUCKET_LABELS[key].fallback)
        return (
          <div key={key} className="flex items-center gap-2">
            <span className="w-14 shrink-0 text-[10px] text-muted-foreground">{label}</span>
            {bucket ? (
              <>
                <QuotaBar
                  usedPercent={bucket.usedPercent}
                  overage={bucket.overage}
                  className="flex-1"
                  label={t('teamclaude.flyout.bucketAria', '{{value0}} {{value1}} usage', {
                    value0: account.name,
                    value1: label
                  })}
                />
                <span className="w-9 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground">
                  {Math.round(bucket.usedPercent)}%
                </span>
                <span className="flex w-32 shrink-0 items-center justify-end gap-1">
                  <ResetCountdown resetsAt={bucket.resetsAt} now={now} />
                  <BucketBadges bucket={bucket} now={now} />
                </span>
              </>
            ) : (
              <span className="flex-1 text-[10px] text-muted-foreground/70">
                {t('teamclaude.flyout.noBucket', 'no data')}
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}

function AccountCard({
  account,
  controls,
  controlsEnabled,
  now
}: {
  account: TcAccount
  controls: TeamclaudeControls
  controlsEnabled: boolean
  now: number
}): React.JSX.Element {
  const { t } = useTranslation()
  const statusLabel = t(STATUS_LABELS[account.status].key, STATUS_LABELS[account.status].fallback)
  return (
    <div className="flex flex-col gap-2 py-2">
      <div className="flex items-center gap-2">
        <StateDot state={account.status} label={statusLabel} />
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{account.name}</span>
        {account.status === 'throttled' ? <ThrottleBadge /> : null}
        {account.status === 'error' ? <ErrorBadge /> : null}
        <Button
          size="icon-xs"
          variant={account.pinned ? 'secondary' : 'ghost'}
          disabled={!controlsEnabled}
          onClick={() => controls.pin(account.pinned ? null : account.id)}
          aria-label={
            account.pinned
              ? t('teamclaude.flyout.unpin', 'Unpin {{value0}}', { value0: account.name })
              : t('teamclaude.flyout.pin', 'Pin {{value0}}', { value0: account.name })
          }
        >
          {account.pinned ? <PinOff className="size-3" /> : <Pin className="size-3" />}
        </Button>
      </div>
      <AccountBuckets account={account} now={now} />
    </div>
  )
}

export type TeamclaudeFlyoutProps = {
  state: TcState | null
  controls: TeamclaudeControls
  onOpenPanel: () => void
  now?: number
  className?: string
}

export function TeamclaudeFlyout({
  state,
  controls,
  onOpenPanel,
  now = Date.now(),
  className
}: TeamclaudeFlyoutProps): React.JSX.Element {
  const { t } = useTranslation()
  const gates = surfaceGates(state)
  const accounts = fleetAccounts(state?.accounts ?? [])
  const anyPinned = accounts.some((account) => account.pinned)
  // Why (offline degradation matrix, spec §5): keep the last-known fleet on
  // screen greyed rather than blanking to a bare message, with an age stamp so
  // the reader knows how stale the numbers are. snapshotAt is the epoch of the
  // last real snapshot this state was built from.
  const showLastKnownFleet = gates.offline && accounts.length > 0
  const lastKnownAgeMs = state ? Math.max(0, now - state.snapshotAt) : 0

  const fleet = (greyed: boolean): React.JSX.Element => (
    <div className={cn('flex flex-col divide-y divide-border', greyed && 'opacity-60')}>
      {accounts.map((account) => (
        <AccountCard
          key={account.id}
          account={account}
          controls={controls}
          controlsEnabled={!greyed && gates.controlsEnabled}
          now={now}
        />
      ))}
    </div>
  )

  return (
    <div className={cn('flex w-80 flex-col gap-2 text-sm', className)}>
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t('teamclaude.flyout.title', 'TeamClaude')}
        </span>
        <Button size="xs" variant="ghost" onClick={onOpenPanel}>
          <Settings2 className="size-3" />
          {t('teamclaude.flyout.manage', 'Manage')}
        </Button>
      </div>

      {gates.adoptedDegraded ? (
        <p className="rounded-md bg-amber-500/10 px-2 py-1 text-[11px] text-amber-700 dark:text-amber-300">
          {t(
            'teamclaude.flyout.adoptedDegraded',
            'Attached to an older proxy; some usage or controls are unavailable.'
          )}
        </p>
      ) : null}

      {showLastKnownFleet ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between px-1">
            <span className="text-[10px] text-muted-foreground">
              {t('teamclaude.flyout.offline', 'The proxy is offline.')}
            </span>
            <span className="text-[10px] text-muted-foreground/80">
              {t('teamclaude.flyout.asOf', 'as of {{value0}} ago', {
                value0: formatAge(lastKnownAgeMs)
              })}
            </span>
          </div>
          {fleet(true)}
        </div>
      ) : !gates.showUsage ? (
        <p className="px-1 py-3 text-center text-xs text-muted-foreground">
          {gates.offline
            ? t('teamclaude.flyout.offline', 'The proxy is offline.')
            : gates.setupNeeded
              ? t('teamclaude.flyout.setupNeeded', 'Finish setup to see usage.')
              : t('teamclaude.flyout.usageUnavailable', 'Usage is unavailable right now.')}
        </p>
      ) : accounts.length === 0 ? (
        <p className="px-1 py-3 text-center text-xs text-muted-foreground">
          {t('teamclaude.flyout.noAccounts', 'No accounts configured.')}
        </p>
      ) : (
        fleet(false)
      )}

      {anyPinned ? (
        <>
          <Separator />
          <p className="text-[10px] text-muted-foreground">
            {t(
              'teamclaude.flyout.pinHint',
              'Pinned accounts route this session only; the pin clears when the proxy restarts.'
            )}
          </p>
        </>
      ) : null}
    </div>
  )
}
