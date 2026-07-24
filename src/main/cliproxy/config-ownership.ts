import type { safeStorage } from 'electron'

export type CpaConfigKeys = {
  apiKey: string
  managementKey: string
}

export type CpaConfigInspection = {
  drifted: boolean
  driftKeys: string[]
  transientRead: boolean
}

export type CpaConfigOwnership = CpaConfigKeys &
  CpaConfigInspection & {
    configPath: string
    port: number
  }

export type CpaSettingsStore = {
  getSettings(): { cliproxyPort?: number }
  updateSettings(updates: { cliproxyPort?: number }): unknown
}

export type CpaSafeStorage = Pick<
  typeof safeStorage,
  'isEncryptionAvailable' | 'encryptString' | 'decryptString'
>

export type CpaConfigOwnerOptions = {
  userDataPath: string
  settings: CpaSettingsStore
  isServiceStopped: () => boolean
  storage?: CpaSafeStorage
  warn?: (message: string) => void
}

export class CpaKeyStorageUnavailableError extends Error {
  constructor() {
    super(
      'CLIProxyAPI setup needs OS-backed safeStorage, but secure encryption is unavailable. No keys or config were generated.'
    )
    this.name = 'CpaKeyStorageUnavailableError'
  }
}

export class CpaUnownedConfigError extends Error {
  constructor() {
    super(
      'A CLIProxyAPI config exists without Orca recovery keys. It was left untouched; stop the service and explicitly regenerate to take ownership.'
    )
    this.name = 'CpaUnownedConfigError'
  }
}
