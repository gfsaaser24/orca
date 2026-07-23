import { RECLAIM_TOLERANCE_MS, type OwnershipMarker, type SupervisorDeps } from './supervisor-types'

type OwnershipProbe = Pick<SupervisorDeps, 'processAlive' | 'processStartTime'>

export async function markerProvesOwnership(
  marker: OwnershipMarker | null,
  port: number,
  probe: OwnershipProbe
): Promise<boolean> {
  if (!marker || marker.port !== port || !probe.processAlive(marker.pid)) {
    return false
  }
  const started = await probe.processStartTime(marker.pid)
  return started !== null && Math.abs(started - marker.startedAt) <= RECLAIM_TOLERANCE_MS
}
