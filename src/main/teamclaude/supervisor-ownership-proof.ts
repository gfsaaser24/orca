import { markerProvesServiceOwnership } from '../services/service-supervisor-runtime'
import type { OwnershipMarker, SupervisorDeps } from './supervisor-types'

type OwnershipProbe = Pick<SupervisorDeps, 'processAlive' | 'processStartTime'>

export async function markerProvesOwnership(
  marker: OwnershipMarker | null,
  port: number,
  probe: OwnershipProbe
): Promise<boolean> {
  return markerProvesServiceOwnership(
    marker
      ? {
          pid: marker.pid,
          startedAt: marker.startedAt,
          identity: `teamclaude:${marker.port}`
        }
      : null,
    `teamclaude:${port}`,
    probe
  )
}
