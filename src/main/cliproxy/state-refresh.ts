import type { CpaState } from '../../shared/cliproxy-types'
import type { CpaConfigOwner } from './config-owner'
import {
  CpaManagementError,
  type CpaAliasMap,
  type CpaAuthFileSummary,
  type CpaModelsResponse,
  type ManagementClient
} from './management-client'
import type { CpaProvisioning, CpaProvisioningResult } from './provisioning'
import { mapCpaAccount, mapCpaModels, type CpaStatePatch } from './state-derivation'

type ModelsSyncRuntime = {
  start(): void
  forceSync(): Promise<void>
}

export type CpaRefreshContext = {
  state: CpaState
  client: ManagementClient
  configOwner: CpaConfigOwner
  provisioning: CpaProvisioning | null
  modelsSync: ModelsSyncRuntime | null
  apiKey: string
  keyMismatch: boolean
  configDrift: string[]
  lastSyncedModels: string
  supervisorReason: Pick<CpaState, 'reasonKey' | 'reasonDetail'>
  usage: CpaState['usage']
  startModelsSync(): void
}

export type CpaRefreshOutcome = {
  patch: CpaStatePatch
  keyMismatch: boolean
  configDrift: string[]
  lastSyncedModels: string
}

export async function refreshCpaState(context: CpaRefreshContext): Promise<CpaRefreshOutcome> {
  const inspection = await context.configOwner.inspect().catch(() => null)
  const configDrift =
    inspection && !inspection.transientRead
      ? inspection.drifted
        ? inspection.driftKeys
        : []
      : context.configDrift
  const alive = await context.client.healthz()
  if (!alive) {
    return outcome(configDrift, context.keyMismatch, context.lastSyncedModels, {
      readiness: {
        alive: false,
        modelsReady: false,
        managementReady: false,
        routingLinked: false
      },
      usage: context.usage
    })
  }

  const rawModels = await readModels(context.client)
  const management = await readManagement(context.client, context.keyMismatch)
  const modelsReady = rawModels !== null && Array.isArray(rawModels.data)
  const routing = await linkRouting(context, rawModels, modelsReady)
  const reason = currentReason(
    management.keyMismatch,
    configDrift,
    routing.provisioning,
    context.supervisorReason
  )
  return outcome(configDrift, management.keyMismatch, routing.fingerprint, {
    readiness: {
      alive: true,
      modelsReady,
      managementReady: management.authFiles !== null && !management.keyMismatch,
      routingLinked: routing.linked
    },
    accounts: management.authFiles
      ? management.authFiles.map(mapCpaAccount)
      : context.state.accounts,
    claudeDelegated: context.configOwner.claudeDelegated,
    models: rawModels
      ? mapCpaModels(rawModels, management.aliases, routing.linked)
      : context.state.models.map((model) => ({ ...model, routable: false })),
    usage: context.usage,
    ...reason
  })
}

async function readModels(client: ManagementClient): Promise<CpaModelsResponse | null> {
  try {
    return await client.getModelsAuthed()
  } catch {
    return null
  }
}

async function readManagement(
  client: ManagementClient,
  mismatch: boolean
): Promise<{ authFiles: CpaAuthFileSummary[] | null; aliases: CpaAliasMap; keyMismatch: boolean }> {
  if (mismatch) {
    return { authFiles: null, aliases: {}, keyMismatch: true }
  }
  try {
    const response = await client.getAuthFiles()
    try {
      return { authFiles: response.files, aliases: await client.getAliases(), keyMismatch: false }
    } catch (error) {
      return {
        authFiles: response.files,
        aliases: {},
        keyMismatch: isKeyMismatch(error)
      }
    }
  } catch (error) {
    return { authFiles: null, aliases: {}, keyMismatch: isKeyMismatch(error) }
  }
}

async function linkRouting(
  context: CpaRefreshContext,
  models: CpaModelsResponse | null,
  modelsReady: boolean
): Promise<{ linked: boolean; provisioning: CpaProvisioningResult | null; fingerprint: string }> {
  if (!modelsReady || !models || !context.provisioning) {
    return { linked: false, provisioning: null, fingerprint: context.lastSyncedModels }
  }
  let provisioning: CpaProvisioningResult
  try {
    provisioning = await context.provisioning.ensure(context.apiKey, context.state.port)
  } catch (error) {
    provisioning = {
      linked: false,
      reasonKey: 'cpa.reason.routingUnavailable',
      reasonDetail: error instanceof Error ? error.message : String(error)
    }
  }
  if (!provisioning.linked || !context.modelsSync) {
    return { linked: false, provisioning, fingerprint: context.lastSyncedModels }
  }

  context.startModelsSync()
  const fingerprint = models.data
    .map((model) => (typeof model.id === 'string' ? model.id : ''))
    .sort()
    .join('\n')
  try {
    if (!context.state.readiness.routingLinked || fingerprint !== context.lastSyncedModels) {
      await context.modelsSync.forceSync()
    }
    return { linked: true, provisioning, fingerprint }
  } catch {
    return { linked: false, provisioning, fingerprint: context.lastSyncedModels }
  }
}

function currentReason(
  keyMismatch: boolean,
  configDrift: string[],
  provisioning: CpaProvisioningResult | null,
  supervisorReason: Pick<CpaState, 'reasonKey' | 'reasonDetail'>
): Pick<CpaState, 'reasonKey' | 'reasonDetail'> {
  if (keyMismatch) {
    return {
      reasonKey: 'cpa.reason.managementKeyMismatch',
      reasonDetail: 'Management calls are stopped until config-key recovery.'
    }
  }
  if (configDrift.length > 0) {
    return {
      reasonKey: 'cpa.reason.configDrift',
      reasonDetail: `Orca-owned config keys changed: ${configDrift.join(', ')}`
    }
  }
  if (provisioning && !provisioning.linked) {
    return { reasonKey: provisioning.reasonKey, reasonDetail: provisioning.reasonDetail }
  }
  return supervisorReason
}

function outcome(
  configDrift: string[],
  keyMismatch: boolean,
  lastSyncedModels: string,
  patch: CpaStatePatch
): CpaRefreshOutcome {
  return { patch, configDrift, keyMismatch, lastSyncedModels }
}

function isKeyMismatch(error: unknown): boolean {
  return error instanceof CpaManagementError && error.code === 'key-mismatch'
}
