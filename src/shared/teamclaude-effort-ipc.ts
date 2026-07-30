/**
 * IPC channels for the TeamClaude reasoning-effort override.
 *
 * These live outside `teamclaude-types.ts` on purpose: that file (and its
 * `TC_IPC` map) is the frozen v2.2 contract, and the effort override is an
 * additive surface layered on top of it. Naming follows TC_IPC's
 * `tc:<noun>:<verb>` convention so the channel list stays readable end to end.
 *
 * Both channels are renderer → main invokes; there is no push counterpart — the
 * proxy is the single source of truth and the cockpit re-reads after a write.
 */
export const TC_EFFORT_IPC = {
  /** invoke: () => TcEffortState — reads GET /teamclaude/effort (no api key) */
  get: 'tc:effort:get',
  /** invoke: (level: TcEffortLevel | null) => TcEffortState — null clears it */
  set: 'tc:effort:set'
} as const
