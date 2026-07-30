import type { TcEffortLevel } from '../../../../shared/teamclaude-types'
import { OAUTH_PROVIDER_FAMILIES } from './panel/backends/backend-readiness'

// Why: the hot-swap control changes two things through two different seams —
// the MODEL is typed into the live CLI (so its own header stays truthful) and
// the reasoning EFFORT is set on the proxy (the CLI has no effort command).
// The pure derivations for both live here so the level-validity rule and the
// provider grouping are unit-testable without a DOM.

/** Provider families the picker groups models under, in render order. */
export type TcHotSwapFamilyId = 'claude' | 'codex' | 'xai' | 'kimi' | 'gemini' | 'other'

const FAMILY_ORDER: readonly TcHotSwapFamilyId[] = [
  'claude',
  'codex',
  'xai',
  'kimi',
  'gemini',
  'other'
]

/** Localization key + English fallback for the "no known family" group. */
const OTHER_FAMILY_LABEL = {
  key: 'teamclaude.flyout.hotSwapOtherModels',
  fallback: 'Other'
} as const

/** A model the proxy currently routes: an id plus its backend provider if known. */
export type TcHotSwapModel = { id: string; provider?: string | null }

export type TcHotSwapOption = { id: string; family: TcHotSwapFamilyId }

export type TcHotSwapGroup = {
  family: TcHotSwapFamilyId
  labelKey: string
  labelFallback: string
  models: TcHotSwapOption[]
}

// Why: models discovered from live traffic carry no provider, so the id itself
// has to place them. Ordered — the first match wins.
const ID_FAMILY_PATTERNS: readonly (readonly [RegExp, TcHotSwapFamilyId])[] = [
  [/^claude[-.]/i, 'claude'],
  [/^(?:gpt|o[13-9])[-.\d]|codex/i, 'codex'],
  [/^grok/i, 'xai'],
  [/^(?:kimi|moonshot)/i, 'kimi'],
  [/^gemini/i, 'gemini']
]

/** Family for a CLIProxyAPI provider id, reusing the Backends family table. */
export function hotSwapFamilyForProvider(
  provider: string | null | undefined
): TcHotSwapFamilyId | null {
  if (!provider) {
    return null
  }
  const family = OAUTH_PROVIDER_FAMILIES.find((candidate) =>
    candidate.providers.some((value) => value === provider)
  )
  if (!family) {
    return null
  }
  return FAMILY_ORDER.find((id) => id === family.id) ?? null
}

/** Provider wins when it maps to a known family; otherwise read the model id. */
export function hotSwapFamily(model: TcHotSwapModel): TcHotSwapFamilyId {
  const fromProvider = hotSwapFamilyForProvider(model.provider)
  if (fromProvider) {
    return fromProvider
  }
  return ID_FAMILY_PATTERNS.find(([pattern]) => pattern.test(model.id))?.[1] ?? 'other'
}

function familyLabel(family: TcHotSwapFamilyId): { key: string; fallback: string } {
  const known = OAUTH_PROVIDER_FAMILIES.find((candidate) => candidate.id === family)
  return known
    ? { key: known.labelKey, fallback: known.labelFallback }
    : { key: OTHER_FAMILY_LABEL.key, fallback: OTHER_FAMILY_LABEL.fallback }
}

/**
 * The selectable model inventory: every id the proxy is known to route right
 * now — the backend model registry plus ids seen in live activity — deduped
 * (registry provider wins) and sorted for a stable picker.
 */
export function hotSwapModelInventory(input: {
  cpaModels?: readonly { id: string; provider?: string | null }[]
  activityModels?: readonly (string | null)[]
}): TcHotSwapModel[] {
  const byId = new Map<string, TcHotSwapModel>()
  for (const model of input.activityModels ?? []) {
    const id = model?.trim()
    if (id) {
      byId.set(id, { id })
    }
  }
  for (const model of input.cpaModels ?? []) {
    const id = model.id.trim()
    if (id) {
      byId.set(id, { id, provider: model.provider ?? null })
    }
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))
}

/** Group the inventory by provider family, dropping families with no models. */
export function hotSwapGroups(models: readonly TcHotSwapModel[]): TcHotSwapGroup[] {
  const byFamily = new Map<TcHotSwapFamilyId, TcHotSwapOption[]>()
  for (const model of models) {
    const family = hotSwapFamily(model)
    const options = byFamily.get(family) ?? []
    if (!options.some((option) => option.id === model.id)) {
      options.push({ id: model.id, family })
    }
    byFamily.set(family, options)
  }
  return FAMILY_ORDER.flatMap((family) => {
    const options = byFamily.get(family)
    if (!options || options.length === 0) {
      return []
    }
    const label = familyLabel(family)
    return [
      {
        family,
        labelKey: label.key,
        labelFallback: label.fallback,
        models: [...options].sort((a, b) => a.id.localeCompare(b.id))
      }
    ]
  })
}

/**
 * Levels offered for an Anthropic model. `none` is deliberately absent:
 * Anthropic answers a `claude-*` request carrying it with a 400, so offering it
 * would hand the user a switch that breaks their session.
 */
export const CLAUDE_EFFORT_LEVELS: readonly TcEffortLevel[] = ['low', 'medium', 'high', 'max']

/** Levels offered for a CLIProxyAPI backend model, where `none` is honored. */
export const BACKEND_EFFORT_LEVELS: readonly TcEffortLevel[] = ['none', 'low', 'high', 'max']

/** The level the picker starts on. */
export const DEFAULT_EFFORT_LEVEL: TcEffortLevel = 'high'

/** Level list valid for the model in play. */
export function effortLevelsFor(claudeModel: boolean): readonly TcEffortLevel[] {
  return claudeModel ? CLAUDE_EFFORT_LEVELS : BACKEND_EFFORT_LEVELS
}

/** Keep a held level legal after the model (and so the level list) changes. */
export function clampEffortLevel(
  level: TcEffortLevel,
  levels: readonly TcEffortLevel[]
): TcEffortLevel {
  return levels.includes(level) ? level : DEFAULT_EFFORT_LEVEL
}

/** Localization key + English fallback for each effort level. */
export const EFFORT_LABELS: Record<TcEffortLevel, { key: string; fallback: string }> = {
  none: { key: 'teamclaude.effort.none', fallback: 'None' },
  low: { key: 'teamclaude.effort.low', fallback: 'Low' },
  medium: { key: 'teamclaude.effort.medium', fallback: 'Medium' },
  high: { key: 'teamclaude.effort.high', fallback: 'High' },
  xhigh: { key: 'teamclaude.effort.xhigh', fallback: 'Extra high' },
  max: { key: 'teamclaude.effort.max', fallback: 'Max' }
}

/**
 * The bytes that make a running Claude CLI switch model: its own `/model`
 * command plus a carriage return to submit it. Typing it (rather than mutating
 * the proxy) is what keeps the CLI's own header honest about the switch.
 */
export function modelSwapKeystrokes(modelId: string): string {
  return `/model ${modelId}\r`
}
