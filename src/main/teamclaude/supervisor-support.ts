import type { RoutingSnapshot } from './routing-env'

/** TeamClaude-only routing snapshot state; lifecycle mechanics live in services/. */
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
