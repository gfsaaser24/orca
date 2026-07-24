import { execFile, spawn } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import type {
  ServiceOwnershipMarker,
  ServiceProfile,
  ServiceSpawnCommand,
  ServiceSupervisorDeps,
  SpawnedServiceChild
} from './service-supervisor'

export const SERVICE_RECLAIM_TOLERANCE_MS = 2000

export async function markerProvesServiceOwnership(
  marker: ServiceOwnershipMarker | null,
  identity: string,
  probe: Pick<ServiceSupervisorDeps, 'processAlive' | 'processStartTime'>
): Promise<boolean> {
  if (!marker || marker.identity !== identity || !probe.processAlive(marker.pid)) {
    return false
  }
  const startedAt = await probe.processStartTime(marker.pid)
  return (
    startedAt !== null && Math.abs(startedAt - marker.startedAt) <= SERVICE_RECLAIM_TOLERANCE_MS
  )
}

export class ServiceProcessControl {
  constructor(
    private readonly profile: ServiceProfile,
    private readonly deps: ServiceSupervisorDeps
  ) {}

  readMarker(): ServiceOwnershipMarker | null {
    return this.deps.readMarker(this.profile.markerPath)
  }

  writeMarker(marker: ServiceOwnershipMarker): void {
    this.deps.writeMarker(this.profile.markerPath, marker)
  }

  clearMarker(): void {
    this.deps.clearMarker(this.profile.markerPath)
  }

  provesOwnership(marker: ServiceOwnershipMarker | null): Promise<boolean> {
    return markerProvesServiceOwnership(marker, this.profile.markerIdentity, this.deps)
  }

  async terminateForRestart(child: SpawnedServiceChild | null): Promise<void> {
    if (child) {
      try {
        child.kill(true)
      } catch {
        // Process teardown is best-effort; marker proof protects later kills.
      }
      this.clearMarker()
      return
    }
    const marker = this.readMarker()
    if (await this.provesOwnership(marker)) {
      this.deps.killPid(marker!.pid, true)
    }
    this.clearMarker()
  }

  async stop(child: SpawnedServiceChild | null): Promise<void> {
    if (!child) {
      await this.stopReclaimed()
      return
    }
    const pid = child.pid
    const marker = this.readMarker()
    try {
      child.kill(false)
    } catch {
      // Process teardown is best-effort during app shutdown.
    }
    this.clearMarker()
    if (pid !== null && this.profile.stopPolicy.forceKillDelayMs > 0) {
      const timer = this.deps.setTimeoutFn(() => {
        void this.forceKillIfStillOwned(marker, pid)
      }, this.profile.stopPolicy.forceKillDelayMs)
      timer.unref?.()
    }
  }

  private async stopReclaimed(): Promise<void> {
    const marker = this.readMarker()
    if (await this.provesOwnership(marker)) {
      this.deps.killPid(marker!.pid, false)
      this.clearMarker()
      if (this.profile.stopPolicy.forceKillDelayMs > 0) {
        const timer = this.deps.setTimeoutFn(() => {
          void this.forceKillIfStillOwned(marker, marker!.pid)
        }, this.profile.stopPolicy.forceKillDelayMs)
        timer.unref?.()
      }
    }
  }

  private async forceKillIfStillOwned(
    marker: ServiceOwnershipMarker | null,
    pid: number
  ): Promise<void> {
    if (await this.provesOwnership(marker)) {
      this.deps.killPid(pid, true)
    }
  }
}

export function spawnServiceProcess(command: ServiceSpawnCommand): SpawnedServiceChild {
  const child = spawn(command.executable, command.args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, ...command.env },
    ...(command.cwd ? { cwd: command.cwd } : {})
  })
  child.unref()
  return {
    pid: child.pid ?? null,
    onExit: (callback) => {
      child.on('exit', (code) => callback(code))
      child.on('error', () => callback(null))
    },
    kill: (force = false) => {
      if (child.pid === undefined) {
        return
      }
      if (process.platform === 'win32') {
        spawnWindowsTaskkill(child.pid)
        return
      }
      try {
        child.kill(force ? 'SIGKILL' : 'SIGTERM')
      } catch {
        // The child may already have exited.
      }
    }
  }
}

export function readServiceMarker(path: string): ServiceOwnershipMarker | null {
  try {
    const marker = JSON.parse(readFileSync(path, 'utf8')) as Partial<ServiceOwnershipMarker>
    if (
      typeof marker.pid === 'number' &&
      typeof marker.startedAt === 'number' &&
      typeof marker.identity === 'string'
    ) {
      return { pid: marker.pid, startedAt: marker.startedAt, identity: marker.identity }
    }
  } catch {
    // Missing, locked, and malformed markers are all unowned.
  }
  return null
}

export function writeServiceMarker(path: string, marker: ServiceOwnershipMarker): void {
  try {
    writeFileSync(path, JSON.stringify(marker), { mode: 0o600 })
  } catch {
    // Marker persistence is best-effort; probing remains authoritative.
  }
}

export function clearServiceMarker(path: string): void {
  try {
    rmSync(path, { force: true })
  } catch {
    // A missing or locked marker is handled by the next ownership proof.
  }
}

export function killServiceProcess(pid: number, force = false): void {
  if (process.platform === 'win32') {
    spawnWindowsTaskkill(pid)
    return
  }
  try {
    process.kill(pid, force ? 'SIGKILL' : 'SIGTERM')
  } catch {
    // The process may already have exited.
  }
}

export function serviceProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function serviceProcessStartTime(pid: number): Promise<number | null> {
  return process.platform === 'win32' ? windowsProcessStartTime(pid) : posixProcessStartTime(pid)
}

export function windowsTaskkillArgs(pid: number): string[] {
  return ['/pid', String(pid), '/T', '/F']
}

function spawnWindowsTaskkill(pid: number): void {
  try {
    // Why: CPA has no usable Windows console signal path in v1 (D7).
    const taskkill = spawn('taskkill', windowsTaskkillArgs(pid), {
      stdio: 'ignore',
      windowsHide: true
    })
    taskkill.on('error', () => {})
  } catch {
    // taskkill is best-effort during teardown.
  }
}

function windowsProcessStartTime(pid: number): Promise<number | null> {
  return new Promise((resolve) => {
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
        resolve((ticks - 621_355_968_000_000_000) / 10_000)
      }
    )
  })
}

function posixProcessStartTime(pid: number): Promise<number | null> {
  return new Promise((resolve) => {
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
