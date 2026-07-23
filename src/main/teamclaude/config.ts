/**
 * TeamClaude config resolution + live watch. Spec §4 (config.ts).
 *
 * Resolves the config path honoring TEAMCLAUDE_CONFIG / XDG_CONFIG_HOME (mirror
 * of teamclaude's own getConfigPath so both sides always agree), reads
 * port/apiKey, and watches for changes with a debounce that re-arms across
 * atomic file replacement (teamclaude writes via tmp+rename, which invalidates a
 * file-scoped fs.watch — so we watch the parent directory instead).
 *
 * On a port change the owner (init.ts) tears down client + supervisor and
 * re-initializes on the new port; this module only reports the change.
 */
import { watch, type FSWatcher } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { EventEmitter } from 'node:events'

export type TcConnectionConfig = {
  port: number
  apiKey: string
  /** Optional explicit path to the teamclaude entrypoint/shim (config override
   *  consulted by the supervisor when PATH lookup fails). */
  binPath: string | null
}

const DEFAULT_PORT = 3456

/** Mirror of teamclaude src/config.js getConfigPath(): TEAMCLAUDE_CONFIG wins,
 *  else XDG_CONFIG_HOME/teamclaude.json, else ~/.config/teamclaude.json. */
export function getTeamclaudeConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.TEAMCLAUDE_CONFIG) {
    return env.TEAMCLAUDE_CONFIG
  }
  const configDir = env.XDG_CONFIG_HOME || join(homedir(), '.config')
  return join(configDir, 'teamclaude.json')
}

type RawTcConfig = {
  proxy?: { port?: number; apiKey?: string }
  binPath?: string
}

/** Read + normalize connection fields. Missing/corrupt config → null (the
 *  "not set up yet" state); never throws. */
export async function readConnectionConfig(
  env: NodeJS.ProcessEnv = process.env
): Promise<TcConnectionConfig | null> {
  let raw: string
  try {
    raw = await readFile(getTeamclaudeConfigPath(env), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    return null
  }
  let parsed: RawTcConfig
  try {
    parsed = JSON.parse(raw) as RawTcConfig
  } catch (error) {
    console.error(`[teamclaude-config] ignoring unparseable config: ${(error as Error).message}`)
    return null
  }
  const port = Number(parsed.proxy?.port) || DEFAULT_PORT
  const apiKey = typeof parsed.proxy?.apiKey === 'string' ? parsed.proxy.apiKey : ''
  const binPath = typeof parsed.binPath === 'string' && parsed.binPath ? parsed.binPath : null
  return { port, apiKey, binPath }
}

export type ConfigWatcherEvents = {
  /** Emitted (debounced) whenever the resolved connection config changes.
   *  `previous` is null on the very first resolution. */
  change: (next: TcConnectionConfig | null, previous: TcConnectionConfig | null) => void
}

/**
 * Watches the config file for changes. Watches the PARENT directory (not the
 * file) so an atomic tmp→rename replacement — which detaches a file-scoped
 * watch — is still observed. Debounced to coalesce the rename storm.
 */
export class TeamclaudeConfigWatcher extends EventEmitter {
  private readonly env: NodeJS.ProcessEnv
  private readonly path: string
  private readonly dir: string
  private readonly file: string
  private watcher: FSWatcher | null = null
  private debounce: NodeJS.Timeout | null = null
  private current: TcConnectionConfig | null = null
  private started = false

  constructor(env: NodeJS.ProcessEnv = process.env) {
    super()
    this.env = env
    this.path = getTeamclaudeConfigPath(env)
    this.dir = dirname(this.path)
    this.file = basename(this.path)
  }

  override on<E extends keyof ConfigWatcherEvents>(
    event: E,
    listener: ConfigWatcherEvents[E]
  ): this {
    return super.on(event, listener as (...args: unknown[]) => void)
  }
  override emit<E extends keyof ConfigWatcherEvents>(
    event: E,
    ...args: Parameters<ConfigWatcherEvents[E]>
  ): boolean {
    return super.emit(event, ...args)
  }

  /** Resolve the initial config and begin watching. Returns the initial value. */
  async start(): Promise<TcConnectionConfig | null> {
    if (this.started) {
      return this.current
    }
    this.started = true
    this.current = await readConnectionConfig(this.env)
    this.arm()
    return this.current
  }

  get value(): TcConnectionConfig | null {
    return this.current
  }

  private arm(): void {
    if (this.watcher) {
      return
    }
    try {
      this.watcher = watch(this.dir, { persistent: false }, (_event, filename) => {
        // Some platforms report null filename; re-check unconditionally then.
        if (filename && basename(filename.toString()) !== this.file) {
          return
        }
        this.schedule()
      })
      this.watcher.on('error', () => this.rearm())
    } catch {
      // Directory may not exist yet (config never created). Retry arming later;
      // schedule a re-check so a freshly created config is still picked up.
      this.scheduleRearm()
    }
  }

  private rearm(): void {
    if (this.watcher) {
      try {
        this.watcher.close()
      } catch {
        /* ignore */
      }
      this.watcher = null
    }
    this.scheduleRearm()
  }

  private scheduleRearm(): void {
    setTimeout(() => {
      if (!this.started) {
        return
      }
      this.arm()
      this.schedule()
    }, 1000).unref?.()
  }

  private schedule(): void {
    if (this.debounce) {
      return
    }
    this.debounce = setTimeout(() => {
      this.debounce = null
      void this.reload()
    }, 200)
    this.debounce.unref?.()
  }

  private async reload(): Promise<void> {
    const next = await readConnectionConfig(this.env)
    const prev = this.current
    if (!changed(prev, next)) {
      return
    }
    this.current = next
    this.emit('change', next, prev)
  }

  stop(): void {
    this.started = false
    if (this.debounce) {
      clearTimeout(this.debounce)
      this.debounce = null
    }
    if (this.watcher) {
      try {
        this.watcher.close()
      } catch {
        /* ignore */
      }
      this.watcher = null
    }
  }
}

function changed(a: TcConnectionConfig | null, b: TcConnectionConfig | null): boolean {
  if (a === null || b === null) {
    return a !== b
  }
  return a.port !== b.port || a.apiKey !== b.apiKey || a.binPath !== b.binPath
}
