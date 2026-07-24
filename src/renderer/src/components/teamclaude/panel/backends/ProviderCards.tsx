import React, { useCallback, useEffect, useState } from 'react'
import { Loader2, Plus } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { Badge } from '../../../ui/badge'
import { Button } from '../../../ui/button'
import { Checkbox } from '../../../ui/checkbox'
import { Input } from '../../../ui/input'
import { Label } from '../../../ui/label'
import type {
  CpaAccount,
  CpaActionResult,
  CpaModel,
  CpaOauthFlow,
  CpaProviderKind
} from '../../../../../../shared/cliproxy-types'
import type { CliproxyControls } from '@/hooks/useCliproxy'
import { CpaActionNotice } from './CpaActionNotice'
import {
  accountsForFamily,
  OAUTH_PROVIDER_FAMILIES,
  type ProviderFamily
} from './backend-readiness'
import { BrowserLoginPending, DeviceLoginDialog } from './ProviderLoginFlow'

type ActiveFlow = {
  provider: CpaProviderKind
  flow: CpaOauthFlow
  initialModelCount: number
}

const ADD_LABELS: Partial<Record<CpaProviderKind, { key: string; fallback: string }>> = {
  gemini: { key: 'cliproxy.providers.addGemini', fallback: 'Add Gemini CLI' },
  antigravity: { key: 'cliproxy.providers.addAntigravity', fallback: 'Add Antigravity' }
}

function AccountRow({
  account,
  enabled,
  controls,
  onResult
}: {
  account: CpaAccount
  enabled: boolean
  controls: CliproxyControls
  onResult: (result: CpaActionResult) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const status =
    account.disabled || account.unavailable ? 'offline' : account.cooling ? 'cooling' : 'ready'
  const statusLabel =
    status === 'ready'
      ? t('cliproxy.accounts.ready', 'Ready')
      : status === 'cooling'
        ? t('cliproxy.accounts.cooling', 'Cooling')
        : t('cliproxy.accounts.unavailable', 'Unavailable')
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 border-t border-border py-2 first:border-t-0">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span
            role="img"
            aria-label={statusLabel}
            className={
              status === 'ready'
                ? 'size-1.5 rounded-full bg-emerald-500'
                : status === 'cooling'
                  ? 'size-1.5 rounded-full bg-amber-500'
                  : 'size-1.5 rounded-full bg-neutral-500/40'
            }
          />
          <span className="truncate text-sm font-medium">{account.label}</span>
          {account.cooling ? (
            <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
              {t('cliproxy.accounts.cooling', 'Cooling')}
            </Badge>
          ) : null}
        </div>
        {account.email ? (
          <p className="truncate pl-3.5 text-xs text-muted-foreground">{account.email}</p>
        ) : null}
        <p className="pl-3.5 text-[10px] text-muted-foreground">
          {t('cliproxy.accounts.recentAccounting', '{{value0}} success · {{value1}} failed', {
            value0: account.recentSuccess ?? '—',
            value1: account.recentFailure ?? '—'
          })}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1">
          <Label
            htmlFor={`cpa-priority-${account.name}`}
            className="text-[10px] text-muted-foreground"
          >
            {t('cliproxy.accounts.priority', 'Priority')}
          </Label>
          <Input
            id={`cpa-priority-${account.name}`}
            type="number"
            defaultValue={account.priority ?? ''}
            disabled={!enabled}
            className="h-7 w-16"
            onBlur={(event) => {
              const priority = Number.parseInt(event.target.value, 10)
              if (!Number.isNaN(priority)) {
                void controls.accountSetFields({ name: account.name, priority }).then(onResult)
              }
            }}
          />
        </div>
        <label className="flex items-center gap-1 text-xs text-muted-foreground">
          <Checkbox
            checked={!account.disabled}
            disabled={!enabled}
            onCheckedChange={(checked) =>
              void controls
                .accountSetDisabled({ name: account.name, disabled: checked !== true })
                .then(onResult)
            }
            aria-label={t('cliproxy.accounts.enabledAria', 'Enable {{value0}}', {
              value0: account.label
            })}
          />
          {t('cliproxy.accounts.enabled', 'Enabled')}
        </label>
      </div>
    </div>
  )
}

