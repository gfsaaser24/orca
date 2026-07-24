import React from 'react'
import { Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '../../../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../../../ui/dialog'
import type { CpaOauthFlow } from '../../../../../../shared/cliproxy-types'

export function BrowserLoginPending({ onCancel }: { onCancel: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="flex items-center gap-2 rounded-md bg-muted/50 px-2 py-1.5 text-xs">
      <Loader2 className="size-3.5 animate-spin" />
      <span className="min-w-0 flex-1">
        {t('cliproxy.login.browserPending', 'Waiting for sign-in in your browser…')}
      </span>
      <Button type="button" variant="ghost" size="xs" onClick={onCancel}>
        {t('cliproxy.login.cancel', 'Cancel')}
      </Button>
    </div>
  )
}

export function DeviceLoginDialog({
  flow,
  onPoll,
  onCancel
}: {
  flow: Extract<CpaOauthFlow, { kind: 'device' }> | null
  onPoll: () => void
  onCancel: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Dialog open={flow !== null} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('cliproxy.login.deviceTitle', 'Finish device sign-in')}</DialogTitle>
          <DialogDescription>
            {t(
              'cliproxy.login.deviceDescription',
              'Open the provider page and enter this one-time code.'
            )}
          </DialogDescription>
        </DialogHeader>
        {flow ? (
          <div className="space-y-3">
            <div className="rounded-md border border-border bg-muted/40 p-3 text-center">
              <p className="text-xs text-muted-foreground">
                {t('cliproxy.login.userCode', 'User code')}
              </p>
              <p className="mt-1 font-mono text-lg font-semibold tracking-wider">
                {flow.userCode ?? t('cliproxy.login.codePending', 'Waiting for code…')}
              </p>
            </div>
            <p className="break-all text-xs text-muted-foreground">{flow.url}</p>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              {t('cliproxy.login.devicePending', 'Waiting for provider confirmation…')}
            </div>
          </div>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onCancel}>
            {t('cliproxy.login.cancel', 'Cancel')}
          </Button>
          <Button type="button" variant="outline" onClick={onPoll}>
            {t('cliproxy.login.checkStatus', 'Check status')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
