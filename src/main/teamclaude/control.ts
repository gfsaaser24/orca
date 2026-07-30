/**
 * TeamClaude control plane — pin / routes / account / effort mutations. Spec §4
 * (control.ts) + §3 (Phase-0 mutation endpoints). NO config-file writes: every
 * mutation flows through the single server process (the lone writer), which
 * applies disk + runtime state atomically before returning 200 (spec §3.5c).
 *
 * `x-api-key` is REQUIRED on mutating endpoints even from loopback (§3.5c), so
 * every mutation sends it. The one read that lives here — GET /teamclaude/effort
 * — is unauthenticated by contract and must NOT send it. All methods resolve to
 * a typed result and never throw: a down/slow proxy or a non-2xx body becomes
 * `{ ok: false, error }` so IPC handlers never reject and the UI can simply
 * re-read state.
 */
import http from 'node:http'
import type {
  TcAccountSetPayload,
  TcEffortLevel,
  TcEffortState,
  TcRoute
} from '../../shared/teamclaude-types'

export type ControlResult = {
  ok: boolean
  /** Populated on failure — a user-facing (English) reason. */
  error?: string
  /** HTTP status when a response was received. */
  status?: number
}

/** Result of an effort read/write. `ok: true` carries the proxy's post-call
 *  state, where `null` legitimately means "no override". */
export type EffortResult = { ok: true; effort: TcEffortState } | { ok: false; error: string }

const EFFORT_PATH = '/teamclaude/effort'
const EFFORT_LEVELS: ReadonlySet<string> = new Set<TcEffortLevel>([
  'none',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
])

type RawResponse = {
  status?: number
  status2xx: boolean
  json: Record<string, unknown> | null
  error?: string
}

type RawRequest = {
  method: 'GET' | 'POST'
  path: string
  body?: unknown
  /** Mutations REQUIRE `x-api-key` even from loopback (§3.5c); plain reads must
   *  NOT send it — GET /teamclaude/effort is unauthenticated by contract. */
  sendApiKey: boolean
}

/** POST /teamclaude/account keys on `id`, which dual-accepts a stable account id
 * OR a name; an unknown id plus {type,apiKey,upstream} creates the account.
 * It is `id` — NOT `name` — and sending `name` fails with
 * "id (string) is required". `models-sync` already used `id`; keep both callers
 * on this type so they cannot drift apart again. */
export type TeamclaudeBackendAccountUpsert = {
  id: 'cliproxy'
  type: 'apikey'
  apiKey: string
  upstream: string
  priority: 100
}

type ControlOptions = {
  port: number
  apiKey: string
  timeoutMs?: number
}

export class TeamclaudeControl {
  private readonly port: number
  private readonly apiKey: string
  private readonly timeoutMs: number

  constructor(opts: ControlOptions) {
    this.port = opts.port
    this.apiKey = opts.apiKey
    this.timeoutMs = opts.timeoutMs ?? 10_000
  }

  /** Pin the active account by stable ID, or clear the pin with `null`. */
  pin(accountId: string | null): Promise<ControlResult> {
    const path =
      accountId == null ? '/teamclaude/pin' : `/teamclaude/pin/${encodeURIComponent(accountId)}`
    return this.post(path)
  }

  /** Replace the route table. Server validates + normalizes (spec §3.1). */
  setRoutes(routes: TcRoute[]): Promise<ControlResult> {
    return this.post('/teamclaude/routes', { routes })
  }

  /** Set account flags by stable ID (spec §3.2). */
  setAccount(payload: TcAccountSetPayload): Promise<ControlResult> {
    return this.post('/teamclaude/account', payload)
  }

  /** Idempotently create/update the dedicated CPA backend account (CPA D2). */
  upsertBackendAccount(payload: TeamclaudeBackendAccountUpsert): Promise<ControlResult> {
    return this.post('/teamclaude/account', payload)
  }

  /** Trigger the cockpit OAuth login flow (spec §4 usage surfaces). */
  oauthLogin(): Promise<ControlResult> {
    return this.post('/teamclaude/oauth/login')
  }

  /** Read the proxy's current effort override. Deliberately UNAUTHENTICATED —
   *  the contract exposes GET /teamclaude/effort without `x-api-key`. */
  getEffort(): Promise<EffortResult> {
    return this.effortRequest({ method: 'GET', path: EFFORT_PATH, sendApiKey: false })
  }

  /** Set the effort override, or clear it with `null`. Authenticated mutation. */
  setEffort(level: TcEffortLevel | null): Promise<EffortResult> {
    return this.effortRequest({
      method: 'POST',
      path: EFFORT_PATH,
      body: { level },
      sendApiKey: true
    })
  }

