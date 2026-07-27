@AGENTS.md

# Orca TC — agent operating guide

Hard fork of the Orca IDE (Electron + React + TypeScript) with two first-party
integrations. Treat this as its own product, not "upstream Orca with patches".

## Identity (installs side-by-side with official Orca)

Verified in `package.json` + `config/electron-builder.config.cjs`:

- package `orca-tc`, `productName: "Orca TC"`, `appId: com.gfsaaser.orca-tc`
- Windows `executableName: OrcaTC`, NSIS `artifactName: orcatc-windows-setup.${ext}`
- packaged CLI command is `orcatc` on Windows (`src/main/cli/cli-installer.ts`);
  macOS keeps `orca`, Linux keeps `orca-ide`. `package.json` `bin` still maps the
  dev CLI to `orca` / `orca-dev` — that is the source-mode CLI, not the installed one.
- userData / runtime metadata namespaced to `Orca TC` (`src/cli/runtime/metadata.ts`,
  `src/main/startup/dev-instance-identity.ts`)
- **Auto-updater is hard-gated off.** `ORCA_TC` is a compile-time define
  (`electron.vite.config.ts`, defaults `true`; `ORCA_TC=0` re-enables). Every
  updater entry point returns early on it (`src/main/updater.ts`), and
  `publish: null` in the builder config. Never re-enable it or point at the
  StablyAI feed.

## Git / remotes — read before any push

- `origin` = `github.com/gfsaaser24/orca` — **the only push target**.
- `upstream` = `github.com/stablyai/orca` — **never push here.**
- Work lands on `main`.

## Commands (from `package.json` — these exist; don't invent others)

```bash
pnpm dev                 # electron-vite dev via config/scripts/run-electron-vite-dev.mjs
pnpm start               # electron-vite preview
pnpm build:desktop       # typecheck + relay + cli + electron-vite + web
```

Real gates, in the order they usually catch things:

```bash
pnpm typecheck           # the trio: node + cli + web (aliases: pnpm tc, tc:node, tc:cli, tc:web)
pnpm lint                # oxlint + switch-exhaustiveness + scrollbars + reliability-gates
                         #   + max-lines-ratchet + skill-guide/manifest + BOTH localization verifiers
pnpm test                # ensure-native-runtime --runtime=node && vitest run --config config/vitest.config.ts
```

Individually runnable sub-gates: `pnpm lint:switch-exhaustiveness` (type-aware
oxlint over `src/**` + `config` + `tests`), `pnpm check:styled-scrollbars`,
`pnpm check:reliability-gates`, `pnpm check:max-lines-ratchet`,
`pnpm verify:localization-catalog`, `pnpm verify:localization-coverage`,
`pnpm lint:react-doctor` (+ `:changed`), `pnpm format` (oxfmt).
`.husky/pre-commit` runs `lint-staged` (oxlint, react-doctor, oxfmt).

## Architecture map

- `electron.vite.config.ts` (repo root) — main/preload/renderer. Main has multiple
  rollup inputs beyond `src/main/index.ts`: `daemon-entry`, `computer-sidecar`,
  `stt-worker`, `warp-theme-parser-worker`, `parcel-watcher-process-entry`,
  `agent-hooks/managed-agent-hook-controls`. Compile-time defines live here.
- Renderer aliases `@renderer` and `@` → `src/renderer/src` (mirrored in
  `config/vitest.config.ts`).
- `src/main/` process code · `src/preload/` bridge · `src/renderer/src/` UI ·
  `src/shared/` cross-process types · also `src/cli/`, `src/relay/`, `src/types/`.
- Generic IPC lives in `src/main/ipc/`; each integration owns its own
  (`src/main/teamclaude/ipc.ts`, `src/main/cliproxy/ipc.ts`).
- Contract flow: `src/shared/*-types.ts` → consumed by main modules → surfaced on
  `src/preload/index.ts` (`teamclaude:` / `cliproxy:` blocks, typed against
  `src/preload/api-types.ts`) → consumed by renderer components.

### FROZEN CONTRACTS

`src/shared/teamclaude-types.ts` and `src/shared/cliproxy-types.ts` are frozen
main↔renderer contracts (their file headers say so). Editing them is a deliberate
contract revision — update both sides plus the specs in
`docs/superpowers/specs/2026-07-22-teamclaude-integration-design.md` and
`docs/superpowers/specs/2026-07-24-cliproxyapi-backends-design.md`. Do not widen
a type just to make a component compile.

### `src/main/services/` — service-supervisor core

Profile-driven supervisor (`service-supervisor.ts`, `-machine`, `-runtime`,
`-recovery`, `-types`). Both integrations are adapters over it via
`src/main/services/profiles/teamclaude.ts` and `profiles/cliproxyapi.ts`.
New supervised child services belong here as a profile, not as a bespoke spawner.

### `src/main/teamclaude/` — TeamClaude fleet proxy

Local multi-account Claude proxy (separate repo, not vendored here). Adopt-or-spawn
supervisor (`supervisor*.ts`), read client over `/status` polling + `/teamclaude/events`
SSE via raw `http.request` (`client.ts`), control plane (`control.ts`), config watcher
(`config.ts`), wired from `src/main/index.ts` via `initTeamclaude`.

`routing-env.ts` is **the single routing seam** for local PTY, daemon PTY, and
text-generation. It is fail-open by contract: it always sets `TEAMCLAUDE_RUN_GUARD=1`,
only injects proxy/CA vars when actually routed, and never half-routes a user-set
`ANTHROPIC_BASE_URL`. Read its header comment before touching it — an agent must
never fail to launch because of TeamClaude.

