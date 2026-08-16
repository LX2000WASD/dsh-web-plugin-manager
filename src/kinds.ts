/**
 * Multi-kind install support (Phase B): detect and install skill and
 * agent-preset repositories into the OFFICIAL harness roots
 * (<dshHome>/skills, <dshHome>/.agent-presets — verified against the DSH
 * source: skill-filesystem scans <dshHome>/skills with a default chokidar
 * watch (hot reload), agent-presets discovers <dshHome>/.agent-presets on
 * every read with agent.cordis.yml as the composition file).
 *
 * Detection mirrors the community marketplace's layered ordering WITHOUT the
 * script type: repositories carrying install.sh/ps1 are never auto-executed
 * (third-party code) and fall through to instructions. A preset is any
 * directory holding agent.cordis.yml (the official composition file) —
 * preset.yml is only optional display metadata, not a requirement.
 *
 * Also owns the shared install record store (installed-kinds.json) and the
 * blocked-repos list (repositories detected as non-installable are filtered
 * from every marketplace listing, cached or fresh).
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { writeOwnerMarker } from './presets.ts'

/** The kind of installable content a repository carries. */
export type RepoKind = 'agent-preset' | 'cordis-plugin' | 'skill' | 'instructions'

/** Official composition file that makes a directory an agent preset. */
export const PRESET_COMPOSITION_FILE = 'agent.cordis.yml'

/** Official skill manifest file. */
export const SKILL_MANIFEST_FILE = 'SKILL.md'

/** The harness home (DSH_HOME env, then ~/.dsh). */
export function dshHomePath(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** Official user skill root. */
export function skillsDirPath(): string {
  return join(dshHomePath(), 'skills')
}

/** Official user agent-preset root. */
export function presetsDirPath(): string {
  return join(dshHomePath(), '.agent-presets')
}

/** Sluggish dir-name form used by skill/preset install dirs. */
export function slugDirName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'plugin'
}

/** Windows reserved device names (CON/NUL/COM1...) — mkdir fails EINVAL. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/** A directory name safe on every platform (reserved names get a suffix). */
export function safeDirName(name: string): string {
  return WINDOWS_RESERVED.test(name) ? name + '-skill' : name
}

/** Normalize a repository reference (URL or owner/repo) to lowercase owner/repo. */
export function normalizeRepoRef(value: string): string | null {
  const s = value.trim()
    .replace(/^git\+/i, '')
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/^git@github\.com:/i, '')
    .replace(/^github:/i, '')
    .replace(/\.git$/i, '')
    .split('#')[0]
    .replace(/\/+$/, '')
  return s.length > 0 ? s.toLowerCase() : null
}

/**
 * DSH plugin eligibility: the manifest declares a `dsh` field, or depends on
 * the DSH core packages. Repos that merely carry a package.json (aggregate
 * pages, desktop apps, plain npm projects) are filtered out.
 */
export function looksLikeDshPlugin(pkg: unknown): boolean | null {
  if (pkg === null || typeof pkg !== 'object') return null
  const manifest = pkg as Record<string, unknown>
  if (manifest.dsh !== null && typeof manifest.dsh === 'object') return true
  const merge = (section: unknown): Record<string, unknown> =>
    section !== null && typeof section === 'object' ? section as Record<string, unknown> : {}
  const deps = { ...merge(manifest.dependencies), ...merge(manifest.peerDependencies) }
  const names = Object.keys(deps)
  if (names.includes('@deepseek-ai/cordis') || names.includes('@deepseek-ai/dsh')) return true
  return names.some(name => name.startsWith('@deepseek-ai/dsh-'))
}

/** vendored 目录惯例命名：子模块/第三方源码，其中的 SKILL.md 不属于本仓库分发。 */
const VENDORED_DIR_NAMES = new Set(['upstream', 'vendor', 'vendored', 'third_party', 'third-party', 'external', 'deps'])

/** Read a directory listing defensively (missing/unreadable → []). */
function readDirEntries(dir: string): Array<{ name: string; isDirectory(): boolean; isFile(): boolean }> {
  try {
    return readdirSync(dir, { withFileTypes: true }) as unknown as Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>
  } catch {
    return []
  }
}

