import { statSync } from 'node:fs'
import type {
  ServiceExitAction,
  ServiceProfile,
  ServiceProbeStatus,
  ServiceSpawnResolution
} from '../service-supervisor'

export type CliProxyApiProfileDeps = {
  getBinaryPath(): string | null
  getConfigPath(): string | null
  getApiKey(): string | null
  markerPath: string
  port: number
  isFile?(path: string): boolean
  fetchFn?: CliProxyApiFetch
}

export type CliProxyApiFetch = (input: string, init?: RequestInit) => Promise<Response>

const CLEAN_EXIT_ACTION: ServiceExitAction = {
  kind: 'restart',
  reasonKey: 'cpa.reason.exited',
  reasonDetail: 'CLIProxyAPI exited cleanly'
}

export function createCliProxyApiProfile(deps: CliProxyApiProfileDeps): ServiceProfile {
  const baseUrl = `http://127.0.0.1:${deps.port}`
  const fetchFn = deps.fetchFn ?? fetch
  const isFile = deps.isFile ?? pathIsFile

  return {
    id: 'cliproxyapi',
    displayName: 'CLIProxyAPI',
    probe: () => probeCliProxyApi(baseUrl, deps.getApiKey, fetchFn),
    resolveSpawn: () => resolveCliProxyApiSpawn(deps, isFile),
    markerPath: deps.markerPath,
    markerIdentity: `cliproxyapi:127.0.0.1:${deps.port}`,
    // Why: probing an unknown-key CPA can contribute to its loopback auth ban.
    adoptionPolicy: 'owned-only',
    // Why: Windows taskkill is immediate (D7); POSIX gets the documented SIGTERM grace.
    stopPolicy: { killOnQuitDefault: false, forceKillDelayMs: 30_000 },
    exitCodeMap: { 0: CLEAN_EXIT_ACTION },
    onOwnedUnready: 'restart',
    reasonKeys: {
      degraded: 'cpa.reason.unready',
      adoptedLost: 'cpa.reason.lost',
      crashed: 'cpa.reason.crashed',
      offline: 'cpa.reason.offline',
      ownedUnready: 'cpa.reason.ownedUnready'
    }
  }
}

async function probeCliProxyApi(
  baseUrl: string,
  getApiKey: () => string | null,
  fetchFn: CliProxyApiFetch
): Promise<ServiceProbeStatus> {
  let health: Response
  try {
    health = await fetchFn(`${baseUrl}/healthz`, { method: 'HEAD', cache: 'no-store' })
  } catch {
    return 'down'
  }
  if (!health.ok) {
    return 'down'
  }

  const apiKey = getApiKey()
  if (!apiKey) {
    return 'alive-unready'
  }
  try {
    const models = await fetchFn(`${baseUrl}/v1/models`, {
      method: 'GET',
      cache: 'no-store',
      headers: { Authorization: `Bearer ${apiKey}` }
    })
    if (!models.ok) {
      return 'alive-unready'
    }
    const payload = (await models.json()) as { data?: unknown }
    // Why: zero credentials is a usable ready state, not a startup failure.
    return Array.isArray(payload.data) ? 'ready' : 'alive-unready'
  } catch {
    return 'alive-unready'
  }
}

async function resolveCliProxyApiSpawn(
  deps: CliProxyApiProfileDeps,
  isFile: (path: string) => boolean
): Promise<ServiceSpawnResolution> {
  const binaryPath = deps.getBinaryPath()?.trim() || null
  if (!binaryPath || !isFile(binaryPath)) {
    return {
      kind: 'setup-needed',
      reasonKey: 'cpa.reason.binaryMissing',
      reasonDetail: binaryPath
        ? `CLIProxyAPI binary is missing or invalid: ${binaryPath}`
        : 'Choose a CLIProxyAPI binary in settings'
    }
  }
  const configPath = deps.getConfigPath()?.trim() || null
  if (!configPath || !isFile(configPath)) {
    return {
      kind: 'setup-needed',
      reasonKey: 'cpa.reason.configMissing',
      reasonDetail: configPath
        ? `CLIProxyAPI config is missing or invalid: ${configPath}`
        : 'CLIProxyAPI config has not been generated yet'
    }
  }
  return {
    kind: 'resolved',
    command: {
      executable: binaryPath,
      args: ['--config', configPath]
    }
  }
}

function pathIsFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}
