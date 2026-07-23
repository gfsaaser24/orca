import type { TcReadiness, TcState } from '../../shared/teamclaude-types'

export const ZERO_READINESS: TcReadiness = {
  usageReady: false,
  routingReady: false,
  controlReady: false
}

export function createEmptyTcState(port: number): TcState {
  return {
    lifecycle: 'probing',
    readiness: ZERO_READINESS,
    reasonKey: null,
    reasonDetail: null,
    port,
    serverVersion: null,
    bootId: null,
    capabilities: [],
    owned: false,
    currentAccount: null,
    accounts: [],
    routes: [],
    snapshotAt: Date.now()
  }
}
