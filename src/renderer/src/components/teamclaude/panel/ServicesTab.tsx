import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { CpaActionResult, CpaLifecycle, CpaState } from '../../../../../shared/cliproxy-types'
import type { TcActivityRow, TcState } from '../../../../../shared/teamclaude-types'
import type { CliproxyControlError, CliproxyControls } from '@/hooks/useCliproxy'
import type { TeamclaudeControlError, TeamclaudeControls } from '@/hooks/useTeamclaude'
import { CpaActionNotice } from './backends/CpaActionNotice'
import { ProxyTab } from './ProxyTab'
import { ServiceCard } from './ServiceCard'

const CPA_LIFECYCLE_LABELS: Record<CpaLifecycle, { key: string; fallback: string }> = {
  probing: { key: 'cliproxy.lifecycle.probing', fallback: 'Probing' },
  adopted: { key: 'cliproxy.lifecycle.adopted', fallback: 'Adopted' },
  owned: { key: 'cliproxy.lifecycle.owned', fallback: 'Owned' },
  'setup-needed': { key: 'cliproxy.lifecycle.setupNeeded', fallback: 'Setup needed' },
  offline: { key: 'cliproxy.lifecycle.offline', fallback: 'Offline' },
  'restart-required': {
    key: 'cliproxy.lifecycle.restartRequired',
    fallback: 'Restart required'
  }
}

function CliproxyServiceCard({
  state,
  controls,
  controlError
}: {
  state: CpaState | null
  controls: CliproxyControls
  controlError: CliproxyControlError | null
}): React.JSX.Element {
  const { t } = useTranslation()
  const [actionResult, setActionResult] = useState<CpaActionResult | null>(null)
  const lifecycle = state?.lifecycle ?? 'offline'
  const label = CPA_LIFECYCLE_LABELS[lifecycle]
  const startVisible = lifecycle === 'offline' || lifecycle === 'setup-needed'
  const stopVisible = !!state?.owned && (lifecycle === 'owned' || lifecycle === 'restart-required')
  // Why: `setup-needed` covers several distinct blockers (missing binary,
  // config drift, unavailable secure storage). Hardcoding the binary-path
  // guidance for all of them told users to fix a setting that was already
  // correct, so the copy follows the reason the service actually reported.
  const setupGuidance = (): string => {
    switch (state?.reasonKey) {
      case 'cpa.reason.configDrift':
      case 'cpa.reason.configMissing':
        return t(
          'cliproxy.service.setupConfig',
          'Orca is repairing its CLIProxyAPI config — start the service to finish.'
        )
      case 'cpa.reason.secureSetupUnavailable':
        return t(
          'cliproxy.service.setupSecureStorage',
          'CLIProxyAPI setup needs OS-backed secure storage, which is unavailable.'
        )
      default:
        return t(
          'cliproxy.service.setupGuidance',
          'Set the CLIProxyAPI binary path in Settings before starting the service.'
        )
    }
  }
  const reasonSummary = controlError
    ? t('cliproxy.service.actionFailed', 'The CLIProxyAPI service action could not be completed.')
    : state?.reasonKey || lifecycle === 'setup-needed'
      ? lifecycle === 'setup-needed'
        ? setupGuidance()
        : t('cliproxy.service.attention', 'CLIProxyAPI needs attention.')
      : null
  const run = async (action: () => Promise<CpaActionResult>): Promise<void> => {
    setActionResult(await action())
  }
  return (
    <div className="space-y-2">
      <ServiceCard
        title={t('teamclaude.services.cliproxy', 'CLIProxyAPI')}
        statusLabel={t(label.key, label.fallback)}
        owned={!!state?.owned}
        ownedLabel={t('cliproxy.service.owned', 'Owned by this Orca')}
        unownedLabel={t('cliproxy.service.notOwned', 'Not owned')}
        metadata={[
          { label: t('cliproxy.service.port', 'Port'), value: state?.port ?? '—' },
          {
            label: t('cliproxy.service.version', 'Version'),
            value: state?.version ?? '—'
          }
        ]}
        reasonSummary={reasonSummary}
        reasonDetail={controlError?.message ?? state?.reasonDetail}
        restartRequired={lifecycle === 'restart-required'}
        startLabel={
          startVisible
            ? lifecycle === 'setup-needed'
              ? t('cliproxy.service.finishSetup', 'Finish setup')
              : t('cliproxy.service.start', 'Start service')
            : undefined
        }
        stopLabel={stopVisible ? t('cliproxy.service.stop', 'Stop service') : undefined}
        onStart={startVisible ? () => void run(controls.serviceStart) : undefined}
        onStop={stopVisible ? () => void run(controls.serviceStop) : undefined}
        stopConfirmation={
          stopVisible
            ? {
                title: t('cliproxy.service.stopTitle', 'Stop CLIProxyAPI?'),
                body: t(
                  'cliproxy.service.stopBody',
                  'Backend model requests will fail until the service is started again.'
                ),
                confirmLabel: t('cliproxy.service.stopConfirm', 'Stop service')
              }
            : undefined
        }
      />
      <CpaActionNotice result={actionResult} />
    </div>
  )
}

export function ServicesTab({
  state,
  activity,
  controls,
  controlError,
  cpaState,
  cpaControls,
  cpaControlError
}: {
  state: TcState | null
  activity: TcActivityRow[]
  controls: TeamclaudeControls
  controlError: TeamclaudeControlError | null
  cpaState: CpaState | null
  cpaControls: CliproxyControls
  cpaControlError: CliproxyControlError | null
}): React.JSX.Element {
  return (
    <div className="max-h-[68vh] space-y-3 overflow-y-auto pr-1 scrollbar-sleek">
      <ProxyTab state={state} activity={activity} controls={controls} controlError={controlError} />
      <CliproxyServiceCard state={cpaState} controls={cpaControls} controlError={cpaControlError} />
    </div>
  )
}
