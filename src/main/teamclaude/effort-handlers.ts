/**
 * Effort-override IPC handlers. Split out of init.ts to keep that file inside the
 * 300-line budget (and to make the offline behaviour unit-testable without
 * standing up the whole service).
 *
 * The proxy is the single source of truth: nothing is cached here. A down proxy
 * or a not-yet-connected control plane resolves to `null` ("no override known")
 * instead of rejecting, so `window.api.teamclaude.getEffort()` never throws a
 * raw fetch error at the renderer — same contract as the pin/routes/account
 * mutations, which resolve to `{ ok: false, error }` rather than rejecting.
 */
import type { TcEffortLevel, TcEffortState } from '../../shared/teamclaude-types'
import { effortOrNull, type TeamclaudeControl } from './control'

export type EffortHandlers = {
  getEffort(): Promise<TcEffortState>
  setEffort(level: TcEffortLevel | null): Promise<TcEffortState>
}

/** `control` is a getter, not a value: init.ts rebuilds the control plane on
 *  every config change, and the handlers are registered once for the app
 *  lifetime — so they must read the *current* instance on each call. */
export function createEffortHandlers(control: () => TeamclaudeControl | null): EffortHandlers {
  return {
    getEffort: async () => effortOrNull(await control()?.getEffort()),
    setEffort: async (level) => {
      const result = await control()?.setEffort(level)
      if (!result || !result.ok) {
        console.warn(
          `[teamclaude] effort set failed: ${result?.error ?? 'TeamClaude is not connected'}`
        )
      }
      return effortOrNull(result)
    }
  }
}
