import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  killServiceProcess,
  serviceProcessAlive,
  serviceProcessStartTime,
  spawnServiceProcess
} from '../services/service-supervisor-runtime'
import type { EntrypointResolution, OwnershipMarker, SpawnedChild } from './supervisor-types'

export { resolveNodeEntrypoint } from './supervisor-entrypoint-resolver'

/** TeamClaude command adapter; generic process spawning never invokes a shim or shell. */
export function spawnServerProcess(
  resolution: EntrypointResolution,
  extraEnv: NodeJS.ProcessEnv,
  cwd?: string
): SpawnedChild {
  return spawnServiceProcess({
    executable: resolution.node,
    args: [resolution.entry, 'server', '--headless'],
    env: { ...resolution.env, ...extraEnv },
    ...(cwd ? { cwd } : {})
  })
}

/** Compatibility codec for the existing `{pid, port, startedAt}` marker. */
export function readMarkerFile(path: string): OwnershipMarker | null {
  try {
    const marker = JSON.parse(readFileSync(path, 'utf8')) as Partial<OwnershipMarker>
    if (
      typeof marker.pid === 'number' &&
      typeof marker.port === 'number' &&
      typeof marker.startedAt === 'number'
    ) {
      return { pid: marker.pid, port: marker.port, startedAt: marker.startedAt }
    }
  } catch {
    // Missing, locked, and malformed markers are all unowned.
  }
  return null
}

export function writeMarkerFile(path: string, marker: OwnershipMarker): void {
  try {
    writeFileSync(path, JSON.stringify(marker), { mode: 0o600 })
  } catch {
    // Ownership persistence is best-effort; liveness probing remains authoritative.
  }
}

export function clearMarkerFile(path: string): void {
  try {
    rmSync(path, { force: true })
  } catch {
    // A missing or locked marker is handled by the next liveness probe.
  }
}

export function markerPath(userDataDir: string): string {
  return join(userDataDir, 'teamclaude-owned-proxy.json')
}

export function killProcess(pid: number): void {
  killServiceProcess(pid, false)
}

export const processAlive = serviceProcessAlive
export const processStartTime = serviceProcessStartTime
