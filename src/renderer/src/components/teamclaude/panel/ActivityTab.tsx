import React, { useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useVirtualizer } from '@tanstack/react-virtual'

import { cn } from '@/lib/utils'
import type { TcActivityRow } from '../../../../../shared/teamclaude-types'
import { isActivityRowPending } from '../teamclaude-model'

// Why: the request log. Virtualized because a busy proxy produces thousands of
// rows; incomplete rows (status/duration not yet known) render with muted,
// italic "pending" styling and a live indicator instead of a status code.

const ROW_HEIGHT = 30
const OVERSCAN = 12

// Why: every track uses minmax(0,…) so the grid can compress below its natural
// width inside a narrow dialog — cells truncate instead of running off the card.
const GRID_TEMPLATE =
  'grid-cols-[minmax(0,4.5rem)_minmax(0,1.2fr)_minmax(0,1.2fr)_minmax(0,3rem)_minmax(0,3.75rem)_minmax(0,1.5fr)]'

function formatTime(at: number): string {
  const date = new Date(at)
  return date.toLocaleTimeString(undefined, { hour12: false })
}

function ActivityRowView({ row }: { row: TcActivityRow }): React.JSX.Element {
  const { t } = useTranslation()
  const pending = isActivityRowPending(row)
  const statusOk = row.status != null && row.status >= 200 && row.status < 400
  return (
    <div
      role="row"
      className={cn(
        'grid h-[30px] items-center gap-2 border-b border-border/60 px-2 text-xs',
        GRID_TEMPLATE,
        pending && 'italic text-muted-foreground'
      )}
    >
      <span role="cell" className="truncate tabular-nums text-muted-foreground">
        {formatTime(row.at)}
      </span>
      <span role="cell" className="truncate">
        {row.model ?? '—'}
      </span>
      <span role="cell" className="truncate">
        {row.account ?? '—'}
      </span>
      <span
        role="cell"
        className={cn(
          'truncate tabular-nums',
          pending
            ? 'text-sky-500'
            : statusOk
              ? 'text-emerald-600 dark:text-emerald-400'
              : 'text-red-500'
        )}
      >
        {pending ? t('teamclaude.activity.pending', 'live') : row.status}
      </span>
      <span role="cell" className="truncate tabular-nums text-muted-foreground">
        {row.durationMs == null
          ? '—'
          : t('teamclaude.activity.durationMs', '{{value0}}ms', { value0: row.durationMs })}
      </span>
      <span
        role="cell"
        className="truncate font-mono text-muted-foreground"
        title={row.path ?? undefined}
      >
        {row.path ?? '—'}
      </span>
    </div>
  )
}

// Why: retained history stays visible while the proxy is offline; a banner (not
// a blank/replaced view) tells the reader the feed is frozen. `offline` comes
// from the parent's surfaceGates so this presentational tab never touches state.
function OfflineBanner(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <p className="mb-2 rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
      {t('teamclaude.activity.offlineBanner', 'Proxy offline — showing recent activity.')}
    </p>
  )
}

export function ActivityTab({
  activity,
  offline = false
}: {
  activity: TcActivityRow[]
  offline?: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const virtualizer = useVirtualizer({
    count: activity.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: OVERSCAN,
    getItemKey: (index) => activity[index]?.key ?? index
  })

  if (activity.length === 0) {
    return (
      <div className="flex flex-col">
        {offline ? <OfflineBanner /> : null}
        <p className="py-8 text-center text-sm text-muted-foreground">
          {t('teamclaude.activity.empty', 'No activity yet.')}
        </p>
      </div>
    )
  }

  const virtualRows = virtualizer.getVirtualItems()

  return (
    <div className="flex h-[min(360px,55vh)] flex-col overflow-hidden">
      {offline ? <OfflineBanner /> : null}
      <div
        role="row"
        className={cn(
          'grid gap-2 border-b border-border bg-muted/60 px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground',
          GRID_TEMPLATE
        )}
      >
        <span role="columnheader" className="truncate">
          {t('teamclaude.activity.time', 'Time')}
        </span>
        <span role="columnheader" className="truncate">
          {t('teamclaude.activity.model', 'Model')}
        </span>
        <span role="columnheader" className="truncate">
          {t('teamclaude.activity.account', 'Account')}
        </span>
        <span role="columnheader" className="truncate">
          {t('teamclaude.activity.status', 'Status')}
        </span>
        <span role="columnheader" className="truncate">
          {t('teamclaude.activity.duration', 'Duration')}
        </span>
        <span role="columnheader" className="truncate">
          {t('teamclaude.activity.path', 'Path')}
        </span>
      </div>
      <div ref={scrollRef} role="table" className="min-h-0 flex-1 overflow-auto scrollbar-sleek">
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualRows.map((virtualRow) => {
            const row = activity[virtualRow.index]
            if (!row) {
              return null
            }
            return (
              <div
                key={virtualRow.key}
                data-index={virtualRow.index}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${virtualRow.start}px)`
                }}
              >
                <ActivityRowView row={row} />
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
