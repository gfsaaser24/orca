import { app } from 'electron'
import type { TeamclaudeClient } from './client'
import { deriveReadiness } from './client-mapping'
import type { TcConnectionConfig } from './config'
import {
  clearMarkerFile,
  killProcess,
  markerPath,
  processAlive,
  processStartTime,
  readMarkerFile,
  resolveNodeEntrypoint,
  spawnServerProcess,
  writeMarkerFile
} from './supervisor-runtime'
import type { SupervisorConfig, SupervisorDeps } from './supervisor-types'

export function createSupervisorProductionWiring(
  client: TeamclaudeClient,
  connection: TcConnectionConfig
): { config: SupervisorConfig; deps: SupervisorDeps } {
  const userData = safeUserData()
  const marker = markerPath(userData)
  return {
    config: {
      port: connection.port,
      apiKey: connection.apiKey,
      binPath: connection.binPath,
      markerPath: marker
    },
    deps: {
      probe: async () => {
        try {
          const status = await client.fetchStatus()
          return {
            ok: true,
            version: status.serverVersion,
            capabilities: status.capabilities,
            bootId: status.bootId
          }
        } catch {
          return { ok: false, version: null, capabilities: [], bootId: null }
        }
      },
      spawnServer: (resolution) => spawnServerProcess(resolution, {}, userData),
      resolveEntrypoint: (binPath) => resolveNodeEntrypoint(binPath ?? connection.binPath),
      readMarker: () => readMarkerFile(marker),
      writeMarker: (value) => writeMarkerFile(marker, value),
      clearMarker: () => clearMarkerFile(marker),
      processAlive,
      killPid: killProcess,
      processStartTime,
      isSupported: (capabilities) => deriveReadiness(capabilities).routingReady,
      now: Date.now,
      random: Math.random,
      setTimeoutFn: setTimeout,
      clearTimeoutFn: clearTimeout,
      watchdogMs: 4000
    }
  }
}

function safeUserData(): string {
  try {
    return app.getPath('userData')
  } catch {
    return process.cwd()
  }
}
