/**
 * Production dependency implementations for the {@link Supervisor}: entrypoint
 * resolution, detached spawn, ownership-marker IO, and process introspection.
 * Split out of supervisor.ts so the state machine and its runtime wiring each
 * stay focused (and under the file-size budget). The Supervisor itself takes all
 * of these as injected deps, so this file is what init.ts wires in.
 */
import { spawn, execFile } from 'node:child_process'
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, dirname, resolve as resolvePath, delimiter } from 'node:path'
import type { EntrypointResolution, OwnershipMarker, SpawnedChild } from './supervisor-types'

/**
 * Resolve the real Node entrypoint for teamclaude. On Windows a bare `.cmd`
 * spawn fails; more importantly a shim PID breaks ownership. So we locate
 * `teamclaude` on PATH (or the config override), then resolve to the real
 * `src/index.js` under the adjacent `node_modules` (npm / pnpm / volta layouts).
 * Resolution failure returns null → setup-needed.
 */
export async function resolveNodeEntrypoint(
  binPath: string | null,
  env: NodeJS.ProcessEnv = process.env
): Promise<EntrypointResolution | null> {
  const found = binPath ?? locateOnPath('teamclaude', env)
  if (!found) {
    return null
  }

  const entry = await resolveEntryFromShim(found)
  if (!entry) {
    return null
  }

  const node = locateOnPath('node', env)
  if (node) {
    return { node, entry, foundPath: found }
  }
  // Fall back to Electron's own binary run as a plain Node runtime.
  return {
    node: process.execPath,
    entry,
    foundPath: found,
    env: { ELECTRON_RUN_AS_NODE: '1' }
  }
}

function locateOnPath(name: string, env: NodeJS.ProcessEnv): string | null {
  const pathVar = env.PATH || env.Path || ''
  const exts =
    process.platform === 'win32'
      ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.toLowerCase())
      : ['']
  for (const dir of pathVar.split(delimiter)) {
    if (!dir) {
      continue
    }
    for (const ext of exts) {
      const candidate = join(dir, name + ext)
      if (existsSync(candidate)) {
        return candidate
      }
    }
    // Unix bins have no extension but PATHEXT loop already covers '' there.
    const bare = join(dir, name)
    if (process.platform !== 'win32' && existsSync(bare)) {
      return bare
    }
  }
  return null
}

/** Given a located `teamclaude` (shim, .cmd, or .js), find the real JS entry. */
async function resolveEntryFromShim(found: string): Promise<string | null> {
  if (found.toLowerCase().endsWith('.js')) {
    return existsSync(found) ? found : null
  }

  const shimDir = dirname(found)
  // 1. Adjacent node_modules layouts (npm .bin, npm global, pnpm, volta).
  const pkgDirCandidates = [
    join(shimDir, 'node_modules', 'teamclaude'),
    join(shimDir, '..', 'node_modules', 'teamclaude'),
    join(shimDir, '..', 'lib', 'node_modules', 'teamclaude')
  ]
  for (const pkgDir of pkgDirCandidates) {
    const entry = await entryFromPackage(pkgDir)
    if (entry) {
      return entry
    }
  }

  // 2. Parse the shim text for a referenced .js path (npm/pnpm shims embed one).
  try {
    const text = readFileSync(found, 'utf8')
    const match = text.match(/[^\s"']+index\.js|[^\s"']+\.js/gi)
    if (match) {
      for (const raw of match) {
        const cleaned = raw.replace(/%~dp0\\?|\$basedir\/?|"|'/g, '').trim()
        const abs = resolvePath(shimDir, cleaned)
        if (existsSync(abs)) {
          return abs
        }
      }
    }
  } catch {
    /* unreadable shim */
  }
  return null
}

async function entryFromPackage(pkgDir: string): Promise<string | null> {
  const pkgJson = join(pkgDir, 'package.json')
  if (!existsSync(pkgJson)) {
    return null
  }
  try {
    const pkg = JSON.parse(await readFile(pkgJson, 'utf8')) as {
      bin?: string | Record<string, string>
      main?: string
    }
    let rel: string | undefined
    if (typeof pkg.bin === 'string') {
      rel = pkg.bin
    } else if (pkg.bin && typeof pkg.bin === 'object') {
      rel = pkg.bin.teamclaude ?? Object.values(pkg.bin)[0]
    }
    rel = rel ?? pkg.main ?? 'src/index.js'
    const entry = join(pkgDir, rel)
    return existsSync(entry) ? entry : null
  } catch {
    return null
  }
}

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
    onExit: (cb) => {
      child.on('exit', (code) => cb(code))
      child.on('error', () => cb(null))
    },
    kill: () => {
      if (child.pid == null) {
        return
      }
      if (process.platform === 'win32') {
        try {
          const tk = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
            stdio: 'ignore',
            windowsHide: true
          })
          tk.on('error', () => {})
        } catch {
          /* taskkill unavailable */
        }
      } else {
        try {
          child.kill()
        } catch {
          /* ignore */
        }
      }
    }
  }
}

// --- ownership marker + process introspection ------------------------------

export function readMarkerFile(path: string): OwnershipMarker | null {
  try {
    const raw = readFileSync(path, 'utf8')
    const m = JSON.parse(raw) as Partial<OwnershipMarker>
    if (
      typeof m.pid === 'number' &&
      typeof m.port === 'number' &&
      typeof m.startedAt === 'number'
    ) {
      return { pid: m.pid, port: m.port, startedAt: m.startedAt }
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
    /* best-effort */
  }
}

export function clearMarkerFile(path: string): void {
  try {
    rmSync(path, { force: true })
  } catch {
    /* ignore */
  }
}

export function markerPath(userDataDir: string): string {
  return join(userDataDir, 'teamclaude-owned-proxy.json')
}

/** Force-kill a process tree by pid. Mirrors the spawned child's `kill()` (a
 *  Windows `taskkill /T /F` tree kill; POSIX SIGTERM) so a RECLAIMED owned
 *  server — which has no child handle — can still be stopped. */
export function killProcess(pid: number): void {
  if (process.platform === 'win32') {
    try {
      const tk = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true
      })
      tk.on('error', () => {})
    } catch {
      /* taskkill unavailable */
    }
    return
  }
  try {
    process.kill(pid)
  } catch {
    /* already gone / not signalable */
  }
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM → exists but not signalable (still alive); ESRCH → gone.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
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
          // .NET ticks (100ns since 0001-01-01) → epoch ms.
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
