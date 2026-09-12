/**
 * Protected install/remove/update flow: source preparation (git clone cache,
 * npm-first probe), official-CLI mutations through the global mutation
 * mutex, the quality gate with automatic rollback, update checks (npm
 * dist-tag / git HEAD / lockfile commit) and the managed-row cleanup that
 * follows a removal.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { commandEnv, execFileTimeout, resolveCommand, runDshPlugin } from './childproc.ts'
import {
  dshHome, enqueueMutation, hostProfileName, isSafeProfileName, patchPath, profileDir,
  readBundles, readManifest, readPatch, slugify,
} from './paths.ts'
import { restoreInBoxBundles } from './profiles.ts'
import { applyLiveOps, type StackOp } from './live.ts'
import { addDisableBlock, addInsertRow, readInsertRows, readManagedIds, removeDisableBlock, removeInsertRow, writePatch } from './patch.ts'
import { analyzeProfile, isLoaderProvided, OFFICIAL_DEP_ALLOWED, packageEntries, scanImports, scanNodeModulesNames, scanPackageImports } from './analyze.ts'
import { compareVersions, isGitSourceSpec, updateSpec } from './match.ts'
import {
  addBlockedRepo, detectRepoType, installPreset, installSkill, loadKindRecords, looksLikeDshPlugin,
  normalizeRepoRef, presetsDirPath, rmRetry, saveKindRecord, skillsDirPath,
} from './kinds.ts'
import { cleanupOwnedPresets, formatCleanupResult, pluginInstalledInOtherProfiles } from './presets.ts'
import { GITHUB_UA, marketplaceFetch } from './net.ts'
import { buildFilteredEnv, scanRequirements } from './scan.ts'
import { createInstallSession, dropInstallSession, filterAnswers, getInstallSession } from './installSession.ts'
import { invalidateInstalledIndex } from './marketplaceMerge.ts'
import type { CommandResult, UpdateInfo } from './types.ts'

/** Whether a directory is a git repository (cheap probe). */
export async function isGitRepo(path: string): Promise<boolean> {
  // Async (never execFileSync): a git probe on the request path must not
  // freeze the whole web server for up to its timeout.
  const result = await execFileTimeout('git', ['-C', path, 'rev-parse', '--git-dir'], 5_000)
  return result.ok
}

/** Resolve a `link:`/`file:` dependency value to its target path, or null. */
export function parseLocalSource(source: string): string | null {
  const match = /^(?:link|file):(.+)$/.exec(source.trim())
  return match !== null ? match[1]!.trim() : null
}

/** Extract a cloneable URL from a git source spec (drops #ref fragments). */
export function gitUrlFromSpec(source: string): string {
  const spec = source.trim().split('#')[0]!
  if (spec.startsWith('github:')) return 'https://github.com/' + spec.slice(7).replace(/^\.git/, '')
  if (spec.startsWith('git+')) return spec.slice(4)
  return spec
}

/** Whether a spec looks like a git clone URL (used by update/checkUpdates). */
export function isGitCloneSpec(source: string): boolean {
  const spec = source.trim()
  return spec.startsWith('file:')
    || spec.startsWith('git@')
    || spec.startsWith('github:')
    || spec.startsWith('git+')
    || /^https?:\/\//.test(spec)
}

/** The installed git commit of a package manifest (gitHead), when recorded. */
export async function installedGitHead(dir: string, name: string): Promise<string | undefined> {
  // pnpm never writes gitHead (that is an npm convention): for plugins
  // installed from the git cache the installed package is a link INTO the
  // cache clone, so the clone's HEAD IS the installed commit. Read it
  // directly; fall back to package.json gitHead for npm-style git installs.
  try {
    const resolved = realpathSync(join(dir, 'node_modules', name))
    const cacheRoot = join(dshHome(), 'plugin-manager-src') + sep
    if (resolved.startsWith(cacheRoot)) {
      const head = await execFileTimeout('git', ['-C', resolved, 'rev-parse', 'HEAD'], 10_000)
      if (head.ok) {
        const first = head.output.trim().split(/\r?\n/)[0]
        if (first !== undefined && first.length > 0) return first
      }
    }
  } catch { /* not a cache link: fall through to package.json gitHead */ }
  try {
    const manifest = JSON.parse(
      readFileSync(join(dir, 'node_modules', name, 'package.json'), 'utf8'),
    ) as { gitHead?: unknown }
    return typeof manifest.gitHead === 'string' && manifest.gitHead.length > 0 ? manifest.gitHead : undefined
  } catch {
    return undefined
  }
}

/** Latest dist-tag version of an npm package, or undefined when unreachable. */
export function npmLatestVersion(name: string): Promise<string | undefined> {
  return npmRegistryLatest(name)
}

/** Remote HEAD commit of a git URL, or undefined when unreachable. */
export async function gitRemoteHead(url: string): Promise<string | undefined> {
  const result = await execFileTimeout('git', ['ls-remote', url, 'HEAD'], 20_000)
  if (!result.ok) return undefined
  const first = result.output.trim().split(/\r?\n/)[0]
  return first !== undefined ? first.split(/\s+/)[0] : undefined
}

/**
 * Fetch a git cache directory (never merging) and compare the local HEAD
 * with the remote ref (the branch upstream, falling back to FETCH_HEAD).
 */
