import React from 'react'
import { useTranslation } from 'react-i18next'

import type { CpaActionResult } from '../../../../../../shared/cliproxy-types'

const ACTION_REASON_LABELS: Record<string, { key: string; fallback: string }> = {
  'port-busy': {
    key: 'cliproxy.action.portBusy',
    fallback: 'Choose another CLIProxyAPI port in Settings, or stop the process using this port.'
  },
  'callback-port-busy': {
    key: 'cliproxy.action.callbackPortBusy',
    fallback: 'Close the process using the provider callback port, then retry.'
  },
  'login-in-progress': {
    key: 'cliproxy.action.loginInProgress',
    fallback: 'Finish or cancel the existing login for this provider, then retry.'
  },
  'binary-not-found': {
    key: 'cliproxy.action.binaryNotFound',
    fallback: 'Set the CLIProxyAPI binary path in Settings before starting the service.'
  },
  'bridge-unavailable': {
    key: 'cliproxy.action.bridgeUnavailable',
    fallback: 'CLIProxyAPI controls are unavailable in this build.'
  },
  'supervisor-unavailable': {
    key: 'cliproxy.action.supervisorUnavailable',
    fallback: 'CLIProxyAPI could not finish setup — check the binary path and config below.'
  },
  'start-failed': {
    key: 'cliproxy.action.startFailed',
    fallback: 'CLIProxyAPI could not start.'
  }
}

export function CpaActionNotice({
  result,
  className
}: {
  result: CpaActionResult | null
  className?: string
}): React.JSX.Element | null {
  const { t } = useTranslation()
  if (!result || result.ok) {
    return null
  }
  const label = ACTION_REASON_LABELS[result.reason]
  return (
    <div className={className ?? 'rounded-md border border-border bg-muted/40 px-3 py-2 text-xs'}>
      <p className="font-medium text-foreground">
        {label
          ? t(label.key, label.fallback)
          : t('cliproxy.action.failed', 'The CLIProxyAPI action could not be completed.')}
      </p>
      {result.message ? (
        <p className="mt-1 break-words text-muted-foreground">{result.message}</p>
      ) : null}
    </div>
  )
}
