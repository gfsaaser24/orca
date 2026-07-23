# Kimi K3 review (moonshotai/kimi-k3 via OpenRouter, 2026-07-22)

Reviewed the design doc without code access (context preamble only). Verdict: SHIP-WITH-FIXES.

## Blockers
1. §3/§5 — Adopt-or-spawn TOCTOU race: probe-then-spawn not atomic; needs bind-failure → re-probe-and-adopt path + single-instance decision.
2. §3 client.ts — SSE auth: EventSource can't set x-api-key header; needs the http.request-based approach (desktop proxy-client pattern) written into the plan.
3. §11 — Commit-message-generation path (Electron net vs process env) is a scope blocker for Seam 1; must be resolved before phase 1.
4. §5/§8 — Missing/unresolvable teamclaude binary with config present: supervisor spawn-fails forever with a useless retry button.

## Risks
5. Last-writer-wins config writes still racy vs concurrent desktop edits.
6. No version/capability negotiation on adopt → broken cockpit tabs after teamclaude up/downgrades.
7. Exit-toggle default-detach orphans headless servers; no reaper.
8. Unconditional ANTHROPIC_BASE_URL deletion clobbers legitimate custom endpoints (corporate gateway/Bedrock users).
9. Disabled auto-update + weekly upstream cadence = stale fork; no owner for the rebase cadence.
10. NODE_EXTRA_CA_CERTS only helps Node claude; cert generation ordering unspecified (is ensureCerts done before first agent launch?).
11. Routes tab can re-poison config if it ships before the teamclaude setRoutes hygiene fix; cross-repo sequencing not captured.

## Gaps
12. config.ts watch semantics (debounce, partial writes, apiKey rotation).
13. WSL spawn detection criteria unspecified.
14. IPC contract/store shape/SSE flood throttling undefined.
15. Panel/flyout offline-degradation matrix missing.
16. Adopted-server-death re-probe timing/jitter unspecified.
17. Routes-endpoints decision needed before phase 2, not phase 6.
18. No test exercising the shim-coexistence guard end-to-end.
19. Dev-mode appId override mechanism asserted, not specified.

## Questions
20. Support/escalation contract between the two apps' UIs.
21. Does /status quota cover all ProviderRateLimits fields (resets, fable bucket)?
22. Two Orca TC instances / single-instance lock?
23. What does a WSL user see in the UI for unrouted agents?
24. Resolve §11 open questions before phase 1.
25. Who ships teamclaude changes; minimum version floor checked at adopt time.

Verdict: SHIP-WITH-FIXES — findings 1–4 and questions 21–24 before phase 1.
