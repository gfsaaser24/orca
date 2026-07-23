import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveNodeEntrypoint } from './supervisor-runtime'

const roots: string[] = []
const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'orca-teamclaude-resolver-'))
  roots.push(root)
  return root
}
const write = (path: string, contents = ''): void => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents, 'utf8')
}
const envFor = (bin: string): NodeJS.ProcessEnv => ({ PATH: bin, PATHEXT: '.EXE;.CMD' })
const nodeExecutable = process.platform === 'win32' ? 'node.exe' : 'node'
const teamclaudeShim = process.platform === 'win32' ? 'teamclaude.cmd' : 'teamclaude'
const makePackage = (dir: string): string => {
  const entry = join(dir, 'dist', 'teamclaude-cli.js')
  write(
    join(dir, 'package.json'),
    JSON.stringify({
      name: '@karpeleslab/teamclaude',
      bin: { teamclaude: 'dist/teamclaude-cli.js' }
    })
  )
  write(entry)
  write(join(dir, 'src', 'index.js'))
  return entry
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('resolveNodeEntrypoint', () => {
  it('resolves package.json bin from the exact scoped %dp0% npm shim layout', async () => {
    const root = tempRoot()
    const bin = join(root, 'bin')
    const pkg = join(bin, 'node_modules', '@karpeleslab', 'teamclaude')
    const entry = makePackage(pkg)
    write(join(bin, nodeExecutable))
    write(
      join(bin, teamclaudeShim),
      '@ECHO off\r\nSET dp0=%~dp0\r\nSETLOCAL\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@karpeleslab\\teamclaude\\src\\index.js" %*\r\n'
    )

    const result = await resolveNodeEntrypoint(null, envFor(bin))
    expect(result.kind).toBe('resolved')
    if (result.kind !== 'resolved') {
      throw new Error(result.kind)
    }
    expect(result.resolution).toMatchObject({ node: join(bin, nodeExecutable), entry })
    expect(result.nodeFallback).toBe('path-node')
    expect(result.attemptedCandidates).toContain(join(pkg, 'package.json'))
  })

  it('resolves a scoped package referenced by a %~dp0 store shim', async () => {
    const root = tempRoot()
    const bin = join(root, 'bin')
    const pkg = join(root, 'store', 'node_modules', '@karpeleslab', 'teamclaude')
    const entry = makePackage(pkg)
    write(join(bin, nodeExecutable))
    write(
      join(bin, teamclaudeShim),
      '@ECHO off\r\n%~dp0\\..\\store\\node_modules\\@karpeleslab\\teamclaude\\src\\index.js %*\r\n'
    )

    const result = await resolveNodeEntrypoint(null, envFor(bin))
    expect(result.kind).toBe('resolved')
    if (result.kind !== 'resolved') {
      throw new Error(result.kind)
    }
    expect(result.resolution.entry).toBe(entry)
    expect(result.attemptedCandidates).toContain(join(pkg, 'package.json'))
  })

  it('follows a scoped global node_modules junction', async () => {
    const root = tempRoot()
    const bin = join(root, 'prefix')
    const real = join(root, 'store', '@karpeleslab', 'teamclaude')
    const linked = join(bin, 'node_modules', '@karpeleslab', 'teamclaude')
    makePackage(real)
    mkdirSync(dirname(linked), { recursive: true })
    symlinkSync(real, linked, 'junction')
    write(join(bin, nodeExecutable))
    write(
      join(bin, teamclaudeShim),
      '@ECHO off\r\n%~dp0\\node_modules\\@karpeleslab\\teamclaude\\src\\index.js %*\r\n'
    )

    const result = await resolveNodeEntrypoint(null, envFor(bin))
    expect(result.kind).toBe('resolved')
    if (result.kind !== 'resolved') {
      throw new Error(result.kind)
    }
    expect(result.resolution.entry).toBe(join(linked, 'dist', 'teamclaude-cli.js'))
  })

  it('distinguishes not-found from shim-unresolvable with evidence', async () => {
    const bin = join(tempRoot(), 'bin')
    mkdirSync(bin)
    const missing = await resolveNodeEntrypoint(null, envFor(bin))
    expect(missing).toMatchObject({
      kind: 'not-found',
      foundPath: null,
      nodeFallback: 'electron-run-as-node'
    })
    expect(missing.attemptedCandidates.length).toBeGreaterThan(0)

    const shim = join(bin, teamclaudeShim)
    write(shim, '@ECHO off\r\nREM no target\r\n')
    const broken = await resolveNodeEntrypoint(shim, envFor(bin))
    expect(broken).toMatchObject({ kind: 'shim-unresolvable', foundPath: shim })
    expect(broken.attemptedCandidates).toContain(shim)
  })

  it('uses Electron as Node when a resolvable shim has no system Node', async () => {
    const root = tempRoot()
    const bin = join(root, 'bin')
    const pkg = join(root, 'store', 'node_modules', '@karpeleslab', 'teamclaude')
    const entry = makePackage(pkg)
    const shim = join(bin, teamclaudeShim)
    write(
      shim,
      '@ECHO off\r\n%dp0%\\..\\store\\node_modules\\@karpeleslab\\teamclaude\\src\\index.js %*\r\n'
    )

    const result = await resolveNodeEntrypoint(shim, envFor(bin))
    expect(result.kind).toBe('resolved')
    if (result.kind !== 'resolved') {
      throw new Error(result.kind)
    }
    expect(result.resolution).toMatchObject({
      node: process.execPath,
      entry,
      env: { ELECTRON_RUN_AS_NODE: '1' }
    })
    expect(result.nodeFallback).toBe('electron-run-as-node')
  })
})
