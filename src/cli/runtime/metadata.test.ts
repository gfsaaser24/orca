import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getDefaultUserDataPath } from './metadata'

// Why: Orca TC installs side-by-side with official Orca. The standalone CLI's
// default runtime dir MUST be namespaced to `orca-tc` so `orcatc` commands
// resolve the Orca TC app's runtime metadata, never official Orca's `orca` dir.
describe('getDefaultUserDataPath (Orca TC namespace)', () => {
  const originalAppData = process.env.APPDATA
  const originalOverride = process.env.ORCA_USER_DATA_PATH

  beforeEach(() => {
    delete process.env.ORCA_USER_DATA_PATH
  })

  afterEach(() => {
    if (originalAppData === undefined) {
      delete process.env.APPDATA
    } else {
      process.env.APPDATA = originalAppData
    }
    if (originalOverride === undefined) {
      delete process.env.ORCA_USER_DATA_PATH
    } else {
      process.env.ORCA_USER_DATA_PATH = originalOverride
    }
  })

  it('uses %APPDATA%\\orca-tc on win32', () => {
    process.env.APPDATA = join('C:', 'Users', 'dev', 'AppData', 'Roaming')
    expect(getDefaultUserDataPath('win32', join('C:', 'Users', 'dev'))).toBe(
      join(process.env.APPDATA, 'orca-tc')
    )
  })

  it('uses Application Support/orca-tc on darwin', () => {
    const home = join('/Users', 'dev')
    expect(getDefaultUserDataPath('darwin', home)).toBe(
      join(home, 'Library', 'Application Support', 'orca-tc')
    )
  })

  it('uses $XDG_CONFIG_HOME/orca-tc (or ~/.config/orca-tc) on linux', () => {
    const home = join('/home', 'dev')
    const priorXdg = process.env.XDG_CONFIG_HOME
    delete process.env.XDG_CONFIG_HOME
    try {
      expect(getDefaultUserDataPath('linux', home)).toBe(join(home, '.config', 'orca-tc'))
    } finally {
      if (priorXdg === undefined) {
        delete process.env.XDG_CONFIG_HOME
      } else {
        process.env.XDG_CONFIG_HOME = priorXdg
      }
    }
  })

  it('honors the ORCA_USER_DATA_PATH override verbatim', () => {
    const override = join('D:', 'custom', 'runtime')
    process.env.ORCA_USER_DATA_PATH = override
    expect(getDefaultUserDataPath('win32', join('C:', 'Users', 'dev'))).toBe(override)
  })
})
