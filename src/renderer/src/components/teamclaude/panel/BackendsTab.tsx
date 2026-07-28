import React, { useState } from 'react'
import { AlertTriangle, HardDrive, Link2Off, WifiOff } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '../../ui/button'
import { Input } from '../../ui/input'
import type { CpaState } from '../../../../../shared/cliproxy-types'
import type { CliproxyControls } from '@/hooks/useCliproxy'
import { cn } from '@/lib/utils'
import { formatAge } from '../teamclaude-model'
import { cpaSurfaceGates } from './backends/backend-readiness'
import { LogsSection } from './backends/LogsSection'
import { ModelsSection } from './backends/ModelsSection'
import { ProviderCards } from './backends/ProviderCards'
import { UsageSection } from './backends/UsageSection'

// Why: the "set the binary path" guidance must be actionable in place — there is
// no dedicated Settings field for it, so the setup card carries the input itself.
function BinaryPathSetup({
  controls,
  binaryPath,
  onSaveBinaryPath
}: {
  controls: CliproxyControls
  binaryPath: string
  onSaveBinaryPath: (path: string) => Promise<void>
}): React.JSX.Element {
  const { t } = useTranslation()
  const [path, setPath] = useState(binaryPath)
  const [busy, setBusy] = useState(false)
  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      await onSaveBinaryPath(path)
      if (path.trim()) {
        await controls.serviceStart()
      }
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="mt-2 flex min-w-0 items-center gap-1.5">
      <Input
        value={path}
        className="h-7 w-full min-w-0 font-mono text-xs"
        placeholder={t('cliproxy.setup.binaryPlaceholder', 'C:\\path\\to\\cli-proxy-api.exe')}
        aria-label={t('cliproxy.setup.binaryAria', 'CLIProxyAPI binary path')}
        onChange={(event) => setPath(event.target.value)}
      />
      <Button
        type="button"
        size="sm"
        className="h-7 shrink-0"
        disabled={busy || !path.trim()}
        onClick={() => void save()}
      >
        {t('cliproxy.setup.saveAndStart', 'Save & start')}
      </Button>
    </div>
  )
}

function ReadinessGuidance({
  state,
  now,
  controls,
  binaryPath,
  onSaveBinaryPath
}: {
  state: CpaState | null
  now: number
  controls: CliproxyControls
  binaryPath: string
  onSaveBinaryPath?: (path: string) => Promise<void>
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const gates = cpaSurfaceGates(state)
  if (gates.offline) {
    return (
      <div className="flex gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs">
        <WifiOff className="mt-0.5 size-3.5 shrink-0" />
        <div>
          <p className="font-medium">
            {t('cliproxy.degradation.offline', 'CLIProxyAPI is offline.')}
          </p>
          {gates.greyLastKnown && state ? (
            <p className="text-muted-foreground">
              {t('cliproxy.degradation.lastKnown', 'Showing last-known data from {{value0}} ago.', {
                value0: formatAge(Math.max(0, now - state.snapshotAt))
              })}
            </p>
          ) : null}
        </div>
      </div>
    )
  }
  if (gates.setupNeeded) {
    return (
      <div className="flex gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs">
        <HardDrive className="mt-0.5 size-3.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="font-medium">
            {t('cliproxy.degradation.setupNeeded', 'CLIProxyAPI setup is required.')}
          </p>
          <p className="text-muted-foreground">
            {t(
              'cliproxy.degradation.binaryPath',
              'Enter the CLIProxyAPI binary path below, then start the service.'
            )}
          </p>
          {onSaveBinaryPath ? (
            <BinaryPathSetup
              controls={controls}
              binaryPath={binaryPath}
              onSaveBinaryPath={onSaveBinaryPath}
            />
          ) : null}
        </div>
      </div>
    )
  }
  if (!state) {
    return null
  }
  const messages: React.ReactNode[] = []
  if (!state.readiness.modelsReady) {
    messages.push(
      <span key="models">{t('cliproxy.degradation.models', 'Model inventory is not ready.')}</span>
    )
  }
  if (!state.readiness.managementReady) {
    messages.push(
      <span key="management">
        {t('cliproxy.degradation.management', 'Provider management is unavailable.')}
      </span>
    )
  }
  if (!state.readiness.routingLinked) {
    messages.push(
      <span key="routing">
        {t(
          'cliproxy.degradation.routing',
          'Update teamclaude or reconnect routing before launching backend models.'
        )}
      </span>
    )
  }
  if (messages.length === 0) {
    return null
  }
  return (
    <div className="flex gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs">
      {state.readiness.routingLinked ? (
        <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
      ) : (
        <Link2Off className="mt-0.5 size-3.5 shrink-0" />
      )}
      <div className="flex flex-col text-muted-foreground">{messages}</div>
    </div>
  )
}

export function BackendsTab({
  state,
  controls,
  localLaunchAvailable = true,
  now = Date.now(),
  binaryPath = '',
  onSaveBinaryPath
}: {
  state: CpaState | null
  controls: CliproxyControls
  localLaunchAvailable?: boolean
  now?: number
  binaryPath?: string
  onSaveBinaryPath?: (path: string) => Promise<void>
}): React.JSX.Element {
  const { t } = useTranslation()
  const gates = cpaSurfaceGates(state)
  const accounts = state?.accounts ?? []
  const models = state?.models ?? []
  const usage = state?.usage ?? []
  return (
    <div className="max-h-[68vh] min-w-0 space-y-5 overflow-y-auto overflow-x-hidden pr-1 scrollbar-sleek">
      <ReadinessGuidance
        state={state}
        now={now}
        controls={controls}
        binaryPath={binaryPath}
        onSaveBinaryPath={onSaveBinaryPath}
      />
      <div className={cn('space-y-5', (gates.greyLastKnown || gates.setupNeeded) && 'opacity-60')}>
        <section className="space-y-2">
          <div>
            <h3 className="text-sm font-semibold">
              {t('cliproxy.providers.title', 'Provider accounts')}
            </h3>
            <p className="text-xs text-muted-foreground">
              {t(
                'cliproxy.providers.description',
                'OAuth and device accounts used by CLIProxyAPI.'
              )}
            </p>
          </div>
          <ProviderCards
            claudeDelegated={state?.claudeDelegated ?? false}
            accounts={accounts}
            models={models}
            enabled={gates.managementEnabled}
            controls={controls}
          />
        </section>
        <ModelsSection
          models={models}
          visible={gates.modelsVisible || gates.greyLastKnown}
          aliasesEnabled={gates.managementEnabled}
          routingLinked={gates.routingLinked}
          localLaunchAvailable={localLaunchAvailable}
          controls={controls}
        />
        <UsageSection usage={usage} />
        <LogsSection enabled={gates.managementEnabled} controls={controls} />
      </div>
    </div>
  )
}