function ProviderCard({
  family,
  accounts,
  enabled,
  busyProvider,
  activeFlow,
  controls,
  onStart,
  onCancel,
  onResult
}: {
  family: ProviderFamily
  accounts: CpaAccount[]
  enabled: boolean
  busyProvider: CpaProviderKind | null
  activeFlow: ActiveFlow | null
  controls: CliproxyControls
  onStart: (provider: CpaProviderKind) => void
  onCancel: () => void
  onResult: (result: CpaActionResult) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const pendingHere = activeFlow && family.providers.includes(activeFlow.provider)
  return (
    <section className="rounded-md border border-border p-3">
      {/* Wrap-aware header: two-provider families (Gemini / Antigravity) carry
          two Add buttons that cannot fit beside the title in a half-width card,
          so the button cluster flows to its own line instead of overlapping. */}
      <div className="mb-2 flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={
              accounts.length > 0
                ? 'size-1.5 shrink-0 rounded-full bg-emerald-500'
                : 'size-1.5 shrink-0 rounded-full bg-neutral-500/40'
            }
          />
          <h4 className="truncate text-sm font-medium">
            {t(family.labelKey, family.labelFallback)}
          </h4>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-1">
          {family.providers.map((provider) => {
            const label = ADD_LABELS[provider]
            return (
              <Button
                key={provider}
                type="button"
                variant="outline"
                size="xs"
                className="shrink-0"
                disabled={!enabled || busyProvider !== null || activeFlow !== null}
                onClick={() => onStart(provider)}
              >
                {busyProvider === provider ? <Loader2 className="animate-spin" /> : <Plus />}
                {label
                  ? t(label.key, label.fallback)
                  : t('cliproxy.providers.addAccount', 'Add account')}
              </Button>
            )
          })}
        </div>
      </div>
      {accounts.length === 0 ? (
        <p className="py-2 text-xs text-muted-foreground">
          {t('cliproxy.providers.empty', 'No accounts connected.')}
        </p>
      ) : (
        accounts.map((account) => (
          <AccountRow
            key={account.name}
            account={account}
            enabled={enabled}
            controls={controls}
            onResult={onResult}
          />
        ))
      )}
      {pendingHere && activeFlow.flow.kind === 'browser' ? (
        <BrowserLoginPending onCancel={onCancel} />
      ) : null}
    </section>
  )
}

function ManagedOutsideRows({ models }: { models: CpaModel[] }): React.JSX.Element | null {
  const { t } = useTranslation()
  const providers = ['api-key', 'openai-compat'].filter((provider) =>
    models.some((model) => model.provider === provider)
  )
  if (providers.length === 0) {
    return null
  }
  return (
    <section className="rounded-md border border-border p-3">
      <h4 className="text-sm font-medium">
        {t('cliproxy.providers.externalTitle', 'API-key providers')}
      </h4>
      {providers.map((provider) => (
        <div key={provider} className="mt-2 flex items-center justify-between text-xs">
          <span>
            {provider === 'api-key'
              ? t('cliproxy.providers.apiKey', 'API key')
              : t('cliproxy.providers.openaiCompatible', 'OpenAI compatible')}
          </span>
          <span className="text-muted-foreground">
            {t('cliproxy.providers.managedOutside', 'Managed outside Orca (v2)')}
          </span>
        </div>
      ))}
    </section>
  )
}

export function ProviderCards({
  accounts,
  models,
  enabled,
  controls
}: {
  accounts: CpaAccount[]
  models: CpaModel[]
  enabled: boolean
  controls: CliproxyControls
}): React.JSX.Element {
  const { t } = useTranslation()
  const [activeFlow, setActiveFlow] = useState<ActiveFlow | null>(null)
  const [busyProvider, setBusyProvider] = useState<CpaProviderKind | null>(null)
  const [actionResult, setActionResult] = useState<CpaActionResult | null>(null)

  const pollActive = useCallback(async (): Promise<void> => {
    if (!activeFlow) {
      return
    }
    const status = await controls.loginPoll(activeFlow.flow.state)
    if (status === 'ok') {
      toast.success(
        t('cliproxy.login.success', '{{value0}} new models routable', {
          value0: Math.max(0, models.length - activeFlow.initialModelCount)
        })
      )
      setActiveFlow(null)
    } else if (status === 'error' || status === 'cancelled') {
      setActionResult({ ok: false, reason: 'login-failed', message: '' })
      setActiveFlow(null)
    }
  }, [activeFlow, controls, models.length, t])

  useEffect(() => {
    if (!activeFlow) {
      return
    }
    const timer = window.setInterval(() => void pollActive(), 1_500)
    return () => window.clearInterval(timer)
  }, [activeFlow, pollActive])

  const start = async (provider: CpaProviderKind): Promise<void> => {
    setActionResult(null)
    setBusyProvider(provider)
    const result = await controls.loginStart(provider)
    setBusyProvider(null)
    if ('ok' in result) {
      setActionResult(result)
      return
    }
    setActiveFlow({ provider, flow: result, initialModelCount: models.length })
  }

  const cancel = async (): Promise<void> => {
    if (!activeFlow) {
      return
    }
    const result = await controls.loginCancel(activeFlow.flow.state)
    if (!result.ok) {
      setActionResult(result)
    }
    setActiveFlow(null)
  }

  return (
    <div className="space-y-2">
      <div className="grid gap-2 sm:grid-cols-2">
        {OAUTH_PROVIDER_FAMILIES.map((family) => (
          <ProviderCard
            key={family.id}
            family={family}
            accounts={accountsForFamily(accounts, family)}
            enabled={enabled}
            busyProvider={busyProvider}
            activeFlow={activeFlow}
            controls={controls}
            onStart={(provider) => void start(provider)}
            onCancel={() => void cancel()}
            onResult={setActionResult}
          />
        ))}
      </div>
      <ManagedOutsideRows models={models} />
      <CpaActionNotice result={actionResult} />
      <DeviceLoginDialog
        flow={activeFlow?.flow.kind === 'device' ? activeFlow.flow : null}
        onPoll={() => void pollActive()}
        onCancel={() => void cancel()}
      />
    </div>
  )
}
