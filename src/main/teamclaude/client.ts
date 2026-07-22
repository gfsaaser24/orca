/**
 * TeamClaude read client — /status polling + /events SSE + /log seed. Spec §4
 * (client.ts) and §2/§3 (endpoint contract).
 *
 * Transport is main-process `http.request` (not EventSource) so we can send the
 * `x-api-key` header on the SSE connection. Loopback clients are exempt from the
 * key on reads, but we send it anyway for forward-compat (spec §2).
 *
 * Dedupe: every activity row is keyed `${bootId}:${eventId}`. eventIds reset per
 * proxy process, so we track a per-bootId high-water mark — a reconnect replays
 * the ring, and a proxy restart changes the bootId, both handled by the same
 * rule (spec §5, contract TcActivityRow.key).
 */
import http from 'node:http'
import { EventEmitter } from 'node:events'
import type { TcActivityRow } from '../../shared/teamclaude-types'
import {
  ActivityDeduper,
  parseStatus,
  type RawHello,
  type RawEvent,
  type RawLog,
  type RawStatus,
  type TcStatusSnapshot
} from './client-mapping'

// Re-export the mapping surface so consumers (and tests) import from ./client.
export { ActivityDeduper, deriveReadiness } from './client-mapping'
export type { TcStatusSnapshot, TcRawEvent } from './client-mapping'

export type TcClientEvents = {
  status: (snapshot: TcStatusSnapshot) => void
  activity: (rows: TcActivityRow[]) => void
  /** A poll failed (proxy likely down). The supervisor uses this to invalidate
   *  its routing snapshot synchronously. */
  pollError: (error: Error) => void
}

type ClientOptions = {
  port: number
  apiKey: string
  /** /status poll cadence. Default 5s. */
  pollMs?: number
  /** SSE reconnect backoff. Default 2s. */
  reconnectMs?: number
}

const REQUEST_TIMEOUT_MS = 10_000

export class TeamclaudeClient extends EventEmitter {
  private readonly port: number
  private readonly apiKey: string
  private readonly pollMs: number
  private readonly reconnectMs: number
  private pollTimer: NodeJS.Timeout | null = null
  private sseDisconnect: (() => void) | null = null
  private stopped = false
  /** Per-bootId high-water eventId for dedupe across replays + restarts. */
  private readonly deduper = new ActivityDeduper()

  constructor(opts: ClientOptions) {
    super()
    this.port = opts.port
    this.apiKey = opts.apiKey
    this.pollMs = opts.pollMs ?? 5000
    this.reconnectMs = opts.reconnectMs ?? 2000
  }

  override on<E extends keyof TcClientEvents>(event: E, listener: TcClientEvents[E]): this {
    return super.on(event, listener as (...args: unknown[]) => void)
  }
  override emit<E extends keyof TcClientEvents>(
    event: E,
    ...args: Parameters<TcClientEvents[E]>
  ): boolean {
    return super.emit(event, ...args)
  }

  start(): void {
    if (this.stopped) {
      return
    }
    void this.poll()
    this.pollTimer = setInterval(() => void this.poll(), this.pollMs)
    this.pollTimer.unref?.()
    this.connectEvents()
    void this.seedActivity()
  }

  stop(): void {
    this.stopped = true
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    this.sseDisconnect?.()
    this.sseDisconnect = null
  }

  // --- HTTP helpers -------------------------------------------------------

  private json<T>(path: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const req = http.get(
        { host: '127.0.0.1', port: this.port, path, headers: { 'x-api-key': this.apiKey } },
        (res) => {
          let buf = ''
          res.setEncoding('utf8')
          res.on('data', (c) => (buf += c))
          res.on('end', () => {
            if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
              reject(new Error(`${path} responded ${res.statusCode}`))
              return
            }
            if (buf.trim() === '') {
              reject(new Error(`${path} returned an empty body`))
              return
            }
            try {
              resolve(JSON.parse(buf) as T)
            } catch {
              reject(new Error(`${path} returned a non-JSON body`))
            }
          })
          res.on('error', reject)
        }
      )
      req.on('error', reject)
      req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error(`${path} timed out`)))
    })
  }

  // --- /status ------------------------------------------------------------

  private async poll(): Promise<void> {
    if (this.stopped) {
      return
    }
    try {
      const raw = await this.json<RawStatus>('/teamclaude/status')
      this.emit('status', parseStatus(raw))
    } catch (error) {
      this.emit('pollError', error as Error)
    }
  }

  /** One-shot status read (used by the supervisor probe / adopt handshake). */
  async fetchStatus(): Promise<TcStatusSnapshot> {
    return parseStatus(await this.json<RawStatus>('/teamclaude/status'))
  }

  // --- /log seed ----------------------------------------------------------

  async seedActivity(): Promise<TcActivityRow[]> {
    try {
      const raw = await this.json<RawLog>('/teamclaude/log')
      const bootId = raw.bootId ?? null
      const rows = this.deduper.ingest(bootId, raw.events ?? [])
      if (rows.length) {
        this.emit('activity', rows)
      }
      return rows
    } catch {
      return []
    }
  }

  // --- /events SSE --------------------------------------------------------

  private connectEvents(): void {
    let req: http.ClientRequest | null = null
    let timer: NodeJS.Timeout | null = null

    const schedule = (): void => {
      if (this.stopped || timer) {
        return
      }
      timer = setTimeout(() => {
        timer = null
        connect()
      }, this.reconnectMs)
      timer.unref?.()
    }

    const connect = (): void => {
      if (this.stopped) {
        return
      }
      req = http.get(
        {
          host: '127.0.0.1',
          port: this.port,
          path: '/teamclaude/events',
          headers: { 'x-api-key': this.apiKey }
        },
        (res) => {
          let buf = ''
          res.setEncoding('utf8')
          res.on('data', (chunk: string) => {
            buf += chunk
            let sep: number
            while ((sep = buf.indexOf('\n\n')) >= 0) {
              const frame = buf.slice(0, sep)
              buf = buf.slice(sep + 2)
              this.handleFrame(frame)
            }
          })
          res.on('end', schedule)
          res.on('error', schedule)
        }
      )
      req.on('error', schedule)
    }

    connect()
    this.sseDisconnect = (): void => {
      if (timer) {
        clearTimeout(timer)
      }
      req?.destroy()
    }
  }

  private handleFrame(frame: string): void {
    const isHello = /^event:\s*hello$/m.test(frame)
    const dataLine = frame.split('\n').find((l) => l.startsWith('data:'))
    if (!dataLine) {
      return
    }
    let data: unknown
    try {
      data = JSON.parse(dataLine.slice(dataLine.indexOf(':') + 1).trim())
    } catch {
      return
    }
    if (isHello) {
      const hello = data as RawHello
      // A fresh hello may carry a new bootId + capability/version refresh; the
      // status poll owns those, but the replay ring is delivered here.
      const rows = this.deduper.ingest(hello.bootId ?? null, hello.recent ?? hello.events ?? [])
      if (rows.length) {
        this.emit('activity', rows)
      }
      return
    }
    const evt = data as RawEvent
    const rows = this.deduper.ingest(evt.bootId ?? null, [evt])
    if (rows.length) {
      this.emit('activity', rows)
    }
  }
}
