import http from 'node:http'

/** Browser-flow providers redirect to a fixed localhost port. CPA only listens
 * on that port when the auth-url request sets `is_webui`, and its forwarder
 * binds 0.0.0.0 — exposing the callback (which carries the authorization code)
 * to the whole network. Orca therefore runs the listener itself, bound to
 * loopback only, and hands the result to CPA's management oauth-callback. */
export type OauthCallbackForwarder = (params: {
  provider: string
  code: string
  state: string
  error: string
}) => Promise<void>

export type OauthCallbackServer = { close(): void }

const DONE_PAGE = (message: string): string =>
  `<!doctype html><meta charset="utf-8"><title>Sign-in</title>` +
  `<body style="font:14px system-ui;padding:3rem;text-align:center">` +
  `<p>${message}</p><p style="color:#666">You can close this tab and return to Orca.</p></body>`

/** Listen on 127.0.0.1:<port> for a single provider redirect, forward it, and
 * keep serving until closed (a user may retry in the browser). Resolves once
 * the socket is bound so callers can fail fast on a port conflict. */
export function startOauthCallbackServer(
  port: number,
  provider: string,
  forward: OauthCallbackForwarder,
  onError: (message: string) => void
): Promise<OauthCallbackServer> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const query = new URL(req.url ?? '/', `http://127.0.0.1:${port}`).searchParams
      const code = query.get('code')?.trim() ?? ''
      const state = query.get('state')?.trim() ?? ''
      const error = (query.get('error') ?? query.get('error_description'))?.trim() ?? ''
      if (!code && !error) {
        // Not the redirect (favicon, probe) — do not forward an empty callback.
        res.writeHead(204)
        res.end()
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(DONE_PAGE(error ? 'Sign-in failed.' : 'Sign-in complete.'))
      void forward({ provider, code, state, error }).catch((cause) => {
        onError(cause instanceof Error ? cause.message : String(cause))
      })
    })
    server.once('error', (cause) => reject(cause))
    // Loopback only — never 0.0.0.0.
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      server.removeAllListeners('error')
      server.on('error', (cause) => onError(cause.message))
      resolve({
        close: () => {
          server.closeAllConnections?.()
          server.close()
        }
      })
    })
  })
}
