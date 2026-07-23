/**
 * Liveness monitoring for the {@link Supervisor}: polls the proxy while it is
 * up, and on death routes recovery — reclaimed-owned servers respawn with
 * backoff; adopted servers get a 2s+jitter grace window (so the desktop app's
 * own restart wins the race) before we spawn our own. Extracted from
 * supervisor.ts behind a small host interface to keep each file focused.
 */
import type { TcProxyLifecycle } from '../../shared/teamclaude-types'
import type { ProbeResult } from './supervisor-types'
import { ADOPTED_DEATH_WINDOW_MS, ADOPTED_DEATH_BASE_MS } from './supervisor-types'
import { RESOLVER_RECOVERY_PROBE_MS } from './supervisor-types'
import type { TimerBag } from './supervisor-support'

/** The Supervisor operations the monitor drives (all already exist on it). */
export type LivenessHost = {
  timers: TimerBag
  watchdogMs: number
  generation(): number
  stopping(): boolean
  owned(): boolean
  hasChild(): boolean
  now(): number
  random(): number
  probe(): Promise<ProbeResult>
  markUp(probe: ProbeResult): void
  refreshFromProbe(probe: ProbeResult): void
  invalidateSnapshot(): void
  transition(
    lifecycle: TcProxyLifecycle,
    reasonKey: string | null,
    reasonDetail: string | null
  ): void
  onProbeUp(probe: ProbeResult): Promise<void>
  spawnFlow(): Promise<void>
  clearMarker(): void
  setOwned(value: boolean): void
  scheduleBackoffRestart(reasonKey: string, detail: string): void
}

export class LivenessMonitor {
  constructor(private readonly host: LivenessHost) {}

  /** Poll the probe while up. For a spawned child, `expectUp` waits for the
   *  first successful probe; the child's own exit handler owns crash detection,
   *  so we only act on silent death when there is NO child handle (reclaimed /
   *  adopted). */
  start(hasChildAtStart: boolean, expectUp = false): void {
    const h = this.host
    const gen = h.generation()
    let sawUp = !expectUp
    h.timers.setMonitor(h.watchdogMs, () => {
      void (async (): Promise<void> => {
        if (gen !== h.generation()) {
          return
        }
        let ok = false
        try {
          const probe = await h.probe()
          ok = probe.ok
          if (ok) {
            h.markUp(probe)
            sawUp = true
            if (gen === h.generation()) {
              h.refreshFromProbe(probe)
            }
          }
        } catch {
          ok = false
        }
        if (gen !== h.generation()) {
          return
        }
        if (!ok) {
          h.invalidateSnapshot()
          // For a spawned child, defer crash detection to its exit handler.
          if ((hasChildAtStart && h.hasChild()) || !sawUp) {
            this.start(h.hasChild(), false)
            return
          }
          await this.onLost()
          return
        }
        this.start(h.hasChild(), false)
      })()
    })
  }

  /** Resolver failure must not spawn-loop, but an externally started listener
   * can still recover the app without a restart. This lane only probes. */
  startResolverRecovery(): void {
    const h = this.host
    const gen = h.generation()
    h.timers.setMonitor(RESOLVER_RECOVERY_PROBE_MS, () => {
      void (async (): Promise<void> => {
        if (gen !== h.generation() || h.stopping()) {
          return
        }
        try {
          const probe = await h.probe()
          if (probe.ok) {
            await h.onProbeUp(probe)
            return
          }
        } catch {
          // A failed recovery probe stays in the low-frequency probe-only lane.
        }
        if (gen === h.generation() && !h.stopping()) {
          this.startResolverRecovery()
        }
      })()
    })
  }

  private async onLost(): Promise<void> {
    const h = this.host
    if (h.stopping()) {
      return
    }
    h.invalidateSnapshot()
    if (h.owned()) {
      // Reclaimed-owned server died: respawn with backoff.
      h.clearMarker()
      h.setOwned(false)
      h.scheduleBackoffRestart('tc.reason.crashed', 'owned server stopped responding')
      return
    }
    await this.adoptedDeath()
  }

  private async adoptedDeath(): Promise<void> {
    const h = this.host
    const gen = h.generation()
    h.transition('probing', 'tc.reason.adoptedLost', 'adopted proxy stopped; waiting for restart')
    const deadline = h.now() + ADOPTED_DEATH_WINDOW_MS
    while (h.now() < deadline) {
      if (gen !== h.generation() || h.stopping()) {
        return
      }
      const jitter = Math.floor(h.random() * 500)
      await h.timers.wait(ADOPTED_DEATH_BASE_MS + jitter)
      if (gen !== h.generation() || h.stopping()) {
        return
      }
      const probe = await h.probe()
      if (probe.ok) {
        await h.onProbeUp(probe)
        return
      }
    }
    if (gen !== h.generation() || h.stopping()) {
      return
    }
    await h.spawnFlow()
  }
}
