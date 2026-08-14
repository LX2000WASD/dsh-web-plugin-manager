/**
 * dsh-plugin-manager host service: Web-UI plugin management for a DSH profile.
 *
 * Communication with the browser uses a small REST surface registered on
 * `ctx.webServer` under /api2/plugin-manager/* (the official /api channel is
 * Typert-owned and requires generated reflection artifacts; a standalone
 * bundle cannot ship them). Same-origin fetch from the Settings tab.
 *
 * Read side merges three truths:
 *  - the live Loader tree (`ctx.loader.entries()`, like the official
 *    read-only inventory),
 *  - the profile manifest (`dsh.profile.bundles` layer stack),
 *  - the profile's installed dependencies (`package.json`),
 *  - insert rows in the profile `cordis.patch.yml` (live-mounted non-bundle
 *    plugins).
 *
 * Write side (V2):
 *  - enable/disable edits the profile's `cordis.patch.yml` through the
 *    managed-block mechanism (src/patch.ts) — reversible, reviewable, never
 *    rewrites user content; config HMR applies it live, no restart;
 *  - install/remove shells out to the official `dsh plugin` CLI (pnpm +
 *    reconcile of `dsh.profile.bundles`); after install the real package name
 *    is resolved from the manifest, and a non-bundle plugin is additionally
 *    mounted as a managed insert row (config HMR live, no restart);
 *  - agent tools (plugin_status/install/uninstall/toggle) register on
 *    ctx.tools when the host provides it (src/tools.ts).
 */

import { execFile, execFileSync, spawn } from 'node:child_process'
import { connect, createServer } from 'node:net'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context, Service } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import z from '@deepseek-ai/schemastery'
import type {
  CommandResult, InsertRow, ManagedPackage, MarketplaceItem, MarketplaceResult,
  MutationResult, PluginManagerSnapshot, ProfileInfo, RuntimeEntry, StartResult,
} from './types.ts'
import {
  addDisableBlock, addInsertRow, applyRowDisabled, applyRowEnabled,
  hasManagedDisable, readInsertRows, readManagedIds, removeDisableBlock,
  removeInsertRow, writePatch,
} from './patch.ts'
import { registerTools } from './tools.ts'

export type * from './types.ts'

/** Route prefix for the REST surface. */
export const ROUTE_PREFIX = '/api2/plugin-manager'

/** This package's own name (identifies the hosting profile). */
export const OUR_PACKAGE_NAME = (() => {
  try {
    const manifest = JSON.parse(
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'),
    ) as { name?: unknown }
    return typeof manifest.name === 'string' ? manifest.name : 'dsh-web-plugin-manager'
  } catch {
    return 'dsh-web-plugin-manager'
  }
})()

/** Resolve the Harness home directory (DSH_HOME env, then ~/.dsh). */
function dshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** Resolve one profile's directory, rejecting traversal. */
function profileDir(name: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name.length > 120) {
    throw new Error(`unsafe profile name: ${JSON.stringify(name)}`)
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

/** Run `dsh plugin --profile <name> <verb> <args...>` and collect output. */
function runDshPlugin(
  profile: string,
  verb: string,
  args: readonly string[],
  cwd: string,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(
      'dsh',
      ['plugin', '--profile', profile, verb, ...args],
      { cwd, timeout: 10 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const output = [stdout, stderr].filter(Boolean).join('\n')
        if (error === null) {
          resolve({ ok: true, exitCode: 0, output })
        } else {
          const code = typeof error.code === 'number' ? error.code : null
          resolve({ ok: code === 0, exitCode: code, output })
        }
      },
    )
  })
}

/** Management service (also registered as ctx.pluginManager for host peers). */
export class PluginManagerService extends Service {
  static inject = ['loader']

  constructor(ctx: Context) {
    super(ctx, 'pluginManager')
  }

  /** List every profile under $DSH_HOME/profiles (directories with package.json). */
  listProfiles(): ProfileInfo[] {
    const root = join(dshHome(), 'profiles')
    const runs = scanRuns()
    const out: ProfileInfo[] = []
    for (const entry of readdirSafe(root)) {
      if (!entry.isDirectory() || entry.name === 'node_modules') continue
      const dir = join(root, entry.name)
      const manifest = readManifest(dir)
      const dsh = (manifest['dsh'] ?? {}) as Record<string, unknown>
      const profile = (dsh['profile'] ?? {}) as Record<string, unknown>
      const bundles = Array.isArray(profile['bundles']) ? profile['bundles'] as string[] : []
      const dependencies = manifest['dependencies'] as Record<string, string> | undefined
      out.push({
        name: entry.name,
        path: dir,
        bundles,
        dependencies: Object.keys(dependencies ?? {}),
        // The profile hosting this running plugin is its dependency.
        isCurrent: Object.keys(dependencies ?? {}).includes(OUR_PACKAGE_NAME),
        isOfficial: isOfficialProfile(entry.name),
        running: runs.get(entry.name) ?? null,
      })
    }
    return out.sort((a, b) => a.name.localeCompare(b.name))
  }