  /** Ensure MITM certs exist for the upstream and return the CA path (spec §3.3).
   *  A SINGLE POST — cert generation is a real side effect (shared CONNECT cert
   *  lock); issuing it twice raced the generation and doubled the work (D4). */
  async ensureCerts(): Promise<{ ok: boolean; caPath?: string; error?: string }> {
    const raw = await this.postRaw('/teamclaude/certs/ensure')
    if (raw.error) {
      return { ok: false, error: raw.error }
    }
    const ok = raw.json && typeof raw.json.ok === 'boolean' ? raw.json.ok : raw.status2xx
    if (!ok) {
      const error =
        (raw.json && typeof raw.json.error === 'string' && raw.json.error) ||
        `Proxy /teamclaude/certs/ensure responded ${raw.status ?? '(no status)'}`
      return { ok: false, error }
    }
    const caPath = raw.json && typeof raw.json.caPath === 'string' ? raw.json.caPath : undefined
    return caPath ? { ok: true, caPath } : { ok: false, error: 'certs/ensure returned no caPath' }
  }

  private async post(path: string, body?: unknown): Promise<ControlResult> {
    const raw = await this.postRaw(path, body)
    if (raw.error) {
      return { ok: false, error: raw.error, ...(raw.status ? { status: raw.status } : {}) }
    }
    const ok = raw.json && typeof raw.json.ok === 'boolean' ? raw.json.ok : raw.status2xx
    if (ok) {
      return { ok: true, ...(raw.status ? { status: raw.status } : {}) }
    }
    const error =
      (raw.json && typeof raw.json.error === 'string' && raw.json.error) ||
      `Proxy ${path} responded ${raw.status ?? '(no status)'}`
    return { ok: false, error, ...(raw.status ? { status: raw.status } : {}) }
  }

  private async effortRequest(request: RawRequest): Promise<EffortResult> {
    const raw = await this.requestRaw(request)
    if (raw.error) {
      return { ok: false, error: raw.error }
    }
    const ok = raw.json && typeof raw.json.ok === 'boolean' ? raw.json.ok : raw.status2xx
    if (!ok) {
      const error =
        (raw.json && typeof raw.json.error === 'string' && raw.json.error) ||
        `Proxy ${request.path} responded ${raw.status ?? '(no status)'}`
      return { ok: false, error }
    }
    return { ok: true, effort: parseEffortState(raw.json) }
  }

  private postRaw(path: string, body?: unknown): Promise<RawResponse> {
    return this.requestRaw({ method: 'POST', path, body, sendApiKey: true })
  }

  private requestRaw(request: RawRequest): Promise<RawResponse> {
    const { method, path, body, sendApiKey } = request
    return new Promise((resolve) => {
      const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
      const req = http.request(
        {
          host: '127.0.0.1',
          port: this.port,
          path,
          method,
          headers: {
            ...(sendApiKey ? { 'x-api-key': this.apiKey } : {}),
            ...(payload
              ? { 'content-type': 'application/json', 'content-length': String(payload.length) }
              : {})
          }
        },
        (res) => {
          let buf = ''
          res.setEncoding('utf8')
          res.on('data', (c) => (buf += c))
          res.on('end', () => {
            const status = res.statusCode
            const status2xx = !!status && status >= 200 && status < 300
            let json: Record<string, unknown> | null = null
            try {
              json = buf.trim() ? (JSON.parse(buf) as Record<string, unknown>) : null
            } catch {
              json = null
            }
            resolve({ status, status2xx, json })
          })
          res.on('error', (err) => resolve({ status2xx: false, json: null, error: err.message }))
        }
      )
      req.on('error', (err) => resolve({ status2xx: false, json: null, error: err.message }))
      req.setTimeout(this.timeoutMs, () => req.destroy(new Error(`Proxy ${path} timed out`)))
      if (payload) {
        req.write(payload)
      }
      req.end()
    })
  }
}

/** Defensive read of `{ effort: { level } | null }`. Anything unrecognized (a
 *  missing key, a level this build does not know) reads as "no override" rather
 *  than leaking an unvalidated string into the frozen `TcEffortState`. */
function parseEffortState(json: Record<string, unknown> | null): TcEffortState {
  const effort = json?.effort
  if (!effort || typeof effort !== 'object') {
    return null
  }
  const level = (effort as { level?: unknown }).level
  return typeof level === 'string' && EFFORT_LEVELS.has(level)
    ? { level: level as TcEffortLevel }
    : null
}

/** Collapse an effort result — or a missing control plane — to the bridge's
 *  `TcEffortState`. A failed read/write is reported as "no override known"; the
 *  renderer never sees a raw transport error, matching how the rest of this
 *  module degrades when the proxy is offline. */
export function effortOrNull(result: EffortResult | undefined): TcEffortState {
  return result?.ok ? result.effort : null
}
