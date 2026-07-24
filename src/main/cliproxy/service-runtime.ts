import type { ServiceSupervisorDeps } from '../services/service-supervisor'
import {
  clearServiceMarker,
  killServiceProcess,
  readServiceMarker,
  serviceProcessAlive,
  serviceProcessStartTime,
  spawnServiceProcess,
  writeServiceMarker
} from '../services/service-supervisor-runtime'

export function createCpaSupervisorDeps(): ServiceSupervisorDeps {
  return {
    spawn: spawnServiceProcess,
    readMarker: readServiceMarker,
    writeMarker: writeServiceMarker,
    clearMarker: clearServiceMarker,
    processAlive: serviceProcessAlive,
    processStartTime: serviceProcessStartTime,
    killPid: killServiceProcess,
    now: Date.now,
    random: Math.random,
    setTimeoutFn: setTimeout,
    clearTimeoutFn: clearTimeout,
    watchdogMs: 4_000
  }
}
