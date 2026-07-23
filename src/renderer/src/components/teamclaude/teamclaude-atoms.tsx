import React from 'react'
import { useTranslation } from 'react-i18next'

import { cn } from '@/lib/utils'
import { Badge } from '../ui/badge'
import type {
  TcAccount,
  TcProxyLifecycle,
  TcQuotaBucket
} from '../../../../shared/teamclaude-types'
import { formatAge, formatCountdown, isBucketStale, resetCountdownMs } from './teamclaude-model'

// Why: presentational atoms shared by the widget, flyout, and panel so the
// state vocabulary (dot colors, bar thresholds, badge set) is defined once.

/** Map an account status to the ambient dot color state. */
export type TcDotState = TcAccount['status']

/** Localization key + English fallback for each account status. */
export const STATUS_LABELS: Record<TcDotState, { key: string; fallback: string }> = {
  active: { key: 'teamclaude.status.active', fallback: 'Active' },
  throttled: { key: 'teamclaude.status.throttled', fallback: 'Throttled' },
  exhausted: { key: 'teamclaude.status.exhausted', fallback: 'Exhausted' },
  error: { key: 'teamclaude.status.error', fallback: 'Error' },
  disabled: { key: 'teamclaude.status.disabled', fallback: 'Disabled' }
}

function dotColor(state: TcDotState): string {
  switch (state) {
    case 'active':
      return 'bg-emerald-500'
    case 'throttled':
      return 'bg-amber-500'
    case 'exhausted':
      return 'bg-red-500'
    case 'error':
      return 'bg-red-500'
    case 'disabled':
      return 'bg-neutral-500/40'
  }
}

/** Lifecycle → dot color for the proxy/connection indicator on the widget. */
export function lifecycleDotColor(lifecycle: TcProxyLifecycle): string {
  switch (lifecycle) {
    case 'owned':
    case 'adopted':
      return 'bg-emerald-500'
    case 'adopted-degraded':
      return 'bg-amber-500'
    case 'probing':
      return 'bg-sky-500'
    case 'setup-needed':
      return 'bg-amber-500'
    case 'offline':
      return 'bg-neutral-500/40'
  }
}

export function StateDot({
  state,
  label,
  className
}: {
  state: TcDotState
  label: string
  className?: string
}): React.JSX.Element {
  return (
    <span
      className={cn('inline-flex size-2.5 shrink-0 items-center justify-center', className)}
      role="img"
      aria-label={label}
    >
      <span className={cn('block size-1.5 rounded-full', dotColor(state))} />
    </span>
  )
}

/** Color the fill by proximity to the limit. */
function barFill(usedPercent: number): string {
  if (usedPercent >= 95) {
    return 'bg-red-500'
  }
  if (usedPercent >= 80) {
    return 'bg-amber-500'
  }
  return 'bg-emerald-500'
}

/** Compact quota bar with clamped fill; overage widens the visual to full. */
export function QuotaBar({
  usedPercent,
  overage,
  className,
  label
}: {
  usedPercent: number
  overage?: boolean
  className?: string
  label?: string
}): React.JSX.Element {
  const clamped = Math.max(0, Math.min(100, usedPercent))
  return (
    <div
      className={cn('h-1.5 w-full overflow-hidden rounded-full bg-primary/15', className)}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped)}
      aria-label={label}
    >
      <div
        className={cn('h-full rounded-full transition-[width] duration-300', barFill(usedPercent))}
        style={{ width: `${overage ? 100 : clamped}%` }}
      />
    </div>
  )
}

export function OverageBadge(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Badge variant="destructive" className="px-1.5 py-0 text-[10px]">
      {t('teamclaude.badge.overage', 'Over')}
    </Badge>
  )
}

export function StaleBadge({ ageMs }: { ageMs: number | null }): React.JSX.Element {
  const { t } = useTranslation()
  const suffix = ageMs == null ? '' : ` ${formatAge(ageMs)}`
  return (
    <Badge variant="outline" className="px-1.5 py-0 text-[10px] text-muted-foreground">
      {t('teamclaude.badge.stale', 'Stale')}
      {suffix}
    </Badge>
  )
}

export function ThrottleBadge(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Badge
      variant="outline"
      className="border-amber-500/40 px-1.5 py-0 text-[10px] text-amber-600 dark:text-amber-400"
    >
      {t('teamclaude.badge.throttled', 'Throttled')}
    </Badge>
  )
}

export function ErrorBadge(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Badge variant="destructive" className="px-1.5 py-0 text-[10px]">
      {t('teamclaude.badge.error', 'Error')}
    </Badge>
  )
}

/**
 * Render the status-driven badges (throttle/error) plus quota-derived badges
 * (overage/stale) for a single bucket, in a stable order.
 */
export function BucketBadges({
  bucket,
  now
}: {
  bucket: TcQuotaBucket
  now: number
}): React.JSX.Element | null {
  const stale = isBucketStale(bucket, now)
  if (!bucket.overage && !stale) {
    return null
  }
  const ageMs = bucket.observedAt == null ? null : now - bucket.observedAt
  return (
    <span className="inline-flex items-center gap-1">
      {bucket.overage ? <OverageBadge /> : null}
      {stale ? <StaleBadge ageMs={ageMs} /> : null}
    </span>
  )
}

/** Reset countdown label, e.g. "resets in 2h 5m". Null when reset unknown. */
export function ResetCountdown({
  resetsAt,
  now
}: {
  resetsAt: number | null
  now: number
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const remaining = resetCountdownMs(resetsAt, now)
  if (remaining == null) {
    return null
  }
  return (
    <span className="text-[10px] tabular-nums text-muted-foreground">
      {t('teamclaude.resetsIn', 'resets in {{value0}}', { value0: formatCountdown(remaining) })}
    </span>
  )
}