/**
 * Find SKILL.md roots (root and nested skill-collection repos), skipping dot
 * directories (repo-internal agent tooling), node_modules and vendored dirs.
 */
export function findSkillRoots(root: string, maxDepth = 5, limit = 200): string[] {
  const roots: string[] = []
  const walk = (dir: string, depth: number): void => {
    if (roots.length >= limit) return
    const entries = readDirEntries(dir)
    if (entries.some(entry => entry.isFile() && entry.name.toLowerCase() === SKILL_MANIFEST_FILE.toLowerCase())) {
      roots.push(dir)
      return
    }
    if (depth >= maxDepth) return
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue
      if (VENDORED_DIR_NAMES.has(entry.name.toLowerCase())) continue
      walk(join(dir, entry.name), depth + 1)
      if (roots.length >= limit) return
    }
  }
  walk(root, 0)
  return roots
}

/** Find directories holding the official preset composition file (nested presets included). */
export function findPresetRoots(root: string, maxDepth = 3, limit = 50): string[] {
  const roots: string[] = []
  const walk = (dir: string, depth: number): void => {
    if (roots.length >= limit) return
    const entries = readDirEntries(dir)
    if (entries.some(entry => entry.isFile() && entry.name === PRESET_COMPOSITION_FILE)) {
      roots.push(dir)
      return
    }
    if (depth >= maxDepth) return
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue
      walk(join(dir, entry.name), depth + 1)
      if (roots.length >= limit) return
    }
  }
  walk(root, 0)
  return roots
}

/** Find DSH-plugin package roots (skin/multi-package repos), filtered by eligibility. */
export function findPluginRoots(root: string, maxDepth = 3, limit = 50): string[] {
  const roots: string[] = []
  const walk = (dir: string, depth: number): void => {
    if (roots.length >= limit) return
    const entries = readDirEntries(dir)
    if (entries.some(entry => entry.isFile() && entry.name === 'package.json')) {
      try {
        const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as unknown
        if (looksLikeDshPlugin(manifest) === true) {
          roots.push(dir)
          return
        }
      } catch { /* broken JSON: keep looking */ }
    }
    if (depth >= maxDepth) return
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue
      walk(join(dir, entry.name), depth + 1)
      if (roots.length >= limit) return
    }
  }
  walk(root, 0)
  return roots
}

/**
 * Layered type detection:
 *   1. preset (root or nested agent.cordis.yml) — official single-file rule;
 *   2. root package.json declaring DSH capability → cordis-plugin;
 *   3. root SKILL.md → skill (covers tool-chain package.json on pure skill
 *      repos — looksLikeDshPlugin is false there);
 *   4. a package.json that is NOT a DSH plugin (aggregate pages, desktop
 *      apps, plain npm projects) → instructions (blocked from the
 *      marketplace instead of being force-installed as a cordis plugin);
 *   5. nested preset / nested plugin / nested skill roots;
 *   6. install scripts are NOT auto-executed — such repos fall through to
 *      instructions (third-party code requires a confirmation loop we do not
 *      ship; the user is told to run the script manually if they trust it).
 */
export function detectRepoType(root: string): RepoKind {
  const has = (name: string): boolean => existsSync(join(root, name))
  // Root-level shapes first.
  if (findPresetRoots(root, 0, 1).length > 0) return 'agent-preset'
  if (has('package.json')) {
    let looksLike = false
    try {
      const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as unknown
      looksLike = looksLikeDshPlugin(manifest) === true
    } catch { /* unreadable manifest: keep checking */ }
    if (looksLike) return 'cordis-plugin'
    // A tool-chain package.json on a pure skill repo stays a skill.
    if (findSkillRoots(root, 0, 1).length > 0) return 'skill'
    // Non-plugin package.json (aggregate pages, desktop apps): fall through
    // to the nested checks before giving up — the repo may carry presets or
    // skills in subdirectories (e.g. dsh-anchored-standard's preset/).
  } else if (findSkillRoots(root, 0, 1).length > 0) {
    return 'skill'
  }
  // Nested shapes (skin/multi-package repos, preset collections, skill sets).
  if (findPresetRoots(root).length > 0) return 'agent-preset'
  if (findPluginRoots(root).length > 0) return 'cordis-plugin'
  if (findSkillRoots(root, 5, 1).length > 0) return 'skill'
  return 'instructions'
}

