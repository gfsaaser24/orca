import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '../../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../../ui/dialog'
import type {
  TcActivityRow,
  TcProxyLifecycle,
  TcState
} from '../../../../../shared/teamclaude-types'
import type { TeamclaudeControlError, TeamclaudeControls } from '@/hooks/useTeamclaude'
import { inFlightRequestCount, surfaceGates } from '../teamclaude-model'

// Why: proxy lifecycle surface. Distinguishes owned vs adopted supervisors,
// guides setup-needed states with the localized reason, and guards Stop behind
// a confirmation that echoes the in-flight request count back as consent. The
// IPC field stays `confirmLiveSessions` (frozen contract), but the count is a
// request-level heuristic and the copy says "in-flight requests", not sessions.

const LIFECYCLE_LABELS: Record<TcProxyLifecycle, { key: string; fallback: string }> = {
  probing: { key: 'teamclaude.lifecycle.probing', fallback: 'Probing' },
  adopted: { key: 'teamclaude.lifecycle.adopted', fallback: 'Adopted' },
  'adopted-degraded': { key: 'teamclaude.lifecycle.adoptedDegraded', fallback: 'Degraded' },
  owned: { key: 'teamclaude.lifecycle.owned', fallback: 'Owned' },
  'setup-needed': { key: 'teamclaude.lifecycle.setupNeeded', fallback: 'Setup needed' },
  offline: { key: 'teamclaude.lifecycle.offline', fallback: 'Offline' }
}

const REASON_LABELS: Record<string, { key: string; fallback: string }> = {
  'tc.reason.noConfig': {
    key: 'teamclaude.proxy.reason.noConfig',
    fallback: 'TeamClaude setup is required.'
  },
  'tc.reason.teamclaudeNotFound': {
    key: 'teamclaude.proxy.reason.notFound',
    fallback: 'TeamClaude is not installed or is not available on PATH.'
  },
  'tc.reason.shimUnresolvable': {
    key: 'teamclaude.proxy.reason.shimUnresolvable',
    fallback: 'Orca found TeamClaude but could not resolve its launcher.'
  },
  'tc.reason.noAccounts': {
    key: 'teamclaude.proxy.reason.noAccounts',
    fallback: 'TeamClaude needs at least one account before it can start.'
  },
  'tc.reason.degraded': {
    key: 'teamclaude.proxy.reason.degraded',
    fallback: 'The connected TeamClaude server is missing required capabilities.'
  },
  'tc.reason.crashed': {
    key: 'teamclaude.proxy.reason.crashed',
    fallback: 'The TeamClaude proxy stopped unexpectedly.'
  },
  'tc.reason.offline': {
    key: 'teamclaude.proxy.reason.offline',
    fallback: 'The TeamClaude proxy is offline.'
  },
  'tc.reason.adoptedLost': {
    key: 'teamclaude.proxy.reason.adoptedLost',
    fallback: 'The external TeamClaude proxy stopped responding.'
  },
  launchedUnrouted: {
    key: 'teamclaude.proxy.reason.launchedUnrouted',
    fallback: 'A Claude session was launched without TeamClaude routing.'
  }
}

const PROXY_START_REASON_LABELS: Record<
  NonNullable<TeamclaudeControlError['reason']>,
  { key: string; fallback: string }
> = {
  'no-config': {
    key: 'teamclaude.proxy.reason.noConfig',
    fallback: 'TeamClaude setup is required.'
  },
  'supervisor-unavailable': {
    key: 'teamclaude.proxy.reason.supervisorUnavailable',
    fallback: 'The TeamClaude supervisor is not ready yet.'
  },
  'start-failed': {
    key: 'teamclaude.proxy.reason.startFailed',
    fallback: 'The TeamClaude proxy could not be started.'
  }
}