### `src/main/cliproxy/` — CLIProxyAPI ("CPA") backends

Supervises the upstream Go binary (`router-for-me/CLIProxyAPI`) as a child service to
expose non-Claude backends (Codex, Gemini/Antigravity, Grok/xAI, Kimi, api-key,
openai-compat) as models. Orca owns CPA's config file (`config-manifest.ts`,
`config-owner.ts`, `config-ownership.ts`), provisions a teamclaude backend account
(`provisioning.ts`, requires the `account.backend` capability), delegates CPA's own
Claude provider back through the fleet (`teamclaude-backend-connector.ts`), and syncs
models/usage (`models-sync.ts`, `usage-aggregator.ts`). Entry: `initCliproxy(store)`.

### Cockpit UI

`src/renderer/src/components/teamclaude/` — widget → `TeamclaudeFlyout` →
`TeamclaudePanel` with tabs **Accounts / Routes / Activity / Services / Backends**
(`panel/`). Mounted from `src/renderer/src/components/status-bar/StatusBar.tsx`;
also reachable from `components/settings/AccountsPane.tsx`.

## Conventions enforced by tooling (`.oxlintrc.json`, `config/`)

- **max-lines**: `.ts` 300, `.tsx` 400, `.mjs` 600, test/spec files 800
  (blank lines and comments skipped). Never add a `max-lines` disable — the
  ratchet (`config/scripts/check-max-lines-ratchet.mjs`, baseline
  `config/max-lines-baseline.txt`) freezes existing bypasses and fails on new
  ones. Split the file instead.
- `typescript/consistent-type-definitions: ["error", "type"]` — use `type`, not `interface`.
- `curly: error`; `prefer-template`; `no-unneeded-ternary`; `no-useless-return`.
- `typescript/no-explicit-any: error`, `consistent-type-imports`, `array-type`,
  `prefer-optional-chain`, plus a `unicorn` set (`prefer-node-protocol`, `prefer-at`, …).
- Switch exhaustiveness twice: the plain rule in `.oxlintrc.json` and a type-aware
  pass via `config/oxlint-switch-exhaustiveness.json` (`allowDefaultCaseForExhaustiveSwitch: false`).
- Styled-scrollbar check: `config/scripts/check-styled-scrollbars.mjs`.
- Reliability gates manifest: `config/reliability-gates.jsonc`, validated by
  `config/scripts/check-reliability-gates.mjs`.
- React lint profile: `config/oxlint-react-doctor.json`.

## i18n — five catalogs, exact key parity

`src/renderer/src/i18n/locales/{en,es,ja,ko,zh}.json`. `en.json` is the source of
truth; `config/scripts/verify-localization-catalog.mjs` enforces key parity **and**
`{{placeholder}}` parity across all five, and it runs inside `pnpm lint`.

- **NEVER run `pnpm sync:localization-catalog`** (that's the verifier's `--fix`
  mode). It rewrites whole catalogs with `JSON.stringify(catalog, null, 2)` + `\n`,
  i.e. it reflows the file and force-normalizes line endings.
- Add keys to all five catalogs by hand or with a targeted script. **Detect each
  file's existing EOL before writing** — do not assume LF; a Windows working tree
  can hand you CRLF. (They are LF as checked out today, but the files are not
  pinned by `.gitattributes`.)
- Coverage audit is separate: `pnpm verify:localization-coverage` /
  `pnpm audit:localization` (`config/scripts/audit-localization-coverage.mjs`,
  allowlist `config/localization-coverage-allowlist.json`).

## Testing — baseline honesty

Vitest via `config/vitest.config.ts` (node env; `src/**/*.test.ts(x)`,
`config/scripts/**/*.test.mjs`, `tests/e2e/**/*.unit.test.ts`; Windows capped at
4 workers). Playwright E2E lives under `tests/` via the `test:e2e:*` scripts.

**The full suite is not green on a Windows dev machine, and that is expected.**
Verified here on a clean checkout with no local edits:
`src/main/rate-limits/service.test.ts` fails 7 of 59 tests. The same class of
environment-dependent failures is reported for relay/PTY, ssh, hosted-review,
native-chat and editor suites (not re-verified individually in this pass).

The rule is **zero NEW failures versus the base commit**, proven by a
stash-baseline comparison (stash your work, run the same targeted suites, compare).
Do not "fix" pre-existing failures you did not cause, and do not treat a red wall
as a signal that the branch is broken.

## Windows packaging

```bash
pnpm build:desktop
npx electron-builder --config config/electron-builder.local.cjs --win -c.npmRebuild=false
```

- `config/electron-builder.local.cjs` is a thin wrapper over the real config that
  pins `toolsets: { winCodeSign: '1.1.0' }`. Its header explains why: the legacy
  default toolset ships a 7z containing darwin symlinks whose extraction needs a
  privilege normal Windows users lack. Use the wrapper; leave
  `config/electron-builder.config.cjs` untouched for CI parity.
- `npmRebuild: true` in the base config exists for macOS dual-arch native rebuilds;
  `-c.npmRebuild=false` is the local Windows override.
- Output: `dist/orcatc-windows-setup.exe`.
- Caution (operational, not derivable from the repo): plain `-c.win.X` CLI
  overrides replace the entire `win` config block rather than merging into it.
  Change `win` settings by editing/extending a config file, not via `-c.win.*`.