/** Read the SKILL.md display name from its YAML frontmatter; null when absent. */
function skillDisplayName(root: string): string | null {
  const manifest = readDirEntries(root).find(entry => entry.isFile() && entry.name.toLowerCase() === SKILL_MANIFEST_FILE.toLowerCase())
  if (manifest === undefined) return null
  try {
    const text = readFileSync(join(root, manifest.name), 'utf8')
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
    const match = fm !== null ? /^name:\s*"?([a-z0-9][a-z0-9-]*)"?\s*$/m.exec(fm[1]!) : null
    return match !== null && match[1] !== undefined ? match[1] : null
  } catch {
    return null
  }
}

/** Copy filter: exclude .git and node_modules (skills/presets are plain files). */
function copyFilter(src: string): boolean {
  if (src.split(sep).includes('.git')) return false
  if (src.split(sep).includes('node_modules')) return false
  return true
}

/**
 * Install a skill repository into <dshHome>/skills. One root or many (skill
 * collections); names come from SKILL.md frontmatter, falling back to the
 * repo name (single root) or the directory name (multiple roots).
 */
export function installSkill(root: string, repoName: string, occupied?: Set<string>): { name: string; names: string[]; location: string } {
  const skillRoots = findSkillRoots(root)
  if (skillRoots.length === 0) throw new Error('no SKILL.md found in the repository')
  const destRoot = skillsDirPath()
  mkdirSync(destRoot, { recursive: true })
  const installed: string[] = []
  const repoSlug = slugDirName(repoName.split('/').pop() ?? repoName)
  for (const skillRoot of skillRoots) {
    const fallback = skillRoots.length === 1 ? repoSlug : slugDirName(skillRoot.split(sep).pop() ?? '')
    const name = safeDirName(skillDisplayName(skillRoot) ?? fallback)
    // A name owned by ANOTHER live install record would be silently
    // overwritten — refuse with guidance instead (audit m1).
    if (occupied !== undefined && occupied.has(name)) {
      throw new Error('skill name "' + name + '" is already installed from another repository — '
        + 'rename the SKILL.md frontmatter name, or uninstall the other skill first')
    }
    const dest = join(destRoot, name)
    rmSync(dest, { recursive: true, force: true })
    cpSync(skillRoot, dest, { recursive: true, filter: copyFilter })
    installed.push(name)
  }
  return {
    name: installed.length === 1 ? installed[0]! : installed.length + '-skills',
    names: installed,
    location: installed.length === 1 ? join(destRoot, installed[0]!) : destRoot,
  }
}

/**
 * Install agent presets into <dshHome>/.agent-presets. Nested preset
 * directories are each copied under their directory name (the conventional
 * `preset` name falls back to the repo name as the id); a root preset copies
 * under the repo name.
 */
export function installPreset(root: string, repoName: string, occupied?: Set<string>): { name: string; names: string[]; location: string } {
  const presetRoots = findPresetRoots(root)
  if (presetRoots.length === 0) throw new Error('no agent.cordis.yml found in the repository')
  const repoSlug = slugDirName(repoName.split('/').pop() ?? repoName)
  const destRoot = presetsDirPath()
  mkdirSync(destRoot, { recursive: true })
  const installed: string[] = []
  for (const presetRoot of presetRoots) {
    const base = presetRoot === root ? '' : presetRoot.split(sep).pop() ?? ''
    const id = safeDirName(base === '' || base === 'preset' ? repoSlug : slugDirName(base))
    if (occupied !== undefined && occupied.has(id)) {
      throw new Error('preset id "' + id + '" is already installed from another repository — '
        + 'rename the preset directory, or uninstall the other preset first')
    }
    const dest = join(destRoot, id)
    rmSync(dest, { recursive: true, force: true })
    cpSync(presetRoot, dest, { recursive: true, filter: copyFilter })
    // Ownership marker: who installed this preset and the digest it shipped
    // with, so uninstalling the owner can clean it up without touching user
    // edits (see src/presets.ts).
    writeOwnerMarker(dest, [repoName])
    installed.push(id)
  }
  return {
    name: installed.length === 1 ? installed[0]! : installed.length + '-presets',
    names: installed,
    location: installed.length === 1 ? join(destRoot, installed[0]!) : destRoot,
  }
}

