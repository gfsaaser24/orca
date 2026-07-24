import { ServiceSupervisor } from './service-supervisor-machine'
import type { ServiceProfile, ServiceSupervisorDeps } from './service-supervisor-types'

export { ServiceSupervisor } from './service-supervisor-machine'
export type {
  ServiceExitAction,
  ServiceLifecycle,
  ServiceOwnershipMarker,
  ServiceProbeStatus,
  ServiceProfile,
  ServiceReason,
  ServiceSpawnCommand,
  ServiceSpawnResolution,
  ServiceStopOptions,
  ServiceSupervisorDeps,
  ServiceTransition,
  SpawnedServiceChild
} from './service-supervisor-types'

export function createServiceSupervisor(
  profile: ServiceProfile,
  deps: ServiceSupervisorDeps
): ServiceSupervisor {
  return new ServiceSupervisor(profile, deps)
}
