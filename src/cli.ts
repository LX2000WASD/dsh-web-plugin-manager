#!/usr/bin/env node
/**
 * dshpm — the dsh-web-plugin-manager command line.
 *
 * Every mutation goes through the same protected path as the Web UI:
 * pnpm add/remove through the official dsh CLI, the quality gate (undeclared
 * imports, official packages declared as regular dependencies), rollback on
 * failure, post-install analysis, and managed insert-row bookkeeping.
 *
 * Agents that manage plugins for a user should call this CLI (or the
 * plugin_* tools) instead of raw dsh plugin / pnpm commands: the raw path
 * skips the quality gate and can break the whole profile at runtime.
 *
 * Usage:
 *   dshpm install <source> [--profile <name>]
 *   dshpm remove <name>    [--profile <name>]
 *   dshpm update <name>    [--profile <name>]
 *   dshpm mount <name>     [--profile <name>]
 *   dshpm list             [--profile <name>]
 *   dshpm analyze          [--profile <name>]
 *   dshpm help | --help
 *   dshpm version | --version
 *
 * --home <path> overrides the Harness home (default: $DSH_HOME or ~/.dsh).
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { analyzeProfile } from './analyze.ts'
import { installWithSource, removeProtected, updateProtected } from './index.ts'
import { addInsertRow, readInsertRows, readManagedIds, removeInsertRow, writePatch } from './patch.ts'

/** Resolve the Harness home directory (DSH_HOME env, then ~/.dsh). */
function dshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** The safe-profile-name rule (mirrors src/index.ts). */
function isSafeProfileName(name: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(name) && name.length <= 120
}

/** Resolve one profile's directory, rejecting traversal. */
function profileDir(name: string): string {
  if (!isSafeProfileName(name)) {
    throw new Error('unsafe profile name: ' + JSON.stringify(name))
  }
  return join(dshHome(), 'profiles', name)
}

