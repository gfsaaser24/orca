import React, { useMemo, useState } from 'react'
import { Check, Copy, Save } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { Badge } from '../../../ui/badge'
import { Button } from '../../../ui/button'
import { Input } from '../../../ui/input'
import type { CpaActionResult, CpaModel } from '../../../../../../shared/cliproxy-types'
import type { CliproxyControls } from '@/hooks/useCliproxy'
import { CpaActionNotice } from './CpaActionNotice'

function AliasEditor({
  model,
  models,
  enabled,
  controls,
  onResult
}: {
  model: CpaModel
  models: CpaModel[]
  enabled: boolean
  controls: CliproxyControls
  onResult: (result: CpaActionResult) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [alias, setAlias] = useState(model.alias ?? '')
  const save = async (): Promise<void> => {
    const aliases = Object.fromEntries(
      models
        .filter((candidate) => candidate.provider === model.provider && candidate.alias)
        .map((candidate) => [candidate.id, candidate.alias as string])
    )
    if (alias.trim()) {
      aliases[model.id] = alias.trim()
    } else {
      delete aliases[model.id]
    }
    onResult(
      await controls.aliasSet({
        channel: String(model.provider),
        aliases
      })
    )
  }
  return (
    <div className="flex w-full min-w-0 items-center gap-1">
      <Input
        value={alias}
        disabled={!enabled}
        className="h-7 w-full min-w-0"
        placeholder={t('cliproxy.models.aliasPlaceholder', 'Alias')}
        aria-label={t('cliproxy.models.aliasAria', 'Global alias for {{value0}}', {
          value0: model.id
        })}
        onChange={(event) => setAlias(event.target.value)}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="shrink-0"
        disabled={!enabled}
        aria-label={t('cliproxy.models.saveAlias', 'Save alias for {{value0}}', {
          value0: model.id
        })}
        onClick={() => void save()}
      >
        <Save />
      </Button>
    </div>
  )
}

function ModelRow({
  model,
  models,
  aliasesEnabled,
  routingLinked,
  localLaunchAvailable,
  controls,
  onResult
}: {
  model: CpaModel
  models: CpaModel[]
  aliasesEnabled: boolean
  routingLinked: boolean
  localLaunchAvailable: boolean
  controls: CliproxyControls
  onResult: (result: CpaActionResult) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const copyCommand = async (): Promise<void> => {
    await navigator.clipboard.writeText(`claude --model ${model.id}`)
    toast.success(t('cliproxy.models.commandCopied', 'Launch command copied'))
  }
  return (
    <div className="grid grid-cols-[minmax(0,1.2fr)_minmax(6.5rem,0.8fr)_minmax(0,auto)] items-center gap-2 border-t border-border py-2 first:border-t-0">
      <div className="min-w-0">
        <p className="truncate font-mono text-xs">{model.id}</p>
        <p className="truncate text-[10px] text-muted-foreground">
          {model.provider}
          {model.displayName ? ` · ${model.displayName}` : ''}
        </p>
      </div>
      <AliasEditor
        model={model}
        models={models}
        enabled={aliasesEnabled}
        controls={controls}
        onResult={onResult}
      />
      <div className="flex min-w-0 items-center justify-end gap-1">
        <Badge
          variant={routingLinked && model.routable ? 'secondary' : 'outline'}
          className="min-w-0 max-w-36"
        >
          <span className="truncate">
            {routingLinked
              ? model.routable
                ? t('cliproxy.models.routable', 'Routable')
                : t('cliproxy.models.notRoutable', 'Not routable')
              : t('cliproxy.models.routingUnavailable', 'Routing unavailable')}
          </span>
        </Badge>
        {localLaunchAvailable ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="shrink-0"
            aria-label={t('cliproxy.models.copyCommand', 'Copy launch command for {{value0}}', {
              value0: model.id
            })}
            onClick={() => void copyCommand()}
          >
            <Copy />
          </Button>
        ) : null}
      </div>
    </div>
  )
}

export function ModelsSection({
  models,
  visible,
  aliasesEnabled,
  routingLinked,
  localLaunchAvailable,
  controls
}: {
  models: CpaModel[]
  visible: boolean
  aliasesEnabled: boolean
  routingLinked: boolean
  localLaunchAvailable: boolean
  controls: CliproxyControls
}): React.JSX.Element {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [actionResult, setActionResult] = useState<CpaActionResult | null>(null)
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    if (!needle) {
      return models
    }
    return models.filter((model) =>
      [model.id, model.provider, model.alias ?? ''].some((value) =>
        String(value).toLocaleLowerCase().includes(needle)
      )
    )
  }, [models, query])

  return (
    <section className="space-y-2">
      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold">{t('cliproxy.models.title', 'Models')}</h3>
          <p className="truncate text-xs text-muted-foreground">
            <Check className="mr-1 inline size-3" />
            {t('cliproxy.models.globalAliases', 'Global aliases')}
            {localLaunchAvailable
              ? ` · ${t('cliproxy.models.localHint', 'Launch commands are for local sessions.')}`
              : ''}
          </p>
        </div>
        <Input
          type="search"
          value={query}
          className="h-8 w-40 min-w-24 shrink sm:w-56"
          placeholder={t('cliproxy.models.search', 'Search models')}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      {!visible ? (
        <p className="rounded-md bg-muted/40 p-3 text-xs text-muted-foreground">
          {t('cliproxy.models.unavailable', 'Model inventory is unavailable right now.')}
        </p>
      ) : filtered.length === 0 ? (
        <p className="rounded-md border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
          {query
            ? t('cliproxy.models.noMatches', 'No models match this search.')
            : t(
                'cliproxy.models.empty',
                'No models discovered yet. Add a provider account to begin.'
              )}
        </p>
      ) : (
        <div className="rounded-md border border-border px-3">
          {filtered.map((model) => (
            <ModelRow
              key={`${model.provider}:${model.id}`}
              model={model}
              models={models}
              aliasesEnabled={aliasesEnabled}
              routingLinked={routingLinked}
              localLaunchAvailable={localLaunchAvailable}
              controls={controls}
              onResult={setActionResult}
            />
          ))}
        </div>
      )}
      <CpaActionNotice result={actionResult} />
    </section>
  )
}
