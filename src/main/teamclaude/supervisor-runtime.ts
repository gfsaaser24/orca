/** Production process, marker, and process-introspection dependencies. */
import { execFile, spawn } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { EntrypointResolution, OwnershipMarker, SpawnedChild } from './supervisor-types'

export { resolveNodeEntrypoint } from './supervisor-entrypoint-resolver'

/** Detached spawn of the resolved entrypoint. Never a shim; never `shell:true`. */
export function spawnServerProcess(
  resolution: EntrypointResolution,
  extraEnv: NodeJS.ProcessEnv,
  cwd?: string
): SpawnedChild {
  const child = spawn(resolution.node, [resolution.entry, 'server', '--headless'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, ...resolution.env, ...extraEnv },
    ...(cwd ? { cwd } : {})
  })
  child.unref()
  return {
    pid: child.pid ?? null,
    onExit: (callback) => {
      child.on('exit', (code) => callback(code))
      child.on('error', () => callback(null))
    },
    kill: () => {
      if (child.pid == null) {
        return
      }
      if (process.platform === 'win32') {
        try {
          const taskkill = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
            stdio: 'ignore',
            windowsHide: true
          })
          taskkill.on('error', () => {})
        } catch {
          // taskkill is best-effort during teardown.
        }
      } else {
        try {
          child.kill()
        } catch {
          // The child may already have exited.
        }
      }
    }
  }
}

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
    return null
  } catch {
    return null
  }
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

/** Kill a reclaimed process after the supervisor has proven marker ownership. */
export function killProcess(pid: number): void {
  if (process.platform === 'win32') {
    try {
      const taskkill = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true
      })
      taskkill.on('error', () => {})
    } catch {
      // taskkill is best-effort during teardown.
    }
    return
  }
  try {
    process.kill(pid)
  } catch {
    // The process may already have exited.
  }
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists but cannot be signalled; ESRCH means gone.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function processStartTime(pid: number): Promise<number | null> {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      execFile(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `try { (Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks } catch { '' }`
        ],
        { windowsHide: true, timeout: 4000 },
        (error, stdout) => {
          if (error) {
            resolve(null)
            return
          }
          const ticks = Number(String(stdout).trim())
          if (!Number.isFinite(ticks) || ticks <= 0) {
            resolve(null)
            return
          }
          // Convert .NET ticks (100ns since year 1) to Unix epoch milliseconds.
          resolve((ticks - 621_355_968_000_000_000) / 10_000)
        }
      )
      return
    }
    execFile('ps', ['-o', 'lstart=', '-p', String(pid)], { timeout: 4000 }, (error, stdout) => {
      if (error) {
        resolve(null)
        return
      }
      const parsed = Date.parse(String(stdout).trim())
      resolve(Number.isFinite(parsed) ? parsed : null)
    })
  })
}
