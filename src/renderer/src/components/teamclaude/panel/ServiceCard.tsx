import React, { useState } from 'react'
import { RotateCcw } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Badge } from '../../ui/badge'
import { Button } from '../../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../../ui/dialog'

export type ServiceCardMetadata = {
  label: React.ReactNode
  value: React.ReactNode
}

export type ServiceStopConfirmation = {
  title: React.ReactNode
  body: React.ReactNode
  confirmLabel: React.ReactNode
}

export function ServiceCard({
  title,
  statusLabel,
  owned,
  ownedLabel,
  unownedLabel,
  metadata,
  reasonSummary,
  reasonDetail,
  restartRequired,
  startLabel,
  stopLabel,
  onStart,
  onStop,
  stopConfirmation,
  externalNotice
}: {
  title: React.ReactNode
  statusLabel: React.ReactNode
  owned: boolean
  ownedLabel: React.ReactNode
  unownedLabel: React.ReactNode
  metadata: ServiceCardMetadata[]
  reasonSummary?: React.ReactNode
  reasonDetail?: React.ReactNode
  restartRequired?: boolean
  startLabel?: React.ReactNode
  stopLabel?: React.ReactNode
  onStart?: () => void
  onStop?: () => void
  stopConfirmation?: ServiceStopConfirmation
  externalNotice?: React.ReactNode
}): React.JSX.Element {
  const { t } = useTranslation()
  const [confirmOpen, setConfirmOpen] = useState(false)
  return (
    <section className="flex flex-col gap-3 rounded-md border border-border p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <h3 className="truncate text-sm font-semibold">{title}</h3>
          <Badge variant={owned ? 'secondary' : 'outline'}>
            {owned ? ownedLabel : unownedLabel}
          </Badge>
        </div>
        <span className="text-sm">{statusLabel}</span>
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {metadata.map((entry) => (
          <React.Fragment key={String(entry.label)}>
            <dt>{entry.label}</dt>
            <dd className="text-right text-foreground">{entry.value}</dd>
          </React.Fragment>
        ))}
      </dl>

      {restartRequired ? (
        <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs">
          <RotateCcw className="size-3.5 shrink-0" />
          <span>
            {t('teamclaude.services.restartRequired', 'Restart required to apply changes.')}
          </span>
        </div>
      ) : null}

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
        {onStart && startLabel ? (
          <Button type="button" size="sm" onClick={onStart}>
            {startLabel}
          </Button>
        ) : null}
        {onStop && stopLabel ? (
          <Button
            type="button"
            size="sm"
            variant="destructive"
            onClick={() => (stopConfirmation ? setConfirmOpen(true) : onStop())}
          >
            {stopLabel}
          </Button>
        ) : null}
        {externalNotice ? <p className="text-xs text-muted-foreground">{externalNotice}</p> : null}
      </div>

      {stopConfirmation ? (
        <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <DialogContent showCloseButton={false} className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>{stopConfirmation.title}</DialogTitle>
              <DialogDescription>{stopConfirmation.body}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setConfirmOpen(false)}>
                {t('teamclaude.services.cancel', 'Cancel')}
              </Button>
              <Button
                type="button"
                variant="destructive"
                onClick={() => {
                  setConfirmOpen(false)
                  onStop?.()
                }}
              >
                {stopConfirmation.confirmLabel}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </section>
  )
}
