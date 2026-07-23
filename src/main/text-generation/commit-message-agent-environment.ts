import type { ClaudeRuntimeAuthPreparation } from '../claude-accounts/runtime-auth-service'
import { applyClaudeEnvPatch } from '../claude-accounts/environment'
import { readShellStartupEnvVar } from '../pty/shell-startup-env'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { getTeamclaudeRoutingSnapshot } from '../teamclaude/init'
import { applyRouting } from '../teamclaude/routing-env'

export type CommitMessageAgentEnvironmentResolvers = {
  prepareForCodexLaunch?: (target?: CommitMessageAgentRuntimeTarget) => string | null
  prepareForClaudeLaunch?: (
    target?: CommitMessageAgentRuntimeTarget,
    options?: { skipManagedTokenRotation?: boolean }
  ) => Promise<ClaudeRuntimeAuthPreparation>
}

// TeamClaude text-generation routing seam (spec §4). Host-only: WSL/SSH text-gen
// is remote out-of-scope (a 127.0.0.1 proxy + Windows CA are meaningless in WSL).
function applyTeamclaudeTextgenRouting(env: NodeJS.ProcessEnv): void {
  try {
    const result = applyRouting(
      env as Record<string, string>,
      'textgen',
      getTeamclaudeRoutingSnapshot()
    )
    for (const [key, value] of Object.entries(result.env)) {
      if (typeof value === 'string') {
        env[key] = value
      }
    }
    for (const key of result.envToDelete) {
      delete env[key]
    }
  } catch {
    // Fail-open: text generation must never fail to launch because of TeamClaude.
  }
}

// Whether text-gen will actually be fleet-routed — drives the auth-preparation
// gate (skip only managed-token-rotation). Delegates carve-outs to applyRouting.
function willTeamclaudeTextgenRoute(): boolean {
  try {
    const snapshot = getTeamclaudeRoutingSnapshot()
    // Probe on a CLEAN env carrying only ANTHROPIC_BASE_URL so an inherited
    // HTTPS_PROXY on the host cannot false-positive "routed".
    const probeEnv: Record<string, string> = {}
    if (typeof process.env.ANTHROPIC_BASE_URL === 'string') {
      probeEnv.ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL
    }
    const probe = applyRouting(probeEnv, 'textgen', snapshot)
    return probe.env.HTTPS_PROXY === `http://127.0.0.1:${snapshot.port}`
  } catch {
    return false
  }
}

export type CommitMessageAgentRuntimeTarget = {
  runtime?: 'host' | 'wsl'
  wslDistro?: string | null
}

function cloneProcessEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value
    }
  }
  return env
}

function readInheritedOrShellEnvVar(name: string, sourceName?: string): string | undefined {
  return (
    (sourceName ? process.env[sourceName] : undefined) ??
    process.env[name] ??
    readShellStartupEnvVar(name, process.env.HOME, process.env.SHELL)
  )
}

function prepareShellConfigDirEnv(agentId: string): { ok: true; env?: NodeJS.ProcessEnv } | null {
  const configVar =
    agentId === 'opencode'
      ? 'OPENCODE_CONFIG_DIR'
      : agentId === 'pi' || agentId === 'omp'
        ? 'PI_CODING_AGENT_DIR'
        : null
  if (!configVar) {
    return null
  }
  // Why: each kind owns a distinct ORCA_*_SOURCE_* shadow so a headless commit
  // run from inside a legacy OMP overlay restores the OMP source dir, never
  // the Pi one (and vice versa). PI_CODING_AGENT_DIR is the binary-facing var
  // both kinds consume — see src/main/pi/titlebar-extension-service.ts.
  const sourceVar =
    agentId === 'opencode'
      ? 'ORCA_OPENCODE_SOURCE_CONFIG_DIR'
      : agentId === 'pi'
        ? 'ORCA_PI_SOURCE_AGENT_DIR'
        : agentId === 'omp'
          ? 'ORCA_OMP_SOURCE_AGENT_DIR'
          : undefined

  const value = readInheritedOrShellEnvVar(configVar, sourceVar)
  if (!value) {
    return { ok: true }
  }

  // Why: GUI-launched Orca may not inherit shell startup exports, but these
  // vars point the headless CLI at the user's auth/config root. Nested Orca
  // launches inherit PTY overlays, so prefer ORCA_*_SOURCE_* when present.
  return { ok: true, env: { ...cloneProcessEnv(), [configVar]: value } }
}

export async function prepareLocalCommitMessageAgentEnv(
  agentId: string,
  resolvers: CommitMessageAgentEnvironmentResolvers | undefined,
  target?: CommitMessageAgentRuntimeTarget
): Promise<{ ok: true; env?: NodeJS.ProcessEnv } | { ok: false; error: string }> {
  const shellConfigEnv = target?.runtime === 'wsl' ? null : prepareShellConfigDirEnv(agentId)
  if (shellConfigEnv) {
    return shellConfigEnv
  }
  if (!resolvers) {
    return { ok: true }
  }

  try {
    if (agentId === 'codex' && resolvers.prepareForCodexLaunch) {
      const codexHomePath = resolvers.prepareForCodexLaunch(target)
      const wslCodexHome = codexHomePath ? parseWslUncPath(codexHomePath) : null
      if (target?.runtime === 'wsl') {
        const codexHomeForTarget = wslCodexHome?.linuxPath ?? null
        return {
          ok: true,
          env: codexHomeForTarget
            ? { ...cloneProcessEnv(), CODEX_HOME: codexHomeForTarget }
            : undefined
        }
      }
      if (codexHomePath && wslCodexHome) {
        // Why: this local generation path spawns the host Codex binary. A WSL
        // managed home is only valid when the process is routed through wsl.exe.
        return { ok: true }
      }
      return {
        ok: true,
        env: codexHomePath ? { ...cloneProcessEnv(), CODEX_HOME: codexHomePath } : undefined
      }
    }

    if (agentId === 'claude' && resolvers.prepareForClaudeLaunch) {
      const willRoute = target?.runtime !== 'wsl' && willTeamclaudeTextgenRoute()
      const preparation = await resolvers.prepareForClaudeLaunch(target, {
        skipManagedTokenRotation: willRoute
      })
      const env = applyClaudeEnvPatch(cloneProcessEnv(), preparation.envPatch, {
        stripAuthEnv: preparation.stripAuthEnv
      })
      if (target?.runtime !== 'wsl') {
        applyTeamclaudeTextgenRouting(env)
      }
      return { ok: true, env }
    }
  } catch (error) {
    console.error('[commit-message] Failed to prepare agent environment:', error)
    return {
      ok: false,
      error: 'Failed to prepare the selected agent account for commit message generation.'
    }
  }

  return { ok: true }
}