// ── Install record store (installed-kinds.json) ──

/** One marketplace-install record: what a repo installed, and where. */
export interface KindRecord {
  readonly type: RepoKind
  /** Display name (single install) — package name for cordis, skill/preset id otherwise. */
  readonly name: string | null
  /** All installed names (multi-root skill collections / multi-preset repos). */
  readonly names: string[] | null
  /** Install location(s): directory for skills/presets, profile node_modules for cordis. */
  readonly location: string | null
  /** Installed version, when the kind carries one. */
  readonly version: string | null
  /** ISO timestamp. */
  readonly installedAt: string
  /** Target profile (cordis-plugin installs; skill/preset are global). */
  readonly profile?: string
}

export function kindRecordsFile(): string {
  return join(dshHomePath(), 'plugin-manager-cache', 'installed-kinds.json')
}

let kindRecordsCache: Map<string, KindRecord> | null = null
let kindQueue: Promise<unknown> = Promise.resolve()

function enqueueKind<T>(task: () => Promise<T>): Promise<T> {
  const run = kindQueue.then(task, task)
  kindQueue = run.catch(() => { /* previous failure must not break the chain */ })
  return run
}

/** Load the record map (cached in-process; keys are normalized lowercase repo refs). */
export async function loadKindRecords(): Promise<Map<string, KindRecord>> {
  if (kindRecordsCache !== null) return kindRecordsCache
  try {
    const data = JSON.parse(readFileSync(kindRecordsFile(), 'utf8')) as { records?: Record<string, KindRecord> }
    kindRecordsCache = new Map(Object.entries(data.records ?? {}))
  } catch {
    kindRecordsCache = new Map()
  }
  return kindRecordsCache
}

function writeKindRecords(records: Map<string, KindRecord>): void {
  mkdirSync(join(kindRecordsFile(), '..'), { recursive: true })
  const data: Record<string, KindRecord> = {}
  for (const [key, record] of records) data[key] = record
  // Atomic write (tmp + rename): a concurrent dshpm CLI write or a crash
  // mid-write must not leave a truncated JSON that reads as an empty map
  // (audit m2).
  const target = kindRecordsFile()
  const tmp = target + '.tmp'
  writeFileSync(tmp, JSON.stringify({ version: 1, records: data }, undefined, 2) + '\n')
  renameSync(tmp, target)
  try { rmSync(tmp, { force: true }) } catch { /* best-effort */ }
}

/** Persist one record (serialized read-modify-write). */
export async function saveKindRecord(repoKey: string, record: KindRecord): Promise<void> {
  const key = normalizeRepoRef(repoKey) ?? repoKey
  await enqueueKind(async () => {
    const records = await loadKindRecords()
    records.set(key, record)
    writeKindRecords(records)
  })
}

/** Remove one record (serialized read-modify-write). */
export async function removeKindRecord(repoKey: string): Promise<void> {
  const key = normalizeRepoRef(repoKey) ?? repoKey
  await enqueueKind(async () => {
    const records = await loadKindRecords()
    records.delete(key)
    writeKindRecords(records)
  })
}

/** Whether a record's install target still exists on disk. */
function kindRecordAlive(record: KindRecord): boolean {
  if (record.type === 'skill' || record.type === 'agent-preset') {
    const root = record.type === 'skill' ? skillsDirPath() : presetsDirPath()
    const names = record.names !== null && record.names.length > 0
      ? record.names
      : record.name !== null ? [record.name] : []
    return names.some(name => existsSync(join(root, name)))
      || (record.location !== null && record.location !== root && existsSync(record.location))
  }
  if (record.type === 'cordis-plugin') {
    return record.location !== null && existsSync(record.location)
  }
  return true
}

