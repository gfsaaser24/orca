import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { delimiter, dirname, join, resolve as resolvePath, sep } from 'node:path'
import type { EntrypointResolution, EntrypointResolutionResult } from './supervisor-types'

export async function resolveNodeEntrypoint(
  binPath: string | null,
  env: NodeJS.ProcessEnv = process.env
): Promise<EntrypointResolutionResult> {
  const nodeLookup = locateOnPath('node', env)
  const nodeFallback = nodeLookup.found ? 'path-node' : 'electron-run-as-node'
  const binaryLookup = binPath
    ? { found: existsSync(binPath) ? binPath : null, attempted: [binPath] }
    : locateOnPath('teamclaude', env)
  const found = binaryLookup.found
  if (!found) {
    return {
      kind: 'not-found',
      foundPath: null,
      attemptedCandidates: binaryLookup.attempted,
      nodeFallback
    }
  }

  const entryResult = await resolveEntryFromShim(found)
  if (!entryResult.entry) {
    return {
      kind: 'shim-unresolvable',
      foundPath: found,
      attemptedCandidates: entryResult.attempted,
      nodeFallback
    }
  }

  const resolution: EntrypointResolution = {
    node: nodeLookup.found ?? process.execPath,
    entry: entryResult.entry,
    foundPath: found,
    ...(nodeLookup.found ? {} : { env: { ELECTRON_RUN_AS_NODE: '1' } })
  }
  return {
    kind: 'resolved',
    resolution,
    foundPath: found,
    attemptedCandidates: entryResult.attempted,
    nodeFallback
  }
}

function locateOnPath(
  name: string,
  env: NodeJS.ProcessEnv
): { found: string | null; attempted: string[] } {
  const pathVar = env.PATH || env.Path || ''
  const attempted: string[] = []
  const exts =
    process.platform === 'win32'
      ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
          .split(';')
          .map((extension) => extension.toLowerCase())
      : ['']
  for (const dir of pathVar.split(delimiter)) {
    if (!dir) {
      continue
    }
    for (const extension of exts) {
      const candidate = join(dir, name + extension)
      attempted.push(candidate)
      if (existsSync(candidate)) {
        return { found: candidate, attempted }
      }
    }
    const bare = join(dir, name)
    attempted.push(bare)
    if (process.platform !== 'win32' && existsSync(bare)) {
      return { found: bare, attempted }
    }
  }
  return { found: null, attempted }
}

type EntryLookup = { entry: string | null; attempted: string[] }

async function resolveEntryFromShim(found: string): Promise<EntryLookup> {
  const attempted = [found]
  if (found.toLowerCase().endsWith('.js')) {
    return { entry: existsSync(found) ? found : null, attempted }
  }

  const shimDir = dirname(found)
  try {
    const text = readFileSync(found, 'utf8')
    const matches = text.match(/[^\s"']+index\.js|[^\s"']+\.js/gi)
    for (const raw of matches ?? []) {
      const reference = raw.replace(/"|'/g, '').trim()
      const absolute = resolvePath(shimDir, normalizeShimReference(reference))
      attempted.push(absolute)
      const packageDir = findReferencedPackageRoot(absolute, attempted)
      if (packageDir) {
        const packageEntry = await entryFromPackage(packageDir, attempted)
        if (packageEntry) {
          return { entry: packageEntry, attempted }
        }
      }
      if (existsSync(absolute)) {
        return { entry: absolute, attempted }
      }
    }
  } catch {
    // An unreadable shim is reported as shim-unresolvable with the candidates tried.
  }

  const moduleRoots = [
    join(shimDir, 'node_modules'),
    join(shimDir, '..'),
    join(shimDir, '..', 'node_modules'),
    join(shimDir, '..', 'lib', 'node_modules')
  ]
  const packageNames = [join('@karpeleslab', 'teamclaude'), 'teamclaude']
  const packageDirs = [
    ...new Set(moduleRoots.flatMap((root) => packageNames.map((name) => join(root, name))))
  ]
  for (const packageDir of packageDirs) {
    const entry = await entryFromPackage(packageDir, attempted)
    if (entry) {
      return { entry, attempted }
    }
  }
  return { entry: null, attempted }
}

function normalizeShimReference(raw: string): string {
  return raw
    .replace(/^%~dp0[\\/]?/i, '')
    .replace(/^%dp0%[\\/]?/i, '')
    .replace(/^\$basedir[\\/]?/i, '')
    .replace(/[\\/]+/g, sep)
    .trim()
}

function findReferencedPackageRoot(candidate: string, attempted: string[]): string | null {
  let current = dirname(candidate)
  for (;;) {
    const packageJson = join(current, 'package.json')
    attempted.push(packageJson)
    if (existsSync(packageJson)) {
      return current
    }
    const parent = dirname(current)
    if (parent === current) {
      return null
    }
    current = parent
  }
}

async function entryFromPackage(packageDir: string, attempted: string[]): Promise<string | null> {
  const packageJson = join(packageDir, 'package.json')
  attempted.push(packageJson)
  if (!existsSync(packageJson)) {
    return null
  }
  try {
    const packageDefinition = JSON.parse(await readFile(packageJson, 'utf8')) as {
      bin?: string | Record<string, string>
      main?: string
    }
    const bin = packageDefinition.bin
    const binEntry =
      typeof bin === 'string'
        ? bin
        : bin && typeof bin === 'object'
          ? (bin.teamclaude ?? Object.values(bin)[0])
          : undefined
    const relativeEntry = binEntry ?? packageDefinition.main ?? 'src/index.js'
    if (!relativeEntry) {
      return null
    }
    const entry = join(packageDir, relativeEntry)
    attempted.push(entry)
    return existsSync(entry) ? entry : null
  } catch {
    return null
  }
}
