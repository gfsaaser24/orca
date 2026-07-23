/**
 * Types + constants shared by the {@link Supervisor} state machine and its
 * runtime dependency implementations. Split out so both sides depend on one
 * neutral module (no cycle) and each file stays within the size budget.
 */
import type { TcProxyLifecycle } from '../../shared/teamclaude-types'

/** Distinct exit code teamclaude `server --headless` uses to signal "no
 *  accounts configured" so a supervisor classifies setup-needed vs crash. This
 *  is the REAL server value (`process.exit(3)` in teamclaude src/index.js), not
 *  the sysexits.h EX_CONFIG (78) the spec draft assumed. */
export const NO_ACCOUNTS_EXIT_CODE = 3

/** Backoff attempts before the supervisor gives up to `offline`. */
export const BACKOFF_CAP = 5
/** Process-start-time match window for ownership-marker reclaim (spec §4). */
export const RECLAIM_TOLERANCE_MS = 2000
/** Adopted-death grace: re-probe for this long before spawning our own. */
export const ADOPTED_DEATH_WINDOW_MS = 10_000
export const ADOPTED_DEATH_BASE_MS = 2000
/** Low-frequency liveness probe after resolver-caused setup-needed. */
export const RESOLVER_RECOVERY_PROBE_MS = 10_000
/** Routing-snapshot freshness TTL — bounds a death nobody has noticed. */
export const SNAPSHOT_TTL_MS = 2000
/** Previously-owned ports remembered for stale base-URL cleanup. */
export const PORT_HISTORY = 4

export type OwnershipMarker = {
  pid: number
  port: number
  /** Epoch ms captured at spawn; validated against OS process start time ±2s. */
  startedAt: number
}

export type EntrypointResolution = {
  /** Node binary to invoke. */
  node: string
  /** Absolute path to the resolved `.js` entrypoint (never the shim). */
  entry: string
  /** The found-but-context path shown to the user on resolution success/fail. */
  foundPath: string | null
  /** Extra env required to run `node` (e.g. ELECTRON_RUN_AS_NODE when we fall
   *  back to Electron's own binary as a Node runtime). */
  env?: NodeJS.ProcessEnv
}

export type EntrypointResolutionResult =
  | {
      kind: 'resolved'
      resolution: EntrypointResolution
      foundPath: string
      attemptedCandidates: string[]
      nodeFallback: 'path-node' | 'electron-run-as-node'
    }
  | {
      kind: 'not-found'
      foundPath: null
      attemptedCandidates: string[]
      nodeFallback: 'path-node' | 'electron-run-as-node'
    }
  | {
      kind: 'shim-unresolvable'
      foundPath: string
      attemptedCandidates: string[]
      nodeFallback: 'path-node' | 'electron-run-as-node'
    }

export type ProbeResult = {
  ok: boolean
  version: string | null
  capabilities: string[]
  bootId: string | null
}

export type SpawnedChild = {
  pid: number | null
  onExit(cb: (code: number | null) => void): void
  kill(): void
}

export type SupervisorDeps = {
  /** GET /teamclaude/status → parsed liveness/capability. */
  probe(): Promise<ProbeResult>
  /** Detached spawn of `node <entry> server --headless`. */
  spawnServer(resolution: EntrypointResolution): SpawnedChild
  /** Resolve the Node entrypoint from PATH (or the config binPath override). */
  resolveEntrypoint(binPath: string | null): Promise<EntrypointResolutionResult>
  readMarker(): OwnershipMarker | null
  writeMarker(marker: OwnershipMarker): void
  clearMarker(): void
  /** True if a process with this pid is alive. */
  processAlive(pid: number): boolean
  /** Force-kill a process tree by pid (used to stop a RECLAIMED owned server,
   *  which has no child handle). */
  killPid(pid: number): void
  /** OS process start time (epoch ms) or null if unknowable. */
  processStartTime(pid: number): Promise<number | null>
  /** Whether the server's capabilities/version are supported (else degraded). */
  isSupported(capabilities: string[], version: string | null): boolean
  now(): number
  random(): number
  setTimeoutFn: typeof setTimeout
  clearTimeoutFn: typeof clearTimeout
  watchdogMs: number
}

export type SupervisorTransition = {
  lifecycle: TcProxyLifecycle
  reasonKey: string | null
  reasonDetail: string | null
  owned: boolean
  serverVersion: string | null
  capabilities: string[]
  bootId: string | null
}

export type SupervisorConfig = {
  port: number
  apiKey: string
  binPath: string | null
}