/**
 * Drop ghost records: installs whose directories were removed OUTSIDE the
 * manager (manual `rm`, another tool, a cleaned-up temp dir). The in-process
 * record cache cannot notice external deletions, so every read surface
 * (listKinds, marketplace installed flags) prunes first — otherwise deleted
 * skills/presets keep showing as installed forever.
 */
export async function pruneGhostRecords(): Promise<void> {
  await enqueueKind(async () => {
    const records = await loadKindRecords()
    let changed = false
    for (const [key, record] of records) {
      if (!kindRecordAlive(record)) {
        records.delete(key)
        changed = true
      }
    }
    if (changed) writeKindRecords(records)
  })
}

// ── Blocked repos (detected non-installable → filtered from the marketplace) ──

export function blockedReposFile(): string {
  return join(dshHomePath(), 'plugin-manager-cache', 'blocked-repos.json')
}

let blockedCache: Set<string> | null = null

/** Load the blocked set (cached in-process; normalized lowercase repo refs). */
export async function loadBlockedRepos(): Promise<Set<string>> {
  if (blockedCache !== null) return blockedCache
  try {
    const data = JSON.parse(readFileSync(blockedReposFile(), 'utf8')) as { repos?: string[] }
    blockedCache = new Set((data.repos ?? []).map((repo: string) => normalizeRepoRef(repo) ?? repo))
  } catch {
    blockedCache = new Set()
  }
  return blockedCache
}

function writeBlockedRepos(repos: Set<string>): void {
  mkdirSync(join(blockedReposFile(), '..'), { recursive: true })
  const target = blockedReposFile()
  const tmp = target + '.tmp'
  writeFileSync(tmp, JSON.stringify({ version: 1, repos: [...repos].sort() }, undefined, 2) + '\n')
  renameSync(tmp, target)
  try { rmSync(tmp, { force: true }) } catch { /* best-effort */ }
}

/** Block a repository (detected as not plugin/skill/preset). */
export async function addBlockedRepo(repoKey: string): Promise<void> {
  const key = normalizeRepoRef(repoKey) ?? repoKey
  await enqueueKind(async () => {
    const repos = await loadBlockedRepos()
    repos.add(key)
    writeBlockedRepos(repos)
  })
}

/** Unblock a repository (restores it in the marketplace). */
export async function removeBlockedRepo(repoKey: string): Promise<void> {
  const key = normalizeRepoRef(repoKey) ?? repoKey
  await enqueueKind(async () => {
    const repos = await loadBlockedRepos()
    repos.delete(key)
    writeBlockedRepos(repos)
  })
}

/** Ensure the managed dir exists (called by install paths before copying). */
export function ensureCacheDir(): void {
  mkdirSync(join(dshHomePath(), 'plugin-manager-cache'), { recursive: true })
}

/**
 * Path-containment guard for deletions: target must stay under a managed
 * root. Windows file systems are case-insensitive while JS startsWith is
 * case-sensitive — a case-mismatched path would wrongly block a legal
 * deletion (audit W2).
 */
export function isUnderRoot(target: string, root: string): boolean {
  const t = resolve(target)
  const r = resolve(root)
  if (process.platform === 'win32') return t.toLowerCase().startsWith(r.toLowerCase() + sep)
  return t.startsWith(r + sep)
}

/**
 * Remove a tree with brief retries. Windows AV scanners / editors hold
 * transient handles and rmSync fails EPERM/EBUSY on the first attempt
 * (audit W1); `force` only tolerates a missing path, not an open handle.
 */
export function rmRetry(target: string): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      rmSync(target, { recursive: true, force: true })
      return
    } catch (error: unknown) {
      if (attempt >= 3) throw error
      // Synchronous short backoff (no timers available in sync call sites).
      const end = Date.now() + 120
      while (Date.now() < end) { /* spin */ }
    }
  }
}

/** Rename with brief retries (Windows: destination busy / AV scanning). */
export function renameRetry(from: string, to: string): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(from, to)
      return
    } catch (error: unknown) {
      if (attempt >= 3) throw error
      const end = Date.now() + 120
      while (Date.now() < end) { /* spin */ }
    }
  }
}