function StopConfirmDialog({
  open,
  inFlight,
  onCancel,
  onConfirm
}: {
  open: boolean
  inFlight: number
  onCancel: () => void
  onConfirm: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('teamclaude.proxy.stopTitle', 'Stop the proxy?')}</DialogTitle>
          <DialogDescription>
            {inFlight > 0
              ? t(
                  'teamclaude.proxy.stopBodyInFlight',
                  'Stopping the proxy will interrupt {{value0}} in-flight request(s) currently routing through it.',
                  { value0: inFlight }
                )
              : t(
                  'teamclaude.proxy.stopBodyIdle',
                  'No requests are currently in flight through the proxy.'
                )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel}>
            {t('teamclaude.proxy.cancel', 'Cancel')}
          </Button>
          <Button type="button" variant="destructive" onClick={onConfirm}>
            {t('teamclaude.proxy.stopConfirm', 'Stop proxy')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function ProxyTab({
  state,
  activity,
  controls,
  controlError
}: {
  state: TcState | null
  activity: TcActivityRow[]
  controls: TeamclaudeControls
  controlError: TeamclaudeControlError | null
}): React.JSX.Element {
  const { t } = useTranslation()
  const gates = surfaceGates(state)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const lifecycle = state?.lifecycle ?? 'offline'
  const inFlight = inFlightRequestCount(activity)

  const label = LIFECYCLE_LABELS[lifecycle]
  const controlReasonLabel = controlError?.reason
    ? PROXY_START_REASON_LABELS[controlError.reason]
    : null
  const stateReasonLabel = state?.reasonKey ? REASON_LABELS[state.reasonKey] : null
  const reasonLabel = controlReasonLabel ?? stateReasonLabel
  const reasonSummary = controlError
    ? reasonLabel
      ? t(reasonLabel.key, reasonLabel.fallback)
      : t('teamclaude.proxy.actionFailed', 'The TeamClaude action could not be completed.')
    : reasonLabel
      ? t(reasonLabel.key, reasonLabel.fallback)
      : gates.setupNeeded
        ? t('teamclaude.proxy.setupGuidance', 'Finish TeamClaude setup to start routing.')
        : state?.reasonKey
          ? t('teamclaude.proxy.reason.generic', 'TeamClaude needs attention.')
          : null
  const reasonDetail = controlError?.message ?? state?.reasonDetail

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1 rounded-md border border-border p-3">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">
            {t('teamclaude.proxy.status', 'Proxy status')}
          </span>
          <span className="text-sm">{t(label.key, label.fallback)}</span>
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <dt>{t('teamclaude.proxy.ownership', 'Ownership')}</dt>
          <dd className="text-right text-foreground">
            {state?.owned
              ? t('teamclaude.proxy.owned', 'Owned by this Orca')
              : t('teamclaude.proxy.adopted', 'Adopted (external)')}
          </dd>
          <dt>{t('teamclaude.proxy.port', 'Port')}</dt>
          <dd className="text-right tabular-nums text-foreground">{state?.port ?? '—'}</dd>
          <dt>{t('teamclaude.proxy.serverVersion', 'Server version')}</dt>
          <dd className="text-right text-foreground">{state?.serverVersion ?? '—'}</dd>
          <dt>{t('teamclaude.proxy.inFlightRequests', 'In-flight requests')}</dt>
          <dd className="text-right tabular-nums text-foreground">{inFlight}</dd>
        </dl>
      </div>

      {reasonSummary ? (
        <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs">
          <p data-teamclaude-reason-summary className="font-medium text-foreground">
            {reasonSummary}
          </p>
          {reasonDetail ? (
            <p data-teamclaude-reason-detail className="mt-1 break-words text-muted-foreground">
              {reasonDetail}
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="flex items-center gap-2">
        {lifecycle === 'offline' || gates.setupNeeded ? (
          <Button size="sm" onClick={() => void controls.startProxy()}>
            {gates.setupNeeded
              ? t('teamclaude.proxy.finishSetup', 'Finish setup')
              : t('teamclaude.proxy.start', 'Start proxy')}
          </Button>
        ) : null}
        {(lifecycle === 'owned' || lifecycle === 'adopted' || lifecycle === 'adopted-degraded') &&
        state?.owned ? (
          <Button size="sm" variant="destructive" onClick={() => setConfirmOpen(true)}>
            {t('teamclaude.proxy.stop', 'Stop proxy')}
          </Button>
        ) : null}
        {!state?.owned && (lifecycle === 'adopted' || lifecycle === 'adopted-degraded') ? (
          <p className="text-xs text-muted-foreground">
            {t(
              'teamclaude.proxy.adoptedNoStop',
              'This proxy is managed externally and cannot be stopped from Orca.'
            )}
          </p>
        ) : null}
      </div>

      <StopConfirmDialog
        open={confirmOpen}
        inFlight={inFlight}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => {
          setConfirmOpen(false)
          void controls.stopProxy(inFlight)
        }}
      />
    </div>
  )
}
