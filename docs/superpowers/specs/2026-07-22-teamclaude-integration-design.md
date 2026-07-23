# Orca TC — TeamClaude Integration Design & Plan (v2.2)

**Date:** 2026-07-22 (v2.2 — three reviewers, five review passes: Kimi K3 ×2, Codex gpt-5.6-sol ×2, Claude Fable 5 subagent ×1; all findings incorporated; see companion review files)
**Repos:** `C:\code\orca-ide` (fork of stablyai/orca, MIT) — primary; `C:\code\teamclaude` — prerequisite phase
**Status:** Draft v2 for re-review

## 1. Goal & locked decisions

Build "Orca TC": a side-by-side branded Windows build of the Orca fork where every Claude-bound feature routes through the TeamClaude proxy, with a full cockpit UI for the account fleet.

- **Scope: full cockpit** — routing + fleet visibility + control.
- **Proxy ownership: adopt-or-spawn**, desktop app coexistence.
- **Install: side-by-side**, official Orca untouched. **v1 ships Windows/NSIS only** (Linux/mac identity namespacing deferred).
- **UI: status-bar widget + flyout + dedicated panel.**
- **One source of truth**: TeamClaude feeds Orca's usage surfaces when connected.
- **Out of scope v1**: WSL-side and SSH-remote agents (explicit "not routed (remote)" UI state, never silent).

## 2. Context facts (verified; corrected after review)

- TeamClaude HTTP API on `127.0.0.1:<port>` (default 3456): `GET /teamclaude/status`, `GET /teamclaude/events` (SSE; 200-event replay ring, numeric IDs reset per process), `GET /teamclaude/log` (returns `{events:[...]}` from the same ring), `POST /teamclaude/pin`, `POST /teamclaude/reload`, `POST /teamclaude/oauth/login`. **Loopback clients are exempt from `x-api-key` on BOTH the HTTP path and CONNECT** (server.js:55); we send the key anyway for forward-compat.
- Routing env contract (mirror of `teamclaude run`, index.js:647-661): set `TEAMCLAUDE_RUN_GUARD=1` **unconditionally (before the probe — the proxy-down fallback needs it too)**; when proxy up: `HTTPS_PROXY`/`HTTP_PROXY`/`https_proxy`/`http_proxy` → proxy URL, **both** `NO_PROXY` and `no_proxy` → `localhost,127.0.0.1,::1`, `NODE_EXTRA_CA_CERTS` → CA path, remove `ANTHROPIC_BASE_URL`; when down: remove an `ANTHROPIC_BASE_URL` pointing at the dead proxy port, touch nothing else.
  - **Deviation from `teamclaude run` (deliberate):** `ANTHROPIC_BASE_URL` is removed **only when it points at the TeamClaude proxy** (loopback + configured port). A user-set corporate gateway/Bedrock URL is preserved and that launch is left **fully unrouted — no proxy vars, no CA cert either** (never a half-routed hybrid), with a cockpit notice.
- Orca env assembly is **imperative, not a pure chain**: `LocalPtyProvider` merges env, invokes a sync callback (receiving `command`, `launchAgent`, WSL context — no `agentId`), then applies deletions and WSL processing (local-pty-provider.ts:652-714). **At startup the local provider is replaced by a daemon adapter; daemon spawns never run the local callback** (daemon-init.ts:577, pty.ts:3825/4014). The daemon re-merges its inherited `process.env` and honors an explicit `envToDelete` list (pty-subprocess.ts:570-588).
- Claude-backed text generation (commit messages, PR fields, branch names) is a **third spawn path**: its own env preparation + direct `child_process.spawn` (commit-message-agent-environment.ts:107, commit-message-text-generation.ts:565-1018). It is env-driven — no Electron networking — so env injection works there.
- Orca's native usage fetch uses **Electron `net.fetch`** with proxy rules bridged from `process.env` into `session.defaultSession` (claude-fetcher.ts:432-446, proxy-settings.ts:41). Usage source order is **hardcoded OAuth-first, optional CLI; `'web'` is a deferred stub** (claude-usage-refresh-plan.ts:22-38). `RateLimitService` prepares/refreshes OAuth credentials via Electron networking **before** fetching, including for inactive accounts (service.ts:519/1349/1696, oauth-refresh.ts:133).
- Desktop-app portables: `proxy-client.ts` (SSE via main-process `http.request` + `x-api-key` — no EventSource header limitation), `supervisor.ts` (probe = HTTP 2xx on `/status`, spawn, exponential backoff internal to the class; **`crash-backoff.ts` is window-recreation logic, not proxy logic — do not port it**), `teamclaude-config.ts`.
- Dev isolation mechanism that actually exists: Orca's `ORCA_DEV_USER_DATA_PATH` (configure-process.ts:179-205); TeamClaude desktop uses early `app.setPath('userData', …)`. There is no appId-env-override mechanism.
- TeamClaude mints MITM certs **lazily on the first intercepted CONNECT**; the CA path is derived, not stored in config (mitm.js:39, server.js:165-171).
- Fork base: 1.4.146-rc.0 (package.json). First step is an upstream merge; treat "installed official = 1.4.150" as unverified environment info, not a plan input.

