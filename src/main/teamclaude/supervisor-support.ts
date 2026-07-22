/**
 * Small composable helpers for the {@link Supervisor}: a timer bag (so every
 * scheduled callback is tracked and torn down together, using the injected
 * clock) and the routing-snapshot state it owns. Extracted to keep the state
 * machine file focused and within the size budget.
 */
import type { TcProxyLifecycle } from '../../shared/teamclaude-types'
import type { RoutingSnapshot } from './routing-env'

/** Transition args `[lifecycle, reasonKey, reasonDetail]`. */
export type TransitionArgs = [TcProxyLifecycle, string | null, string | null]

/** Given a fresh probe while monitoring, compute the lifecycle transition (or
 *  null for no change). Owned servers stay `owned`; adopted ones flip between
 *  `adopted` and `adopted-degraded` on capability support. */
export function deriveMonitorTransition(
  owned: boolean,
  supported: boolean,
  version: string | null,
  current: TcProxyLifecycle
): TransitionArgs | null {
  if (owned) {
    return current === 'owned' ? null : ['owned', null, null]
  }
  const next: TcProxyLifecycle = supported ? 'adopted' : 'adopted-degraded'
  if (current === next) {
    return null
  }
  const detail = supported ? null : `have ${version ?? '?'}, missing required capabilities`
  return [next, supported ? null : 'tc.reason.degraded', detail]
}

/** Tracks all timers (incl. one distinguished "monitor") behind the injected
 *  clock so tests can drive them and teardown is a single call. */
export class TimerBag {
  private readonly timers = new Set<NodeJS.Timeout>()
  private monitor: NodeJS.Timeout | null = null

  constructor(
    private readonly setFn: typeof setTimeout,
    private readonly clearFn: typeof clearTimeout
  ) {}

  set(ms: number, cb: () => void): void {
    const t = this.setFn(() => {
      this.timers.delete(t)
      cb()
    }, ms)
    this.track(t)
  }

  wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = this.setFn(() => {
        this.timers.delete(t)
        resolve()
      }, ms)
      this.track(t)
    })
  }

  setMonitor(ms: number, cb: () => void): void {
    this.clearMonitor()
    this.monitor = this.setFn(cb, ms)
    this.track(this.monitor)
  }

  clearMonitor(): void {
    if (this.monitor) {
      this.clearFn(this.monitor)
      this.timers.delete(this.monitor)
      this.monitor = null
    }
  }

  clearAll(): void {
    this.clearMonitor()
    for (const t of this.timers) {
      this.clearFn(t)
    }
    this.timers.clear()
  }

  private track(t: NodeJS.Timeout): void {
    t.unref?.()
    this.timers.add(t)
  }
}

/** The cached routing-snapshot state the seams read. `proxyUp` decays after the
 *  TTL so a death nobody has noticed yet still fails-open within ≤2s (spec §4). */
export class SnapshotState {
  private proxyUp = false
  private lastProbeOkAt = 0
  private caPath: string | null = null
  private networkProxyConfigured = false
  private portHistory: number[] = []

  constructor(
    private readonly ttlMs: number,
    private readonly historyMax: number
  ) {}

  recordUp(now: number): void {
    this.proxyUp = true
    this.lastProbeOkAt = now
  }

  invalidate(): void {
    this.proxyUp = false
  }

  setCaPath(caPath: string | null): void {
    this.caPath = caPath
  }

  setNetworkProxyConfigured(configured: boolean): void {
    this.networkProxyConfigured = configured
  }

  rememberPort(port: number): void {
    if (!this.portHistory.includes(port)) {
      this.portHistory.unshift(port)
      this.portHistory = this.portHistory.slice(0, this.historyMax)
    }
  }

  build(now: number, port: number): RoutingSnapshot {
    const fresh = now - this.lastProbeOkAt <= this.ttlMs
    return {
      proxyUp: this.proxyUp && fresh,
      port,
      caPath: this.caPath,
      knownPorts: [port, ...this.portHistory],
      orcaNetworkProxyConfigured: this.networkProxyConfigured
    }
  }
}