/** The profile's package.json manifest, parsed defensively. */
function readManifest(dir: string): Record<string, unknown> {
  const path = join(dir, 'package.json')
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

/** The profile's cordis.patch.yml path (may not exist yet). */
function patchPath(dir: string): string {
  return join(dir, 'cordis.patch.yml')
}

/** Read patch file content, or the empty string when absent. */
function readPatch(dir: string): string {
  const path = patchPath(dir)
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

/** Turn a package name into a safe insert-row id (mirrors src/index.ts). */
function slugify(name: string): string {
  return name.replace(/^@/, '').replace(/[^a-z0-9-]/gi, '-').toLowerCase()
}

/** The profile's bundle layer list (dsh.profile.bundles). */
function readBundles(dir: string): string[] {
  const manifest = readManifest(dir)
  const dsh = (manifest['dsh'] ?? {}) as Record<string, unknown>
  const profileManifest = (dsh['profile'] ?? {}) as Record<string, unknown>
  const bundles = Array.isArray(profileManifest['bundles']) ? profileManifest['bundles'] as string[] : []
  return [...bundles]
}

function printHelp(): void {
  process.stdout.write(`dshpm — dsh-web-plugin-manager CLI (protected plugin operations)

Usage:
  dshpm install <source> [--profile <name>]   Install a plugin (quality gate + rollback)
  dshpm remove <name>    [--profile <name>]   Remove a plugin or managed insert row
  dshpm update <name>    [--profile <name>]   Update a plugin to @latest (quality gate + rollback)
  dshpm mount <name>     [--profile <name>]   Mount an installed-but-unmounted dependency as an insert row
  dshpm list             [--profile <name>]   List bundles, packages, and insert rows
  dshpm analyze          [--profile <name>]   Run the dependency/conflict health analysis
  dshpm help | --help                         Show this help
  dshpm version | --version                   Show the package version

Options:
  --profile <name>   Target profile directory under the Harness home (default: web)
  --home <path>      Harness home override (default: \$DSH_HOME or ~/.dsh)

Sources: npm package name, github:user/repo, git URL, tarball URL, or ./local/path.
Every install runs the quality gate and rolls back on failure — the same
protected flow the Web UI and the plugin_* agent tools use.
`)
}

/** Parse --profile/--home flags out of argv; returns [positionals, options]. */
function parseArgs(argv: readonly string[]): { positionals: string[]; profile: string; home: string | null } {
  const positionals: string[] = []
  let profile = 'web'
  let home: string | null = null
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!
    if (arg === '--profile' && i + 1 < argv.length) {
      profile = argv[++i]!
    } else if (arg === '--home' && i + 1 < argv.length) {
      home = argv[++i]!
    } else if (arg.startsWith('--profile=')) {
      profile = arg.slice('--profile='.length)
    } else if (arg.startsWith('--home=')) {
      home = arg.slice('--home='.length)
    } else {
      positionals.push(arg)
    }
  }
  return { positionals, profile, home }
}

async function cmdInstall(profile: string, source: string): Promise<number> {
  const result = await installWithSource(null, profile, source)
  process.stdout.write(result.output + '\n')
  return result.ok ? 0 : 1
}

async function cmdRemove(profile: string, name: string): Promise<number> {
  const dir = profileDir(profile)
  if (!existsSync(dir)) {
    process.stdout.write('profile not found: ' + profile + '\n')
    return 1
  }
  // Managed insert row first (non-bundle plugin): file-level removal; a
  // running profile's patch watcher applies it, other profiles on start.
  const content = readPatch(dir)
  const rows = readInsertRows(content)
  const row = rows.find(r => r.id === name || r.name === name)
  let removedRow = false
  if (row !== undefined && row.managed) {
    const { content: next, removed } = removeInsertRow(content, row.id)
    if (removed) {
      writePatch(patchPath(dir), next)
      removedRow = true
    }
  }
  // A non-bundle plugin is BOTH an insert row and a profile dependency:
  // remove the package as well (manifest entry + node_modules) when the
  // name is declared, through the official CLI.
  const deps = (readManifest(dir)['dependencies'] ?? {}) as Record<string, string>
  if (name in deps) {
    const result = await removeProtected(null, profile, name)
    process.stdout.write(result.output + '\n')
    if (!result.ok) return 1
    if (removedRow) process.stdout.write('removed insert row ' + row!.id + ' and package ' + name + '\n')
    return 0
  }
  if (removedRow) {
    process.stdout.write('removed insert row ' + row!.id + ' (file updated; applied by the running profile via HMR, or on next start)\n')
    return 0
  }
  process.stdout.write(JSON.stringify(name) + ' is not a managed insert row nor a profile dependency\n')
  return 1
}

function cmdList(profile: string): number {
  const dir = profileDir(profile)
  if (!existsSync(dir)) {
    process.stdout.write('profile not found: ' + profile + '\n')
    return 1
  }
  const manifest = readManifest(dir)
  const deps = (manifest['dependencies'] ?? {}) as Record<string, string>
  const bundles = readBundles(dir)
  const rows = readInsertRows(readPatch(dir))
  process.stdout.write('profile ' + profile + ' (' + dir + ')\n')
  process.stdout.write('\nbundle layers:\n')
  for (const bundle of bundles) process.stdout.write('  - ' + bundle + '\n')
  if (bundles.length === 0) process.stdout.write('  (none)\n')
  process.stdout.write('\ninstalled packages:\n')
  const names = Object.keys(deps)
  for (const name of names) {
    const source = deps[name] ?? ''
    const extra = source.length > 0 && source !== name ? ' (' + source + ')' : ''
    process.stdout.write('  - ' + name + extra + '\n')
  }
  if (names.length === 0) process.stdout.write('  (none)\n')
  process.stdout.write('\nmanaged insert rows:\n')
  for (const row of rows) {
    process.stdout.write('  - ' + row.id + ' -> ' + row.name + (row.managed ? '' : ' (user-owned)') + '\n')
  }
  if (rows.length === 0) process.stdout.write('  (none)\n')
  return 0
}

async function cmdUpdate(profile: string, name: string): Promise<number> {
  const result = await updateProtected(profile, name)
  process.stdout.write(result.output + '\n')
  return result.ok ? 0 : 1
}

function cmdMount(profile: string, packageName: string): number {
  const dir = profileDir(profile)
  if (!existsSync(dir)) {
    process.stdout.write('profile not found: ' + profile + '\n')
    return 1
  }
  const manifest = readManifest(dir)
  const deps = (manifest['dependencies'] ?? {}) as Record<string, string>
  if (!(packageName in deps)) {
    process.stdout.write(packageName + ' is not a profile dependency (install it first)\n')
    return 1
  }
  const bundles = readBundles(dir)
  if (bundles.includes(packageName)) {
    process.stdout.write(packageName + ' is a bundle-layer plugin — it loads on restart, no mount row needed\n')
    return 0
  }
  const current = readPatch(dir)
  const rowId = slugify(packageName)
  const existing = readInsertRows(current).find(row => row.id === rowId && row.name !== packageName)
  const userOwns = readManagedIds(current).has(rowId)
  if (existing !== undefined || userOwns) {
    process.stdout.write('row id ' + rowId + ' is already used'
      + (existing !== undefined ? ' by ' + existing.name : ' by a user row') + ' (id collision)\n')
    return 1
  }
  const next = addInsertRow(current, rowId, packageName)
  if (next === current) {
    process.stdout.write(packageName + ' is already mounted\n')
    return 0
  }
  writePatch(patchPath(dir), next)
  process.stdout.write('mounted ' + packageName + ' as insert row ' + rowId
    + ' (file updated; applied by the running profile via HMR, or on next start)\n')
  return 0
}

function cmdAnalyze(profile: string): number {
  const dir = profileDir(profile)
  if (!existsSync(dir)) {
    process.stdout.write('profile not found: ' + profile + '\n')
    return 1
  }
  const bundles = readBundles(dir)
  const analysis = analyzeProfile(dir, bundles, readPatch(dir), new Set(), [])
  process.stdout.write('analysis of profile ' + profile + ': ' + (analysis.ok ? 'no issues\n' : analysis.issues.length + ' issue(s)\n'))
  for (const issue of analysis.issues) {
    process.stdout.write('  - [' + issue.kind + '] ' + issue.message + '\n')
  }
  if (analysis.topoOrder.length > 0) {
    process.stdout.write('\nload order: ' + analysis.topoOrder.join(' -> ') + '\n')
  }
  return analysis.ok ? 0 : 1
}

async function main(): Promise<number> {
  const { positionals, profile, home } = parseArgs(process.argv.slice(2))
  if (home !== null) process.env.DSH_HOME = home
  const command = positionals[0]
  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    printHelp()
    return 0
  }
  if (command === 'version' || command === '--version' || command === '-v') {
    try {
      const manifest = JSON.parse(
        readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
      ) as { version?: unknown }
      process.stdout.write((typeof manifest.version === 'string' ? manifest.version : 'unknown') + '\n')
    } catch {
      process.stdout.write('unknown\n')
    }
    return 0
  }
  if (command === 'install') {
    const source = positionals[1]
    if (source === undefined) {
      process.stdout.write('dshpm install: missing source (npm name, github:user/repo, git URL, tarball, or local path)\n')
      return 1
    }
    return await cmdInstall(profile, source)
  }
  if (command === 'remove') {
    const name = positionals[1]
    if (name === undefined) {
      process.stdout.write('dshpm remove: missing plugin name\n')
      return 1
    }
    return await cmdRemove(profile, name)
  }
  if (command === 'update') {
    const name = positionals[1]
    if (name === undefined) {
      process.stdout.write('dshpm update: missing plugin name\n')
      return 1
    }
    return await cmdUpdate(profile, name)
  }
  if (command === 'mount') {
    const name = positionals[1]
    if (name === undefined) {
      process.stdout.write('dshpm mount: missing plugin name\n')
      return 1
    }
    return cmdMount(profile, name)
  }
  if (command === 'list') return cmdList(profile)
  if (command === 'analyze') return cmdAnalyze(profile)
  process.stdout.write('dshpm: unknown command ' + JSON.stringify(command) + ' (try dshpm --help)\n')
  return 1
}

main().then(
  (code) => { process.exitCode = code },
  (error: unknown) => {
    process.stderr.write('dshpm: ' + (error instanceof Error ? error.message : String(error)) + '\n')
    process.exitCode = 1
  },
)