export async function gitRemoteState(dir: string): Promise<{
  ok: boolean
  hasUpdate: boolean
  latest?: string
  message: string
}> {
  const head = await execFileTimeout('git', ['-C', dir, 'rev-parse', 'HEAD'], 10_000)
  if (!head.ok) return { ok: false, hasUpdate: false, message: 'not a git repository' }
  const headHash = head.output.trim()
  if (headHash.length === 0) return { ok: false, hasUpdate: false, message: 'no HEAD commit' }
  // A CHECK must not mutate a user's own git workspace (audit M12: the old
  // code ran `git fetch --prune` on any local repo — it deleted remote
  // tracking refs and wrote into the working tree). Only the manager's own
  // clone cache (<dshHome>/plugin-manager-src) is fetched; everything else
  // is compared read-only via ls-remote.
  const cacheRoot = join(dshHome(), 'plugin-manager-src')
  const isManagedCache = resolve(dir).startsWith(resolve(cacheRoot) + sep)
  if (isManagedCache) {
    const fetched = await execFileTimeout('git', ['-C', dir, 'fetch', '--quiet', '--prune'], 20_000)
    if (!fetched.ok) {
      return { ok: false, hasUpdate: false, message: 'git fetch failed: ' + fetched.output.trim().slice(0, 200) }
    }
    const upstream = await execFileTimeout('git', ['-C', dir, 'rev-parse', '@{u}'], 10_000)
    let remoteHash = upstream.ok ? upstream.output.trim() : ''
    if (remoteHash.length === 0) {
      const fetchHead = await execFileTimeout('git', ['-C', dir, 'rev-parse', 'FETCH_HEAD'], 10_000)
      if (fetchHead.ok) remoteHash = fetchHead.output.trim()
    }
    if (remoteHash.length === 0) return { ok: false, hasUpdate: false, message: 'no remote ref to compare' }
    const hasUpdate = remoteHash !== headHash
    return {
      ok: true,
      hasUpdate,
      latest: remoteHash.slice(0, 12),
      message: hasUpdate
        ? 'remote moved (' + headHash.slice(0, 12) + ' → ' + remoteHash.slice(0, 12) + ')'
        : 'up to date (' + headHash.slice(0, 12) + ')',
    }
  }
  const branch = await execFileTimeout('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], 10_000)
  const branchName = branch.ok ? branch.output.trim() : ''
  if (branchName.length === 0 || branchName === 'HEAD') {
    return { ok: false, hasUpdate: false, message: 'detached HEAD — cannot compare' }
  }
  const remote = await execFileTimeout('git', ['-C', dir, 'ls-remote', '--heads', 'origin'], 20_000)
  if (!remote.ok) {
    // Offline / unreachable: this is NOT "no update" — say so explicitly so
    // the caller can distinguish a failed check from a fresh one (audit M12).
    return { ok: false, hasUpdate: false, message: 'cannot reach the remote (' + remote.output.trim().slice(0, 120) + ')' }
  }
  let remoteHash = ''
  for (const line of remote.output.split(/\r?\n/)) {
    const match = /^([0-9a-f]{40,})\trefs\/heads\/(.+)$/.exec(line.trim())
    if (match !== null && match[2] === branchName) { remoteHash = match[1]!; break }
  }
  if (remoteHash.length === 0) return { ok: false, hasUpdate: false, message: 'no remote ref to compare' }
  const hasUpdate = remoteHash !== headHash
  return {
    ok: true,
    hasUpdate,
    latest: remoteHash.slice(0, 12),
    message: hasUpdate
      ? 'remote moved (' + headHash.slice(0, 12) + ' → ' + remoteHash.slice(0, 12) + ')'
      : 'up to date (' + headHash.slice(0, 12) + ')',
  }
}

/** Fetch and hard-reset a git cache directory to its remote branch. */
export async function gitPullToRemote(dir: string): Promise<{ ok: boolean; message: string }> {
  const branch = await execFileTimeout('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], 10_000)
  const branchName = branch.ok ? branch.output.trim() : ''
  if (branchName.length === 0 || branchName === 'HEAD') {
    return { ok: false, message: 'detached HEAD — cannot fast-forward the cache' }
  }
  const fetched = await execFileTimeout('git', ['-C', dir, 'fetch', '--quiet', '--prune'], 20_000)
  if (!fetched.ok) return { ok: false, message: fetched.output.trim().slice(0, 300) }
  const reset = await execFileTimeout('git', ['-C', dir, 'reset', '--hard', 'origin/' + branchName], 20_000)
  if (!reset.ok) return { ok: false, message: reset.output.trim().slice(0, 300) }
  const head = await execFileTimeout('git', ['-C', dir, 'rev-parse', 'HEAD'], 10_000)
  return { ok: true, message: 'cache reset to ' + (head.ok ? head.output.trim().slice(0, 12) : 'remote') }
}

/** Update-check for one installed package (see PluginManagerService.checkUpdates). */
export async function checkPackageUpdate(dir: string, name: string, source: string): Promise<UpdateInfo> {
  const installed = readPackageInfo(dir, name).version
  const local = parseLocalSource(source)
  if (local !== null) {
    // link:/file: targets resolve relative to the profile directory (pnpm
    // semantics — the manifest location), NOT the host cwd: handing a
    // relative path to `git -C` would silently resolve it against wherever
    // the service was launched (the same relative-path trap the official
    // workspace package fixed in 0.1.3: qualify paths before realpath/git).
    const localPath = resolve(dir, local)
    if (!(await isGitRepo(localPath))) {
      return {
        name,
        hasUpdate: false,
        ...(installed !== undefined ? { currentVersion: installed } : {}),
        source: 'local',
        message: 'installed from a local directory — no upstream to compare',
      }
    }
    const git = await gitRemoteState(localPath)
    return {
      name,
      hasUpdate: git.ok && git.hasUpdate,
      ...(installed !== undefined ? { currentVersion: installed } : {}),
      ...(git.latest !== undefined ? { latestVersion: git.latest } : {}),
      source: 'git',
      message: git.message,
    }
  }
  if (isGitSourceSpec(source)) {
    const remote = await gitRemoteHead(gitUrlFromSpec(source))
    const gitHead = await installedGitHead(dir, name)
    if (remote === undefined || gitHead === undefined) {
      return {
        name,
        hasUpdate: false,
        ...(installed !== undefined ? { currentVersion: installed } : {}),
        source: 'git',
        message: remote === undefined
          ? 'remote unreachable — cannot check'
          : 'no recorded install commit — cannot compare (reinstall to refresh)',
      }
    }
    const hasUpdate = remote !== gitHead
    return {
      name,
      hasUpdate,
      ...(installed !== undefined ? { currentVersion: installed } : {}),
      latestVersion: remote.slice(0, 12),
      source: 'git',
      message: hasUpdate
        ? 'remote moved (' + gitHead.slice(0, 12) + ' → ' + remote.slice(0, 12) + ')'
        : 'up to date (' + gitHead.slice(0, 12) + ')',
    }
  }
  // npm source: compare against the registry dist-tag latest.
  const latest = await npmLatestVersion(name)
  if (latest === undefined) {
    return {
      name,
      hasUpdate: false,
      ...(installed !== undefined ? { currentVersion: installed } : {}),
      source: 'npm',
      message: 'registry lookup failed (offline?)',
    }
  }
  // Compare semver-wise: a string compare flags 1.2 vs 1.2.0 as an update
  // (audit) — compareVersions pads missing segments.
  const hasUpdate = installed !== undefined && compareVersions(installed, latest) < 0
  return {
    name,
    hasUpdate,
    ...(installed !== undefined ? { currentVersion: installed } : {}),
    latestVersion: latest,
    source: 'npm',
    message: installed !== undefined
      ? 'installed ' + installed + ', latest ' + latest
      : 'latest ' + latest,
  }
}

/**
 * Normalize a cloneable git URL into the pnpm git-protocol form
 * (github:owner/repo for GitHub, the URL itself otherwise), keeping a #ref
 * fragment. Git-source plugins install INTO the profile tree through this
 * spec so their dependencies resolve; a link install would put the code in
 * the clone cache outside the profile, where bare imports cannot reach the
 * profile/fallback node_modules (ERR_MODULE_NOT_FOUND crash).
 */
export function toGitSpec(repo: string, ref?: string): string {
  const github = /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)\.git$/.exec(repo)
    ?? /^https?:\/\/github\.com\/([^/]+)\/([^/]+)$/.exec(repo)
  let spec = github !== null ? 'github:' + github[1] + '/' + github[2] : repo
  if (ref !== undefined && ref.length > 0) spec += '#' + ref
  return spec
}

/**
 * The pnpm git-protocol spec for a clone-cache directory, from its origin
 * remote (github:owner/repo for GitHub remotes, the URL otherwise). Used by
 * the update path so a cache refresh reinstalls the plugin through the git
 * protocol instead of re-linking it (a link cannot resolve the plugin's
 * dependencies — see prepareInstallSource).
 */
export async function gitSpecFromCache(local: string): Promise<string | undefined> {
  const remote = await execFileTimeout('git', ['-C', local, 'remote', 'get-url', 'origin'], 10_000)
  if (!remote.ok || remote.output.trim().length === 0) return undefined
  let url = remote.output.trim()
  if (url.startsWith('git@github.com:')) url = 'https://github.com/' + url.slice('git@github.com:'.length)
  return toGitSpec(url)
}

/**
 * The commit a git-protocol dependency currently resolves to, from the
 * profile lockfile (pnpm records it as the tar.gz URL suffix). Used to roll
 * a failed git-source update back to the previous commit.
 */
export function gitCommitFromLock(profile: string, packageName: string): string | undefined {
  try {
    const lock = readFileSync(join(profileDir(profile), 'pnpm-lock.yaml'), 'utf8')
    for (const line of lock.split('\n')) {
      // Scoped names appear YAML-quoted:  ' @scope/pkg@https://...tar.gz/<commit>':
      // the closing quote sits between the commit and the colon.
      const m = /^ {2}['"]?(.+?)['"]?@(https?:[^\s]+?tar\.gz\/([0-9a-f]{40,}))['"]?:/.exec(line)
      if (m === null) continue
      const key = m[1]!.replace(/^node_modules\//, '')
      if (key === packageName || key.endsWith('/' + packageName)) return m[3]!
    }
  } catch { /* no lockfile: no commit to roll back to */ }
  return undefined
}

/**
 * Prepare an install source. Git URLs (npm-unpublished repositories,
 * workspace subpackages) are cloned into $DSH_HOME/plugin-manager-src and
 * installed from there — the "official path" for repositories that never
 * reached the registry — with npm-first when the cloned package is published.
 * Custom subdir syntax: `repo#路径:packages/x` (the # in normal git specs is
 * a ref/branch). The cache is kept: local-directory installs are pnpm links
 * that need their source to stay in place.
 */
export async function prepareInstallSource(spec: string): Promise<{ spec?: string; note?: string; error?: string; packageName?: string; created?: boolean; gitSpec?: string }> {
  const trimmed = spec.trim()
  const gitUrl = /^(?:git\+)?(https?:\/\/[^\s#]+?)(?:#([^\s]*))?$/.exec(trimmed)
  const gitFile = /^file:(\/\/[^\s#]+?)(?:#([^\s]*))?$/.exec(trimmed)
  const gitSsh = /^([^\s@]+@[^\s:]+:[^\s#]+?)(?:#([^\s]*))?$/.exec(trimmed)
  const githubShort = /^github:([^\s#]+?)(?:#([^\s]*))?$/.exec(trimmed)
  const m = gitUrl ?? gitFile ?? gitSsh ?? githubShort
  if (m === null) return { spec: trimmed }
  let repo = m[1]!
  if (githubShort !== null && githubShort[1] !== undefined) repo = "https://github.com/" + githubShort[1]!.replace(/^\.git/, '')
  const frag = m[2] ?? ''
  // Our subdir convention: `#路径:<relative-dir>` (a plain #ref stays a git ref).
  let ref: string | undefined
  let subdir: string | undefined
  if (frag.startsWith('路径:')) subdir = frag.slice(3)
  else if (frag.length > 0) ref = frag
  // pnpm git-protocol spec for the cloned source (installed INTO the profile
  // tree so the plugin's dependencies resolve). A link install puts the code
  // in the clone cache outside the profile, where bare imports cannot reach
  // the profile/fallback node_modules — the crash reported for git-source
  // plugins with regular dependencies (ERR_MODULE_NOT_FOUND). Subdir and
  // workspace-subpackage clones have no reliable git-protocol form yet and
  // keep the link install. file: git sources are local-only and also link.
  let gitSpec: string | undefined
  if (subdir === undefined && gitFile === null) {
    gitSpec = toGitSpec(repo, ref)
  }
  try {
    const cacheRoot = join(dshHome(), 'plugin-manager-src')
    mkdirSync(cacheRoot, { recursive: true })
    // Drop a trailing .git so the clone dir name matches gitCacheIdentity
    // (audit: git+https://…repo.git used to cache as …-repo-git).
    const base = repo.replace(/^https?:\/\//, '').replace(/^git@/, '').replace(/^\/+/, '')
      .replace(/\.git$/, '').replace(/[^A-Za-z0-9._-]/g, '-')
    const dirName = base + (ref !== undefined ? '-' + ref.replace(/[^A-Za-z0-9._-]/g, '-') : '')
    const dest = join(cacheRoot, dirName)
    const created = !existsSync(dest)
    if (created) {
      const args = ['clone']
      if (ref !== undefined) args.push('-b', ref)
      args.push('--depth', '1', repo, dest)
      // Async clone (never execFileSync): a slow network clone must not
      // freeze the whole web server event loop for up to three minutes.
      const clone = await execFileTimeout('git', args, 3 * 60 * 1000)
      if (!clone.ok) return { error: 'git clone failed: ' + (clone.output.trim() || 'git exited non-zero') }
    }
    const pkgDir = subdir !== undefined ? join(dest, subdir) : dest
    // The #路径: subdirectory must stay inside the clone cache — `../../`
    // would turn the whole local filesystem into an install source (audit M20).
    if (subdir !== undefined && !resolve(pkgDir).startsWith(resolve(dest) + sep)) {
      return { error: 'subdirectory escapes the clone cache: ' + JSON.stringify(subdir) }
    }
    if (existsSync(join(pkgDir, 'package.json'))) {
      try {
        const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as { name?: unknown }
        if (typeof manifest.name === 'string' && manifest.name.length > 0) {
          return {
            spec: pkgDir,
            packageName: manifest.name,
            created,
            gitSpec,
            note: 'cloned ' + repo + (subdir !== undefined ? ' (' + subdir + ')' : '') + ' into ' + dest,
          }
        }
      } catch { /* unreadable manifest: continue below */ }
    }
    if (!existsSync(join(pkgDir, 'package.json'))) {
      // Auto-detect workspace packages when the root is not a package.
      const candidates = discoverWorkspacePackages(dest)
      if (candidates.length === 1) {
        return { spec: candidates[0]!, note: 'cloned ' + repo + ' into ' + dest + ' (package: ' + candidates[0] + ')' }
      }
      if (candidates.length > 1) {
        return {
          error: 'the repository contains multiple packages (' + candidates.map(c => c.split('/').pop()).join(', ') + '); install with #路径:<dir> to pick one',
        }
      }
      // No package.json anywhere: not a cordis plugin — could be a skill or
      // agent-preset repo (neither ships a manifest). Keep the clone and let
      // installWithSource's type detection decide.
      return {
        spec: pkgDir,
        created,
        note: 'cloned ' + repo + ' into ' + dest + ' (no package.json — kind detection will decide)',
      }
    }
    return {
      spec: pkgDir,
      created,
      note: 'cloned ' + repo + (subdir !== undefined ? ' (' + subdir + ')' : '') + ' into ' + dest + ' — keep this cache directory: the installed package links to it',
    }
  } catch (error: unknown) {
    return { error: 'git clone failed: ' + (error instanceof Error ? error.message : String(error)) }
  }
}

/** The npm registry's /latest document (the full latest manifest). */
export interface NpmLatestManifest {
  readonly version?: string
  readonly dsh?: unknown
  readonly dependencies?: Record<string, unknown>
  readonly peerDependencies?: Record<string, unknown>
}

/**
 * The npm registry base URL, resolved once per process. The value is a
 * process constant — re-running `npm config get registry` for every version
 * check multiplied checkUpdates latency by the dependency count (and each
 * spawn blocked the event loop for up to 5s). The npm_config_registry env
 * var (npm's own override channel) is consulted first, zero-cost.
 */
export let npmRegistryBase: string | undefined
export async function resolveNpmRegistry(): Promise<string> {
  if (npmRegistryBase !== undefined) return npmRegistryBase
  const fromEnv = process.env.npm_config_registry
  if (typeof fromEnv === 'string' && /^https?:\/\//.test(fromEnv.trim())) {
    npmRegistryBase = fromEnv.trim().endsWith('/') ? fromEnv.trim() : fromEnv.trim() + '/'
    return npmRegistryBase
  }
  let registry = 'https://registry.npmjs.org/'
  const probe = await execFileTimeout('npm', ['config', 'get', 'registry'], 5_000)
  const trimmed = probe.ok ? probe.output.trim() : ''
  if (trimmed.length > 0 && /^https?:\/\//.test(trimmed)) {
    registry = trimmed.endsWith('/') ? trimmed : trimmed + '/'
  }
  npmRegistryBase = registry
  return registry
}

/**
 * Latest dist-tag manifest of an npm package. Uses the registry's /latest
 * endpoint (a tiny document) instead of `npm view` (which pulls the full
 * packument and routinely exceeds short timeouts on slow networks), through
 * the proxy-aware marketplaceFetch (15s cap) with one retry. Registry
 * resolved from the npm config so mirrors and private registries work.
 */
export async function npmRegistryManifest(packageName: string): Promise<NpmLatestManifest | undefined> {
  const registry = await resolveNpmRegistry()
  // Scoped packages keep their slash: encodeURIComponent would turn the `/`
  // into %2F, which some private registries/proxies 404 (audit M4) — encode
  // each segment instead.
  const encodedName = packageName.startsWith('@')
    ? packageName.split('/').map(part => encodeURIComponent(part)).join('/')
    : encodeURIComponent(packageName)
  const url = registry + encodedName + '/latest'
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await marketplaceFetch(url, {
        headers: { ...GITHUB_UA },
        redirect: 'follow',
      })
      if (response.ok) {
        const doc = await response.json() as NpmLatestManifest
        return typeof doc.version === 'string' ? doc : undefined
      }
      return undefined // 404 / 4xx: not published (no retry for definitive answers)
    } catch {
      // network / timeout: retry once, then report undetected
    }
  }
  return undefined
}

/** Latest dist-tag version of an npm package (version-only wrapper). */
export async function npmRegistryLatest(packageName: string): Promise<string | undefined> {
  return (await npmRegistryManifest(packageName))?.version
}

/**
 * npm-first probe: returns the package name ONLY when the npm package is a
 * real DSH plugin (declares the dsh field or depends on the DSH core).
 * Skill / agent-preset / non-plugin repos that happen to publish npm packages
 * (e.g. a skill repo whose name collides with an npm package) must fall
 * through to the clone + type-detection path — installing them as cordis
 * plugins would mount a useless dependency instead of the skill.
 */
export async function probeNpmPublished(packageName: string): Promise<string | undefined> {
  const manifest = await npmRegistryManifest(packageName)
  if (manifest === undefined) return undefined
  return looksLikeDshPlugin(manifest) === true ? packageName : undefined
}

/** Bare-package root of a specifier (subpath imports resolve through it). */
export function declaredRoot(spec: string): string | undefined {
  if (spec.startsWith('@')) {
    const parts = spec.split('/')
    return parts.length >= 2 ? parts[0] + '/' + parts[1] : undefined
  }
  const first = spec.split('/')[0]
  return first !== undefined && first.length > 0 ? first : undefined
}

/** Find cordis-style packages inside a cloned repository (depth 3). */
export function discoverWorkspacePackages(root: string): string[] {
  const found: string[] = []
  const walk = (dir: string, depth: number): void => {
    if (depth > 3) return
    let entries: { name: string; isDirectory(): boolean }[] = []
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as unknown as { name: string; isDirectory(): boolean }[]
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (existsSync(join(full, 'package.json'))) {
          try {
            const manifest = JSON.parse(readFileSync(join(full, 'package.json'), 'utf8')) as Record<string, unknown>
            const dsh = manifest['dsh'] as Record<string, unknown> | undefined
            const isPlugin = dsh?.bundle !== undefined
            if (isPlugin) found.push(full)
          } catch { /* unreadable manifest: skip */ }
        } else {
          walk(full, depth + 1)
        }
      }
    }
  }
  walk(root, 0)
  return found
}
/**
 * Install with source preparation: git sources (not published on npm,
 * workspace subpackages) are cloned into a cache directory and installed
 * from there — the "official path" for repositories that never reached the
 * registry — with npm-first when the cloned package is published. ctx null
 * = out-of-process caller (the dshpm CLI). Serialized by the mutation mutex.
 */
export function installWithSource(ctx: Context | null, profile: string, spec: string, answers?: Record<string, string>, locale?: 'zh' | 'en'): Promise<CommandResult> {
  return enqueueMutation(() => installWithSourceInner(ctx, profile, spec, answers, locale))
}

export async function installWithSourceInner(ctx: Context | null, profile: string, spec: string, answers?: Record<string, string>, locale?: 'zh' | 'en'): Promise<CommandResult> {
  // Profile-less call (Skills & Presets page re-pull): skills and agent
  // presets install into the global harness roots and never touch profile
  // state. The npm-first shortcut is skipped because it installs INTO a
  // profile — the clone is always needed so the kind can be detected, and a
  // cordis plugin is refused below with guidance instead of crashing on an
  // empty profile name.
  const profileLess = profile.length === 0
  // npm-first BEFORE cloning for plain GitHub URLs (the marketplace shape:
  // repo name == npm name). A pinned ref / subdir requests a specific git
  // state, so those still clone. On slow networks the registry /latest
  // probe is tiny and fast, so the npm path wins instead of a doomed clone.
  const plainGit = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^\/#\s]+)\/([^\/#\s]+?)(?:\.git)?$/.exec(spec.trim())
  if (!profileLess && plainGit !== null) {
    const npmName = await probeNpmPublished(plainGit[2]!)
    if (npmName !== undefined) {
      const result = await installProtected(ctx, profile, npmName)
      return {
        ...result,
        output: result.output + '\n[plugin-manager] installed from npm (' + npmName + ' — the GitHub repository publishes it)',
      }
    }
  }
  const prepared = await prepareInstallSource(spec)
  if (prepared.error !== undefined || prepared.spec === undefined) {
    return { ok: false, exitCode: 1, output: '[plugin-manager] ' + (prepared.error ?? 'no install source') }
  }
  // Kind detection for cloned/local sources: skill and agent-preset repos
  // install directly (file copies into the official harness roots + an
  // install record); instructions (not plugin/skill/preset) are refused with
  // guidance and added to the marketplace blocklist; cordis plugins continue
  // through the existing npm-first + quality-gate path below.
  const repoKey = normalizeRepoRef(spec) ?? spec
  // C2: env injection for git-source installs — host credentials are NOT
  // passed to third-party lifecycle scripts (prepare/build); the user's
  // scanned answers (whitelist-validated below) are merged on top.
  let envAnswers: Record<string, string> | undefined
  if (existsSync(prepared.spec)) {
    const kind = detectRepoType(prepared.spec)
    if (kind === 'skill' || kind === 'agent-preset') {
      try {
        // Names owned by OTHER live records must not be silently
        // overwritten by this install (audit m1).
        const records = await loadKindRecords()
        const occupied = new Set<string>()
        for (const [otherKey, record] of records) {
          if (otherKey === repoKey) continue
          for (const name of record.names ?? []) occupied.add(name)
        }
        const installed = kind === 'skill'
          ? installSkill(prepared.spec, repoKey, occupied)
          : installPreset(prepared.spec, repoKey, occupied)
        await saveKindRecord(repoKey, {
          type: kind,
          name: installed.name,
          names: installed.names,
          location: installed.location,
          version: null,
          installedAt: new Date().toISOString(),
        })
        return {
          ok: true,
          exitCode: 0,
          output: '[plugin-manager] installed ' + (kind === 'skill' ? 'skill' : 'agent preset')
            + ' "' + installed.name + '" to ' + installed.location
            + (prepared.note !== undefined ? '\n' + prepared.note : '')
            + '\n' + (kind === 'skill'
              ? 'Skills hot-reload (chokidar watch on <dshHome>/skills) — no restart needed.'
              : 'Presets are discovered per session — pick it in the agent-preset picker.'),
        }
      } catch (error: unknown) {
        return {
          ok: false,
          exitCode: 1,
          output: '[plugin-manager] ' + (kind === 'skill' ? 'skill' : 'agent preset') + ' install failed: '
            + (error instanceof Error ? error.message : String(error)),
        }
      }
    }
    if (kind === 'instructions') {
      // Not a plugin, skill, or preset: refuse, block from the marketplace,
      // and point the user at what the repository actually is.
      await addBlockedRepo(repoKey).catch(() => { /* blocklist is advisory */ })
      const readmeHint = readmeFirstLines(prepared.spec)
      return {
        ok: false,
        exitCode: 1,
        output: '[plugin-manager] ' + repoKey
          + ' is not a DSH plugin, skill, or agent preset (no dsh-capable package.json, SKILL.md, or agent.cordis.yml).'
          + ' It has been added to the marketplace blocklist.'
          + (readmeHint.length > 0 ? '\n\nRepository README (first lines):\n' + readmeHint : '')
          + '\n\nIf the repository ships install.sh/install.ps1, we never auto-execute third-party scripts — run it manually if you trust the repo:'
          + '\n  cd ' + prepared.spec + ' && bash install.sh',
      }
    }
    // cordis-plugin: continue to the npm-first + quality-gate path below,
    // after the C2 env-requirement scan (git-source installs only).
    if (profileLess) {
      // Reached only when a profile-less caller (Skills & Presets re-pull)
      // points at a cordis plugin: the global roots cannot host one, and
      // installProtected would throw on the empty profile name. Refuse with
      // the actionable route instead.
      return {
        ok: false,
        exitCode: 1,
        output: '[plugin-manager] ' + repoKey + ' is a cordis plugin — plugins install into a profile.'
          + ' Install it from the marketplace or the Manage tab, or run: dshpm install <spec> --profile <name>',
      }
    }
    const scanned = await scanRequirements(prepared.spec)
    if (scanned.length > 0) {
      const session = getInstallSession(spec)
      const supplied = answers !== undefined && Object.keys(answers).length > 0
      if (supplied) {
        // Materials provided: whitelist-validate against the scan, then
        // continue with them injected into the pnpm subprocess env. The
        // whitelist comes from the session when present (Web flow), else
        // from this scan (out-of-process dshpm CLI: sessions are in-process
        // memory, and an explicit --env is the user's own consent).
        envAnswers = filterAnswers(session !== undefined ? session.scanned : scanned, answers)
        if (session !== undefined) dropInstallSession(spec)
      } else {
        // No session or no materials yet: (re)create the session, keep the
        // clone, and pause the install asking for the missing variables.
        createInstallSession(spec, prepared.spec, scanned)
        return {
          ok: false,
          exitCode: null,
          output: '[plugin-manager] install paused: this repository requests the following environment variable(s) at install time: '
            + scanned.join(', ')
            + '. Re-submit the install with answers (an empty value skips the variable).',
          awaiting: {
            spec,
            questions: scanned.map(v => ({
              id: v,
              header: 'Environment variable: ' + v,
              question: 'The repository requests ' + v + ' during install/build. Leave empty to skip.',
            })),
          },
        }
      }
    }
  }
  // npm-first: when the cloned package is published on the registry, prefer
  // the npm install (faster, no local link); fall back to the git clone.
  // The git fallback runs with a filtered env (see gitSourceEnv); the npm
  // path keeps the host env so private-registry tokens (.npmrc auth) work.
  if (profileLess) {
    // Defensive: a spec that never reached the kind detection above (a bare
    // package name rather than a cloned repository) cannot be classified, and
    // the npm path would install into a profile that does not exist.
    return {
      ok: false,
      exitCode: 1,
      output: '[plugin-manager] cannot install ' + JSON.stringify(spec) + ' without a profile —'
        + ' the Skills & Presets page installs skills and agent presets from GitHub repositories.',
    }
  }
  const npmName = prepared.packageName !== undefined ? await probeNpmPublished(prepared.packageName) : undefined
  // Git-protocol install when the source has an equivalent (root package of
  // a git URL): the code lands inside the profile tree and pnpm installs the
  // plugin's dependencies, so its imports resolve. Subdir/workspace/file:
  // sources have no git-protocol form and keep the link install (their bare
  // imports may fail to resolve — see prepareInstallSource).
  const gitSpec = prepared.gitSpec
  // The npm path deliberately keeps the UNFILTERED host env so private
  // registry credentials (.npmrc auth) resolve — so the user's scanned
  // answers are merged on top rather than swapping in the filtered env.
  // Dropping them here (the old behavior) lost the very variables the C2
  // scan had just prompted for, and the npm lifecycle script then ran
  // without them.
  const npmEnv = envAnswers !== undefined && Object.keys(envAnswers).length > 0
    ? { ...process.env, ...envAnswers }
    : undefined
  const result = npmName !== undefined
    ? await installProtected(ctx, profile, npmName, npmEnv)
    : await installProtected(ctx, profile, gitSpec ?? prepared.spec, gitSourceEnv(envAnswers))
  const note = npmName !== undefined
    ? 'installed from npm (' + npmName + '; the repository also publishes it)'
    : gitSpec !== undefined
      ? prepared.note + ' (installed via git protocol; the clone cache is kept for updates and quality checks)'
      : prepared.note
  const output = note !== undefined
    ? result.output + '\n[plugin-manager] ' + note
    : result.output
  if (!result.ok) {
    // Append a readable failure classification when the raw output matches a
    // known npm/pnpm failure signature (browser language on the Web UI,
    // process locale on the CLI).
    const hintOutput = withFailureHint(output, locale)
    // A failed install leaves a clone behind only if it is unreferenced:
    // git sources often lack committed build artifacts (dist/lib), which
    // the quality gate catches as an unresolvable entry file — clean the
    // freshly created cache dir and say so.
    if (prepared.created && !cacheDirReferencedByProfile(dshHome(), prepared.spec)) {
      try {
        rmSync(prepared.spec, { recursive: true, force: true })
        return {
          ...result,
          output: hintOutput + '\n[plugin-manager] the repository may not commit build artifacts (dist/lib), or the package is not published to npm — check that the main/exports entry file exists in the repo, or install the npm package by name. Removed the unused clone cache.',
        }
      } catch { /* cleanup is best-effort */ }
    }
    return {
      ...result,
      output: hintOutput + '\n[plugin-manager] the repository may not commit build artifacts (dist/lib), or the package is not published to npm — check that the main/exports entry file exists in the repo, or install the npm package by name.',
    }
  }
  if (result.ok) {
    // cordis-plugin install succeeded: keep a kind record so the
    // marketplace uninstall / listKinds surfaces it (audit m3 — previously
    // cordis installs never recorded anything and uninstall-kind was dead
    // for them). The record also carries the target profile.
    const installedNames = result.installed ?? []
    if (installedNames.length > 0) {
      try {
        await saveKindRecord(repoKey, {
          type: 'cordis-plugin',
          name: installedNames[0] ?? null,
          names: installedNames.length > 0 ? [...installedNames] : null,
          location: join(profileDir(profile), 'node_modules'),
          version: null,
          installedAt: new Date().toISOString(),
          profile: profile,
        })
      } catch { /* the install record is advisory */ }
    }
  }
  return { ...result, output }
}

/**
 * C2: env for a git-source install — the host's full environment is NOT
 * passed to the third-party package's lifecycle scripts (prepare/postinstall
 * inherit the pnpm subprocess env, so a full pass-through would hand every
 * host token/key to unaudited code). Sensitive keys are stripped; the user's
 * scanned answers (already whitelist-validated against the repo scan) are
 * merged on top.
 */
export function gitSourceEnv(answers: Record<string, string> | undefined): NodeJS.ProcessEnv {
  const env = buildFilteredEnv()
  if (answers !== undefined) {
    for (const [key, value] of Object.entries(answers)) env[key] = value
  }
  return env
}

/** First lines of a repository README (install-guidance for refused repos). */
export function readmeFirstLines(dir: string): string {
  for (const file of ['README.md', 'readme.md', 'README.zh.md', 'README.en.md']) {
    try {
      const text = readFileSync(join(dir, file), 'utf8')
      const trimmed = text.trim()
      if (trimmed.length === 0) continue
      return trimmed.split(/\r?\n/).slice(0, 12).join('\n').slice(0, 600)
    } catch { /* try the next README variant */ }
  }
  return ''
}

/**
 * Post-install entry verification: warn when the installed package's load
 * entries (main / exports "." and "./client", conditional exports recursed)
 * are missing from the installed directory — the package is present but will
 * not load. Source-only repos that never committed build artifacts land here.
 */
/**
 * Install-time peer warning note: pnpm warns about "missing peer" for the
 * official @deepseek-ai/* packages because the profile does not declare them
 * — the host provides them one level up (profiles/node_modules) and every
 * plugin shares that single instance. The warning is harmless noise; the
 * note explains it at the exact moment the user sees it.
 */
export const PEER_WARNING_NOTE = '\n[plugin-manager] note: pnpm "missing peer @deepseek-ai/*" warnings are harmless — '
  + 'the DSH host provides these packages in the shared profiles/node_modules; do NOT install them into the profile '
  + '(a second copy would split module identity and break the plugin).'

export function entryWarning(profile: string, packageName: string): string {
  const pkgDir = join(profileDir(profile), 'node_modules', packageName)
  try {
    const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as {
      main?: unknown
      exports?: unknown
      dsh?: { client?: unknown; bundle?: unknown }
    }
    const targets: string[] = []
    if (typeof manifest.main === 'string' && manifest.main.length > 0) targets.push(manifest.main)
    const collect = (node: unknown): void => {
      if (typeof node === 'string') {
        if (node.length > 0) targets.push(node)
        return
      }
      if (node === null || typeof node !== 'object') return
      for (const value of Object.values(node)) collect(value)
    }
    if (manifest.exports !== null && typeof manifest.exports === 'object') {
      const exportsObj = manifest.exports as Record<string, unknown>
      for (const sub of ['.', './client']) {
        if (Object.prototype.hasOwnProperty.call(exportsObj, sub)) collect(exportsObj[sub])
      }
    }
    // A pure client-manifest plugin needs no host entry (browser-only).
    if (targets.length === 0 && manifest.dsh?.client !== undefined) return ''
    const missing = targets.filter(target => !existsSync(join(pkgDir, target)))
    return missing.length > 0
      ? '\n[plugin-manager] ⚠ ' + packageName + ' installed but its load entries are missing: ' + missing.join(', ')
        + ' — the plugin may not take effect; check the repository build instructions (source-only repos need a build step).'
      : ''
  } catch {
    return ''
  }
}

/** Locale of the host process (CLI and terminal output); default English. */
export function hostLocale(): 'zh' | 'en' {
  const lang = (process.env.LANG ?? process.env.LC_ALL ?? process.env.LC_MESSAGES ?? '').trim()
  return /^zh/i.test(lang) ? 'zh' : 'en'
}

/**
 * Locale from an Accept-Language request header (browser sends it on
 * same-origin fetch): zh* wins, anything else falls back to the host locale.
 */
export function acceptLanguageLocale(header: string | undefined): 'zh' | 'en' {
  if (header === undefined || header.length === 0) return hostLocale()
  for (const part of header.split(',')) {
    const lang = part.trim().split(';')[0]?.toLowerCase() ?? ''
    if (lang === 'zh' || lang.startsWith('zh-')) return 'zh'
  }
  return 'en'
}

/**
 * Classify common npm/pnpm failure signatures into a readable
 * troubleshooting hint (bilingual — the Web UI picks the browser language,
 * the CLI picks the process locale).
 */
export function classifyInstallFailure(text: string): { zh: string; en: string } | null {
  const rules: Array<[RegExp, string, string]> = [
    [/ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up|premature close|network request failed/i,
      '网络错误：无法连接 npm registry / GitHub，请检查网络或代理后重试。',
      'Network error: cannot reach the npm registry / GitHub — check your network or proxy and retry.'],
    [/EINTEGRITY|integrity checksum failed/i,
      '依赖完整性校验失败（常见于网络缓存损坏）：删除依赖目录后重试，或清 npm 缓存（npm cache clean --force）。',
      'Dependency integrity check failed (often a corrupted network cache): delete the dependency directory and retry, or clear the npm cache (npm cache clean --force).'],
    [/ETARGET|No matching version|404 Not Found|E404|ENOVERSIONS/i,
      '依赖版本不存在：某个依赖或其版本在 registry 找不到（私有包、版本号错误或未发布）。',
      'Dependency version not found: a dependency or its version is missing from the registry (private package, wrong version, or not published).'],
    [/gyp ERR|node-gyp|python(3)?(\s|\.exe)? not found|not found: python/i,
      '原生模块编译失败：node-gyp 需要 Python 与 C++ 构建工具链，请先安装（Windows: Visual Studio Build Tools）。',
      'Native module build failed: node-gyp needs Python and a C++ toolchain (Windows: Visual Studio Build Tools).'],
    [/MODULE_NOT_FOUND|Cannot find module/i,
      '缺少模块：包或依赖不完整——可能是源码型仓库未构建，或本地链接依赖被剥离后仍被引用。',
      'Missing module: the package or its dependencies are incomplete — the repo may be source-only without a build step, or a local link dependency was pruned while still referenced.'],
    [/ERR_PNPM|Command failed/i,
      '构建/包管理命令失败：请查看上方日志输出定位具体步骤。',
      'Build/package-manager command failed: check the log output above to locate the failing step.'],
    [/EACCES|EPERM|EBUSY/i,
      '权限/占用错误：目标目录被占用或没有写入权限（Windows 常见：杀毒软件锁文件）。',
      'Permission/lock error: the target directory is in use or not writable (on Windows antivirus software often locks files).'],
  ]
  for (const [re, zh, en] of rules) {
    if (re.test(text)) return { zh, en }
  }
  return null
}

/** Append the failure classification (if any) to a command output. */
export function withFailureHint(output: string, locale: 'zh' | 'en' = hostLocale()): string {
  const hint = classifyInstallFailure(output)
  return hint !== null ? output + '\n[plugin-manager] ' + hint[locale] : output
}

/** Whether any profile manifest references the given install path (link:). */
export function cacheDirReferencedByProfile(home: string, pkgDir: string): boolean {
  const profilesRoot = join(home, 'profiles')
  let entries: string[] = []
  try {
    entries = readdirSync(profilesRoot, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name)
  } catch {
    return false
  }
  for (const name of entries) {
    try {
      const manifest = JSON.parse(readFileSync(join(profilesRoot, name, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> }
      for (const value of Object.values(manifest.dependencies ?? {})) {
        if (value.includes(pkgDir)) return true
      }
    } catch { /* unreadable profile: skip */ }
  }
  return false
}

/**
 * Shared install path: pnpm add through the official CLI, resolve the real
 * package name, mount non-bundle plugins as managed insert rows, restore
 * in-box bundles, and run a quality check (undeclared runtime imports and
 * official packages declared as regular dependencies are the main reasons
 * third-party plugins break a profile — auto-rollback on failure).
 *
 * ctx is the live host context when a profile instance is running (live
 * apply of insert rows) and null for out-of-process callers (the dshpm
 * CLI): the file-level install, quality gate, and rollback are identical,
 * only the live-mount step is skipped.
 */
export async function installProtected(ctx: Context | null, profile: string, spec: string, env?: NodeJS.ProcessEnv): Promise<CommandResult> {
  const before = readBundles(profile)
  const result = await runDshPlugin(profile, 'add', [spec], process.cwd(), env)
  if (!result.ok) return result
  restoreInBoxBundles(profile, before)
  const installed = resolveInstalledName(profile, spec)
  if (installed === null) return { ...result, installed: [] }

  // Quality gate: scan the installed package entry for imports its manifest
  // does not declare and the loader does not provide. Undeclared deps fail
  // at boot (ERR_MODULE_NOT_FOUND) and take the whole profile down.
  const issues = qualityIssues(profile, installed)
  if (issues.length > 0) {
    // Roll back: remove the dependency and any insert row written below.
    await runDshPlugin(profile, 'remove', [installed], process.cwd())
    restoreInBoxBundles(profile, before)
    await cleanupInsertRows(ctx, profile, installed)
    return {
      ok: false,
      exitCode: 1,
      output: result.output
        + "\n[plugin-manager] QUALITY CHECK FAILED for " + installed + ":"
        + issues.map(issue => "\n  - " + issue).join("")
        + "\n[plugin-manager] rolled back the install to keep the profile bootable.",
      installed: [],
    }
  }

  // Every return below leaves the package installed (bundle layer, live
  // mount, or a failed mount that keeps the dependency): drop the cached
  // installed index so the next marketplace request sees the new package
  // immediately. The quality-gate path above rolled back to the previous
  // state and returns before reaching this line.
  invalidateInstalledIndex(profile)

  const isBundle = exportsBundlePatch(profile, installed)
  // Post-install entry verification: warn when the load entries are missing
  // (source-only repos), so "installed but not working" is caught up front.
  const entryNote = entryWarning(profile, installed)
  // Post-install analysis summary: dependency/conflict/compatibility issues
  // between the new package and the profile (warnings — the install itself
  // already passed the quality gate).
  let analysisNote = ''
  try {
    const dir = profileDir(profile)
    const bundles = readBundles(profile)
    const analysis = analyzeProfile(dir, bundles, readPatch(dir), new Set(), [])
    const related = analysis.issues.filter(issue =>
      issue.from === installed || issue.to === installed || issue.cycle?.includes(installed))
    if (related.length > 0) {
      analysisNote = '\n[plugin-manager] analysis: ' + related.length + ' issue(s) for ' + installed + ':'
        + related.map(issue => '\n  - ' + issue.message).join('')
    }
  } catch { /* analysis is advisory */ }
  if (isBundle) {
    return {
      ...result,
      installed: [installed],
      // Bundle layers load at the next start; the client must not claim a
      // live mount for them.
      live: false,
      output: result.output + analysisNote + entryNote + PEER_WARNING_NOTE
        + '\n[plugin-manager] bundle plugin added to the layer stack — restart the profile to load it (the catalog will show it then).',
    }
  }

  // Non-bundle plugin: write the managed insert row (live mount).
  const rowId = slugify(installed)
  try {
    const dir = profileDir(profile)
    const current = readPatch(dir)
    // A managed disable block we wrote earlier (a previous disable) is not a
    // user row: drop it first, or readManagedIds misjudges it as user-owned
    // and every re-install/mount of this package dies with id collision.
    const cleaned = removeDisableBlock(current, rowId)
    const base = cleaned !== current ? cleaned : current
    // An id collision with an existing row (user-written or another
    // plugin's) would make the loader refuse the whole tree — fail this
    // install instead of corrupting the patch.
    const idOwner = readInsertRows(base).find(row => row.id === rowId && row.name !== installed)
    const userOwnsId = readManagedIds(base).has(rowId)
    if (idOwner !== undefined || userOwnsId) {
      await runDshPlugin(profile, 'remove', [installed], process.cwd())
      restoreInBoxBundles(profile, before)
      return {
        ok: false,
        exitCode: 1,
        output: result.output
          + "\n[plugin-manager] row id " + rowId + " is already used"
          + (idOwner !== undefined ? " by " + idOwner.name : " by a user row")
          + " (id collision) — rolled back the install. Rename the conflicting package or remove the other row first.",
        installed: [],
      }
    }
    const next = addInsertRow(base, rowId, installed)
    const live = next !== base && ctx !== null && profile === hostProfileName()
      ? await applyLiveOps(ctx, [{ kind: 'append', value: { insert: [{ id: rowId, name: installed }] } }])
      : { ok: false, message: 'profile not running' }
    if (next !== base) writePatch(patchPath(dir), next)
    if (!live.ok && /ERR_MODULE_NOT_FOUND|Cannot find package|failed to import/i.test(live.message ?? '')) {
      // The mount failed because the module cannot be imported. Leaving the
      // insert row in the patch would fail the WHOLE profile at the next
      // boot — roll the row back instead (the dependency stays installed).
      const rolledBack = removeInsertRow(next, rowId)
      if (rolledBack.removed) writePatch(patchPath(dir), rolledBack.content)
      return {
        ...result,
        installed: [installed],
        live: false,
        output: result.output
          + "\n[plugin-manager] mount failed (" + (live.message ?? 'import error') + ")"
          + "\n[plugin-manager] insert row " + rowId + " rolled back — the profile stays bootable. Check the plugin's dependencies.",
      }
    }
    return {
      ...result,
      installed: [installed],
      live: live.ok,
      output: result.output
        + "\n[plugin-manager] quality check passed; mounted " + installed + " as insert row " + rowId + (live.ok ? " (applied live)" : " (file updated; " + (live.message ?? 'mounts on next restart') + ")")
        + entryNote + PEER_WARNING_NOTE,
    }
  } catch (error: unknown) {
    return {
      ...result,
      installed: [installed],
      live: false,
      output: result.output + "\n[plugin-manager] install ok but insert row failed: " + (error instanceof Error ? error.message : String(error)),
    }
  }
}

/**
 * Shared remove path: pnpm remove through the official CLI, preserving
 * in-box bundles and cleaning up the managed insert rows of the removed
 * package. ctx null = out-of-process caller (the dshpm CLI); the file
 * removal is identical, only the live unmount is skipped. Serialized by the
 * mutation mutex.
 */
export function removeProtected(ctx: Context | null, profile: string, name: string): Promise<CommandResult> {
  return enqueueMutation(() => removeProtectedInner(ctx, profile, name))
}

export async function removeProtectedInner(ctx: Context | null, profile: string, name: string): Promise<CommandResult> {
  const before = readBundles(profile)
  // Row ids the removal orphans (managed disable blocks must not survive
  // the package): the mount id, the patch's insert-row ids, and the ids the
  // package's own bundle patch declares. Collected BEFORE pnpm deletes the
  // package files.
  const orphanedIds = managedRowIdsOf(profile, name)
  let result = await runDshPlugin(profile, 'remove', [name], process.cwd())
  if (result.ok) {
    // The package is gone: drop the cached installed index so the next
    // marketplace request stops flagging it as installed immediately.
    invalidateInstalledIndex(profile)
    restoreInBoxBundles(profile, before)
    await cleanupInsertRows(ctx, profile, name)
    removeDisableBlocks(profile, orphanedIds)
    // Live-unmount every loader row mounting the removed package in the
    // running profile. pnpm remove only rewrites the manifest and deletes
    // the package files; without an unmount the fiber stays mounted and the
    // client boot table keeps serving its client entry — the browser then
    // fails to load the deleted client.js on the next refresh and the whole
    // UI dies until a restart (client-modules: bundle script ... failed to
    // load). Disposing the fiber now lets the platform drop the entry.
    // A failed / timed-out unmount is NOT silent (issue #10): the loader
    // tree may be half-disposed (the web server is gone but the process
    // lingers), so the removal reports live: false with an explicit
    // restart directive instead of pretending the change was applied live.
    if (ctx !== null && profile === hostProfileName()) {
      const unmount = await liveUnmountPackage(ctx, name)
      result = unmount.ok
        ? { ...result, live: true }
        : {
            ...result,
            live: false,
            output: result.output
              + '\n[plugin-manager] live unmount did not complete ('
              + (unmount.message ?? 'the live loader did not confirm the unmount')
              + '). The removed entry may still be served until the next start —'
              + ' restart the profile to fully apply the removal and to clear any'
              + ' unstable loader state before further live changes or an automatic restart.',
          }
    }
    // Plugin-owned agent presets: after the package is gone, delete its
    // unmodified owned presets (see src/presets.ts). Presets are global, so
    // skip when another profile still installs the plugin.
    result = { ...result, output: result.output + '\n' + await presetCleanupNote(ctx, profile, name) }
  }
  return result
}

/**
 * Cleanup note appended to a removal result: deletes the removed plugin's
 * unmodified owned agent presets through the host service when available
 * (direct removal otherwise), reporting what was removed and what was kept
 * and why. Never throws.
 */
export async function presetCleanupNote(ctx: Context | null, profile: string, name: string): Promise<string> {
  try {
    if (pluginInstalledInOtherProfiles(profile, name)) {
      return '[plugin-manager] preset cleanup skipped for ' + name + ': still installed in another profile'
    }
    const result = await cleanupOwnedPresets(ctx, presetsDirPath(), name)
    return formatCleanupResult(name, result)
  } catch (error) {
    return '[plugin-manager] preset cleanup failed for ' + name + ': ' + (error instanceof Error ? error.message : String(error))
  }
}

/**
 * Collect the loader row ids a package owns in a profile: the managed mount
 * id (slugify), every managed insert row id mounting it, and the row ids its
 * own bundle patch inserts. Used to drop managed disable blocks whose row
 * disappears with the package — a stale block would warn on every boot and
 * silently disable a future plugin that reuses the same row id.
 */
export function managedRowIdsOf(profile: string, packageName: string): string[] {
  const ids = new Set<string>([slugify(packageName)])
  try {
    const dir = profileDir(profile)
    for (const row of readInsertRows(readPatch(dir))) {
      if (row.name === packageName) ids.add(row.id)
    }
  } catch { /* patch rows are optional */ }
  try {
    const dir = profileDir(profile)
    const manifest = JSON.parse(
      readFileSync(join(dir, 'node_modules', packageName, 'package.json'), 'utf8'),
    ) as { dsh?: { bundle?: { patch?: unknown } } }
    const rel = manifest.dsh?.bundle?.patch
    if (typeof rel === 'string' && rel.length > 0) {
      const patch = readFileSync(join(dir, 'node_modules', packageName, rel), 'utf8')
      // Insert children and patched rows both declare their id the same way.
      for (const match of patch.matchAll(/^\s*-\s+id:\s*['"]?([A-Za-z0-9._-]+)['"]?\s*$/gm)) {
        if (match[1] !== undefined) ids.add(match[1])
      }
    }
  } catch { /* a bundle patch is optional; the mount id already covers non-bundle rows */ }
  return [...ids]
}

/**
 * Drop managed disable blocks for the given row ids from a profile's patch
 * file (best-effort; rows that never had a block are untouched).
 */
export function removeDisableBlocks(profile: string, rowIds: readonly string[]): void {
  try {
    const dir = profileDir(profile)
    const path = patchPath(dir)
    const original = readPatch(dir)
    let next = original
    for (const id of rowIds) {
      const cleaned = removeDisableBlock(next, id)
      if (cleaned !== next) next = cleaned
    }
    if (next !== original) writePatch(path, next)
  } catch { /* block cleanup is best-effort */ }
}

/**
 * Unmount every loader row mounting a package from the running profile's
 * live include stack. Used after a package removal so its fiber disposes
 * immediately instead of lingering until the next restart.
 *
 * Returns the live apply outcome instead of swallowing it (issue #10): a
 * failed or timed-out update can leave the loader tree half-disposed, and
 * the caller must surface the "restart to fully apply" state rather than
 * treat the removal as fully live. The wedged-restart chains themselves
 * (a flush that never settles, a shutdown fallback that never arms) live in
 * the host; this side at least makes the unstable state visible.
 */
export async function liveUnmountPackage(ctx: Context, packageName: string): Promise<{ ok: boolean; message?: string }> {
  try {
    return await applyLiveOps(ctx, [{ kind: 'remove-by-name', name: packageName }])
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('[plugin-manager] live unmount failed:', message)
    return { ok: false, message }
  }
}

/**
 * Shared update path for one installed package (source-kind contract as on
 * the service method): npm @latest reinstall / git-cache fetch+reset /
 * git-URL re-resolve, each with the quality gate and rollback. ctx-free —
 * usable from the dshpm CLI without a live host. Serialized by the
 * mutation mutex.
 */
export function updateProtected(profile: string, name: string, locale?: 'zh' | 'en'): Promise<CommandResult> {
  return enqueueMutation(() => updateProtectedInner(profile, name, locale))
}

export async function updateProtectedInner(profile: string, name: string, locale?: 'zh' | 'en'): Promise<CommandResult> {
  const dir = profileDir(profile)
  if (!existsSync(dir)) return { ok: false, exitCode: 1, output: 'profile not found: ' + profile }
  const manifest = readManifest(dir) as { dependencies?: Record<string, string> }
  const source = manifest.dependencies?.[name]
  if (source === undefined) {
    return { ok: false, exitCode: 1, output: name + ' is not a dependency of ' + profile }
  }
  const before = readBundles(profile)
  const local = parseLocalSource(source)
  if (local !== null && (await isGitRepo(resolve(dir, local)))) {
    // Git-cache update: fetch + hard reset the cache to its remote ref.
    // The previous HEAD is remembered so a failed quality gate can restore
    // the cache (gitPullToRemote already discarded the old worktree — the
    // audit found the old rollback merely removed the package while the
    // cache stayed on the broken new code and the message claimed a
    // rollback that never happened).
    const cacheDir = resolve(dir, local)
    const oldHead = await execFileTimeout('git', ['-C', cacheDir, 'rev-parse', 'HEAD'], 10_000)
    const updated = await gitPullToRemote(cacheDir)
    if (!updated.ok) {
      return { ok: false, exitCode: 1, output: '[plugin-manager] git update failed: ' + updated.message }
    }
    // Reinstall through the git protocol (github:owner/repo) instead of
    // re-linking the cache: the plugin's code then lives inside the profile
    // tree and its dependencies resolve (a link install cannot reach the
    // profile/fallback node_modules). This also migrates legacy link
    // installs to the protocol form.
    const gitSpec = await gitSpecFromCache(cacheDir)
    const result = await runDshPlugin(profile, 'add', [gitSpec ?? cacheDir], process.cwd())
    if (!result.ok) return result
    restoreInBoxBundles(profile, before)
    const issues = qualityIssues(profile, name)
    if (issues.length > 0) {
      // Restore the cache to the previous commit, then re-install the old
      // code so the plugin stays usable (the old version passed the gate
      // when it was installed).
      let restoreNote = ''
      if (oldHead.ok && oldHead.output.trim().length > 0) {
        const restored = await execFileTimeout('git', ['-C', cacheDir, 'reset', '--hard', oldHead.output.trim()], 20_000)
        if (restored.ok) restoreNote = '\n[plugin-manager] cache restored to the previous commit '
          + oldHead.output.trim().slice(0, 12)
        else restoreNote = '\n[plugin-manager] WARNING: could not restore the cache (' + restored.output.trim().slice(0, 120) + ')'
      }
      await runDshPlugin(profile, 'remove', [name], process.cwd())
      // Reinstall the previous commit through the git protocol (the old
      // code passed the gate when it was installed).
      const oldCommit = gitSpec !== undefined && oldHead.ok && oldHead.output.trim().length > 0
        ? oldHead.output.trim()
        : undefined
      const reinstall = await runDshPlugin(
        profile, 'add',
        [oldCommit !== undefined ? gitSpec + '#' + oldCommit : (gitSpec ?? cacheDir)],
        process.cwd(),
      )
      restoreInBoxBundles(profile, before)
      return {
        ok: false,
        exitCode: 1,
        output: result.output + '\n[plugin-manager] QUALITY CHECK FAILED after update:'
          + issues.map(issue => '\n  - ' + issue).join('')
          + restoreNote
          + (reinstall.ok
            ? '\n[plugin-manager] the previous version was re-installed from the restored cache.'
            : '\n[plugin-manager] WARNING: re-installing the previous version failed: ' + reinstall.output.trim().slice(0, 200)),
      }
    }
    // Successful update: the installed version changed — drop the cached
    // installed index so the next marketplace request re-derives
    // installed/updateAvailable from the new commit.
    invalidateInstalledIndex(profile)
    return {
      ok: true,
      exitCode: 0,
      output: result.output + '\n[plugin-manager] ' + name + ' updated from the git cache ('
        + updated.message + '); restart the profile to load the new code.',
    }
  }
  if (local !== null) {
    return {
      ok: false,
      exitCode: 1,
      output: '[plugin-manager] ' + name + ' is installed from a local directory (' + local
        + ') with no git upstream; update is not possible. Remove and reinstall it.',
    }
  }
  // npm or git-URL source: re-add through the official CLI.
  // 显式钉住最新版本号：@latest 依赖 pnpm 对 dist-tag 的解析，在 pnpm 11
  // minimumReleaseAge 或镜像 dist-tag 滞后时会解析到旧版或停在现有范围；
  // 显式 <name>@<version> 重写 specifier，不受这些因素影响（见 updateSpec）。
  const spec = updateSpec(source, name, await npmLatestVersion(name))
  // Previous version captured for the rollback: a failed self-update must
  // restore the old code, never uninstall the package (the manager itself
  // would otherwise disappear from the profile).
  const previousVersion = readPackageInfo(dir, name).version
  const result = await runDshPlugin(profile, 'add', [spec], process.cwd())
  if (!result.ok) return { ...result, output: withFailureHint(result.output, locale) }
  restoreInBoxBundles(profile, before)
  const installed = resolveInstalledName(profile, name)
  if (installed === null) return { ...result, installed: [name] }
  const issues = qualityIssues(profile, installed)
  if (issues.length > 0) {
    let restored = false
    let rollbackLabel = ''
    if (isGitSourceSpec(source)) {
      // Git-protocol dependency: roll back to the previous commit (a version
      // tag re-add would resolve from the registry and may not exist).
      const oldCommit = gitCommitFromLock(profile, installed)
      if (oldCommit !== undefined) {
        const base = source.split('#')[0]!
        const reAdd = await runDshPlugin(profile, 'add', [base + '#' + oldCommit], process.cwd())
        restored = reAdd.ok
        if (restored) rollbackLabel = ' (' + oldCommit.slice(0, 12) + ')'
      }
    } else if (previousVersion !== undefined) {
      const reAdd = await runDshPlugin(profile, 'add', [name + '@' + previousVersion], process.cwd())
      restored = reAdd.ok
      if (restored) rollbackLabel = ' (' + previousVersion + ')'
    }
    if (!restored) await runDshPlugin(profile, 'remove', [installed], process.cwd())
    restoreInBoxBundles(profile, before)
    return {
      ok: false,
      exitCode: 1,
      output: result.output + '\n[plugin-manager] QUALITY CHECK FAILED after update:'
        + issues.map(issue => '\n  - ' + issue).join('')
        + '\n[plugin-manager] rolled back to the previous version'
        + (restored ? rollbackLabel : ' — reinstall the package manually'),
    }
  }
  // Successful update: the installed version changed — drop the cached
  // installed index so the next marketplace request re-derives
  // installed/updateAvailable from the new version.
  invalidateInstalledIndex(profile)
  return {
    ok: true,
    exitCode: 0,
    output: result.output + '\n[plugin-manager] ' + name + ' updated'
      + (isGitSourceSpec(source) ? ' from its git source' : ' to @latest')
      + '; restart the profile to load the new code.',
  }
}
// scanImports / scanPackageImports / packageEntry / LOADER_PROVIDED live in
// src/analyze.ts (shared with the health-check engine so the gate and the
// analysis never drift — entry resolution and the loader-provided whitelist
// in particular must be one implementation, imported above).

/**
 * Quality check for one installed package: undeclared bare imports that the
 * loader does not provide are boot failures waiting to happen. Returns a
 * list of issues (empty = healthy).
 */
export function qualityIssues(profile: string, packageName: string): string[] {
  const pkgDir = join(profileDir(profile), 'node_modules', packageName)
  let manifest: Record<string, unknown>
  try {
    manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
  } catch (error: unknown) {
    return ["cannot read its package.json: " + (error instanceof Error ? error.message : String(error))]
  }
  const declared = new Set([
    ...Object.keys((manifest['dependencies'] ?? {}) as Record<string, unknown>),
    ...Object.keys((manifest['peerDependencies'] ?? {}) as Record<string, unknown>),
  ])
  // EVERY declared entry, not just exports["."]: DSH plugins commonly ship
  // several (host + client + worker), and an undeclared import in a subpath
  // entry fails at boot exactly like one in the root — while the bundle patch
  // row that mounts that subpath makes the WHOLE profile fail to start
  // (audit C-1).
  const entries = packageEntries(pkgDir, manifest)
  if (entries.length === 0) return ["no resolvable entry file (exports/main/index.js)"]
  const issues: string[] = []
  // Official packages as REGULAR dependencies are the one install pattern
  // that passes every import check and still breaks the profile at runtime:
  // pnpm installs a second copy into the profile's node_modules, the Loader
  // resolves the official bundle row to that copy (nearest-wins from the
  // profile directory), and module identity splits between the copies
  // (unique symbols / classes) — tool calls then fail with errors like
  // "Cannot read properties of undefined (reading 'prepare')". The correct
  // contract is a peerDependency: autoInstallPeers:false leaves peers to the
  // shared installation fallback, so every plugin shares one instance.
  const officialClosure = officialFallbackNames(profile)
  for (const dep of Object.keys((manifest['dependencies'] ?? {}) as Record<string, unknown>)) {
    if (dep.startsWith('@deepseek-ai/') && officialClosure.has(dep) && !OFFICIAL_DEP_ALLOWED.has(dep)) {
      issues.push("declares official package " + dep + " as a REGULAR dependency: pnpm installs a second copy into "
        + "the profile and the loader resolves the official row to it, splitting module identity (runtime failures "
        + "like 'Cannot read properties of undefined (reading \'prepare\')'). Declare it as a peerDependency instead "
        + "(the profile falls through to the installation's shared copy), or drop the declaration.")
    }
  }
  // Scan the WHOLE load chain (every declared entry + every file reachable
  // through relative imports): an undeclared import one hop down fails at
  // boot exactly like one in the entry.
  const imports = [...new Set(entries.flatMap(entry => scanPackageImports(pkgDir, entry)))]
  for (const spec of imports) {
    // A subpath import (unpdf/pdfjs) is covered by declaring its parent
    // package (unpdf): Node resolves subpaths through the parent entry.
    const parent = declaredRoot(spec)
    if (declared.has(spec) || (parent !== undefined && declared.has(parent)) || isLoaderProvided(spec)) continue
    issues.push("imports " + spec + " but does not declare it (would fail at boot)")
  }
  // Declared is not installed: a dependency line that pnpm could not place
  // (e.g. a link: source that is not present) fails exactly like an
  // undeclared import at boot — and takes the whole profile down.
  for (const spec of imports) {
    if (!declared.has(spec) || isLoaderProvided(spec)) continue
    if (!bareSpecifierResolves(profileDir(profile), spec)) {
      issues.push("declares " + spec + " but it is not installed in the profile (would fail at boot)")
    }
  }
  // Bundle plugins also mount rows from their own cordis.patch.yml — every
  // row name must resolve, or the whole profile fails at boot.
  const dsh = manifest['dsh'] as Record<string, unknown> | undefined
  const bundle = dsh?.bundle as Record<string, unknown> | undefined
  const patchFile = typeof bundle?.patch === 'string' ? bundle.patch : undefined
  if (patchFile !== undefined) {
    const patchPath = join(pkgDir, patchFile)
    const rows = readBundleRows(patchPath)
    for (const rowName of rows) {
      if (rowName.startsWith('cordis:') || rowName.startsWith('.')) continue
      if (isLoaderProvided(rowName)) continue
      if (!bareSpecifierResolves(profileDir(profile), rowName) && rowName !== packageName) {
        issues.push("bundle patch mounts " + rowName + " but it is not installed in the profile (would fail at boot)")
      }
    }
  }
  return issues
}

/**
 * Package names the dsh installation provides: the shared fallback
 * profiles/node_modules closure (healProfilesModuleFallback's symlink
 * farm). A profile-local copy of any of these — installed through a regular
 * dependency — duplicates an installation-owned module; see the
 * quality-gate check above.
 */
export function officialFallbackNames(profile: string): Set<string> {
  return scanNodeModulesNames(join(dirname(profileDir(profile)), 'node_modules'))
}

/** Row module names in a bundle's own cordis.patch.yml (best-effort parse). */
export function readBundleRows(patchFile: string): string[] {
  try {
    const content = readFileSync(patchFile, 'utf8')
    const rows: string[] = []
    const pattern = /^\s*name:\s*(.+)$/gm
    for (const match of content.matchAll(pattern)) {
      const name = match[1]!.trim().replace(/^['"]|['"]$/g, '')
      if (name.length > 0) rows.push(name)
    }
    return rows
  } catch {
    return []
  }
}

/** Read one installed package's manifest, or null when unreadable. */
function readInstalledManifest(pkgDir: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

/** Probe one path as a module file: exact, then the usual extension suffixes. */
function probeModuleFile(target: string): boolean {
  for (const suffix of ['', '.js', '.mjs', '.cjs', '.json', '.node', '/index.js', '/index.mjs', '/index.cjs']) {
    try {
      if (existsSync(target + suffix)) return true
    } catch { /* keep probing */ }
  }
  return false
}

/**
 * Whether an `exports` field declares one subpath key (`"./server"`), with
 * `*` wildcard patterns honoured (`"./x/*"`). A string field or a
 * conditions-only object exports `"."` alone, so any other subpath is
 * unexported by Node's rules.
 */
function exportsDeclaresKey(exportsField: unknown, key: string): boolean {
  if (typeof exportsField === 'string' || exportsField === null || typeof exportsField !== 'object') {
    return key === '.'
  }
  const record = exportsField as Record<string, unknown>
  const keys = Object.keys(record)
  const isSubpathMap = keys.length > 0 && keys.every(entry => entry.startsWith('.'))
  if (!isSubpathMap) return key === '.'
  if (key in record) return true
  // Wildcard patterns: "./x/*" matches "./x/<anything>".
  for (const pattern of keys) {
    const star = pattern.indexOf('*')
    if (star < 0) continue
    const prefix = pattern.slice(0, star)
    const suffix = pattern.slice(star + 1)
    if (key.startsWith(prefix) && key.endsWith(suffix) && key.length >= prefix.length + suffix.length) return true
  }
  return false
}

/**
 * Whether one bare specifier resolves to a module inside `root`
 * (node_modules layout). Covers both a plain package name and a subpath
 * (`pkg/sub`, `@scope/pkg/sub`).
 *
 * C-2: the previous scoped branch returned true as soon as the PACKAGE
 * directory existed, so `@scope/pkg/<anything>` — including a subpath the
 * package does not export and a file that does not exist — was reported as
 * resolving. That silently disabled the bundle-patch check in the quality
 * gate (the last line of defence for C-1). The subpath is now validated
 * against the package's `exports` map, falling back to plain file probing
 * for legacy packages without one.
 */
function bareSpecifierResolvesInRoot(root: string, spec: string): boolean {
  const parts = spec.split('/')
  const pkgName = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!
  // "@scope" alone is not a package; neither is an empty spec.
  if (pkgName.length === 0 || (spec.startsWith('@') && parts.length < 2)) return false
  const subpath = spec.slice(pkgName.length)
  const pkgDir = join(root, pkgName)
  if (!existsSync(pkgDir)) return false
  if (subpath.length === 0) return true
  const relative = subpath.replace(/^\//, '')
  // 1. A real file/dir at that path (legacy resolution, and what a subpath
  //    means for a package without an exports map).
  if (probeModuleFile(join(pkgDir, relative))) return true
  const manifest = readInstalledManifest(pkgDir)
  const exportsField = manifest?.['exports']
  // 2. No exports map: the subpath IS a file path — already probed above.
  if (exportsField === undefined) return false
  // 3. exports map present: the subpath must be declared by it.
  return exportsDeclaresKey(exportsField, './' + relative)
}

/** Whether a bare specifier resolves inside a profile's node_modules. */
export function bareSpecifierResolves(profileDirPath: string, spec: string): boolean {
  // Node builtins are unconditionally provided by the runtime — they resolve
  // without any node_modules entry (defense in depth: imports are already
  // filtered by scanImports, but bundle patch row names also flow through
  // here).
  if (isBuiltin(spec)) return true
  const roots = [join(profileDirPath, 'node_modules'), join(profileDirPath, '..', 'node_modules')]
  for (const root of roots) {
    try {
      if (bareSpecifierResolvesInRoot(root, spec)) return true
    } catch { /* keep probing */ }
  }
  return false
}
/** Read a package's manifest metadata (version, repository) and install time. */
export function readPackageInfo(dir: string, name: string): {
  version?: string
  installedAt?: string
  repository?: string
} {
  const pkgPath = join(dir, 'node_modules', name, 'package.json')
  try {
    const manifest = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      version?: unknown
      repository?: unknown
      homepage?: unknown
    }
    let repository: string | undefined
    if (typeof manifest.repository === 'string') repository = manifest.repository
    else if (typeof manifest.repository === 'object' && manifest.repository !== null) {
      const url = (manifest.repository as { url?: unknown }).url
      if (typeof url === 'string') repository = url
    }
    if (repository === undefined && typeof manifest.homepage === 'string') repository = manifest.homepage
    // The value lands in an <a href>: only http(s) (and git+https for
    // repository fields) may pass — anything else (javascript:, data:) is
    // dropped to keep a hostile manifest from scripting the settings page
    // (audit M17).
    if (repository !== undefined && !/^(https?:\/\/|git\+https?:\/\/)/i.test(repository)) repository = undefined
    // Install time: the node_modules link mtime (written when pnpm added it).
    let installedAt: string | undefined
    try {
      installedAt = statSync(join(dir, 'node_modules', name)).mtime.toISOString()
    } catch {
      installedAt = undefined
    }
    return {
      ...(typeof manifest.version === 'string' ? { version: manifest.version } : {}),
      ...(installedAt !== undefined ? { installedAt } : {}),
      ...(repository !== undefined ? { repository } : {}),
    }
  } catch {
    return {}
  }
}
/**
 * Resolve the real package name after an install: pnpm writes the package's
 * own name as the dependency key, while the requested source may have been a
 * path/git/tarball locator. Exact match first, then a dependency value
 * containing the source string.
 */
export function resolveInstalledName(profile: string, source: string): string | null {
  const manifest = readManifest(profileDir(profile)) as { dependencies?: Record<string, string> }
  const deps = manifest.dependencies ?? {}
  if (typeof deps[source] === 'string') return source
  // Windows: the caller's source is a backslash path (clone cache) while pnpm
  // writes forward slashes (link:C:/Users/...) — compare both forms or the
  // match fails and the quality gate + insert-row mount are silently skipped.
  // Comparisons are case-insensitive on Windows: a case-mismatched path must
  // not silently skip the quality gate (audit W3).
  const ci = process.platform === 'win32'
  const eq = (a: string, b: string): boolean => ci ? a.toLowerCase() === b.toLowerCase() : a === b
  const inc = (a: string, b: string): boolean => ci ? a.toLowerCase().includes(b.toLowerCase()) : a.includes(b)
  const normalized = source.replace(/\\/g, '/')
  const hit = Object.keys(deps).find(key =>
    eq(deps[key]!, source) || (deps[key] !== undefined && inc(deps[key], source))
    || (normalized !== source && (eq(deps[key]!, normalized) || (deps[key] !== undefined && inc(deps[key], normalized)))))
  return hit ?? null
}

/** Whether an installed package declares dsh.bundle (bundle-plugin shape). */
export function exportsBundlePatch(profile: string, packageName: string): boolean {
  try {
    const manifest = JSON.parse(
      readFileSync(join(profileDir(profile), 'node_modules', packageName, 'package.json'), 'utf8'),
    ) as { dsh?: { bundle?: { patch?: unknown } } }
    return manifest.dsh?.bundle?.patch !== undefined
  } catch {
    return false
  }
}

/**
 * Remove managed insert rows whose package was just removed from the
 * profile. A leftover insert row would fail to import on the next boot
 * (the package directory is gone) — the bug that took the instance down
 * during V2 testing.
 */
export async function cleanupInsertRows(ctx: Context | null, profile: string, packageName: string): Promise<void> {
  try {
    const dir = profileDir(profile)
    const current = readPatch(dir)
    const rows = readInsertRows(current)
    const ops: StackOp[] = []
    let next = current
    for (const row of rows) {
      if (!row.managed || row.name !== packageName) continue
      const result = removeInsertRow(next, row.id)
      if (result.removed) {
        next = result.content
        ops.push({ kind: 'remove-first', value: { insert: [{ id: row.id, name: row.name }] } })
      }
    }
    if (ops.length > 0 && ctx !== null && profile === hostProfileName()) {
      // The live half must not fail silently: a stuck entry is the exact
      // issue-#10 hazard (half-mounted loader tree) — log it for diagnosis.
      const live = await applyLiveOps(ctx, ops)
      if (!live.ok) {
        console.error('[plugin-manager] insert-row live cleanup failed for ' + packageName
          + ': ' + (live.message ?? 'unknown error') + ' — restart the profile to finish')
      }
    }
    if (next !== current) writePatch(patchPath(dir), next)
  } catch {
    /* patch cleanup is best-effort */
  }
}
