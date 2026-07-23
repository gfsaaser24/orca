# Claude Fable 5 subagent review — round 3, fresh eyes (2026-07-22)
Code-verified against both repos, briefed to find what Kimi+Codex missed. Verdict: SHIP-WITH-FIXES.
Full findings were delivered in-session; the material ones (all incorporated into spec v2.2):
- B-A: v2.1's auth-preparation short-circuit was wrong — prepareClaudeAuth also supplies envPatch (CLAUDE_CONFIG_DIR) + credential materialization + stripAuthEnv that routed launches still need; scope the skip to refreshManagedAccountTokenIfNeeded only. CLI self-refreshes via proxy /v1/oauth/token passthrough regardless.
- B-B: collision with Orca's own Network Proxy settings (buildConfiguredProxyEnv, incl. NO_PROXY='' clobber) — configured Orca proxy ⇒ launch unrouted + notice.
- B-C: userData namespace comes from package.json name (captured before app.setName by design) — dev-instance-identity patch alone leaves both apps sharing %APPDATA%\orca AND the single-instance lock.
- R-A: Orca's hidden claude usage-CLI spawns get shim-routed → wrong account's usage attributed; set guard on internal spawns.
- R-B: deliberate proxy stops orphan live routed sessions (daemon PTYs outlive the app); confirm with live-session count + stale-env labels.
- R-C: guard inheritance freezes fail-direct for days-long sessions; persistent "launched unrouted" chip.
- R-D: TC module must be app-lifetime singleton, not attachMainWindowServices (re-runs on window recreation).
- G-A i18n plan; G-B WSL text-gen skip; G-C accountUuid must be persisted onto account records (it only lives in credentials JSON); G-D windowsHide + entrypoint resolution algorithm (desktop uses shell:true because bare .cmd spawn fails), resolution failure ⇒ setup-needed; G-E Phase-0 stable-ID rule vs desktop pin UI's name tokens ⇒ dual-accept deprecation window.
- S-A: §3 internal contradiction (names/indices vs stable-ID-only) — back-propagated; S-B = B-C; S-C citation drift (OrcaCliLauncher.cs:16; run env contract index.js:646-677, fallback regex :674).
