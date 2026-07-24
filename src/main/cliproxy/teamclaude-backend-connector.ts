import http from 'node:http'
import type { TcAccountSetPayload, TcRoute } from '../../shared/teamclaude-types'
import { TeamclaudeClient, type TcStatusSnapshot } from '../teamclaude/client'
import { readConnectionConfig, type TcConnectionConfig } from '../teamclaude/config'
import {
  TeamclaudeControl,
  type ControlResult,
  type TeamclaudeBackendAccountUpsert
} from '../teamclaude/control'
import type { ModelsSyncControl, TeamclaudeBackendRoute } from './models-sync'
import type { TeamclaudeBackendControl, TeamclaudeStatusReader } from './provisioning'

export class CpaTeamclaudeConnector
  implements TeamclaudeStatusReader, TeamclaudeBackendControl, ModelsSyncControl
{
  async fetchStatus(): Promise<TcStatusSnapshot> {
    const config = await this.requireConfig()
    return new TeamclaudeClient({ port: config.port, apiKey: config.apiKey }).fetchStatus()
  }

  async upsertBackendAccount(payload: TeamclaudeBackendAccountUpsert): Promise<ControlResult> {
    const control = await this.control()
    return control.upsertBackendAccount(payload)
  }

  async getRoutes(): Promise<TeamclaudeBackendRoute[]> {
    const config = await this.requireConfig()
    const response = await requestJson<{ routes?: TcRoute[] }>(config, 'GET', '/teamclaude/routes')
    if (!Array.isArray(response.routes)) {
      throw new Error('TeamClaude route read returned no routes')
    }
    return response.routes
  }

  async setRoutes(routes: TeamclaudeBackendRoute[]): Promise<ControlResult> {
    const control = await this.control()
    const normalized: TcRoute[] = routes.map((route) => ({
      name: route.name,
      match: route.match,
      accounts: route.accounts ?? [],
      bucket: route.bucket ?? null
    }))
    return control.setRoutes(normalized)
  }

  async setAccount(payload: { id: 'cliproxy'; models: string[] }): Promise<ControlResult> {
    const control = await this.control()
    // Phase-0 widened this endpoint before the frozen cockpit payload learned models.
    return control.setAccount(payload as TcAccountSetPayload)
  }

  private async control(): Promise<TeamclaudeControl> {
    const config = await this.requireConfig()
    return new TeamclaudeControl({ port: config.port, apiKey: config.apiKey })
  }

  private async requireConfig(): Promise<TcConnectionConfig> {
    const config = await readConnectionConfig()
    if (!config) {
      throw new Error('TeamClaude is not configured')
    }
    return config
  }
}

function requestJson<T>(
  config: TcConnectionConfig,
  method: string,
  requestPath: string
): Promise<T> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port: config.port,
        path: requestPath,
        method,
        headers: { 'x-api-key': config.apiKey }
      },
      (response) => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => (body += chunk))
        response.on('end', () => {
          if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
            reject(new Error(`${requestPath} responded ${response.statusCode ?? 'without status'}`))
            return
          }
          try {
            resolve(JSON.parse(body) as T)
          } catch {
            reject(new Error(`${requestPath} returned invalid JSON`))
          }
        })
      }
    )
    request.once('error', reject)
    request.setTimeout(10_000, () => request.destroy(new Error(`${requestPath} timed out`)))
    request.end()
  })
}
