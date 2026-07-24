import { randomBytes, randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { safeStorage } from 'electron'
import { parse, stringify } from 'yaml'
import {
  expectedManifest,
  isCpaManagementHash,
  isStoredSecrets,
  manifestDifferences,
  semanticManifest,
  type CpaClaudeDelegation,
  type StoredSecrets
} from './config-manifest'
import {
  CpaKeyStorageUnavailableError,
  CpaUnownedConfigError,
  type CpaConfigInspection,
  type CpaConfigKeys,
  type CpaConfigOwnerOptions,
  type CpaConfigOwnership,
  type CpaSafeStorage,
  type CpaSettingsStore
} from './config-ownership'

export { CpaKeyStorageUnavailableError, CpaUnownedConfigError } from './config-ownership'
export type {
  CpaConfigInspection,
  CpaConfigKeys,
  CpaConfigOwnerOptions,
  CpaConfigOwnership,
  CpaSafeStorage,
  CpaSettingsStore
} from './config-ownership'

export const DEFAULT_CLIPROXY_PORT = 8319

const CONFIG_DIRECTORY = 'cliproxy'
const CONFIG_FILE = 'config.yaml'
const KEY_FILE = 'keys.safe-storage'

export class CpaConfigOwner {
  readonly directory: string
  readonly configPath: string
  readonly keyPath: string

  private readonly settings: CpaSettingsStore
  private readonly isServiceStopped: () => boolean
  private readonly storage: CpaSafeStorage
  private readonly warn: (message: string) => void
  private readonly claudeDelegation: () => Promise<CpaClaudeDelegation | null>

  constructor(options: CpaConfigOwnerOptions) {
    this.directory = path.join(options.userDataPath, CONFIG_DIRECTORY)
    this.configPath = path.join(this.directory, CONFIG_FILE)
    this.keyPath = path.join(this.directory, KEY_FILE)
    this.settings = options.settings
    this.isServiceStopped = options.isServiceStopped
    this.storage = options.storage ?? safeStorage
    this.warn = options.warn ?? ((message) => console.warn(`[cliproxy] ${message}`))
    this.claudeDelegation = options.claudeDelegation ?? (async () => null)
  }

  async ensure(): Promise<CpaConfigOwnership> {
    const port = this.resolvePort()
    const stored = await this.readSecrets()
    if (!stored) {
      await this.assertNoUnownedConfig()
      this.assertEncryptionAvailable()
      const generated = this.generateSecrets()
      await this.writeOwnedFiles(generated, port)
      return this.result(generated, port, {
        drifted: false,
        driftKeys: [],
        transientRead: false
      })
    }

    let inspection = await this.inspectWith(stored, port)
    if (inspection.acceptedManagementConfigValue) {
      stored.acceptedManagementConfigValue = inspection.acceptedManagementConfigValue
      await this.writeSecrets(stored)
    }
    // Self-heal an Orca-owned config instead of wedging on drift. Every key we
    // diff is one we generate, and some (the teamclaude delegation) track live
    // state, so an app upgrade that adds a key would otherwise strand the user
    // in `setup-needed` with no reachable repair. Only rewrite while the
    // service is stopped — CPA reloads its config on a 150ms watcher, so a
    // live rewrite would race a running process.
    if ((inspection.missing || inspection.drifted) && !inspection.transientRead) {
      if (!this.isServiceStopped()) {
        return this.result(stored, port, inspection)
      }
      await this.writeConfig(stored, port)
      inspection = await this.inspectWith(stored, port)
    }
    return this.result(stored, port, inspection)
  }

  async inspect(): Promise<CpaConfigInspection> {
    const stored = await this.requireSecrets()
    const inspection = await this.inspectWith(stored, this.resolvePort())
    if (inspection.acceptedManagementConfigValue) {
      stored.acceptedManagementConfigValue = inspection.acceptedManagementConfigValue
      await this.writeSecrets(stored)
    }
    return {
      drifted: inspection.drifted,
      driftKeys: inspection.driftKeys,
      transientRead: inspection.transientRead
    }
  }

  async regenerate(): Promise<CpaConfigOwnership> {
    if (!this.isServiceStopped()) {
      throw new Error('CLIProxyAPI must be stopped before regenerating its owned configuration')
    }
    this.assertEncryptionAvailable()
    const port = this.resolvePort()
    const generated = this.generateSecrets()
    await this.writeOwnedFiles(generated, port)
    return this.result(generated, port, {
      drifted: false,
      driftKeys: [],
      transientRead: false
    })
  }

  private resolvePort(): number {
    const current = this.settings.getSettings().cliproxyPort
    const port =
      Number.isInteger(current) && current !== undefined && current >= 1024 && current <= 65_535
        ? current
        : DEFAULT_CLIPROXY_PORT
    if (current !== port) {
      this.settings.updateSettings({ cliproxyPort: port })
    }
    return port
  }

  private assertEncryptionAvailable(): void {
    if (this.storage.isEncryptionAvailable()) {
      return
    }
    const error = new CpaKeyStorageUnavailableError()
    this.warn(error.message)
    throw error
  }

  private async assertNoUnownedConfig(): Promise<void> {
    try {
      await readFile(this.configPath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return
      }
      throw error
    }
    const error = new CpaUnownedConfigError()
    this.warn(error.message)
    throw error
  }

  private generateSecrets(): StoredSecrets {
    const apiKey = `orca-cpa-api-${randomBytes(32).toString('base64url')}`
    const managementKey = `orca-cpa-management-${randomBytes(32).toString('base64url')}`
    return {
      version: 1,
      apiKey,
      managementKey,
      acceptedManagementConfigValue: managementKey
    }
  }

  private async readSecrets(): Promise<StoredSecrets | null> {
    let encrypted: Buffer
    try {
      encrypted = await readFile(this.keyPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null
      }
      throw error
    }
    this.assertEncryptionAvailable()
    let parsed: unknown
    try {
      parsed = JSON.parse(this.storage.decryptString(encrypted))
    } catch (error) {
      throw new Error(
        `CLIProxyAPI recovery keys could not be decrypted: ${error instanceof Error ? error.message : String(error)}`
      )
    }
    if (!isStoredSecrets(parsed)) {
      throw new Error('CLIProxyAPI recovery key envelope is invalid')
    }
    return parsed
  }

  private async requireSecrets(): Promise<StoredSecrets> {
    const stored = await this.readSecrets()
    if (!stored) {
      throw new Error('CLIProxyAPI recovery keys have not been generated')
    }
    return stored
  }

  private async writeOwnedFiles(secrets: StoredSecrets, port: number): Promise<void> {
    await mkdir(this.directory, { recursive: true })
    await this.writeSecrets(secrets)
    await this.writeConfig(secrets, port)
  }

  private async writeSecrets(secrets: StoredSecrets): Promise<void> {
    this.assertEncryptionAvailable()
    await mkdir(this.directory, { recursive: true })
    const encrypted = this.storage.encryptString(JSON.stringify(secrets))
    await atomicWrite(this.keyPath, encrypted, 0o600)
  }

  private async writeConfig(secrets: StoredSecrets, port: number): Promise<void> {
    await mkdir(this.directory, { recursive: true })
    const delegation = await this.resolveDelegation()
    const manifest = expectedManifest(this.directory, port, secrets, delegation)
    const document: Record<string, unknown> = {
      host: manifest.host,
      port: manifest.port,
      'auth-dir': manifest.authDir,
      'api-keys': manifest.apiKeys,
      'remote-management': {
        'allow-remote': manifest.managementAllowRemote,
        'secret-key': secrets.managementKey,
        'disable-control-panel': manifest.disableControlPanel
      },
      'usage-statistics-enabled': manifest.usageStatisticsEnabled,
      'logging-to-file': manifest.loggingToFile,
      'logs-max-total-size-mb': manifest.logsMaxTotalSizeMb,
      'request-log': manifest.requestLog
    }
    if (delegation) {
      document['claude-api-key'] = [
        { 'api-key': delegation.apiKey, 'base-url': delegation.baseUrl }
      ]
    }
    await atomicWrite(this.configPath, stringify(document), 0o600)
    // The file now holds the PLAINTEXT management key; CPA replaces it with a
    // bcrypt hash on its next start, and that hash gets remembered as the
    // accepted value. Reset the accepted value to the plaintext we just wrote,
    // or a rewrite would be diffed against a hash from an earlier run and
    // drift forever (rewrite -> still drifted -> rewrite ...).
    if (secrets.acceptedManagementConfigValue !== secrets.managementKey) {
      secrets.acceptedManagementConfigValue = secrets.managementKey
      await this.writeSecrets(secrets)
    }
  }

  /** teamclaude fleet delegation for CPA's Claude provider. A resolver failure
   * degrades to "no delegation" rather than blocking config generation. */
  private async resolveDelegation(): Promise<CpaClaudeDelegation | null> {
    try {
      return await this.claudeDelegation()
    } catch (error) {
      this.warn(
        `teamclaude delegation unavailable: ${error instanceof Error ? error.message : String(error)}`
      )
      return null
    }
  }

  private async inspectWith(
    secrets: StoredSecrets,
    port: number
  ): Promise<
    CpaConfigInspection & {
      missing?: boolean
      acceptedManagementConfigValue?: string
    }
  > {
    let raw: string
    try {
      raw = await readFile(this.configPath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { drifted: false, driftKeys: [], transientRead: false, missing: true }
      }
      throw error
    }
    if (raw.trim() === '') {
      return { drifted: false, driftKeys: [], transientRead: true }
    }

    let parsed: unknown
    try {
      parsed = parse(raw)
    } catch {
      // Why: CPA atomically rewrites YAML, but watchers can still observe a transient
      // empty/truncated read; never turn that into a destructive regeneration offer.
      return { drifted: false, driftKeys: [], transientRead: true }
    }
    const actual = semanticManifest(parsed)
    if (!actual) {
      return { drifted: false, driftKeys: [], transientRead: true }
    }

    const expected = expectedManifest(this.directory, port, secrets, await this.resolveDelegation())
    const driftKeys = manifestDifferences(expected, actual, secrets.acceptedManagementConfigValue)
    const managementValue = actual.managementSecretKey
    const acceptsCpaHash =
      secrets.acceptedManagementConfigValue === secrets.managementKey &&
      isCpaManagementHash(managementValue)
    return {
      drifted: driftKeys.length > 0,
      driftKeys,
      transientRead: false,
      ...(acceptsCpaHash ? { acceptedManagementConfigValue: managementValue } : {})
    }
  }

  private result(
    secrets: CpaConfigKeys,
    port: number,
    inspection: CpaConfigInspection
  ): CpaConfigOwnership {
    return {
      configPath: this.configPath,
      port,
      apiKey: secrets.apiKey,
      managementKey: secrets.managementKey,
      ...inspection
    }
  }
}

async function atomicWrite(target: string, value: string | Buffer, mode: number): Promise<void> {
  const temporary = `${target}.${randomUUID()}.tmp`
  await writeFile(temporary, value, { mode })
  await rename(temporary, target)
  await chmod(target, mode).catch(() => undefined)
}
