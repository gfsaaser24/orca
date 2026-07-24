import React from 'react'
import { useTranslation } from 'react-i18next'

import type {
  TcActivityRow,
  TcProxyLifecycle,
  TcState
} from '../../../../../shared/teamclaude-types'
import type { TeamclaudeControlError, TeamclaudeControls } from '@/hooks/useTeamclaude'
import { ServiceCard } from './ServiceCard'
import { inFlightRequestCount, surfaceGates } from '../teamclaude-model'

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
  const active =
    lifecycle === 'owned' || lifecycle === 'adopted' || lifecycle === 'adopted-degraded'
  const startVisible = lifecycle === 'offline' || gates.setupNeeded
  const stopVisible = active && !!state?.owned
  const stopBody =
    inFlight > 0
      ? t(
          'teamclaude.proxy.stopBodyInFlight',
          'Stopping the proxy will interrupt {{value0}} in-flight request(s) currently routing through it.',
          { value0: inFlight }
        )
      : t('teamclaude.proxy.stopBodyIdle', 'No requests are currently in flight through the proxy.')

  return (
    <ServiceCard
      title={t('teamclaude.services.teamclaude', 'TeamClaude')}
      statusLabel={t(label.key, label.fallback)}
      owned={!!state?.owned}
      ownedLabel={t('teamclaude.proxy.owned', 'Owned by this Orca')}
      unownedLabel={t('teamclaude.proxy.adopted', 'Adopted (external)')}
      metadata={[
        { label: t('teamclaude.proxy.port', 'Port'), value: state?.port ?? '—' },
        {
          label: t('teamclaude.proxy.serverVersion', 'Server version'),
          value: state?.serverVersion ?? '—'
        },
        {
          label: t('teamclaude.proxy.inFlightRequests', 'In-flight requests'),
          value: inFlight
        }
      ]}
      reasonSummary={reasonSummary}
      reasonDetail={reasonDetail}
      startLabel={
        startVisible
          ? gates.setupNeeded
            ? t('teamclaude.proxy.finishSetup', 'Finish setup')
            : t('teamclaude.proxy.start', 'Start proxy')
          : undefined
      }
      stopLabel={stopVisible ? t('teamclaude.proxy.stop', 'Stop proxy') : undefined}
      onStart={startVisible ? () => void controls.startProxy() : undefined}
      onStop={stopVisible ? () => void controls.stopProxy(inFlight) : undefined}
      stopConfirmation={
        stopVisible
          ? {
              title: t('teamclaude.proxy.stopTitle', 'Stop the proxy?'),
              body: stopBody,
              confirmLabel: t('teamclaude.proxy.stopConfirm', 'Stop proxy')
            }
          : undefined
      }
      externalNotice={
        !state?.owned && active
          ? t(
              'teamclaude.proxy.adoptedNoStop',
              'This proxy is managed externally and cannot be stopped from Orca.'
            )
          : undefined
      }
    />
  )
}