## 3. Phase 0 — TeamClaude prerequisites (own repo, ships first)

Orca TC requires a minimum TeamClaude version; the adopt handshake checks it (see §6). Changes:

1. **`GET/POST /teamclaude/routes`** — server-side validation + normalization (route account references: **stable IDs** per item 5b, with plain-string account *names* dual-accepted during a deprecation window; objects always rejected), persisted via the existing `atomicConfigUpdate`. Removes all config-file writing from Orca TC and closes the corruption loop.
1b. **Field audit**: compare `/teamclaude/status` quota output against every field Orca's `ProviderRateLimits` requires (per-bucket reset timestamps, fable bucket, window labels); add any missing fields to `/status` in this phase so Phase 4's meter gate is achievable.
2. **`POST /teamclaude/account`** — `{id, disabled?, priority?}` (stable ID per 5b; `name` dual-accepted during the deprecation window since the desktop pin UI sends name/index tokens today — desktop Accounts/pin migration to IDs is in this phase's scope alongside the Routing.tsx fix) with the same atomic path.
3. **`POST /teamclaude/certs/ensure`** — calls `ensureCerts(upstreamHost)` **with the configured upstream hostname** (same derivation as the CONNECT path) and **shares the CONNECT path's process-wide generation lock** (one memoized promise) so endpoint and first-CONNECT can't race PID-named temp files. Returns `{caPath}`.
4. **Status/hello envelope**: add `{version, bootId, capabilities:[...]}` to `/teamclaude/status` and the SSE hello, and `{bootId, events}` to `/teamclaude/log` (a restart between seed and subscribe must not mis-associate seed events). Capabilities use a versioned vocabulary the client maps to derived readiness states — `usageReady`, `routingReady`, `controlReady` — each cockpit surface gates on its own readiness, not on mere transport connection.
5. **`durationMs` on request-end events** — so the Activity tab needs no client-side correlation.
5b. **Identity + freshness fields in `/status` accounts**: expose the stable account identity (existing UUID+organization from identity.js) and email alongside the display name, plus per-account `observedAt` for quota buckets (quota is restored passively and probing is off by default — HTTP receipt time is NOT freshness). Mutation endpoints (routes/account/pin) target accounts **by stable ID only** — names collide and indices shift after removal.
5c. **Mutation-endpoint hardening**: `x-api-key` **required** on all mutating endpoints even from loopback (reads and CONNECT keep the loopback exemption); each mutation applies disk + runtime state atomically (or awaits reload) **before** returning 200 — persisted-but-not-live responses are lies. All Orca TC mutations flow through the single server process, making it the lone writer for these fields; residual CLI/desktop direct-config-write races are pre-existing and get a follow-up (serialize `atomicConfigUpdate` in-process).
6. **Desktop `Routing.tsx` bug fix** — it currently seeds its editor from the `/status` display DTO (`{name, eligible}` objects) and writes that back, which is the root cause of the existing config corruption. Point it at the new routes endpoints. Add the `setRoutes()` string/shape filter as defense-in-depth, plus a one-time config cleanup migration.
7. **`server --headless` exit code for "no accounts"** — distinct exit code so a supervisor can classify setup-needed vs crash (used by §6).

*(Related, already-agreed, independent: model-scoped throttling + opus→fable route rewrite. Sequenced separately.)*

## 4. Orca TC architecture

`src/main/teamclaude/` — no imports from the teamclaude repo; HTTP/SSE only:

```
config.ts       — resolve config path honoring TEAMCLAUDE_CONFIG/XDG_CONFIG_HOME;
                  read port/apiKey; fs.watch with debounce + re-arm on file replacement;
                  on port change: tear down client + supervisor and re-init
supervisor.ts   — state machine: probing → adopted | owned | setup-needed | offline;
                  spawns the resolved Node entrypoint DIRECTLY (never the .cmd shim —
                  a shell-wrapper PID makes the ownership marker meaningless and kill
                  orphans the real listener); on config port change: stop the old owned
                  process BEFORE re-initializing on the new port (teamclaude binds once;
                  /reload does not rebind — an orphan would squat the old port forever)
client.ts       — /status polling + SSE (http.request + x-api-key), reconnect with
                  bootId:eventId dedupe; normalizes fleet state
routing-env.ts  — ONE pure fail-open function applyRouting(env, kind, probeSnapshot)
                  used by all three seams; also computes envToDelete entries
control.ts      — pin / routes / account ops via Phase-0 endpoints ONLY (no config writes)
ipc.ts          — tc:state pushes (batched, ≤10 Hz), tc:pin, tc:routes:set,
                  tc:account:set, tc:proxy:start|stop, tc:log:tail; payload schemas
                  defined in src/shared/teamclaude-types.ts
```

### Supervisor state machine

- **probing**: `GET /status` (2xx + parse) with `x-api-key`. Success → **adopted** (+capability/version check; unsupported → adopted-degraded with per-tab gating).
- Probe fail → resolve `teamclaude` binary (PATH, then config override). Missing → **setup-needed** ("install teamclaude", doc link; no retry loop).
- Spawn `teamclaude server --headless` **detached** (`detached:true, stdio:'ignore', windowsHide:true, unref`) → **owned**; write ownership marker `{pid, port, startedAt}` to userData. **Entrypoint resolution algorithm** (bare `.cmd` spawn fails on Windows; the desktop uses `shell:true` for this reason — we don't): locate `teamclaude` on PATH → if it's a `.cmd`/shim, parse/resolve to the real `src/index.js` under the adjacent `node_modules` (npm/pnpm/volta layouts) and spawn `node <entry> server --headless`; resolution failure → **setup-needed** with the found-but-unresolvable path shown, never a spawn-crash backoff loop. Exit with the no-accounts code → **setup-needed** ("run teamclaude login"); other exits → backoff restart (cap 5, then **offline** with manual retry).
- **Spawn race (TOCTOU)**: teamclaude exits cleanly on port-in-use (tested upstream behavior) → on child exit, re-probe; healthy listener → **adopted**. Orca TC itself takes Electron's single-instance lock.
- **Stopping the proxy is loud**: any deliberate stop (Proxy-tab button, quit-with-stop-toggle, port-change migration) counts live routed sessions first and confirms — routed sessions carry frozen `HTTPS_PROXY` env, and daemon PTYs deliberately outlive Orca TC, so killing the listener costs those sessions *all* HTTPS egress (worse than unrouted). After a proxy restart, surviving sessions get a "stale routing env — restart session" label.
- **Module lifecycle**: supervisor/client/config init is an **app-lifetime singleton** (daemon-init style), never wired into `attachMainWindowServices` — that function re-runs on every window recreation (crash recovery, macOS re-activation) and would duplicate SSE connections, spawns, and marker churn. Only the `tc:state` push target rebinds per window.
- **Quit**: owned server is left running by default (it's detached; "stop proxy when I quit" toggle available). **Relaunch reclaims ownership** via the marker file — reclaim requires pid alive **and process start time matches the marker's `startedAt` (±2s)** and port matches; a PID-recycled impostor or someone else's server fails the check and is adopted instead. No "managed externally" drift, no orphan accumulation.
- **Adopted server dies**: re-probe with 2s + jitter for 10s (gives the desktop app's own restart the first move), then spawn.

### Routing seams — three injection points, one function

`applyRouting(env, kind, snapshot)` where `kind ∈ {agent, textgen}` and `snapshot` is the cached probe state (async-refreshed, TTL 2s, owned by supervisor — the seams themselves stay sync). The supervisor **invalidates the snapshot synchronously on every state transition it observes** (owned child exit, SSE drop, failed poll), so the TTL only bounds deaths nobody has noticed yet; the residual ≤2s window matches today's shim behavior and is accepted.

1. **Local PTY** — the existing sync env callback in `LocalPtyProvider`. **Claude-family predicate, enumerated**: `launchAgent ∈ {claude, claude-agent-teams, openclaude}` wins when present; otherwise fall back to Orca's executable detection on `command`; ambiguity resolves to *not routed* (fail-open means fail-direct, never fail-broken). Skip when WSL/SSH context present.
2. **Daemon PTY** — inject at the daemon spawn-request assembly in `pty.ts` (the host side that builds the request), and add stale-proxy `ANTHROPIC_BASE_URL` to the request's `envToDelete` so the daemon's re-merge of its inherited `process.env` cannot resurrect it. Deletions must ride `envToDelete`; additions ride the env map — both derived from the same `applyRouting` result.
3. **Text generation** — inject in `commit-message-agent-environment.ts` env preparation (covers commit/PR/branch generation). **Both SSH-backed and WSL-backed text generation** (`ssh-git-provider`; `wsl.exe` runs via `options.wslDistro`, commit-message-text-generation.ts:323-331) are part of the remote out-of-scope contract: skipped by the seam and labeled unrouted, never silently direct — a `127.0.0.1` proxy and a Windows CA path are meaningless inside WSL.

**Orca's own hidden claude spawns get the guard**: the native CLI usage fallback spawns `claude` from PATH (claude-pty.ts:240-295) — on shim machines that resolves to the shim → `teamclaude run` → fleet-rotated auth, attributing a *random fleet account's* usage numbers to whichever Orca account was being refreshed. All Orca-internal claude spawns set `TEAMCLAUDE_RUN_GUARD=1` with no proxy env (they want the local account, direct). Added to §8's shim-coexistence tests.

**Guard-inheritance caveat (accepted, surfaced)**: a session launched during a proxy-down window carries the guard with no proxy env; nested `claude`/`happy` inside it stay unrouted for the session's lifetime — which in Orca can span days. Same semantics as `teamclaude run`, but the exposure window is wider than the ≤2s snapshot residual, so sessions get a persistent "launched unrouted" chip from launch-time state (not just live proxy state).

**Auth-preparation gate (companion to all three seams)**: PTY and text-gen launches call Orca's `prepareClaudeAuth` *before* env assembly. **The gate is surgical, not wholesale**: `prepareClaudeAuth` also produces `envPatch` (`CLAUDE_CONFIG_DIR` selecting the managed account's credential store, runtime-auth-service.ts:40-49) plus credential materialization and `stripAuthEnv` — all of which fleet-routed launches still need (skipping them boots the CLI against a stale/absent credential store and triggers its login flow). For fleet-routed launches while `usageReady`, skip **only** `refreshManagedAccountTokenIfNeeded` (the Electron-network token rotation); keep envPatch, materialization, and strip behavior intact. Honest framing: "native credentials untouched while connected" is unattainable anyway — the claude CLI self-refreshes its OAuth through the proxy's raw `/v1/oauth/token` passthrough (teamclaude server.js:210); the gate merely stops Orca-initiated rotations. Unrouted launches keep stock preparation.

**Orca Network Proxy settings precedence (both PTY seams)**: Orca already injects user-configured proxy env into agent spawns — `buildPtyHostEnv` applies `buildConfiguredProxyEnv(networkProxySettings)` (pty.ts:857, wired at :1612 local and :4027 daemon), including `NO_PROXY=''` when no bypass rules exist. TeamClaude does not chain upstream proxies, so the two cannot compose: **when Orca's network proxy is configured, claude launches are left fully unrouted with a cockpit notice** (same rule as the preserved-base-URL carve-out). `applyRouting` must be injected with awareness of `buildConfiguredProxyEnv` ordering so neither silently clobbers the other.

Fail-open everywhere: any internal error returns env unchanged; agents must never fail to launch because of TeamClaude. Stale-base-URL cleanup compares **parsed origins** (not string equality — pinned paths like `/tc-acct/<name>` and query variants must match) against the current port **plus a small history of previously-owned ports**.

### Usage feed & account surfaces (one truth)

- Short-circuit at the **refresh-plan/service layer**, not inside `claude-fetcher.ts`: when client state is connected, `RateLimitService` skips OAuth preparation, token refresh, and native fetches entirely (active AND inactive accounts) and consumes the fleet snapshot. Disconnected → existing OAuth/CLI plan unchanged.
- Mapping: teamclaude account ↔ Orca account by the **stable ID (UUID+organization) exposed in Phase 0**. Not free on the Orca side: stored account records carry email + organizationUuid only; `accountUuid` lives inside each account's credentials JSON (runtime-auth-service.ts:62-66) — **persist `accountUuid` onto the account record at login/capture time** (one-time backfill migration reads credentials once) rather than reading credentials at every mapping. Email as display fallback; duplicate emails → warning badge; unmatched teamclaude accounts still render in the cockpit (fleet is the superset); unmatched **Orca** accounts render greyed "not in fleet" while connected (their launches are still fleet-routed — routing is per-request, not per-account). **Active-meter selection**: the account TeamClaude's routing would pick for the session's model (default: the proxy's current account; model-routed sessions show their route's account). Utilization 0–1 → 0–100, clamped at 100 with an "overage" badge; per-bucket resets mapped to Orca's window fields; freshness from Phase-0 `observedAt` (never HTTP receipt time), stale badge when >5min.
- **Scope of the short-circuit**: gates **host-local Claude targets only**. Orca's WSL/SSH runtime targets keep their native usage tracking, visibly labeled as separate — remote work is unrouted, so fleet meters would misrepresent it.
- **Transition quiesce**: entering the short-circuit stops *new* native refreshes but always lets an in-flight OAuth rotation commit its replacement token (a single-use refresh token dropped mid-rotation bricks that account's local auth).
- **Disconnect handling**: while connected, Orca's native tokens are left untouched (no refresh, no decay management). On disconnect, meters mark stale immediately and the native refresh plan resumes **staggered with jitter** (no refresh storm across accounts); tokens that expired while dormant refresh through the existing OAuth path on first use.
- Orca's **add/login account surface**: when connected, replaced by a "managed by TeamClaude" state linking to cockpit OAuth (`POST /teamclaude/oauth/login`); native `claude auth login` child flows disabled to keep credential ownership single-writer. Disconnected → stock behavior.

## 5. Cockpit UI

As v1 draft (widget → flyout → panel: Accounts / Routes / Activity / Proxy) with these review-driven specifics:

- **Offline degradation matrix**: widget shows grey dot + "direct"; flyout shows last-known fleet greyed with age stamp; Accounts/Routes controls disabled with reason tooltip; Activity keeps history, banner "proxy offline"; Proxy tab is the only active surface (start/retry/setup guidance).
- **Adopted-degraded** (old server): tabs requiring missing capabilities show "update teamclaude (have vX, need vY)".
- Pin is presented as **session-scoped** ("resets when proxy restarts") matching teamclaude's intentional runtime-only pin.
- Activity rows come from the event ring (`/log` seed + SSE tail), keyed `bootId:eventId`, latency from `durationMs`.
- Remote (WSL/SSH) agents show a "not routed (remote)" chip instead of nothing.

## 6. Branding & packaging (Windows, full namespace)

- **userData namespacing is the load-bearing change, and it lives in `package.json`, not `dev-instance-identity.ts`**: packaged userData resolves from package.json `name: "orca"`, captured by `initDataPath()` deliberately *before* `app.setName()` runs (persistence.ts:320-333; index.ts:649 vs :1760) — patching only the identity constants changes dock title/AppUserModelID while both apps still share `%APPDATA%\orca` **and the userData-scoped single-instance lock** (launching Orca TC while official Orca runs would silently no-op). Change package.json `name`/`productName` to `orca-tc`/`Orca TC` (plus the identity constants for display/AppUserModelID), and note for upstream merges: the stock capture-before-setName ordering is intentional — do not "fix" it.
- Executable `OrcaTC.exe`, NSIS shortcut/uninstall names.
- **Updater hard-gated in code**: the StablyAI feed is hardcoded in `updater.ts` and scheduled from `attach-main-window-services.ts` — gate all of it behind a build-time `ORCA_TC` define so Orca TC never contacts the official feed. Removing builder `publish` alone is insufficient.
- **Daemon-host namespace**: relocate to `%LOCALAPPDATA%\OrcaTC\daemon-host` (daemon-host-relocation.ts) and scope the NSIS uninstall macro to the OrcaTC image/dir — stock macros would kill official Orca's shared daemon on uninstall.
- **CLI identity too**: rename the bundled CLI (`orca.cmd`/`orca.exe` → `orcatc.*`), patch the native launcher's hardcoded sibling `Orca.exe` → `OrcaTC.exe` (`native/windows-cli-launcher/OrcaCliLauncher.cs:16`), and change the standalone CLI's runtime dir default from `%APPDATA%\orca` (`src/cli/runtime/metadata.ts:42`) — otherwise `orca` CLI commands target official Orca's runtime.
- Dev runs use `ORCA_DEV_USER_DATA_PATH` (existing mechanism).
- **Upstream cadence, owned**: merge upstream before each feature phase and at least monthly (Gabe); each merge ends with the seam checklist (3 seams + identity/updater gates), ~15 min.

## 7. Error handling

- All HTTP/SSE: timeouts, typed failures into `tc:state`; nothing throws into Orca's main loop.
- `routing-env` fail-open (above). Supervisor failures land in visible states, never block app startup.
- No config-file writes from Orca TC at all (Phase-0 endpoints), eliminating cross-app write races on our side. (Desktop↔CLI config races are pre-existing and out of scope.)
- Cert preflight: `certs/ensure` at adopt/owned transition; if unavailable (old server) → agents launch **unrouted** + cockpit "update teamclaude" (never a broken MITM launch).

## 8. Testing

- Unit: `applyRouting` (up/down/base-URL-preservation/WSL-skip/textgen), supervisor state machine incl. setup-needed + reclaim-from-marker + TOCTOU (port teamclaude desktop's supervisor test patterns), fleet→meters mapping (clamp, email match, unmatched accounts), SSE dedupe across simulated proxy restart (bootId change).
- Integration: stub teamclaude server (status/events/routes/certs) — client reconnect, IPC batching, capability degradation.
- **Shim coexistence e2e**: launch a claude agent from Orca TC on a machine with the PATH shim installed; assert exactly one routing layer (guard short-circuits the shim) and the request appears once in the proxy log.
- Daemon-path e2e: agent spawned via daemon adapter shows in proxy log (the v1-draft blind spot).
- Packaging smoke: install Orca TC beside official Orca; run both; uninstall Orca TC; verify official Orca + its daemon unharmed.

## 9. Implementation phases

0. **TeamClaude prerequisites** (§3) + version floor constant. *(gate: desktop Routing tab works via new endpoints; corrupted config migrated)*
1. **Fork prep** — upstream merge, branch, identity/updater/daemon namespace, side-by-side install proven. *(gate: packaging smoke passes)*
2. **Core module** — config/client/supervisor + tests. *(gate: states adopted/owned/setup-needed all reachable and visible)*
3. **Routing seams** — all three + tests. *(gate: local, daemon, and commit-gen launches each appear in proxy log)*
4. **Usage feed + account-surface gating.** *(gate: meters match `teamclaude status`; no native token refresh while connected)*
5. **Widget + flyout.**  6. **Panel.**  7. **Polish** — exit toggle, docs, seam checklist doc, **i18n**: all cockpit strings go through Orca's react-i18next catalog (five locales + pseudo-localization tests); English-complete at each UI phase, translations in phase 7.

## 10. Open items (tracked, non-blocking)

- SSH-remote routing design (v2 feature: remote proxy or per-connection tunnel).
- WSL routing (needs WSL-reachable proxy address instead of 127.0.0.1).
- Whether the desktop app should also adopt the ownership-marker reclaim pattern.
- Support/escalation contract between Orca TC and TeamClaude desktop UIs (which app owns which failure class, e.g. OAuth failures); decide during Phase 5 UI work.
