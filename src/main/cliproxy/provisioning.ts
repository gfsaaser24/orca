import type { TeamclaudeBackendAccountUpsert, ControlResult } from '../teamclaude/control'

const BACKEND_CAPABILITY = 'account.backend'

export type TeamclaudeProvisioningStatus = {
  capabilities: string[]
  accounts: { name: string }[]
}

export type TeamclaudeStatusReader = {
  fetchStatus(): Promise<TeamclaudeProvisioningStatus>
}

export type TeamclaudeBackendControl = {
  upsertBackendAccount(payload: TeamclaudeBackendAccountUpsert): Promise<ControlResult>
}

export type CpaProvisioningResult = {
  linked: boolean
  reasonKey: string | null
  reasonDetail: string | null
}

export class CpaProvisioning {
  constructor(
    private readonly statusReader: TeamclaudeStatusReader,
    private readonly control: TeamclaudeBackendControl
  ) {}

  async ensure(apiKey: string, port: number): Promise<CpaProvisioningResult> {
    let status: TeamclaudeProvisioningStatus
    try {
      status = await this.statusReader.fetchStatus()
    } catch (error) {
      return unavailable(error)
    }

    if (!status.capabilities.includes(BACKEND_CAPABILITY)) {
      return {
        linked: false,
        reasonKey: 'cpa.reason.updateTeamclaude',
        reasonDetail: 'Update TeamClaude to enable the account.backend capability.'
      }
    }

    const upstream = exactLoopbackUpstream(port)
    const result = await this.control.upsertBackendAccount({
      id: 'cliproxy',
      type: 'apikey',
      apiKey,
      upstream,
      priority: 100
    })
    if (!result.ok) {
      return {
        linked: false,
        reasonKey: 'cpa.reason.routingUnavailable',
        reasonDetail: result.error ?? 'TeamClaude rejected the CLIProxyAPI backend account.'
      }
    }

    try {
      const readback = await this.statusReader.fetchStatus()
      if (!readback.accounts.some((account) => account.name === 'cliproxy')) {
        return {
          linked: false,
          reasonKey: 'cpa.reason.routingUnavailable',
          reasonDetail: 'TeamClaude did not report the cliproxy backend after provisioning.'
        }
      }
    } catch (error) {
      return unavailable(error)
    }

    return { linked: true, reasonKey: null, reasonDetail: null }
  }
}

export function exactLoopbackUpstream(port: number): string {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('CLIProxyAPI port is invalid')
  }
  return `http://127.0.0.1:${port}`
}

function unavailable(error: unknown): CpaProvisioningResult {
  return {
    linked: false,
    reasonKey: 'cpa.reason.routingUnavailable',
    reasonDetail:
      error instanceof Error ? error.message : 'TeamClaude status is unavailable for provisioning.'
  }
}
