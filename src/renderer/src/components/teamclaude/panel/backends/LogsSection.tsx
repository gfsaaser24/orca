import React, { useState } from 'react'
import { ChevronDown, Loader2, RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '../../../ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../../../ui/collapsible'
import type { CliproxyControls } from '@/hooks/useCliproxy'

export function LogsSection({
  enabled,
  controls
}: {
  enabled: boolean
  controls: CliproxyControls
}): React.JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [lines, setLines] = useState<string[]>([])
  const [cursor, setCursor] = useState<string | null>(null)

  const load = async (): Promise<void> => {
    if (!enabled || loading) {
      return
    }
    setLoading(true)
    const next = await controls.logsTail(cursor)
    setLines((current) => [...current, ...next.lines].slice(-500))
    setCursor(next.nextCursor)
    setLoaded(true)
    setLoading(false)
  }

  return (
    <Collapsible
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next && !loaded) {
          void load()
        }
      }}
      className="rounded-md border border-border"
    >
      <div className="flex items-center justify-between px-3 py-2">
        <CollapsibleTrigger asChild>
          <Button type="button" variant="ghost" size="sm" className="-ml-2">
            <ChevronDown
              className={open ? 'rotate-180 transition-transform' : 'transition-transform'}
            />
            {t('cliproxy.logs.title', 'Service logs')}
          </Button>
        </CollapsibleTrigger>
        {open ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            disabled={!enabled || loading}
            aria-label={t('cliproxy.logs.refresh', 'Load newer log lines')}
            onClick={() => void load()}
          >
            {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          </Button>
        ) : null}
      </div>
      <CollapsibleContent>
        <div className="border-t border-border p-3">
          <p className="mb-2 text-[10px] text-muted-foreground">
            {t('cliproxy.logs.mainOnly', 'CLIProxyAPI main log only')}
          </p>
          {lines.length > 0 ? (
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted/50 p-2 font-mono text-[10px] scrollbar-editor">
              {lines.join('\n')}
            </pre>
          ) : (
            <p className="text-xs text-muted-foreground">
              {enabled
                ? loaded
                  ? t('cliproxy.logs.empty', 'No log lines returned.')
                  : t('cliproxy.logs.loading', 'Loading logs…')
                : t(
                    'cliproxy.logs.unavailable',
                    'Logs are unavailable while management is offline.'
                  )}
            </p>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
