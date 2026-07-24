import path from 'node:path'

const BCRYPT_PATTERN = /^\$2[aby]\$\d{2}\$/

export type StoredSecrets = {
  version: 1
  apiKey: string
  managementKey: string
  acceptedManagementConfigValue: string
}

/** Generated claude-api-key entry that forwards CPA's Claude provider through
 * the local teamclaude proxy. The fleet stays the single OAuth token holder —
 * copying refresh tokens into CPA would race teamclaude on rotation and log
 * fleet accounts out. */
export type CpaClaudeDelegation = { apiKey: string; baseUrl: string }

export type SemanticManifest = {
  host: string
  port: number
  authDir: string
  apiKeys: string[]
  managementAllowRemote: boolean
  managementSecretKey: string
  disableControlPanel: boolean
  usageStatisticsEnabled: boolean
  loggingToFile: boolean
  logsMaxTotalSizeMb: number
  requestLog: boolean
  /** null = no entry; 'foreign' = a claude-api-key list we did not generate. */
  claudeDelegation: CpaClaudeDelegation | 'foreign' | null
}

export function expectedManifest(
  directory: string,
  port: number,
  secrets: Pick<StoredSecrets, 'apiKey' | 'managementKey'>,
  claudeDelegation: CpaClaudeDelegation | null = null
): SemanticManifest {
  return {
    host: '127.0.0.1',
    port,
    authDir: path.join(directory, 'auth'),
    apiKeys: [secrets.apiKey],
    managementAllowRemote: false,
    managementSecretKey: secrets.managementKey,
    disableControlPanel: true,
    usageStatisticsEnabled: true,
    loggingToFile: true,
    logsMaxTotalSizeMb: 50,
    requestLog: false,
    claudeDelegation
  }
}

function parseClaudeDelegation(value: unknown): CpaClaudeDelegation | 'foreign' | null {
  if (value == null) {
    return null
  }
  if (!Array.isArray(value) || value.length === 0) {
    return Array.isArray(value) ? null : 'foreign'
  }
  const entry = value[0]
  if (
    value.length === 1 &&
    isRecord(entry) &&
    typeof entry['api-key'] === 'string' &&
    typeof entry['base-url'] === 'string'
  ) {
    return { apiKey: entry['api-key'], baseUrl: entry['base-url'] }
  }
  return 'foreign'
}

export function semanticManifest(value: unknown): SemanticManifest | null {
  if (!isRecord(value) || !isRecord(value['remote-management'])) {
    return null
  }
  const management = value['remote-management']
  if (
    typeof value.host !== 'string' ||
    !Number.isInteger(value.port) ||
    typeof value['auth-dir'] !== 'string' ||
    !Array.isArray(value['api-keys']) ||
    !value['api-keys'].every((key) => typeof key === 'string') ||
    typeof management['allow-remote'] !== 'boolean' ||
    typeof management['secret-key'] !== 'string' ||
    typeof management['disable-control-panel'] !== 'boolean' ||
    typeof value['usage-statistics-enabled'] !== 'boolean' ||
    typeof value['logging-to-file'] !== 'boolean' ||
    !Number.isInteger(value['logs-max-total-size-mb']) ||
    typeof value['request-log'] !== 'boolean'
  ) {
    return null
  }
  return {
    host: value.host as string,
    port: value.port as number,
    authDir: value['auth-dir'] as string,
    apiKeys: value['api-keys'] as string[],
    managementAllowRemote: management['allow-remote'] as boolean,
    managementSecretKey: management['secret-key'] as string,
    disableControlPanel: management['disable-control-panel'] as boolean,
    usageStatisticsEnabled: value['usage-statistics-enabled'] as boolean,
    loggingToFile: value['logging-to-file'] as boolean,
    logsMaxTotalSizeMb: value['logs-max-total-size-mb'] as number,
    requestLog: value['request-log'] as boolean,
    claudeDelegation: parseClaudeDelegation(value['claude-api-key'])
  }
}

export function manifestDifferences(
  expected: SemanticManifest,
  actual: SemanticManifest,
  acceptedManagementConfigValue: string
): string[] {
  const differences: string[] = []
  const pairs: [keyof SemanticManifest, string][] = [
    ['host', 'host'],
    ['port', 'port'],
    ['authDir', 'auth-dir'],
    ['apiKeys', 'api-keys'],
    ['managementAllowRemote', 'remote-management.allow-remote'],
    ['disableControlPanel', 'remote-management.disable-control-panel'],
    ['usageStatisticsEnabled', 'usage-statistics-enabled'],
    ['loggingToFile', 'logging-to-file'],
    ['logsMaxTotalSizeMb', 'logs-max-total-size-mb'],
    ['requestLog', 'request-log'],
    ['claudeDelegation', 'claude-api-key']
  ]
  for (const [key, label] of pairs) {
    if (!semanticEqual(expected[key], actual[key])) {
      differences.push(label)
    }
  }
  const actualManagement = actual.managementSecretKey
  const managementMatches =
    actualManagement === acceptedManagementConfigValue ||
    (acceptedManagementConfigValue === expected.managementSecretKey &&
      isCpaManagementHash(actualManagement))
  if (!managementMatches) {
    differences.push('remote-management.secret-key')
  }
  return differences
}

export function isCpaManagementHash(value: string): boolean {
  return BCRYPT_PATTERN.test(value)
}

export function isStoredSecrets(value: unknown): value is StoredSecrets {
  return (
    isRecord(value) &&
    value.version === 1 &&
    typeof value.apiKey === 'string' &&
    value.apiKey.length > 0 &&
    typeof value.managementKey === 'string' &&
    value.managementKey.length > 0 &&
    typeof value.acceptedManagementConfigValue === 'string' &&
    value.acceptedManagementConfigValue.length > 0
  )
}

function semanticEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
