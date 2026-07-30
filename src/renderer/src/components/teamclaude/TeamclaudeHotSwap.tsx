import React, { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { cn } from '@/lib/utils'
import { Button } from '../ui/button'
import type { TcEffortLevel, TcEffortState } from '../../../../shared/teamclaude-types'
import { resolveTcBridge } from '@/hooks/useTeamclaude'
import {
  clampEffortLevel,
  DEFAULT_EFFORT_LEVEL,
  EFFORT_LABELS,
  effortLevelsFor,
  hotSwapGroups,
  modelSwapKeystrokes,
  type TcHotSwapGroup,
  type TcHotSwapModel
} from './teamclaude-hotswap'
import { NO_HOT_SWAP_TARGET, type TcHotSwapTarget } from './teamclaude-hotswap-target'

// Why: two independent mechanisms behind one Apply. The MODEL is typed into the
// live pane (`/model <id>` + CR) so the CLI switches itself and its header stays
// truthful; the EFFORT is set on the proxy because the CLI has no command for
// it. Either half can be unavailable — a pane that is not running Claude, or a
// proxy that predates the effort endpoint — so each is gated on its own.

/** The slice of the TeamClaude bridge this control needs. */
export type TcEffortBridge = {
  getEffort(): Promise<TcEffortState>
  setEffort(level: TcEffortLevel | null): Promise<TcEffortState>
}

/** Resolve the effort seam defensively: the proxy side may not ship it yet. */
function resolveEffortBridge(): TcEffortBridge | null {
  const bridge = resolveTcBridge()
  if (!bridge || typeof bridge.getEffort !== 'function' || typeof bridge.setEffort !== 'function') {
    return null
  }
  return bridge
}

function writeToActivePty(ptyId: string, data: string): void {
  const api = (
    window as unknown as {
      api?: { pty?: { write?: (id: string, data: string) => void } }
    }
  ).api
  api?.pty?.write?.(ptyId, data)
}

export type TeamclaudeHotSwapProps = {
  /** Every model the proxy is currently known to route. */
  models: readonly TcHotSwapModel[]
  /** The pane a model swap would be typed into. */
  target?: TcHotSwapTarget
  /** Effort writes need a live, controllable proxy. */
  effortEnabled: boolean
  /** Seam for tests; defaults to the real PTY write. */
  writeToPty?: (ptyId: string, data: string) => void
  /** Seam for tests; `undefined` resolves the real bridge, `null` forces "absent". */
  effortBridge?: TcEffortBridge | null
}

function ModelPicker({
  groups,
  selectedId,
  disabled,
  onSelect
}: {
  groups: readonly TcHotSwapGroup[]
  selectedId: string | null
  disabled: boolean
  onSelect: (id: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  if (groups.length === 0) {
    return (
      <p className="text-[10px] text-muted-foreground/70">
        {t('teamclaude.flyout.hotSwapNoModels', 'No models to pick from yet.')}
      </p>
    )
  }
  return (
    <div className="scrollbar-sleek flex max-h-32 flex-col gap-1.5 overflow-y-auto pr-1">
      {groups.map((group) => (
        <div key={group.family} className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground/70">
            {t(group.labelKey, group.labelFallback)}
          </span>
          <div className="flex flex-wrap gap-1">
            {group.models.map((option) => (
              <Button
                key={option.id}
                size="xs"
                variant={selectedId === option.id ? 'secondary' : 'ghost'}
                className="font-mono text-[10px]"
                disabled={disabled}
                aria-pressed={selectedId === option.id}
                aria-label={t('teamclaude.flyout.hotSwapModelAria', 'Switch model to {{value0}}', {
                  value0: option.id
                })}
                onClick={() => onSelect(option.id)}
              >
                {option.id}
              </Button>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

function EffortPicker({
  levels,
  selected,
  disabled,
  onSelect
}: {
  levels: readonly TcEffortLevel[]
  selected: TcEffortLevel
  disabled: boolean
  onSelect: (level: TcEffortLevel) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="flex flex-wrap gap-1">
      {levels.map((level) => {
        const label = t(EFFORT_LABELS[level].key, EFFORT_LABELS[level].fallback)
        return (
          <Button
            key={level}
            size="xs"
            variant={selected === level ? 'secondary' : 'ghost'}
            disabled={disabled}
            aria-pressed={selected === level}
            aria-label={t(
              'teamclaude.flyout.hotSwapEffortAria',
              'Set reasoning effort to {{value0}}',
              { value0: label }
            )}
            onClick={() => onSelect(level)}
          >
            {label}
          </Button>
        )
      })}
    </div>
  )
}

export function TeamclaudeHotSwap({
  models,
  target = NO_HOT_SWAP_TARGET,
  effortEnabled,
  writeToPty = writeToActivePty,
  effortBridge
}: TeamclaudeHotSwapProps): React.JSX.Element {
  const { t } = useTranslation()
  const bridge = useMemo(
    () => (effortBridge === undefined ? resolveEffortBridge() : effortBridge),
    [effortBridge]
  )
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [level, setLevel] = useState<TcEffortLevel>(DEFAULT_EFFORT_LEVEL)
  const [applied, setApplied] = useState(false)

  // Why: start from the override the proxy already holds so Apply cannot
  // silently reset an effort the user set elsewhere.
  useEffect(() => {
    if (!bridge) {
      return
    }
    let active = true
    void Promise.resolve(bridge.getEffort())
      .then((current) => {
        if (active && current) {
          setLevel(current.level)
        }
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [bridge])

  const modelSwapAvailable = target.claudeFamily && target.ptyId !== null
  const groups = useMemo(() => hotSwapGroups(models), [models])
  const selectedFamily = groups.find((group) =>
    group.models.some((option) => option.id === selectedId)
  )
  // Why: level validity follows the model in play — the picked model when there
  // is one, otherwise the model the resolved pane is already running. Anthropic
  // answers `none` with a 400, so a Claude model must never be offered it.
  const claudeModel = selectedFamily ? selectedFamily.family === 'claude' : target.claudeFamily
  const levels = effortLevelsFor(claudeModel)
  const effectiveLevel = clampEffortLevel(level, levels)
  const effortAvailable = bridge !== null && effortEnabled
  const canApply = (modelSwapAvailable && selectedId !== null) || effortAvailable

  const modelDisabledReason =
    target.ptyId === null
      ? t(
          'teamclaude.flyout.hotSwapNoSession',
          'No terminal is open, so there is no session to switch.'
        )
      : t(
          'teamclaude.flyout.hotSwapNotClaude',
          'This terminal is not running Claude, so its model cannot be changed here.'
        )

  const apply = async (): Promise<void> => {
    setApplied(false)
    if (modelSwapAvailable && selectedId && target.ptyId) {
      writeToPty(target.ptyId, modelSwapKeystrokes(selectedId))
    }
    if (effortAvailable && bridge) {
      try {
        await bridge.setEffort(effectiveLevel)
      } catch {
        // Why: the flyout already surfaces control failures through the panel;
        // a failed effort write must not lose the model keystrokes above.
      }
    }
    setApplied(true)
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t('teamclaude.flyout.hotSwapTitle', 'Hot swap')}
        </span>
        {target.tabTitle ? (
          <span className="min-w-0 truncate text-[10px] text-muted-foreground/80">
            {target.tabTitle}
          </span>
        ) : null}
      </div>

      <div className={cn('flex flex-col gap-1', !modelSwapAvailable && 'opacity-70')}>
        <span className="text-[10px] text-muted-foreground">
          {t('teamclaude.flyout.hotSwapModel', 'Model')}
        </span>
        <ModelPicker
          groups={groups}
          selectedId={selectedId}
          disabled={!modelSwapAvailable}
          onSelect={(id) => {
            setApplied(false)
            setSelectedId(id)
          }}
        />
        {!modelSwapAvailable ? (
          <p className="text-[10px] text-muted-foreground">{modelDisabledReason}</p>
        ) : null}
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-[10px] text-muted-foreground">
          {t('teamclaude.flyout.hotSwapEffort', 'Reasoning effort')}
        </span>
        <EffortPicker
          levels={levels}
          selected={effectiveLevel}
          disabled={!effortAvailable}
          onSelect={(next) => {
            setApplied(false)
            setLevel(next)
          }}
        />
        {!effortAvailable ? (
          <p className="text-[10px] text-muted-foreground">
            {t(
              'teamclaude.flyout.hotSwapEffortUnavailable',
              'This proxy cannot change reasoning effort yet.'
            )}
          </p>
        ) : null}
      </div>

      <div className="flex items-center gap-2">
        <Button size="xs" disabled={!canApply} onClick={() => void apply()}>
          {t('teamclaude.flyout.hotSwapApply', 'Apply')}
        </Button>
        {applied ? (
          <span className="text-[10px] text-muted-foreground">
            {t('teamclaude.flyout.hotSwapApplied', 'Sent to the running session.')}
          </span>
        ) : null}
      </div>
    </div>
  )
}
