import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Trash2 } from 'lucide-react'

import { Button } from '../../ui/button'
import { Input } from '../../ui/input'
import { Label } from '../../ui/label'
import type { TcRoute, TcState } from '../../../../../shared/teamclaude-types'
import type { TeamclaudeControls } from '@/hooks/useTeamclaude'
import { surfaceGates, TC_MIN_SERVER_VERSION } from '../teamclaude-model'

// Why: the glob→accounts routing editor. Edits are staged locally and committed
// as one tc:routes:set on Apply, so partial keystrokes never push malformed
// routes. Disabled wholesale when routing/control readiness is missing.

function toList(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

type DraftRoute = {
  name: string
  match: string
  accounts: string
  // Why: the editor exposes name/match/accounts, but `bucket` is a real routing
  // field the UI does not (yet) edit. Carry it verbatim through the draft so
  // Apply round-trips it instead of silently wiping it from existing routes.
  bucket: string | null
}

function toDraft(route: TcRoute): DraftRoute {
  return {
    name: route.name,
    match: route.match.join(', '),
    accounts: route.accounts.join(', '),
    bucket: route.bucket
  }
}

function fromDraft(draft: DraftRoute): TcRoute {
  return {
    name: draft.name,
    match: toList(draft.match),
    accounts: toList(draft.accounts),
    bucket: draft.bucket
  }
}

export function RoutesTab({
  state,
  controls
}: {
  state: TcState | null
  controls: TeamclaudeControls
}): React.JSX.Element {
  const { t } = useTranslation()
  const gates = surfaceGates(state)
  const routes = state?.routes
  const [drafts, setDrafts] = useState<DraftRoute[]>([])

  // Why: re-seed the local draft whenever a fresh routes snapshot arrives so the
  // editor reflects server-side changes while nothing is being edited.
  useEffect(() => {
    setDrafts((routes ?? []).map(toDraft))
  }, [routes])

  const enabled = gates.routesEditable

  const update = (index: number, patch: Partial<DraftRoute>): void => {
    setDrafts((prev) => prev.map((draft, i) => (i === index ? { ...draft, ...patch } : draft)))
  }

  // Why: an old (adopted-degraded) server is missing the routing capability, so
  // the fix is an upgrade, not a state to wait out — surface the concrete
  // have/need versions. Plain offline / other read-only states keep the generic
  // copy since upgrading would not help.
  const disabledReason = gates.adoptedDegraded
    ? t(
        'teamclaude.routes.updateNeeded',
        'Update teamclaude to edit routes (have v{{have}}, need v{{need}}).',
        { have: state?.serverVersion ?? '?', need: TC_MIN_SERVER_VERSION }
      )
    : gates.routingDegraded
      ? t('teamclaude.routes.degraded', 'This proxy does not support routing edits.')
      : t('teamclaude.routes.readOnly', 'Routing is unavailable in this state.')

  return (
    <div className="flex flex-col gap-3">
      {!enabled ? (
        <p className="rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">
          {disabledReason}
        </p>
      ) : null}

      <div className="flex flex-col gap-3">
        {drafts.map((draft, index) => (
          <div key={index} className="flex flex-col gap-2 rounded-md border border-border p-2">
            <div className="flex items-center gap-2">
              <Input
                value={draft.name}
                disabled={!enabled}
                placeholder={t('teamclaude.routes.namePlaceholder', 'Route name')}
                className="h-7 flex-1"
                onChange={(event) => update(index, { name: event.target.value })}
              />
              <Button
                size="icon-sm"
                variant="ghost"
                disabled={!enabled}
                onClick={() => setDrafts((prev) => prev.filter((_, i) => i !== index))}
                aria-label={t('teamclaude.routes.remove', 'Remove route {{value0}}', {
                  value0: draft.name
                })}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-xs text-muted-foreground">
                {t('teamclaude.routes.match', 'Match globs (comma-separated)')}
              </Label>
              <Input
                value={draft.match}
                disabled={!enabled}
                placeholder={t('teamclaude.routes.matchPlaceholder', '**/*.ts, src/**')}
                className="h-7 font-mono text-xs"
                onChange={(event) => update(index, { match: event.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-xs text-muted-foreground">
                {t('teamclaude.routes.accounts', 'Account IDs (comma-separated)')}
              </Label>
              <Input
                value={draft.accounts}
                disabled={!enabled}
                className="h-7 font-mono text-xs"
                onChange={(event) => update(index, { accounts: event.target.value })}
              />
            </div>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={!enabled}
          onClick={() =>
            setDrafts((prev) => [...prev, { name: '', match: '', accounts: '', bucket: null }])
          }
        >
          <Plus className="size-3.5" />
          {t('teamclaude.routes.add', 'Add route')}
        </Button>
        <div className="flex-1" />
        <Button
          size="sm"
          variant="ghost"
          disabled={!enabled}
          onClick={() => setDrafts((routes ?? []).map(toDraft))}
        >
          {t('teamclaude.routes.reset', 'Reset')}
        </Button>
        <Button
          size="sm"
          disabled={!enabled}
          onClick={() => controls.setRoutes(drafts.map(fromDraft))}
        >
          {t('teamclaude.routes.apply', 'Apply')}
        </Button>
      </div>
    </div>
  )
}
