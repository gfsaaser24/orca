/**
 * TeamClaude routing seam — the ONE pure, fail-open function shared by all three
 * injection points (local PTY, daemon PTY, text-generation). Spec §2 + §4.
 *
 * Contract:
 *  - `TEAMCLAUDE_RUN_GUARD=1` is set UNCONDITIONALLY (even proxy-down, even the
 *    carve-outs) so nested `claude`/`happy` shims short-circuit and never
 *    double-route. It is applied before any risky logic so a thrown error still
 *    leaves the guard in place.
 *  - Proxy vars (HTTPS_PROXY/HTTP_PROXY + lowercase, NO_PROXY/no_proxy) and the
 *    CA cert are added ONLY when the launch is actually routed.
 *  - `ANTHROPIC_BASE_URL` is removed ONLY when its PARSED ORIGIN points at the
 *    TeamClaude proxy (loopback host + a current-or-historical owned port). A
 *    user-set corporate gateway / Bedrock URL is preserved and the launch is
 *    left FULLY unrouted (no proxy vars, no CA) — never a half-routed hybrid.
 *  - Deletions ride the returned `envToDelete[]` so daemon callers (which
 *    re-merge their own inherited `process.env`) can propagate removals; the
 *    same names are also removed from the returned `env` map for in-process
 *    callers.
 *  - Fully fail-open: any internal error returns the input env unchanged (except
 *    the guard, which is best-effort preserved). Agents must never fail to
 *    launch because of TeamClaude.
 */

export type RoutingKind = 'agent' | 'textgen'

export type RoutingSnapshot = {
  /** True when the proxy answered its probe within the snapshot TTL. */
  proxyUp: boolean
  /** The currently configured proxy port. */
  port: number
  /** MITM CA path (from certs/ensure). Null when unknown/unavailable — a
   *  routed launch without a CA would break TLS, so null forces unrouted. */
  caPath: string | null
  /** Current + a small history of previously-owned proxy ports, for scoped
   *  stale `ANTHROPIC_BASE_URL` cleanup by parsed origin. */
  knownPorts: number[]
  /** Seam-supplied: Orca's Network Proxy is user-configured. TeamClaude cannot
   *  chain an upstream proxy, so when true the launch is left fully unrouted
   *  (same carve-out as a preserved corporate base URL). The seam wave supplies
   *  the real settings value; the core defaults it false. */
  orcaNetworkProxyConfigured: boolean
}

export type RoutingResult = {
  /** The env map to launch with (guard always set; proxy vars only when routed). */
  env: NodeJS.ProcessEnv
  /** Var names the caller must delete from any inherited env it re-merges. */
  envToDelete: string[]
}

const GUARD = 'TEAMCLAUDE_RUN_GUARD'
const BASE_URL = 'ANTHROPIC_BASE_URL'
const NO_PROXY_VALUE = 'localhost,127.0.0.1,::1'
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/** Parse an `ANTHROPIC_BASE_URL` and decide whether its origin is the TeamClaude
 *  proxy (loopback host + a known owned port). Non-loopback or unknown-port URLs
 *  (corporate gateway, Bedrock, api.anthropic.com) return false → preserved. */
/**
 * Whether an inherited `ANTHROPIC_BASE_URL` (e.g. from the daemon host's own
 * `process.env`, which spawn-request envs deliberately exclude) points at the
 * TeamClaude proxy and must therefore ride `envToDelete` so the daemon's
 * re-merge cannot resurrect it. A non-TeamClaude (corporate/Bedrock) value
 * returns false and is preserved.
 */
export function isStaleTeamclaudeBaseUrl(
  value: string | undefined,
  snapshot: Pick<RoutingSnapshot, 'knownPorts'>
): boolean {
  if (typeof value !== 'string' || value.trim() === '') {
    return false
  }
  try {
    return isTeamclaudeBaseUrl(value, snapshot.knownPorts)
  } catch {
    return false
  }
}

function isTeamclaudeBaseUrl(value: string, knownPorts: number[]): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  const host = url.hostname.toLowerCase()
  if (!LOOPBACK_HOSTS.has(host)) {
    return false
  }
  // Default ports: http→80, https→443. TeamClaude always runs on an explicit
  // loopback port, so an empty url.port means "not our proxy".
  if (url.port === '') {
    return false
  }
  const port = Number(url.port)
  return knownPorts.includes(port)
}

export function applyRouting(
  env: NodeJS.ProcessEnv,
  kind: RoutingKind,
  snapshot: RoutingSnapshot
): RoutingResult {
  // Guard is set on a shallow copy first, outside the risky block, so even a
  // catastrophic failure below still yields a guarded env.
  let out: NodeJS.ProcessEnv
  try {
    out = { ...env }
    out[GUARD] = '1'
  } catch {
    return { env, envToDelete: [] }
  }

  const envToDelete: string[] = []

  try {
    const baseUrlRaw = out[BASE_URL]
    const hasBaseUrl = typeof baseUrlRaw === 'string' && baseUrlRaw.trim() !== ''
    const baseUrlIsTeamclaude = hasBaseUrl
      ? isTeamclaudeBaseUrl(baseUrlRaw as string, snapshot.knownPorts)
      : false

    // Carve-outs → fully unrouted (no proxy vars, no CA), guard already set.
    //  1. Orca Network Proxy configured (cannot compose with TeamClaude).
    //  2. A preserved non-TeamClaude base URL (corporate gateway / Bedrock).
    const preservedBaseUrl = hasBaseUrl && !baseUrlIsTeamclaude
    if (snapshot.orcaNetworkProxyConfigured || preservedBaseUrl) {
      return { env: out, envToDelete }
    }

    // The kind currently routes identically for agent vs textgen; it is part of
    // the frozen seam signature and reserved for future per-kind divergence.
    void kind

    const routed = snapshot.proxyUp && typeof snapshot.caPath === 'string' && snapshot.caPath !== ''

    if (routed) {
      const proxyUrl = `http://127.0.0.1:${snapshot.port}`
      out.HTTPS_PROXY = proxyUrl
      out.HTTP_PROXY = proxyUrl
      out.https_proxy = proxyUrl
      out.http_proxy = proxyUrl
      out.NO_PROXY = NO_PROXY_VALUE
      out.no_proxy = NO_PROXY_VALUE
      out.NODE_EXTRA_CA_CERTS = snapshot.caPath as string
      // A stale TeamClaude base URL would override the proxy — remove it.
      if (baseUrlIsTeamclaude) {
        delete out[BASE_URL]
        envToDelete.push(BASE_URL)
      }
      return { env: out, envToDelete }
    }

    // Proxy down (and not a carve-out): remove a base URL that points at the
    // dead proxy port; touch nothing else. Guard stays set for the fallback.
    if (baseUrlIsTeamclaude) {
      delete out[BASE_URL]
      envToDelete.push(BASE_URL)
    }
    return { env: out, envToDelete }
  } catch {
    // Any failure in the routing logic: keep the guarded env, add nothing.
    return { env: out, envToDelete }
  }
}