  /** Create a custom profile from an official template (web/headless). */
  async createProfile(name: string, template: string): Promise<MutationResult> {
    if (!/^[A-Za-z0-9._-]+$/.test(name) || name.length > 120) {
      return { ok: false, message: "invalid profile name: " + JSON.stringify(name) }
    }
    if (isOfficialProfile(name)) return { ok: false, message: name + " is an official profile" }
    const dir = profileDir(name)
    if (existsSync(dir)) return { ok: false, message: "profile already exists: " + name }
    const bundles = template === "headless"
      ? ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"]
      : ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]
    try {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, "package.json"), JSON.stringify({
        name: "dsh-profile-" + name,
        private: true,
        dependencies: {},
        // Template layer stack, official-style (bundles are not deps).
        dsh: { profile: { bundles } },
      }, undefined, 2) + "\n")
      writeFileSync(join(dir, "cordis.patch.yml"), PATCH_TEMPLATE)
      writeFileSync(join(dir, "pnpm-workspace.yaml"), PNPM_WORKSPACE_TEMPLATE)
      // Official bundles resolve through the shared profiles/node_modules
      // fallback (official web/headless have no own node_modules either),
      // so the template is just the declared layer stack. Custom plugins
      // install into this profile via pnpm as usual.
      return { ok: true, message: "created " + template + " profile " + name }
    } catch (error: unknown) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Rename a custom profile directory (never the hosting profile). */
  renameProfile(oldName: string, newName: string): MutationResult {
    if (!/^[A-Za-z0-9._-]+$/.test(newName) || newName.length > 120) {
      return { ok: false, message: "invalid profile name: " + JSON.stringify(newName) }
    }
    if (isOfficialProfile(oldName) || isOfficialProfile(newName)) {
      return { ok: false, message: "official profiles (web/headless) are not managed here" }
    }
    const oldDir = profileDir(oldName)
    if (!existsSync(oldDir)) return { ok: false, message: "profile not found: " + oldName }
    if (isHostProfile(oldName)) return { ok: false, message: "cannot rename the running profile (" + oldName + ")" }
    const newDir = profileDir(newName)
    if (existsSync(newDir)) return { ok: false, message: "profile already exists: " + newName }
    try {
      renameSync(oldDir, newDir)
      return { ok: true, message: "renamed " + oldName + " to " + newName }
    } catch (error: unknown) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Delete a custom profile directory (never the hosting profile). */
  removeProfile(name: string): MutationResult {
    if (isOfficialProfile(name)) return { ok: false, message: "official profiles (web/headless) are not managed here" }
    const dir = profileDir(name)
    if (!existsSync(dir)) return { ok: false, message: "profile not found: " + name }
    if (isHostProfile(name)) return { ok: false, message: "cannot remove the running profile (" + name + ")" }
    try {
      rmSync(dir, { recursive: true, force: true })
      return { ok: true, message: "removed profile " + name }
    } catch (error: unknown) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  }


  /**
   * Launch a profile instance (web environments only): opens a terminal
   * window running dsh on a free port (closing the terminal stops the
   * instance). Falls back to a detached background process when no
   * terminal emulator is available. Waits until the web server answers.
   */
  async startProfile(name: string): Promise<StartResult> {
    const dir = profileDir(name)
    if (!existsSync(dir)) return { ok: false, message: "profile not found: " + name }
    const manifest = readManifest(dir)
    const dsh = (manifest['dsh'] ?? {}) as Record<string, unknown>
    const profileManifest = (dsh['profile'] ?? {}) as Record<string, unknown>
    const bundles = Array.isArray(profileManifest['bundles']) ? profileManifest['bundles'] as string[] : []
    if (!bundles.includes('@deepseek-ai/dsh-web-app')) {
      return { ok: false, message: name + " has no web surface (not a web environment)" }
    }
    try {
      const port = await findFreePort(3090)
      const terminal = await openInTerminal('dsh --profile ' + name + ' --port ' + port)
      if (!terminal.opened) {
        // No terminal emulator: background fallback (visible via ps; the
        // profile scan still reports it as running).
        const child = spawn('dsh', ['--profile', name, '--port', String(port)], {
          cwd: process.cwd(),
          detached: true,
          stdio: 'ignore',
        })
        child.unref()
      }
      // Wait for the web server to answer (up to ~10s).
      const deadline = Date.now() + 10_000
      for (;;) {
        if (Date.now() > deadline) break
        if (await probePort(port)) {
          return {
            ok: true,
            port,
            url: "http://127.0.0.1:" + port,
            message: terminal.opened
              ? "opened " + name + " in " + terminal.terminal + " — closing that terminal stops the instance (" + terminal.command + ")"
              : "started " + name + " in the background (no terminal emulator found) on http://127.0.0.1:" + port,
          }
        }
        await new Promise(resolve => setTimeout(resolve, 500))
      }
      return { ok: false, port, message: "started but did not become ready within 10s: http://127.0.0.1:" + port }
    } catch (error: unknown) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  }


  /** Fetch the marketplace listing (GitHub topic search, 24h cache). */
  async marketplace(refresh: boolean): Promise<MarketplaceResult> {
    const cacheDir = join(dshHome(), 'plugin-manager-cache')
    const cachePath = join(cacheDir, 'marketplace.json')
    mkdirSync(cacheDir, { recursive: true })
    // Serve the cache unless it is missing, stale (>24h), or refresh is forced.
    if (!refresh) {
      try {
        const cached = JSON.parse(readFileSync(cachePath, 'utf8')) as { fetchedAt?: unknown; items?: unknown }
        const fetchedAt = typeof cached.fetchedAt === 'string' ? Date.parse(cached.fetchedAt) : NaN
        const items = Array.isArray(cached.items) ? cached.items as MarketplaceItem[] : []
        if (!Number.isNaN(fetchedAt) && Date.now() - fetchedAt < 24 * 60 * 60 * 1000 && items.length > 0) {
          return {
            ok: true,
            items,
            cachedAt: typeof cached.fetchedAt === 'string' ? cached.fetchedAt : undefined,
            fromCache: true,
            message: 'served from cache',
          }
        }
      } catch { /* no/ broken cache: refetch */ }
    }
    try {
      // Primary source: the maintained awesome-dsh-plugins catalog — its
      // referenced repositories are curated (checked against mainline).
      // PLUGINS.md rows: | name | [org/repo](url) | description | status |
      const mdResponse = await fetch(
        'https://raw.githubusercontent.com/AdamPlatin123/awesome-dsh-plugins/main/PLUGINS.md',
        { headers: { 'user-agent': 'dsh-web-plugin-manager' } },
      )
      if (!mdResponse.ok) throw new Error('catalog fetch HTTP ' + mdResponse.status)
      const markdown = await mdResponse.text()
      const rows: Array<{ fullName: string; description: string; status: string }> = []
      for (const line of markdown.split('\n')) {
        const match = /^\|\s*([^|]+?)\s*\|\s*\[([^|]+?)\]\(https?:\/\/github\.com\/([^/)]+\/[^/)]+)\)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|/.exec(line)
        if (match === null) continue
        const fullName = match[3]!.trim()
        if (fullName.length === 0 || fullName.startsWith('deepseek-ai/')) continue
        rows.push({
          fullName,
          description: match[4]!.trim(),
          status: match[5]!.trim(),
        })
      }
      if (rows.length === 0) throw new Error('no rows parsed from the catalog')
      // Enrich with GitHub repository metadata (stars/dates). Unauthenticated
      // rate limit is 60/h; the list is small and cached for 24h.
      const items: MarketplaceItem[] = []
      for (const row of rows) {
        let stars = 0
        let updatedAt = ''
        let createdAt = ''
        try {
          const repoResponse = await fetch('https://api.github.com/repos/' + row.fullName, {
            headers: { 'user-agent': 'dsh-web-plugin-manager' },
          })
          if (repoResponse.ok) {
            const repo = await repoResponse.json() as { stargazers_count?: unknown; updated_at?: unknown; created_at?: unknown }
            stars = typeof repo.stargazers_count === 'number' ? repo.stargazers_count : 0
            updatedAt = typeof repo.updated_at === 'string' ? repo.updated_at : ''
            createdAt = typeof repo.created_at === 'string' ? repo.created_at : ''
          }
        } catch { /* rate-limited or offline: keep zeros */ }
        items.push({
          name: row.fullName,
          displayName: row.fullName.split('/').pop() ?? row.fullName,
          ...(row.description.length > 0 ? { description: row.description } : {}),
          stars,
          updatedAt,
          createdAt,
          url: 'https://github.com/' + row.fullName,
          status: row.status,
        })
      }
      const now = new Date().toISOString()
      writeFileSync(cachePath, JSON.stringify({ fetchedAt: now, items }, undefined, 2) + '\n')
      return { ok: true, items, fromCache: false, message: 'fetched ' + items.length + ' repositories' }
    } catch (error: unknown) {
      // Fall back to the cache when the network fails.
      try {
        const cached = JSON.parse(readFileSync(cachePath, 'utf8')) as { fetchedAt?: unknown; items?: unknown }
        const items = Array.isArray(cached.items) ? cached.items as MarketplaceItem[] : []
        if (items.length > 0) {
          return { ok: true, items, cachedAt: typeof cached.fetchedAt === 'string' ? cached.fetchedAt : undefined, fromCache: true, message: 'network failed; served from cache: ' + (error instanceof Error ? error.message : String(error)) }
        }
      } catch { /* no cache either */ }
      return { ok: false, items: [], fromCache: false, message: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Snapshot one profile: live entries + installed packages + bundle status. */
  list(profile: string): PluginManagerSnapshot {
    const dir = profileDir(profile)
    if (!existsSync(dir)) throw new Error(`profile not found: ${profile}`)

    const manifest = readManifest(dir)
    const dsh = (manifest['dsh'] ?? {}) as Record<string, unknown>
    const profileManifest = (dsh['profile'] ?? {}) as Record<string, unknown>
    const bundles = (Array.isArray(profileManifest['bundles']) ? profileManifest['bundles'] : []) as string[]
    const deps = (manifest['dependencies'] ?? {}) as Record<string, string>

    const patch = readPatch(dir)
    const packages: ManagedPackage[] = Object.keys(deps).map((name) => {
      const isBundle = bundles.includes(name)
      return {
        name,
        isBundle,
        inLayerStack: isBundle,
        ...readPackageInfo(dir, name),
      }
    })

    const insertRows: InsertRow[] = readInsertRows(patch).map((row) => ({
      id: row.id,
      name: row.name,
      managed: row.managed,
    }))

    // Rows the user patch layer explicitly manages (deviate from defaults).
    const managedIds = readManagedIds(patch)

    // Stable view: Loader entry ids are random per mount (Math.random
    // hex), so patch targeting must use the include-tree row id
    // (EntryOptions.id — stable across reloads; official semantics).
    const entries = includeRows(this.ctx, {
      packageNames: new Set(packages.map(pkg => pkg.name)),
      insertNames: new Set(insertRows.map(row => row.name)),
      insertIds: new Set(insertRows.map(row => row.id)),
      managedIds,
    })

    return {
      profile: {
        name: profile,
        path: dir,
        bundles,
        dependencies: packages.map(p => p.name),
        isCurrent: Object.keys(deps).includes(OUR_PACKAGE_NAME),
        isOfficial: isOfficialProfile(profile),
        running: scanRuns().get(profile) ?? null,
      },
      entries,
      packages,
      insertRows,
    }
  }

  /** Enable or disable one plugin row via the managed patch block (live). */
  setEnabled(profile: string, entryId: string, enabled: boolean): MutationResult {
    const dir = profileDir(profile)
    if (!existsSync(dir)) return { ok: false, message: `profile not found: ${profile}` }
    // entryId is the include-tree row id (stable). Random-mount ids (8-hex)
    // cannot be patch-targeted; the UI does not offer toggles for them.
    if (entryId.includes(':') || !isStableRowId(entryId)) {
      return { ok: false, message: `not a patch-targetable row id: ${JSON.stringify(entryId)}` }
    }
    try {
      const current = readPatch(dir)
      // 1. Drop our managed block first (refresh-in-place semantics; the
      //    line-level edit must not see the block's own row).
      const withoutBlock = removeDisableBlock(current, entryId)
      // 2. Line-level edit of a user-written top-level row (the common case:
      //    the row exists in the profile patch and its disabled field must
      //    actually change).
      const rowEdit = enabled
        ? applyRowEnabled(withoutBlock, entryId)
        : applyRowDisabled(withoutBlock, entryId)
      if (rowEdit.changed) {
        writePatch(patchPath(dir), rowEdit.content)
      } else if (enabled) {
        // No user row: enabling means the block removal above is the edit.
        if (withoutBlock !== current) writePatch(patchPath(dir), withoutBlock)
      } else {
        // No user row: fall back to a managed block.
        const next = addDisableBlock(withoutBlock, entryId)
        if (next !== withoutBlock) writePatch(patchPath(dir), next)
      }
      return {
        ok: true,
        message: enabled
          ? `enabled ${entryId} (live via config HMR)`
          : `disabled ${entryId} (live via config HMR)`,
      }
    } catch (error: unknown) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Stop a running instance of a custom profile (never the current one). */
  async stopProfile(name: string): Promise<MutationResult> {
    const run = scanRuns().get(name)
    if (run === undefined) return { ok: false, message: name + ' is not running' }
    if (isHostProfile(name)) return { ok: false, message: 'cannot stop the current instance (' + name + ')' }
    try {
      process.kill(run.pid, 'SIGTERM')
      // Wait for the process to exit (up to ~5s).
      const deadline = Date.now() + 5_000
      for (;;) {
        if (Date.now() > deadline) break
        await new Promise(resolve => setTimeout(resolve, 400))
        if (scanRuns().get(name) === undefined) {
          return { ok: true, message: 'stopped ' + name }
        }
      }
      return { ok: false, message: 'timed out stopping ' + name }
    } catch (error: unknown) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * Install a plugin via dsh plugin (preserving in-box bundles). After a
   * successful add, the real package name is resolved from the manifest
   * (V2-C: pnpm dependency values may be path/git source strings; the
   * dependency key is the package name). A non-bundle plugin (no dsh.bundle
   * declaration) is then mounted as a managed insert row — config HMR applies
   * it live, no restart.
   */
  async install(profile: string, spec: string): Promise<CommandResult> {
    // Git sources (not published on npm, workspace subpackages) are cloned
    // into a cache directory and installed from there — the "official path"
    // for repositories that never reached the registry.
    const prepared = prepareInstallSource(spec)
    if (prepared.error !== undefined || prepared.spec === undefined) {
      return { ok: false, exitCode: 1, output: '[plugin-manager] ' + (prepared.error ?? 'no install source') }
    }
    // npm-first: when the cloned package is published on the registry, prefer
    // the npm install (faster, no local link); fall back to the git clone.
    const npmName = prepared.packageName !== undefined ? probeNpmPublished(prepared.packageName) : undefined
    const result = npmName !== undefined
      ? await installSpec(profile, npmName)
      : await installSpec(profile, prepared.spec)
    const note = npmName !== undefined
      ? 'installed from npm (' + npmName + '; the repository also publishes it)'
      : prepared.note
    if (note !== undefined) {
      return {
        ...result,
        output: result.output + '\n[plugin-manager] ' + note,
      }
    }
    return result
  }

  /**
   * Copy installed plugins from one profile to another (custom-plugin
   * transfer). Each package is reinstalled into the target using its
   * recorded install source (path/git/tarball/name).
   */
  async copyPlugins(fromProfile: string, toProfile: string, names: readonly string[]): Promise<CommandResult> {
    if (!existsSync(profileDir(fromProfile))) return { ok: false, exitCode: 1, output: "source profile not found: " + fromProfile }
    if (!existsSync(profileDir(toProfile))) return { ok: false, exitCode: 1, output: "target profile not found: " + toProfile }
    const manifest = readManifest(profileDir(fromProfile)) as { dependencies?: Record<string, string> }
    const deps = manifest.dependencies ?? {}
    const outputs: string[] = []
    let allOk = true
    for (const name of names) {
      const source = typeof deps[name] === 'string' && deps[name] !== '' ? deps[name] : name
      const result = await installSpec(toProfile, source)
      outputs.push("# " + name + " -> " + toProfile + ": " + (result.ok ? "ok" : "FAILED") + "\n" + result.output.trim())
      if (!result.ok) allOk = false
    }
    return {
      ok: allOk,
      exitCode: allOk ? 0 : 1,
      output: outputs.join("\n\n"),
      installed: [...names],
    }
  }


  /** Remove an installed package via dsh plugin (preserving in-box bundles). */
  async remove(profile: string, name: string): Promise<CommandResult> {
    const before = readBundles(profile)
    const result = await runDshPlugin(profile, 'remove', [name], process.cwd())
    if (result.ok) {
      restoreInBoxBundles(profile, before)
      cleanupInsertRows(profile, name)
    }
    return result
  }

  /** Remove one managed insert row (non-bundle plugin, live unmount). */
  removeInsert(profile: string, rowId: string): MutationResult {
    const dir = profileDir(profile)
    if (!existsSync(dir)) return { ok: false, message: `profile not found: ${profile}` }
    try {
      const current = readPatch(dir)
      const rows = readInsertRows(current)
      const row = rows.find(r => r.id === rowId)
      if (row === undefined) return { ok: false, message: `insert row not found: ${rowId}` }
      if (!row.managed) return { ok: false, message: `row ${rowId} is user-owned; remove it manually` }
      const { content, removed } = removeInsertRow(current, rowId)
      if (!removed) return { ok: false, message: `no managed insert row: ${rowId}` }
      writePatch(patchPath(dir), content)
      return { ok: true, message: `removed insert row ${rowId} (live via config HMR)` }
    } catch (error: unknown) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  }
}

/**
 * Prepare an install source. Git URLs (npm-unpublished repositories,
 * workspace subpackages) are cloned into $DSH_HOME/plugin-manager-src and
 * installed from there — the local-directory path the official CLI also
 * supports. Custom subdir syntax: `repo#路径:packages/x` (the # in normal
 * git specs is a ref/branch). The cache is kept: local-directory installs
 * are pnpm links that need their source to stay in place.
 */
function prepareInstallSource(spec: string): { spec?: string; note?: string; error?: string; packageName?: string } {
  const trimmed = spec.trim()
  const gitUrl = /^(?:git\+)?(https?:\/\/[^\s#]+?)(?:#([^\s]*))?$/.exec(trimmed)
  const gitSsh = /^([^\s@]+@[^\s:]+:[^\s#]+?)(?:#([^\s]*))?$/.exec(trimmed)
  const githubShort = /^github:([^\s#]+?)(?:#([^\s]*))?$/.exec(trimmed)
  const m = gitUrl ?? gitSsh ?? githubShort
  if (m === null) return { spec: trimmed }
  let repo = m[1]!
  if (githubShort !== null && githubShort[1] !== undefined) repo = "https://github.com/" + githubShort[1]!.replace(/^\.git/, '')
  const frag = m[2] ?? ''
  // Our subdir convention: `#路径:<relative-dir>` (a plain #ref stays a git ref).
  let ref: string | undefined
  let subdir: string | undefined
  if (frag.startsWith('路径:')) subdir = frag.slice(3)
  else if (frag.length > 0) ref = frag
  try {
    const cacheRoot = join(dshHome(), 'plugin-manager-src')
    mkdirSync(cacheRoot, { recursive: true })
    const base = repo.replace(/^https?:\/\//, '').replace(/^git@/, '').replace(/[^A-Za-z0-9._-]/g, '-')
    const dirName = base + (ref !== undefined ? '-' + ref.replace(/[^A-Za-z0-9._-]/g, '-') : '')
    const dest = join(cacheRoot, dirName)
    if (!existsSync(dest)) {
      const args = ['clone']
      if (ref !== undefined) args.push('-b', ref)
      args.push('--depth', '1', repo, dest)
      execFileSync('git', args, { stdio: 'pipe', timeout: 3 * 60 * 1000 })
    }
    const pkgDir = subdir !== undefined ? join(dest, subdir) : dest
    if (existsSync(join(pkgDir, 'package.json'))) {
      try {
        const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as { name?: unknown }
        if (typeof manifest.name === 'string' && manifest.name.length > 0) {
          return {
            spec: pkgDir,
            packageName: manifest.name,
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
      return { error: 'no package.json found at ' + pkgDir + ' (or anywhere in the repository)' }
    }
    return {
      spec: pkgDir,
      note: 'cloned ' + repo + (subdir !== undefined ? ' (' + subdir + ')' : '') + ' into ' + dest + ' — keep this cache directory: the installed package links to it',
    }
  } catch (error: unknown) {
    return { error: 'git clone failed: ' + (error instanceof Error ? error.message : String(error)) }
  }
}

/** Whether a package name exists on the npm registry (short timeout). */
function probeNpmPublished(packageName: string): string | undefined {
  try {
    const output = execFileSync('npm', ['view', packageName, 'version'], {
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return output.trim().length > 0 ? packageName : undefined
  } catch {
    return undefined
  }
}

/** Find cordis-style packages inside a cloned repository (depth 3). */
function discoverWorkspacePackages(root: string): string[] {
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
 * Shared install path: pnpm add through the official CLI, resolve the real
 * package name, mount non-bundle plugins as managed insert rows, restore
 * in-box bundles, and run a quality check (undeclared runtime imports are
 * the main reason third-party plugins take the instance down at boot —
 * auto-rollback on failure).
 */
async function installSpec(profile: string, spec: string): Promise<CommandResult> {
  const before = readBundles(profile)
  const result = await runDshPlugin(profile, 'add', [spec], process.cwd())
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
    cleanupInsertRows(profile, installed)
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

  const isBundle = exportsBundlePatch(profile, installed)
  if (isBundle) return { ...result, installed: [installed] }

  // Non-bundle plugin: write the managed insert row (live mount).
  const rowId = slugify(installed)
  try {
    const dir = profileDir(profile)
    const current = readPatch(dir)
    const next = addInsertRow(current, rowId, installed)
    if (next !== current) writePatch(patchPath(dir), next)
    return {
      ...result,
      installed: [installed],
      output: result.output
        + "\n[plugin-manager] quality check passed; mounted " + installed + " as insert row " + rowId + " (live via config HMR)",
    }
  } catch (error: unknown) {
    return {
      ...result,
      installed: [installed],
      output: result.output + "\n[plugin-manager] install ok but insert row failed: " + (error instanceof Error ? error.message : String(error)),
    }
  }
}

/**
 * Specifiers the loader provides without the plugin declaring them: the
 * client platform table plus the host-side cordis/dsh basics the profile
 * bundles mount. Anything else a plugin imports must be in its manifest.
 */
const LOADER_PROVIDED = new Set([
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/cordis-plugin-loader', '@deepseek-ai/cordis-plugin-include',
  '@deepseek-ai/cordis-plugin-group', '@deepseek-ai/cordis-plugin-hmr',
  '@deepseek-ai/cordis-plugin-timer',
  '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
])

/** Bare specifiers imported by a JS entry (relative/node: paths excluded). */
function scanImports(filePath: string): string[] {
  try {
    const code = readFileSync(filePath, 'utf8')
    const found = new Set<string>()
    const pattern = /(?:from\s+|import\s*\(\s*|require\(\s*)['"]([^'"]+)['"]/g
    for (const match of code.matchAll(pattern)) {
      const spec = match[1]!
      if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) continue
      found.add(spec)
    }
    return [...found]
  } catch {
    return []
  }
}

/** Resolve a package's entry file (exports["."].default, main, or index.js). */
function packageEntry(pkgDir: string, manifest: Record<string, unknown>): string | null {
  const exportsField = manifest['exports'] as Record<string, unknown> | undefined
  const dot = exportsField !== undefined ? exportsField['.'] as Record<string, unknown> | undefined : undefined
  const candidates: unknown[] = [
    dot !== undefined && typeof dot === 'object' ? (dot as Record<string, unknown>)['default'] : undefined,
    manifest['main'],
    manifest['module'],
  ]
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue
    const resolved = join(pkgDir, candidate)
    if (existsSync(resolved)) return resolved
  }
  const index = join(pkgDir, 'index.js')
  return existsSync(index) ? index : null
}

/**
 * Quality check for one installed package: undeclared bare imports that the
 * loader does not provide are boot failures waiting to happen. Returns a
 * list of issues (empty = healthy).
 */
function qualityIssues(profile: string, packageName: string): string[] {
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
  const entry = packageEntry(pkgDir, manifest)
  if (entry === null) return ["no resolvable entry file (exports/main/index.js)"]
  const issues: string[] = []
  for (const spec of scanImports(entry)) {
    if (declared.has(spec) || LOADER_PROVIDED.has(spec)) continue
    issues.push("imports " + spec + " but does not declare it (would fail at boot)")
  }
  return issues
}
/** One live dsh instance found by process scan. */
interface RunInfo {
  readonly port: number | null
  readonly pid: number
}

/**
 * Scan running dsh instances by their command line (dsh --profile <name>
 * [--port <n>]). Stateless: a live process is by definition running; no
 * registry file to go stale. Bash wrappers and the node child both match;
 * the entry carrying a --port wins for the same profile.
 */
function scanRuns(): Map<string, RunInfo> {
  const runs = new Map<string, RunInfo>()
  try {
    const output = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' })
    for (const line of output.split('\n')) {
      let match = /^\s*(\d+)\s+(.*\bdsh\b.*--profile\s+(\S+))/.exec(line)
      let profile: string | undefined
      let pid: number | undefined
      if (match !== null) {
        pid = Number(match[1]!)
        profile = match[3]!
      } else {
        // `dsh web`/`dsh headless` command mode (no --profile flag).
        match = /^\s*(\d+)\s+.*\bbin\.js\s+(\S+)/.exec(line)
        if (match !== null) {
          pid = Number(match[1]!)
          profile = match[2]!
        }
      }
      if (profile === undefined || pid === undefined) continue
      // Parse --port from the whole line (the --profile group ends at the name).
      const portMatch = /--port\s+(\d+)/.exec(line)
      const port = portMatch === null ? null : Number(portMatch[1]!)
      const existing = runs.get(profile)
      if (existing === undefined || (existing.port === null && port !== null)) {
        runs.set(profile, { port, pid })
      }
    }
  } catch {
    /* ps unavailable: no runs reported */
  }
  return runs
}
/** Result of trying to open a terminal window. */
interface TerminalOpen {
  readonly opened: boolean
  readonly terminal?: string
  readonly command?: string
}

/**
 * Open a terminal window running `command` (cross-platform). The instance
 * then lives and dies with that terminal session. Linux probes common
 * emulators; macOS uses Terminal.app via osascript; Windows uses
 * `start cmd /k`. Returns opened=false when nothing is available.
 */
async function openInTerminal(command: string): Promise<TerminalOpen> {
  if (process.platform === 'darwin') {
    spawn('osascript', ['-e', 'tell application "Terminal" to do script "' + command.replace(/"/g, '\\"') + '"'], { stdio: 'ignore' }).unref()
    return { opened: true, terminal: 'Terminal.app', command }
  }
  if (process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', 'cmd', '/k', command], { stdio: 'ignore' }).unref()
    return { opened: true, terminal: 'cmd', command }
  }
  // The user's explicit choice, then the system default terminal selector
  // (x-terminal-emulator / update-alternatives), then common emulators.
  const envTerminal = process.env.TERMINAL?.trim()
  const candidates = [
    ...(envTerminal !== undefined && envTerminal.length > 0 ? [envTerminal.split(/\s+/)[0]!] : []),
    'x-terminal-emulator', 'gnome-terminal', 'konsole', 'xterm', 'kitty', 'alacritty', 'wezterm',
  ]
  for (const bin of candidates) {
    if (!hasBinary(bin)) continue
    const argv = terminalArgs(bin, command)
    try {
      spawn(bin, argv, { stdio: 'ignore' }).unref()
      return { opened: true, terminal: bin, command }
    } catch {
      /* try the next emulator */
    }
  }
  return { opened: false }
}

/** Whether a binary exists on PATH. */
function hasBinary(bin: string): boolean {
  try {
    execFileSync('which', [bin], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** Terminal-emulator specific argv for running one command and keeping the window. */
function terminalArgs(bin: string, command: string): string[] {
  const body = ['bash', '-c', command + '; echo; read -p "Press Enter to close..."']
  switch (bin) {
    case 'gnome-terminal': return ['--', ...body]
    case 'wezterm': return ['start', '--', ...body]
    case 'konsole':
    case 'x-terminal-emulator':
    case 'xterm':
    case 'alacritty': return ['-e', ...body]
    default: return body
  }
}
/** Find the first free port from `start` upward. */
async function findFreePort(start: number): Promise<number> {
  for (let port = start; port < start + 200; port += 1) {
    const free = await new Promise<boolean>((resolve) => {
      const server = createServer()
      server.once('error', () => resolve(false))
      server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
    })
    if (free) return port
  }
  throw new Error('no free port found')
}

/** Whether a TCP port accepts connections. */
function probePort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1')
    const done = (ok: boolean): void => {
      socket.destroy()
      resolve(ok)
    }
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

/** A loader entry with the fields we read (structural, loader types stay optional). */
interface RowEntryLike {
  readonly id: string
  readonly options?: { readonly id?: string; readonly name?: string; readonly group?: boolean | null }
  readonly disabled?: boolean
  readonly fiber?: { readonly state?: number }
  readonly subtree?: { entries(): Iterable<RowEntryLike> }
}

/** Loader random-mount ids are 8-hex (Math.random().toString(16).slice(2, 10)). */
function isStableRowId(id: string): boolean {
  return !/^[0-9a-f]{8}$/.test(id)
}

/** Map a fiber state number to the wire phase label. */
function phaseOf(state: number | undefined): RuntimeEntry['fiberPhase'] {
  if (state === undefined) return null
  if (state === 0) return 'pending'
  if (state === 1) return 'loading'
  if (state === 2) return 'active'
  if (state === 3) return 'failed'
  if (state === 4) return null
  return 'unloading'
}

/** Sets used to decide whether a row is user-installed. */
interface InstalledSets {
  readonly packageNames: ReadonlySet<string>
  readonly insertNames: ReadonlySet<string>
  readonly insertIds: ReadonlySet<string>
  /** Row ids the user patch layer explicitly manages (deviate from defaults). */
  readonly managedIds: ReadonlySet<string>
}

/**
 * Read the composed include-tree rows as the stable runtime view. Loader
 * entry ids are random per mount, so patch targeting must use the include
 * row id (EntryOptions.id — stable across reloads by official semantics).
 * Random-mount rows (no explicit id) keep their random id and are excluded
 * from patch-targetable operations by the UI (isStableRowId).
 */
function includeRows(ctx: Context, installed: InstalledSets): RuntimeEntry[] {
  const loader = ctx.get('loader') as { entries(): Iterable<RowEntryLike> } | undefined
  if (loader === undefined) return []
  for (const entry of loader.entries()) {
    if (entry.id !== 'include') continue
    // Deduplicate by include row id: config-HMR refresh generations can leave
    // both the patched row (configured disabled, unmounted) and the stale
    // mounted row in the tree. Prefer the configured state (disabled), then a
    // live fiber, then the first occurrence — the loader itself never mounts
    // two rows with the same id, so one entry per id is the authoritative view.
    const seen = new Map<string, RuntimeEntry>()
    const authority = (row: RuntimeEntry): number =>
      (row.enabled ? 0 : 2) + (row.fiberPhase === null ? 0 : 1)
    for (const row of entry.subtree?.entries() ?? []) {
      const options = row.options
      if (options === undefined || options.id === undefined || options.group) continue
      const name = options.name ?? ''
      const candidate: RuntimeEntry = {
        entryId: options.id,
        moduleName: name,
        enabled: !row.disabled,
        fiberPhase: phaseOf(row.fiber?.state),
        installed: installed.packageNames.has(name)
          || installed.insertNames.has(name)
          || installed.insertIds.has(options.id),
        modified: installed.managedIds.has(options.id),
      }
      const current = seen.get(options.id)
      if (current === undefined || authority(candidate) > authority(current)) {
        seen.set(options.id, candidate)
      }
    }
    return [...seen.values()]
  }
  return []
}

/** Read a package's manifest metadata (version, repository) and install time. */
function readPackageInfo(dir: string, name: string): {
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
function resolveInstalledName(profile: string, source: string): string | null {
  const manifest = readManifest(profileDir(profile)) as { dependencies?: Record<string, string> }
  const deps = manifest.dependencies ?? {}
  if (typeof deps[source] === 'string') return source
  const hit = Object.keys(deps).find(key => deps[key] === source || deps[key]?.includes(source))
  return hit ?? null
}

/** Whether an installed package declares dsh.bundle (bundle-plugin shape). */
function exportsBundlePatch(profile: string, packageName: string): boolean {
  try {
    const manifest = JSON.parse(
      readFileSync(join(profileDir(profile), 'node_modules', packageName, 'package.json'), 'utf8'),
    ) as { dsh?: { bundle?: { patch?: unknown } } }
    return manifest.dsh?.bundle?.patch !== undefined
  } catch {
    return false
  }
}

/** Turn a package name into a safe insert-row id (scope slash → dash). */
function slugify(name: string): string {
  return name.replace(/^@/, '').replace(/[^a-z0-9-]/gi, '-').toLowerCase()
}

/**
 * Remove managed insert rows whose package was just removed from the
 * profile. A leftover insert row would fail to import on the next boot
 * (the package directory is gone) — the bug that took the instance down
 * during V2 testing.
 */
function cleanupInsertRows(profile: string, packageName: string): void {
  try {
    const dir = profileDir(profile)
    const current = readPatch(dir)
    const rows = readInsertRows(current)
    let next = current
    for (const row of rows) {
      if (!row.managed || row.name !== packageName) continue
      const result = removeInsertRow(next, row.id)
      if (result.removed) next = result.content
    }
    if (next !== current) writePatch(patchPath(dir), next)
  } catch {
    /* patch cleanup is best-effort */
  }
}

/** Read the current bundle list of a profile. */
function readBundles(profile: string): string[] {
  const manifest = readManifest(profileDir(profile))
  const dsh = (manifest['dsh'] ?? {}) as Record<string, unknown>
  const profileManifest = (dsh['profile'] ?? {}) as Record<string, unknown>
  const bundles = Array.isArray(profileManifest['bundles']) ? profileManifest['bundles'] as string[] : []
  return [...bundles]
}

/** Official built-in profiles the environment manager never touches. */
const OFFICIAL_PROFILES = ['web', 'headless'] as const

/** Whether a profile name is an official built-in. */
function isOfficialProfile(name: string): boolean {
  return (OFFICIAL_PROFILES as readonly string[]).includes(name)
}

/** Whether a profile hosts the running plugin-manager (its dependency). */
function isHostProfile(name: string): boolean {
  // The profile hosting this running instance — renaming or removing it would
  // break the live process. Other profiles that merely install the plugin
  // (e.g. via copyPlugins) remain manageable.
  try {
    const argv = process.argv
    const flagIndex = argv.indexOf('--profile')
    if (flagIndex >= 0 && argv[flagIndex + 1] !== undefined) {
      return name === argv[flagIndex + 1]
    }
    // `dsh web` / `dsh headless` command mode (no --profile flag).
    const candidate = argv.find(arg => !arg.startsWith('-') && !arg.endsWith('bin.js') && !arg.includes('node'))
    return candidate !== undefined && name === candidate
  } catch {
    return false
  }
}

/** Official empty patch template for new profiles. */
const PATCH_TEMPLATE = [
  "# Your patch layer for this dsh profile, applied after every bundle layer:",
  "# a top-level YAML array of loader patch entries (id-targeted config",
  "# overrides, disables, and insert lists; `!!js` expressions allowed).",
  '[]',
].join('\n') + '\n'

/** Hoisted-linker workspace for new profiles (mirrors the official template). */
const PNPM_WORKSPACE_TEMPLATE = [
  'packages:',
  '  - .',
  '',
  'nodeLinker: hoisted',
  'autoInstallPeers: false',
  '',
].join('\n')

/** Installation-owned (in-box) bundles: never dependencies, always layers. */
const IN_BOX_BUNDLES = [
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-headless',
] as const

/**
 * `dsh plugin` reconciles bundles from installed dependencies and drops
 * in-box bundles (base/web-app/headless are installation-owned, not
 * dependencies). Re-insert only those in-box bundles that existed before.
 */
function restoreInBoxBundles(profile: string, before: readonly string[]): void {
  const dir = profileDir(profile)
  const path = join(dir, 'package.json')
  const manifest = readManifest(dir) as {
    dependencies?: Record<string, string>
    dsh?: { profile?: { bundles?: string[] } }
  }
  const current = manifest.dsh?.profile?.bundles ?? []
  const missing = before.filter(
    (bundle) => (IN_BOX_BUNDLES as readonly string[]).includes(bundle) && !current.includes(bundle),
  )
  if (missing.length === 0) return
  const next = [...current]
  for (const bundle of missing) {
    // Insert after the previous bundle's position to keep the prior order.
    const beforeIndex = before.indexOf(bundle)
    const anchor = before[beforeIndex - 1]
    const at = anchor === undefined ? 0 : next.indexOf(anchor) + 1
    next.splice(at, 0, bundle)
  }
  manifest.dsh = manifest.dsh ?? {}
  manifest.dsh.profile = manifest.dsh.profile ?? {}
  manifest.dsh.profile.bundles = next
  writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n')
}

/** Read directory entries defensively (missing root → empty). */
function readdirSafe(path: string): { name: string; isDirectory(): boolean }[] {
  try {
    return readdirSync(path, { withFileTypes: true }) as unknown as { name: string; isDirectory(): boolean }[]
  } catch {
    return []
  }
}

/** Read a JSON request body (bounded). */
function readJsonBody(req: NodeJS.ReadableStream & { destroy?(): void }): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 1_000_000) { reject(new Error('request body too large')); req.destroy?.() }
      else chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch (error: unknown) {
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
    req.on('error', reject)
  })
}

/** Write a JSON response. */
function sendJson(res: { writeHead(status: number, headers: Record<string, string>): void; end(body?: string): void }, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(value))
}

/** Mount the REST surface. Returns the route disposers (may be empty). */
export function registerRoutes(ctx: Context, service: PluginManagerService): (() => void)[] {
  const webServer = ctx.get('webServer') as { register(route: WebRoute): () => void } | undefined
  if (webServer === undefined) return []

  const handler = (op: string) => async (req: NodeJS.ReadableStream & { url?: string }, res: { writeHead(status: number, headers: Record<string, string>): void; end(body?: string): void }): Promise<void> => {
    try {
      const body = (await readJsonBody(req)) as Record<string, unknown>
      switch (op) {
        case 'listProfiles': {
          sendJson(res, 200, { ok: true, value: service.listProfiles() })
          return
        }
        case 'list': {
          const profile = typeof body['profile'] === 'string' ? body['profile'] : ''
          sendJson(res, 200, { ok: true, value: service.list(profile) })
          return
        }
        case 'setEnabled': {
          const profile = typeof body['profile'] === 'string' ? body['profile'] : ''
          const entryId = typeof body['entryId'] === 'string' ? body['entryId'] : ''
          const enabled = body['enabled'] === true
          sendJson(res, 200, { ok: true, value: service.setEnabled(profile, entryId, enabled) })
          return
        }
        case 'install': {
          const profile = typeof body['profile'] === 'string' ? body['profile'] : ''
          const spec = typeof body['spec'] === 'string' ? body['spec'] : ''
          sendJson(res, 200, { ok: true, value: await service.install(profile, spec) })
          return
        }
        case 'remove': {
          const profile = typeof body['profile'] === 'string' ? body['profile'] : ''
          const name = typeof body['name'] === 'string' ? body['name'] : ''
          sendJson(res, 200, { ok: true, value: await service.remove(profile, name) })
          return
        }
        case 'createProfile': {
          const name = typeof body['name'] === 'string' ? body['name'] : ''
          const template = typeof body['template'] === 'string' ? body['template'] : 'web'
          sendJson(res, 200, { ok: true, value: await service.createProfile(name, template) })
          return
        }
        case 'stopProfile': {
          const name = typeof body['name'] === 'string' ? body['name'] : ''
          sendJson(res, 200, { ok: true, value: await service.stopProfile(name) })
          return
        }
        case 'marketplace': {
          const refresh = body['refresh'] === true
          sendJson(res, 200, { ok: true, value: await service.marketplace(refresh) })
          return
        }
        case 'startProfile': {
          const name = typeof body['name'] === 'string' ? body['name'] : ''
          sendJson(res, 200, { ok: true, value: await service.startProfile(name) })
          return
        }
        case 'copyPlugins': {
          const from = typeof body['from'] === 'string' ? body['from'] : ''
          const to = typeof body['to'] === 'string' ? body['to'] : ''
          const names = Array.isArray(body['names']) ? body['names'] as string[] : []
          sendJson(res, 200, { ok: true, value: await service.copyPlugins(from, to, names) })
          return
        }
        case 'renameProfile': {
          const oldName = typeof body['oldName'] === 'string' ? body['oldName'] : ''
          const newName = typeof body['newName'] === 'string' ? body['newName'] : ''
          sendJson(res, 200, { ok: true, value: service.renameProfile(oldName, newName) })
          return
        }
        case 'removeProfile': {
          const name = typeof body['name'] === 'string' ? body['name'] : ''
          sendJson(res, 200, { ok: true, value: service.removeProfile(name) })
          return
        }
        case 'removeInsert': {
          const profile = typeof body['profile'] === 'string' ? body['profile'] : ''
          const rowId = typeof body['rowId'] === 'string' ? body['rowId'] : ''
          sendJson(res, 200, { ok: true, value: service.removeInsert(profile, rowId) })
          return
        }
        default:
          sendJson(res, 404, { ok: false, error: { code: 'unknown-op', message: op } })
      }
    } catch (error: unknown) {
      sendJson(res, 400, {
        ok: false,
        error: { code: 'bad-request', message: error instanceof Error ? error.message : String(error) },
      })
    }
  }

  const disposers: (() => void)[] = []
  for (const op of ['listProfiles', 'list', 'setEnabled', 'install', 'remove', 'removeInsert', 'createProfile', 'renameProfile', 'removeProfile', 'copyPlugins', 'startProfile', 'stopProfile', 'marketplace']) {
    disposers.push(webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/${op}`, handler: handler(op) as unknown as WebRoute['handler'] }))
  }
  return disposers
}

/** Plugin entry config: target profile for the agent tools. */
export interface PluginManagerConfig {
  /** Profile the agent tools (plugin_status/install/uninstall/toggle) manage. */
  profile: string
}

export const Config = z.object({
  profile: z.string().default('web'),
}) as unknown as z<PluginManagerConfig>

/** Plugin entry: mount the service, routes, and (when present) agent tools. */
export const name = 'plugin-manager'
export const inject = ['loader']

export function apply(ctx: Context, config: PluginManagerConfig): void {
  const service = new PluginManagerService(ctx)
  // webServer is a sibling include-group row; ctx.inject waits for it like
  // the official agent-tool-presentation waits for codeRuntime.
  ctx.inject(['webServer'], (webCtx: Context) => {
    webCtx.effect(() => {
      const disposers = registerRoutes(webCtx, service)
      return () => { for (const dispose of disposers) dispose() }
    }, 'dsh-web-plugin-manager: routes')
  })
  // V2-E: agent tools, when the host provides the tools service (web
  // profiles do; headless may not — inject simply never fires).
  ctx.inject(['tools'], (toolsCtx: Context) => {
    toolsCtx.effect(() => {
      const disposers = registerTools(toolsCtx, service, config.profile)
      return () => { for (const dispose of disposers) dispose() }
    }, 'dsh-web-plugin-manager: tools')
  })
}

// Function-plugin form: no default export (mixing forms makes the Loader
// discard the named apply). The service class is instantiated inside apply.