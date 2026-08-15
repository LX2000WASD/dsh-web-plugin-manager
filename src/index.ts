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
 *    rewrites user content; the change is applied live through the loader
 *    include (no restart; see src/live.ts for the platform-deadlock rationale);
 *  - install/remove shells out to the official `dsh plugin` CLI (pnpm +
 *    reconcile of `dsh.profile.bundles`); after install the real package name
 *    is resolved from the manifest, and a non-bundle plugin is additionally
 *    mounted as a managed insert row (config HMR live, no restart);
 *  - agent tools (plugin_status/install/uninstall/toggle) register on
 *    ctx.tools when the host provides it (src/tools.ts).
 */

import { execFile, execFileSync, spawn } from 'node:child_process'
import { connect, createServer } from 'node:net'
import { accessSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context, Service } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import z from '@deepseek-ai/schemastery'
import type {
  CommandResult, InsertRow, ManagedPackage, MarketplaceItem, MarketplaceResult,
  MutationResult, PluginManagerSnapshot, ProfileInfo, RuntimeEntry, StartResult,
  UpdateCheckResult, UpdateInfo,
} from './types.ts'
import {
  addDisableBlock, addInsertRow, applyRowDisabled, applyRowEnabled,
  hasManagedDisable, readInsertRows, readManagedIds, removeDisableBlock,
  removeInsertRow, writePatch,
} from './patch.ts'
import { analyzeProfile, scanImports, scanNodeModulesNames, scanPackageImports } from './analyze.ts'
import type { AnalyzeIssue, AnalyzeResult } from './types.ts'
import { applyLiveOps, ensurePatchWatcher, type StackOp } from './live.ts'
import { registerPluginGuard, registerPluginRulePrompt } from './guard.ts'
import { marketplaceFetch } from './net.ts'
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

/** The safe-profile-name rule (shared by profileDir and hostProfileName). */
function isSafeProfileName(name: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(name) && name.length <= 120
}

/** Resolve one profile's directory, rejecting traversal. */
function profileDir(name: string): string {
  if (!isSafeProfileName(name)) {
    throw new Error("unsafe profile name: " + JSON.stringify(name))
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

/**
 * Resolve a command to its executable path, preferring an absolute path so
 * the caller can also inject its directory into child PATH.
 *
 * Resolution order (POSIX):
 *   1. the directory of the running node — nvm/volta/fnm layouts put npm,
 *      npx, pnpm and dsh right next to `process.execPath`. This is also the
 *      toolchain the profile's node_modules were installed with, so it is
 *      preferred over a PATH hit: a PATH `npm`/node from a different
 *      (system) version would explode with module/engine mismatches. Under
 *      a normal nvm host this is the same directory PATH would find;
 *   2. plain PATH lookup — covers tools not installed per-node (git, dsh
 *      via a global manager like pnpm/volta);
 *   3. any nvm-installed node version's bin directory ($NVM_DIR) — rescues
 *      hosts started by absolute path (desktop launcher, service, nohup)
 *      where nvm's PATH setup never ran in this process;
 *   4. the bare name — let the child surface the error.
 *
 * The returned `dir` is the directory the command lives in when it was NOT
 * found on PATH (null when PATH resolution succeeded) — prepend it to child
 * PATH so the tool's own children (a dsh shim's `node`, the CLI's `pnpm`)
 * resolve with the same toolchain.
 *
 * Windows keeps the `where` lookup: the npm CLI shims are .cmd/.bat files
 * (dsh, npm, ...) that `execFile`/spawn cannot run by bare name (no PATHEXT
 * lookup) — the full shim path is needed (Node >= 20.12 then executes
 * .cmd/.bat files natively).
 */
interface ResolvedCommand {
  /** Absolute executable path (or the bare name when nothing resolved). */
  readonly command: string
  /** Directory to prepend to child PATH, or null when already on PATH. */
  readonly dir: string | null
  /** Win32 only: true when command is a cmd/bat shim that spawn must run through a shell. */
  readonly shell?: boolean
}

/** Absolute path of `name` on PATH (POSIX walk; no shell involved). */
function pathLookup(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir.length === 0) continue
    const candidate = join(dir, name)
    try {
      if (statSync(candidate).isFile()) {
        accessSync(candidate, constants.X_OK)
        return candidate
      }
    } catch { /* not executable here: keep walking */ }
  }
  return undefined
}

/** Resolve a command to an absolute path (see above for the resolution order). */
function resolveCommand(name: string): ResolvedCommand {
  if (process.platform !== 'win32') {
    const nextToNode = join(dirname(process.execPath), name)
    if (existsSync(nextToNode)) {
      return { command: nextToNode, dir: dirname(process.execPath) }
    }
    const onPath = pathLookup(name)
    if (onPath !== undefined) return { command: onPath, dir: null }
    // Any nvm-installed node version's bin dir (the host node may be a copy
    // outside $NVM_DIR, e.g. launched via an absolute path).
    const nvmRoot = process.env.NVM_DIR ?? join(homedir(), '.nvm')
    try {
      const versions = join(nvmRoot, 'versions', 'node')
      for (const entry of readdirSync(versions, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const bin = join(versions, entry.name, 'bin')
        if (existsSync(join(bin, name))) return { command: join(bin, name), dir: bin }
      }
    } catch { /* no nvm layout */ }
    return { command: name, dir: null }
  }
  try {
    const output = execFileSync('where', [name], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    })
    const hits = output.split(String.fromCharCode(10)).map(line => line.trim()).filter(line => line.length > 0)
    // npm/nvm shims live as BOTH the bare script and the .cmd wrapper: the
    // extensionless file cannot be spawned (ENOENT) — prefer an executable
    // extension, and flag cmd/bat shims so spawns go through a shell.
    const hit = hits.find(h => h.toLowerCase().endsWith('.exe'))
      ?? hits.find(h => h.toLowerCase().endsWith('.cmd'))
      ?? hits.find(h => h.toLowerCase().endsWith('.bat'))
      ?? hits[0]
    if (hit !== undefined) {
      const lower = hit.toLowerCase()
      const shell = lower.endsWith('.cmd') || lower.endsWith('.bat')
      return { command: hit, dir: dirname(hit), ...(shell ? { shell: true } : {}) }
    }
  } catch { /* not on PATH: let the caller surface the error */ }
  return { command: name, dir: null }
}

/** Child env with an extra directory prepended to PATH (null dir → base env). */
function commandEnv(dir: string | null, base?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (dir === null) return base ?? process.env
  const env = { ...(base ?? process.env) }
  const path = env.PATH ?? ''
  env.PATH = dir + (path.length > 0 ? delimiter + path : '')
  return env
}

/** Run `dsh plugin --profile <name> <verb> <args...>` and collect output. */
function runDshPlugin(
  profile: string,
  verb: string,
  args: readonly string[],
  cwd: string,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const tool = resolveCommand('dsh')
    execFile(
      tool.command,
      ['plugin', '--profile', profile, verb, ...args],
      { cwd, timeout: 10 * 60 * 1000, maxBuffer: 4 * 1024 * 1024, env: commandEnv(tool.dir), ...(tool.shell === true ? { shell: true } : {}) },
      (error, stdout, stderr) => {
        const output = [stdout, stderr].filter(Boolean).join('\n')
        if (error === null) {
          resolve({ ok: true, exitCode: 0, output })
        } else {
          const code = typeof error.code === 'number' ? error.code : null
          if (code === null && (error as NodeJS.ErrnoException).code === 'ENOENT') {
            resolve({
              ok: false,
              exitCode: null,
              output: '[plugin-manager] could not start the dsh CLI (' + error.message + '). '
                + 'Install it if missing (npm i -g dsh), or start this profile from a shell where node/npm/dsh are on PATH '
                + '(nvm: run the profile from an nvm-active terminal, e.g. after `nvm use`).',
            })
          } else {
            resolve({ ok: code === 0, exitCode: code, output })
          }
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
    // Windows device names (CON, NUL, AUX, COM1..9, LPT1..9) and names ending
    // in a dot/space cannot be directories — reject them up front with a
    // clear message instead of a raw EINVAL from the filesystem.
    if (process.platform === 'win32') {
      const base = name.replace(/\.+$/, '').toUpperCase()
      if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(base) || /[\s.]$/.test(name)) {
        return { ok: false, message: name + " is a reserved Windows name; pick another profile name" }
      }
    }
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
      return { ok: false, message: "failed to create profile " + name + " at " + dir + ": " + (error instanceof Error ? error.message : String(error)) }
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
    // Refuse a double start: an already-running instance (possibly started
    // outside this page, e.g. `dsh web` on its default port) must not be
    // shadowed by a second instance — and stopping either would be ambiguous.
    const running = scanRuns().get(name)
    if (running !== undefined) {
      return {
        ok: false,
        message: name + " is already running"
          + (running.port !== null ? " on http://127.0.0.1:" + running.port : " (pid " + running.pid + ")")
          + " — stop it first",
      }
    }
    const manifest = readManifest(dir)
    const dsh = (manifest['dsh'] ?? {}) as Record<string, unknown>
    const profileManifest = (dsh['profile'] ?? {}) as Record<string, unknown>
    const bundles = Array.isArray(profileManifest['bundles']) ? profileManifest['bundles'] as string[] : []
    if (!bundles.includes('@deepseek-ai/dsh-web-app')) {
      return { ok: false, message: name + " has no web surface (not a web environment)" }
    }
    // Async spawn errors (e.g. the dsh command missing) surface here.
    let spawnError: string | null = null
    try {
      const port = await findFreePort(3090)
      // Terminal-window mode everywhere: a visible window keeps the instance
      // in plain sight (the user can see it is alive; closing the window
      // stops it). Windows shows the same visible cmd window — the flash of
      // the intermediate `start` launcher is suppressed, and the dsh
      // shim directory is injected into the window's PATH so its `dsh`
      // command always resolves (see openInTerminal).
      const terminal = await openInTerminal('dsh --profile ' + name + ' --port ' + port)
      if (!terminal.opened) {
        // No terminal emulator / shell available: background fallback (still
        // visible via the process scan; the profile list reports it as
        // running and the stop button manages it).
        const tool = resolveCommand('dsh')
        const child = spawn(tool.command, ['--profile', name, '--port', String(port)], {
          cwd: process.cwd(),
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
          env: commandEnv(tool.dir),
          ...(tool.shell === true ? { shell: true } : {}),
        })
        // Swallow async spawn errors (e.g. dsh missing) — reported below.
        child.on('error', (error) => { spawnError = error.message })
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
              : "started " + name + " in the background on http://127.0.0.1:" + port + " (stop it from this page)",
          }
        }
        await new Promise(resolve => setTimeout(resolve, 500))
      }
      return {
        ok: false,
        port,
        message: spawnError !== null
          ? "could not start " + name + ": " + spawnError + " — check that the dsh CLI is installed and the profile process runs in a shell where node/dsh are on PATH (nvm: start it from an nvm-active terminal)"
          : "started but did not become ready within 10s: http://127.0.0.1:" + port + " — check the terminal window for errors",
      }
    } catch (error: unknown) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  }


  /**
   * Fetch the marketplace listing (24h cache).
   *
   * The awesome-dsh-plugins source moved from a single PLUGINS.md table to a
   * structured catalog (catalog/plugins/*.json + schema + policy). Both
   * sources are fetched and merged (they complement each other), and the
   * on-disk cache is the last resort — an empty list is only shown when
   * every source is unusable.
   */
  async marketplace(refresh: boolean): Promise<MarketplaceResult> {
    const cacheDir = join(dshHome(), 'plugin-manager-cache')
    const cachePath = join(cacheDir, 'marketplace.json')
    const failurePath = join(cacheDir, 'marketplace-failure.json')
    mkdirSync(cacheDir, { recursive: true })
    const readCache = (): { fetchedAt?: string; items: MarketplaceItem[] } => {
      try {
        const cached = JSON.parse(readFileSync(cachePath, 'utf8')) as { version?: unknown; fetchedAt?: unknown; items?: unknown }
        // Cache format changed (item shape / source layout): ignore old files.
        if (cached.version !== MARKETPLACE_CACHE_VERSION) return { items: [] }
        const fetchedAt = typeof cached.fetchedAt === 'string' ? cached.fetchedAt : ''
        const items = Array.isArray(cached.items) ? cached.items as MarketplaceItem[] : []
        return { fetchedAt, items }
      } catch { /* no/ broken cache */ }
      return { items: [] }
    }
    const writeCache = (items: MarketplaceItem[]): void => {
      writeFileSync(cachePath, JSON.stringify({
        version: MARKETPLACE_CACHE_VERSION,
        fetchedAt: new Date().toISOString(),
        items,
      }, undefined, 2) + '\n')
      // A successful fetch clears the recorded failure reason.
      rmSync(failurePath, { force: true })
    }
    const readFailure = (): { fetchedAt?: string; message?: string } => {
      try {
        const parsed = JSON.parse(readFileSync(failurePath, 'utf8')) as { fetchedAt?: unknown; message?: unknown }
        return {
          fetchedAt: typeof parsed.fetchedAt === 'string' ? parsed.fetchedAt : '',
          message: typeof parsed.message === 'string' ? parsed.message : undefined,
        }
      } catch { /* no/broken failure record */ }
      return {}
    }
    const writeFailure = (message: string): void => {
      try {
        writeFileSync(failurePath, JSON.stringify({ fetchedAt: new Date().toISOString(), message }, undefined, 2) + '\n')
      } catch { /* failure recording is best-effort */ }
    }
    // Serve the cache unless it is missing, stale (>24h), or refresh is forced.
    if (!refresh) {
      const cached = readCache()
      const fetchedAt = Date.parse(cached.fetchedAt ?? '')
      if (!Number.isNaN(fetchedAt) && Date.now() - fetchedAt < MARKETPLACE_TTL && cached.items.length > 0) {
        return {
          ok: true,
          items: cached.items,
          cachedAt: cached.fetchedAt,
          fromCache: true,
          message: 'served from cache',
        }
      }
      // Recent total failure: serve the recorded reason instead of re-running
      // the full GitHub round-trip (the failure is environmental and will
      // not clear within minutes).
      const failure = readFailure()
      const failureAt = Date.parse(failure.fetchedAt ?? '')
      if (failure.message !== undefined && !Number.isNaN(failureAt)
        && Date.now() - failureAt < MARKETPLACE_FAILURE_TTL) {
        return {
          ok: false,
          items: [],
          fromCache: false,
          message: failure.message + ' (negative cache — retry automatically in a few minutes)',
        }
      }
    }
    // Keep previous metadata (stars/dates) to reuse when the GitHub API is
    // rate-limited during enrichment.
    const prior = new Map<string, MarketplaceItem>(readCache().items.map(item => [item.name, item]))
    let catalogError: string | null = null
    let markdownError: string | null = null
    // Fetch both sources independently: the structured catalog (new layout)
    // and the curated PLUGINS.md table (legacy layout). Either one failing
    // must not empty the list — they complement each other (the catalog
    // carries auto-discovered repos + npm package names, PLUGINS.md carries
    // curated descriptions and verified statuses).
    const catalogItems = await fetchCatalogItems().catch((error: unknown) => {
      catalogError = error instanceof Error ? error.message : String(error)
      return []
    })
    const markdownItems = await fetchMarkdownItems().catch((error: unknown) => {
      markdownError = error instanceof Error ? error.message : String(error)
      return []
    })
    const merged = mergeMarketplace(catalogItems, markdownItems)
    // Verified entries first: when the unauthenticated API quota runs out
    // mid-enrichment, the most relevant entries keep their stars.
    merged.sort((a, b) => Number(b.status?.includes('✅') ?? false) - Number(a.status?.includes('✅') ?? false))
    const items = await enrichRepos(merged, prior)
    if (items.length > 0) {
      writeCache(items)
      const note = [
        catalogError === null ? 'catalog' : 'catalog unavailable (' + catalogError + ')',
        markdownError === null ? 'PLUGINS.md' : 'PLUGINS.md unavailable (' + markdownError + ')',
      ].join('; ')
      return { ok: true, items, fromCache: false, message: 'fetched ' + items.length + ' plugins (' + note + ')' }
    }
    // Last resort: the on-disk cache (any age — better than an empty list).
    const cached = readCache()
    if (cached.items.length > 0) {
      return {
        ok: true,
        items: cached.items,
        cachedAt: cached.fetchedAt,
        fromCache: true,
        message: 'sources unavailable; served from cache: ' + (catalogError ?? markdownError ?? 'unknown'),
      }
    }
    // Total failure with nothing to serve: record the reason so the next
    // visits within the negative-cache TTL fail fast with a visible message.
    const failure = catalogError ?? markdownError ?? 'no sources'
    writeFailure(failure)
    return { ok: false, items: [], fromCache: false, message: failure }
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
      const source = deps[name]
      return {
        name,
        isBundle,
        inLayerStack: isBundle,
        ...readPackageInfo(dir, name),
        ...(typeof source === 'string' && source.length > 0 ? { source } : {}),
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
    // The live loader tree only covers the RUNNING profile: other profiles'
    // snapshots synthesize their entries from the manifest and insert rows
    // (offline state — nothing is live until that profile starts).
    const isRunning = profile === hostProfileName()
    const entries = isRunning
      ? includeRows(this.ctx, {
        packageNames: new Set(packages.map(pkg => pkg.name)),
        insertNames: new Set(insertRows.map(row => row.name)),
        insertIds: new Set(insertRows.map(row => row.id)),
        managedIds,
      })
      : offlineEntries(bundles, insertRows)

    // Installed-but-unmounted dependencies: a manual install through the
    // official CLI or pnpm writes the dependency but no mount row (the
    // official CLI only mounts bundle-layer packages), so the plugin is
    // invisible to the loader and to this view. Synthesize an entry so it
    // shows up and can be mounted from the UI (mount()).
    const coveredNames = new Set(entries.map(entry => entry.moduleName))
    const unmounted: RuntimeEntry[] = packages
      .filter(pkg => !pkg.isBundle && !coveredNames.has(pkg.name) && pkg.name !== OUR_PACKAGE_NAME)
      .map(pkg => ({
        entryId: slugify(pkg.name),
        moduleName: pkg.name,
        enabled: true,
        fiberPhase: null,
        installed: true,
        modified: false,
        unmounted: true,
      }))
    const allEntries = [...entries, ...unmounted]

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
      entries: allEntries,
      packages,
      insertRows,
    }
  }

  /**
   * Mount an installed-but-unmounted dependency as a managed insert row:
   * the manual-install fix. The official CLI writes only the dependency
   * (non-bundle plugins get no row, so they never load); this writes the
   * same managed insert row the install flow would, applied live when the
   * profile is running.
   */
  async mount(profile: string, packageName: string): Promise<MutationResult> {
    const dir = profileDir(profile)
    if (!existsSync(dir)) return { ok: false, message: `profile not found: ` + profile }
    const manifest = readManifest(dir) as { dependencies?: Record<string, string> }
    const deps = manifest.dependencies ?? {}
    if (!(packageName in deps)) {
      return { ok: false, message: packageName + ' is not a profile dependency (install it first)' }
    }
    const bundles = readBundles(profile)
    if (bundles.includes(packageName)) {
      return { ok: false, message: packageName + ' is a bundle-layer plugin — it loads on restart, no mount row needed' }
    }
    const current = readPatch(dir)
    const rowId = slugify(packageName)
    // Never clobber an existing row (user-written or another plugin's) that
    // already owns this id — the loader refuses duplicate ids and the whole
    // tree fails.
    const existing = readInsertRows(current).find(row => row.id === rowId && row.name !== packageName)
    const userOwns = readManagedIds(current).has(rowId)
    if (existing !== undefined || userOwns) {
      return {
        ok: false,
        message: 'row id ' + rowId + ' is already used'
          + (existing !== undefined ? ' by ' + existing.name : ' by a user row')
          + ' (id collision — mount under a different id or remove the other row)'
      }
    }
    const next = addInsertRow(current, rowId, packageName)
    if (next === current) return { ok: false, message: packageName + ' is already mounted' }
    const live = profile === hostProfileName()
      ? await applyLiveOps(this.ctx, [{ kind: 'append', value: { insert: [{ id: rowId, name: packageName }] } }])
      : { ok: false, message: 'profile not running' }
    writePatch(patchPath(dir), next)
    return {
      ok: true,
      message: live.ok
        ? 'mounted ' + packageName + ' as insert row ' + rowId + ' (applied live)'
        : 'mounted ' + packageName + ' as insert row ' + rowId + ' (file updated; ' + (live.message ?? 'restart to apply') + ')'
    }
  }

  /** Enable or disable one plugin row via the managed patch block (live). */
  async setEnabled(profile: string, entryId: string, enabled: boolean): Promise<MutationResult> {
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
      // 3. Compute the live stack mutation, then apply it through the loader
      //    include BEFORE writing the file. Direct application avoids the
      //    platform deadlock that a watcher-triggered refresh hits when the
      //    change unloads a service the HMR service depends on (the timer
      //    row); the watcher's later refresh of the same content is a no-op.
      const ops: StackOp[] = []
      let next = current
      if (rowEdit.changed) {
        next = rowEdit.content
        // User-written row edited in place: mirror the edit on the live
        // stack (drop any stale managed block, then patch the row).
        ops.push({ kind: 'remove-first', id: entryId, value: { id: entryId, disabled: true } })
        ops.push({
          kind: 'replace-last',
          id: entryId,
          mutate: (row) => {
            const copy = { ...row }
            if (enabled) {
              delete copy.disabled
              return Object.keys(copy).length > 1 ? copy : null
            }
            return { ...copy, disabled: true }
          },
        })
      } else if (enabled) {
        // No user row: enabling means the block removal above is the edit.
        if (withoutBlock !== current) next = withoutBlock
        ops.push({ kind: 'remove-first', id: entryId, value: { id: entryId, disabled: true } })
      } else {
        // No user row: fall back to a managed block.
        const candidate = addDisableBlock(withoutBlock, entryId)
        if (candidate !== withoutBlock) next = candidate
        ops.push({ kind: 'append', value: { id: entryId, disabled: true } })
      }
      // Live application only reaches the running profile's own tree;
      // other profiles' rows are not mounted here (their patch file is
      // written and applies on their next start).
      const live = profile === hostProfileName()
        ? await applyLiveOps(this.ctx, ops)
        : { ok: false, message: 'profile not running' }
      if (next !== current) writePatch(patchPath(dir), next)
      const state = enabled ? 'enabled' : 'disabled'
      return {
        ok: true,
        message: live.ok
          ? `${state} ${entryId} (applied live)`
          : `${state} ${entryId} (file updated; ${live.message ?? 'restart to apply'})`,
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
      // Kill the real instance first, then its launchers (the terminal-window
      // cmd/bash that hosts it) — otherwise a stopped instance would leave a
      // dead window behind and the user would think it is still running.
      process.kill(run.pid, 'SIGTERM')
      for (const launcher of run.launchers) {
        try { process.kill(launcher, 'SIGTERM') } catch { /* already gone */ }
      }
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
    return installWithSource(this.ctx, profile, spec)
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
      const result = await installProtected(this.ctx, toProfile, source)
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
    return removeProtected(this.ctx, profile, name)
  }

  /** Remove one managed insert row (non-bundle plugin, live unmount). */
  async removeInsert(profile: string, rowId: string): Promise<MutationResult> {
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
      // Live-unmount through the loader include before persisting the
      // file (running profile only; other profiles apply on next start).
      const live = profile === hostProfileName()
        ? await applyLiveOps(this.ctx, [{
          kind: 'remove-first',
          value: { insert: [{ id: rowId, name: row.name }] },
        }])
        : { ok: false, message: 'profile not running' }
      writePatch(patchPath(dir), content)
      return {
        ok: true,
        message: live.ok
          ? `removed insert row ${rowId} (applied live)`
          : `removed insert row ${rowId} (file updated; ${live.message ?? 'restart to apply'})`,
      }
    } catch (error: unknown) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * Check every installed package for a newer version (manual update check).
   *
   * Source kinds:
   *  - npm packages (semver range / bare version in the manifest) are
   *    compared against the npm registry dist-tag `latest`;
   *  - git-cloned cache directories (dependencies value `link:<path>` where
   *    the target is a git repository) are compared against their remote:
   *    the cache is fetched (never pulled) and the local HEAD is compared
   *    with the remote ref;
   *  - anything else (local non-git directories, tarballs, unknown shapes)
   *    reports `hasUpdate: false` with an explanatory message — a manual
   *    reinstall is still possible via the update action.
   */
  async checkUpdates(profile: string): Promise<UpdateCheckResult> {
    const dir = profileDir(profile)
    if (!existsSync(dir)) return { ok: false, items: [], message: 'profile not found: ' + profile }
    const manifest = readManifest(dir) as { dependencies?: Record<string, string> }
    const deps = manifest.dependencies ?? {}
    // Self-update included: updating the running manager is safe — the new
    // files land on disk while the loaded module keeps running in memory,
    // and the update path carries the quality gate (rollback re-installs the
    // previous version, never uninstalls). A restart applies the new code.
    const names = Object.keys(deps)
    // Bounded concurrency: npm view / git fetch are child processes.
    const results: UpdateInfo[] = []
    let cursor = 0
    const workers = Array.from({ length: Math.min(4, names.length) }, async () => {
      for (;;) {
        const index = cursor
        cursor += 1
        if (index >= names.length) return
        const name = names[index]!
        results.push(await checkPackageUpdate(dir, name, deps[name]))
      }
    })
    await Promise.all(workers)
    const updatable = results.filter(item => item.hasUpdate).length
    return {
      ok: true,
      items: results.sort((a, b) => a.name.localeCompare(b.name)),
      message: updatable > 0
        ? updatable + ' of ' + results.length + ' packages have updates'
        : 'all ' + results.length + ' packages are up to date',
    }
  }

  /**
   * Update one installed package to the latest version.
   *
   *  - npm: reinstall through the official CLI with `@latest` (quality gate
   *    and in-box bundle preservation included);
   *  - git cache (link:path into plugin-manager-src): fetch + hard reset the
   *    cache to its remote ref, then re-run the official add to refresh the
   *    dependency record; the installed package links into the cache, so the
   *    new content is picked up on the next start;
   *  - git URL sources (`github:…` / git URLs): re-add the source spec so
   *    pnpm re-resolves the remote;
   *  - local non-git directories cannot be updated (no upstream to pull).
   */
  async update(profile: string, name: string): Promise<CommandResult> {
    return updateProtected(profile, name)
  }

  /**
   * Dependency / conflict / compatibility analysis for one profile. The
   * offline engine (src/analyze.ts) covers any profile; the running profile
   * additionally feeds live observations: fiber states and errors, the
   * active service table (ctx.reflect), and pending-inject diagnostics.
   */
  analyze(profile: string): AnalyzeResult {
    const dir = profileDir(profile)
    if (!existsSync(dir)) throw new Error(`profile not found: ${profile}`)
    const manifest = readManifest(dir)
    const dsh = (manifest['dsh'] ?? {}) as Record<string, unknown>
    const profileManifest = (dsh['profile'] ?? {}) as Record<string, unknown>
    const bundles = (Array.isArray(profileManifest['bundles']) ? profileManifest['bundles'] : []) as string[]
    const patch = readPatch(dir)
    const isRunning = profile === hostProfileName()
    const liveRows = isRunning ? liveRowStates(this.ctx) : []
    const disabledNames = new Set(liveRows.filter(row => !row.enabled).map(row => row.moduleName))
    const extra: AnalyzeIssue[] = []
    if (isRunning) {
      // Failed fibers: surface the underlying error when the runtime keeps it.
      for (const row of liveRows) {
        if (row.phase !== 'failed' && row.phase !== 'unloading') continue
        extra.push({
          kind: 'load-failure',
          from: row.moduleName,
          message: row.moduleName + ' (' + row.entryId + ') failed to load'
            + (row.error !== undefined ? ': ' + row.error : ''),
        })
      }
      // Pending fibers: compare static inject declarations against the
      // active service table (a missing provider leaves the entry pending).
      // ctx.reflect is the public reflection property on every context
      // (NOT a service — ctx.get('reflect') is undefined). The store is an
      // internal object keyed by isolate symbols; it is read defensively.
      const activeServices = new Set<string>()
      const reflect = (this.ctx as unknown as {
        reflect?: { store?: Record<string, { name?: unknown; fiber?: { state?: unknown } }> }
      }).reflect
      if (reflect?.store !== undefined) {
        for (const impl of Object.values(reflect.store)) {
          if (impl?.fiber?.state === 2 && typeof impl.name === 'string') activeServices.add(impl.name)
        }
      }
      const analysis = analyzeProfile(dir, bundles, patch, disabledNames, [])
      for (const pkg of analysis.packages) {
        if (pkg.injects.length === 0) continue
        const row = liveRows.find(live => live.moduleName === pkg.name)
        if (row === undefined || row.phase !== 'pending') continue
        const missing = pkg.injects.filter(name => !activeServices.has(name) && name !== 'loader' && name !== 'webServer')
        if (missing.length > 0) {
          extra.push({
            kind: 'pending-dependency',
            from: pkg.name,
            message: pkg.name + ' is pending: it injects ' + missing.join(', ')
              + ' but no active service provides it (install or enable the provider, or check its own failure)',
          })
        }
      }
    }
    return analyzeProfile(dir, bundles, patch, disabledNames, extra)
  }
}

/** Run a command with a timeout, resolving (never throwing) with the output. */
function execFileTimeout(cmd: string, args: readonly string[], timeoutMs: number): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const tool = resolveCommand(cmd)
    execFile(
      tool.command,
      [...args],
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true, env: commandEnv(tool.dir), ...(tool.shell === true ? { shell: true } : {}) },
      (error, stdout, stderr) => {
        const output = [stdout, stderr].filter(Boolean).join('\n')
        if (error === null) resolve({ ok: true, output })
        else resolve({ ok: false, output })
      },
    )
  })
}

/** Whether a directory is a git repository (cheap probe). */
function isGitRepo(path: string): boolean {
  try {
    const tool = resolveCommand('git')
    execFileSync(tool.command, ['-C', path, 'rev-parse', '--git-dir'], { stdio: 'ignore', timeout: 5_000, windowsHide: true, env: commandEnv(tool.dir), ...(tool.shell === true ? { shell: true } : {}) })
    return true
  } catch {
    return false
  }
}

/** Resolve a `link:`/`file:` dependency value to its target path, or null. */
function parseLocalSource(source: string): string | null {
  const match = /^(?:link|file):(.+)$/.exec(source.trim())
  return match !== null ? match[1]!.trim() : null
}

/** Whether a dependency value is a git source spec (github:/git+/URL). */
function isGitSourceSpec(source: string): boolean {
  const spec = source.trim()
  if (spec.startsWith('github:') || spec.startsWith('git+') || spec.startsWith('git@')) return true
  return /^https?:\/\//.test(spec) && (/\.git(\/|$)/.test(spec) || /github\.com\//.test(spec))
}

/** Extract a cloneable URL from a git source spec (drops #ref fragments). */
function gitUrlFromSpec(source: string): string {
  const spec = source.trim().split('#')[0]!
  if (spec.startsWith('github:')) return 'https://github.com/' + spec.slice(7).replace(/^\.git/, '')
  if (spec.startsWith('git+')) return spec.slice(4)
  return spec
}

/** Whether a spec looks like a git clone URL (used by update/checkUpdates). */
function isGitCloneSpec(source: string): boolean {
  const spec = source.trim()
  return spec.startsWith('file:')
    || spec.startsWith('git@')
    || spec.startsWith('github:')
    || spec.startsWith('git+')
    || /^https?:\/\//.test(spec)
}

/** The installed git commit of a package manifest (gitHead), when recorded. */
async function installedGitHead(dir: string, name: string): Promise<string | undefined> {
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
function npmLatestVersion(name: string): Promise<string | undefined> {
  return npmRegistryLatest(name)
}

/** Remote HEAD commit of a git URL, or undefined when unreachable. */
async function gitRemoteHead(url: string): Promise<string | undefined> {
  const result = await execFileTimeout('git', ['ls-remote', url, 'HEAD'], 20_000)
  if (!result.ok) return undefined
  const first = result.output.trim().split(/\r?\n/)[0]
  return first !== undefined ? first.split(/\s+/)[0] : undefined
}

/**
 * Fetch a git cache directory (never merging) and compare the local HEAD
 * with the remote ref (the branch upstream, falling back to FETCH_HEAD).
 */
async function gitRemoteState(dir: string): Promise<{
  ok: boolean
  hasUpdate: boolean
  latest?: string
  message: string
}> {
  const head = await execFileTimeout('git', ['-C', dir, 'rev-parse', 'HEAD'], 10_000)
  if (!head.ok) return { ok: false, hasUpdate: false, message: 'not a git repository' }
  const headHash = head.output.trim()
  if (headHash.length === 0) return { ok: false, hasUpdate: false, message: 'no HEAD commit' }
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

/** Fetch and hard-reset a git cache directory to its remote branch. */
async function gitPullToRemote(dir: string): Promise<{ ok: boolean; message: string }> {
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
async function checkPackageUpdate(dir: string, name: string, source: string): Promise<UpdateInfo> {
  const installed = readPackageInfo(dir, name).version
  const local = parseLocalSource(source)
  if (local !== null) {
    if (!isGitRepo(local)) {
      return {
        name,
        hasUpdate: false,
        ...(installed !== undefined ? { currentVersion: installed } : {}),
        source: 'local',
        message: 'installed from a local directory — no upstream to compare',
      }
    }
    const git = await gitRemoteState(local)
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
  return {
    name,
    hasUpdate: installed !== undefined && installed !== latest,
    ...(installed !== undefined ? { currentVersion: installed } : {}),
    latestVersion: latest,
    source: 'npm',
    message: installed !== undefined
      ? 'installed ' + installed + ', latest ' + latest
      : 'latest ' + latest,
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
function prepareInstallSource(spec: string): { spec?: string; note?: string; error?: string; packageName?: string; created?: boolean } {
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
  try {
    const cacheRoot = join(dshHome(), 'plugin-manager-src')
    mkdirSync(cacheRoot, { recursive: true })
    const base = repo.replace(/^https?:\/\//, '').replace(/^git@/, '').replace(/^\/+/, '').replace(/[^A-Za-z0-9._-]/g, '-')
    const dirName = base + (ref !== undefined ? '-' + ref.replace(/[^A-Za-z0-9._-]/g, '-') : '')
    const dest = join(cacheRoot, dirName)
    const created = !existsSync(dest)
    if (created) {
      const args = ['clone']
      if (ref !== undefined) args.push('-b', ref)
      args.push('--depth', '1', repo, dest)
      const tool = resolveCommand('git')
      execFileSync(tool.command, args, { stdio: 'pipe', timeout: 3 * 60 * 1000, env: commandEnv(tool.dir), ...(tool.shell === true ? { shell: true } : {}) })
    }
    const pkgDir = subdir !== undefined ? join(dest, subdir) : dest
    if (existsSync(join(pkgDir, 'package.json'))) {
      try {
        const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as { name?: unknown }
        if (typeof manifest.name === 'string' && manifest.name.length > 0) {
          return {
            spec: pkgDir,
            packageName: manifest.name,
            created,
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
      created,
      note: 'cloned ' + repo + (subdir !== undefined ? ' (' + subdir + ')' : '') + ' into ' + dest + ' — keep this cache directory: the installed package links to it',
    }
  } catch (error: unknown) {
    return { error: 'git clone failed: ' + (error instanceof Error ? error.message : String(error)) }
  }
}

/**
 * Latest dist-tag version of an npm package. Uses the registry's /latest
 * endpoint (a tiny document) instead of `npm view` (which pulls the full
 * packument and routinely exceeds short timeouts on slow networks), through
 * the proxy-aware marketplaceFetch (15s cap) with one retry. Registry
 * resolved from the npm config so mirrors and private registries work.
 */
async function npmRegistryLatest(packageName: string): Promise<string | undefined> {
  let registry = 'https://registry.npmjs.org/'
  try {
    const tool = resolveCommand('npm')
    const config = execFileSync(tool.command, ['config', 'get', 'registry'], {
      encoding: 'utf8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      env: commandEnv(tool.dir),
      ...(tool.shell === true ? { shell: true } : {}),
    })
    const trimmed = config.trim()
    if (trimmed.length > 0) registry = trimmed.endsWith('/') ? trimmed : trimmed + '/'
  } catch { /* registry defaults to npmjs.org */ }
  const url = registry + encodeURIComponent(packageName) + '/latest'
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await marketplaceFetch(url, {
        headers: { ...GITHUB_UA },
        redirect: 'follow',
      })
      if (response.ok) {
        const doc = await response.json() as { version?: string }
        return typeof doc.version === 'string' ? doc.version : undefined
      }
      return undefined // 404 / 4xx: not published (no retry for definitive answers)
    } catch {
      // network / timeout: retry once, then report undetected
    }
  }
  return undefined
}

/** Whether a package name exists on the npm registry. */
async function probeNpmPublished(packageName: string): Promise<string | undefined> {
  return (await npmRegistryLatest(packageName)) !== undefined ? packageName : undefined
}

/** Bare-package root of a specifier (subpath imports resolve through it). */
function declaredRoot(spec: string): string | undefined {
  if (spec.startsWith('@')) {
    const parts = spec.split('/')
    return parts.length >= 2 ? parts[0] + '/' + parts[1] : undefined
  }
  const first = spec.split('/')[0]
  return first !== undefined && first.length > 0 ? first : undefined
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
 * Install with source preparation: git sources (not published on npm,
 * workspace subpackages) are cloned into a cache directory and installed
 * from there — the "official path" for repositories that never reached the
 * registry — with npm-first when the cloned package is published. ctx null
 * = out-of-process caller (the dshpm CLI).
 */
export async function installWithSource(ctx: Context | null, profile: string, spec: string): Promise<CommandResult> {
  // npm-first BEFORE cloning for plain GitHub URLs (the marketplace shape:
  // repo name == npm name). A pinned ref / subdir requests a specific git
  // state, so those still clone. On slow networks the registry /latest
  // probe is tiny and fast, so the npm path wins instead of a doomed clone.
  const plainGit = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^\/#\s]+)\/([^\/#\s]+?)(?:\.git)?$/.exec(spec.trim())
  if (plainGit !== null) {
    const npmName = await probeNpmPublished(plainGit[2]!)
    if (npmName !== undefined) {
      const result = await installProtected(ctx, profile, npmName)
      return {
        ...result,
        output: result.output + '\n[plugin-manager] installed from npm (' + npmName + ' — the GitHub repository publishes it)',
      }
    }
  }
  const prepared = prepareInstallSource(spec)
  if (prepared.error !== undefined || prepared.spec === undefined) {
    return { ok: false, exitCode: 1, output: '[plugin-manager] ' + (prepared.error ?? 'no install source') }
  }
  // npm-first: when the cloned package is published on the registry, prefer
  // the npm install (faster, no local link); fall back to the git clone.
  const npmName = prepared.packageName !== undefined ? await probeNpmPublished(prepared.packageName) : undefined
  const result = npmName !== undefined
    ? await installProtected(ctx, profile, npmName)
    : await installProtected(ctx, profile, prepared.spec)
  const note = npmName !== undefined
    ? 'installed from npm (' + npmName + '; the repository also publishes it)'
    : prepared.note
  const output = note !== undefined
    ? result.output + '\n[plugin-manager] ' + note
    : result.output
  if (!result.ok) {
    // A failed install leaves a clone behind only if it is unreferenced:
    // git sources often lack committed build artifacts (dist/lib), which
    // the quality gate catches as an unresolvable entry file — clean the
    // freshly created cache dir and say so.
    if (prepared.created && !cacheDirReferencedByProfile(dshHome(), prepared.spec)) {
      try {
        rmSync(prepared.spec, { recursive: true, force: true })
        return {
          ...result,
          output: output + '\n[plugin-manager] the repository may not commit build artifacts (dist/lib), or the package is not published to npm — check that the main/exports entry file exists in the repo, or install the npm package by name. Removed the unused clone cache.',
        }
      } catch { /* cleanup is best-effort */ }
    }
    return {
      ...result,
      output: output + '\n[plugin-manager] the repository may not commit build artifacts (dist/lib), or the package is not published to npm — check that the main/exports entry file exists in the repo, or install the npm package by name.',
    }
  }
  return { ...result, output }
}

/** Whether any profile manifest references the given install path (link:). */
function cacheDirReferencedByProfile(home: string, pkgDir: string): boolean {
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
export async function installProtected(ctx: Context | null, profile: string, spec: string): Promise<CommandResult> {
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
    cleanupInsertRows(ctx, profile, installed)
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
      output: result.output + analysisNote
        + '\n[plugin-manager] bundle plugin added to the layer stack — restart the profile to load it (the catalog will show it then).',
    }
  }

  // Non-bundle plugin: write the managed insert row (live mount).
  const rowId = slugify(installed)
  try {
    const dir = profileDir(profile)
    const current = readPatch(dir)
    // An id collision with an existing row (user-written or another
    // plugin's) would make the loader refuse the whole tree — fail this
    // install instead of corrupting the patch.
    const idOwner = readInsertRows(current).find(row => row.id === rowId && row.name !== installed)
    const userOwnsId = readManagedIds(current).has(rowId)
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
    const next = addInsertRow(current, rowId, installed)
    const live = next !== current && ctx !== null && profile === hostProfileName()
      ? await applyLiveOps(ctx, [{ kind: 'append', value: { insert: [{ id: rowId, name: installed }] } }])
      : { ok: false, message: 'profile not running' }
    if (next !== current) writePatch(patchPath(dir), next)
    if (!live.ok && /ERR_MODULE_NOT_FOUND|Cannot find package|failed to import/i.test(live.message ?? '')) {
      // The mount failed because the module cannot be imported. Leaving the
      // insert row in the patch would fail the WHOLE profile at the next
      // boot — roll the row back instead (the dependency stays installed).
      const rolledBack = removeInsertRow(next, rowId)
      if (rolledBack.removed) writePatch(patchPath(dir), rolledBack.content)
      return {
        ...result,
        installed: [installed],
        output: result.output
          + "\n[plugin-manager] mount failed (" + (live.message ?? 'import error') + ")"
          + "\n[plugin-manager] insert row " + rowId + " rolled back — the profile stays bootable. Check the plugin's dependencies.",
      }
    }
    return {
      ...result,
      installed: [installed],
      output: result.output
        + "\n[plugin-manager] quality check passed; mounted " + installed + " as insert row " + rowId + (live.ok ? " (applied live)" : " (file updated; " + (live.message ?? 'mounts on next restart') + ")"),
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
 * Shared remove path: pnpm remove through the official CLI, preserving
 * in-box bundles and cleaning up the managed insert rows of the removed
 * package. ctx null = out-of-process caller (the dshpm CLI); the file
 * removal is identical, only the live unmount is skipped.
 */
export async function removeProtected(ctx: Context | null, profile: string, name: string): Promise<CommandResult> {
  const before = readBundles(profile)
  const result = await runDshPlugin(profile, 'remove', [name], process.cwd())
  if (result.ok) {
    restoreInBoxBundles(profile, before)
    cleanupInsertRows(ctx, profile, name)
  }
  return result
}

/**
 * Shared update path for one installed package (source-kind contract as on
 * the service method): npm @latest reinstall / git-cache fetch+reset /
 * git-URL re-resolve, each with the quality gate and rollback. ctx-free —
 * usable from the dshpm CLI without a live host.
 */
export async function updateProtected(profile: string, name: string): Promise<CommandResult> {
  const dir = profileDir(profile)
  if (!existsSync(dir)) return { ok: false, exitCode: 1, output: 'profile not found: ' + profile }
  const manifest = readManifest(dir) as { dependencies?: Record<string, string> }
  const source = manifest.dependencies?.[name]
  if (source === undefined) {
    return { ok: false, exitCode: 1, output: name + ' is not a dependency of ' + profile }
  }
  const before = readBundles(profile)
  const local = parseLocalSource(source)
  if (local !== null && isGitRepo(local)) {
    // Git-cache update: fetch + hard reset the cache to its remote ref.
    const updated = await gitPullToRemote(local)
    if (!updated.ok) {
      return { ok: false, exitCode: 1, output: '[plugin-manager] git update failed: ' + updated.message }
    }
    const result = await runDshPlugin(profile, 'add', [local], process.cwd())
    if (!result.ok) return result
    restoreInBoxBundles(profile, before)
    const issues = qualityIssues(profile, name)
    if (issues.length > 0) {
      await runDshPlugin(profile, 'remove', [name], process.cwd())
      restoreInBoxBundles(profile, before)
      return {
        ok: false,
        exitCode: 1,
        output: result.output + '\n[plugin-manager] QUALITY CHECK FAILED after update:'
          + issues.map(issue => '\n  - ' + issue).join('')
          + '\n[plugin-manager] rolled back to the previous version.',
      }
    }
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
  const spec = isGitSourceSpec(source) ? source : name + '@latest'
  // Previous version captured for the rollback: a failed self-update must
  // restore the old code, never uninstall the package (the manager itself
  // would otherwise disappear from the profile).
  const previousVersion = readPackageInfo(dir, name).version
  const result = await runDshPlugin(profile, 'add', [spec], process.cwd())
  if (!result.ok) return result
  restoreInBoxBundles(profile, before)
  const installed = resolveInstalledName(profile, name)
  if (installed === null) return { ...result, installed: [name] }
  const issues = qualityIssues(profile, installed)
  if (issues.length > 0) {
    let restored = false
    if (previousVersion !== undefined) {
      const reAdd = await runDshPlugin(profile, 'add', [name + '@' + previousVersion], process.cwd())
      restored = reAdd.ok
    }
    if (!restored) await runDshPlugin(profile, 'remove', [installed], process.cwd())
    restoreInBoxBundles(profile, before)
    return {
      ok: false,
      exitCode: 1,
      output: result.output + '\n[plugin-manager] QUALITY CHECK FAILED after update:'
        + issues.map(issue => '\n  - ' + issue).join('')
        + '\n[plugin-manager] rolled back to the previous version'
        + (restored && previousVersion !== undefined ? ' (' + previousVersion + ')' : ' — reinstall the package manually'),
    }
  }
  return {
    ok: true,
    exitCode: 0,
    output: result.output + '\n[plugin-manager] ' + name + ' updated'
      + (isGitSourceSpec(source) ? ' from its git source' : ' to @latest')
      + '; restart the profile to load the new code.',
  }
}

/**
 * Specifiers the loader provides without the plugin declaring them: the
 * client platform table plus the host-side cordis basics the profile
 * bundles mount. Anything else a plugin imports must be in its manifest.
 * The @deepseek-ai/dsh-client-* and @deepseek-ai/cordis-plugin-* families
 * are platform packages (matched by prefix so the whitelist cannot drift
 * from the web-app client table).
 */
const LOADER_PROVIDED = new Set([
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/cordis-plugin-loader', '@deepseek-ai/cordis-plugin-include',
  '@deepseek-ai/cordis-plugin-group', '@deepseek-ai/cordis-plugin-hmr',
  '@deepseek-ai/cordis-plugin-timer',
  '@deepseek-ai/dsh-client-web-react',
])

/** Whether the loader/platform provides a specifier without declaration. */
function isLoaderProvided(spec: string): boolean {
  return LOADER_PROVIDED.has(spec)
    || spec.startsWith('@deepseek-ai/dsh-client-')
    || spec.startsWith('@deepseek-ai/cordis-plugin-')
}

// scanImports / scanPackageImports live in src/analyze.ts (shared with the
// health-check engine so the gate and the analysis never drift).

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
    if (dep.startsWith('@deepseek-ai/') && officialClosure.has(dep)) {
      issues.push("declares official package " + dep + " as a REGULAR dependency: pnpm installs a second copy into "
        + "the profile and the loader resolves the official row to it, splitting module identity (runtime failures "
        + "like 'Cannot read properties of undefined (reading \'prepare\')'). Declare it as a peerDependency instead "
        + "(the profile falls through to the installation's shared copy), or drop the declaration.")
    }
  }
  // Scan the WHOLE load chain (entry + every file reachable through relative
  // imports): an undeclared import one hop down fails at boot exactly like
  // one in the entry.
  const imports = scanPackageImports(pkgDir, entry)
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
function officialFallbackNames(profile: string): Set<string> {
  return scanNodeModulesNames(join(dirname(profileDir(profile)), 'node_modules'))
}

/** Row module names in a bundle's own cordis.patch.yml (best-effort parse). */
function readBundleRows(patchFile: string): string[] {
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

/** Whether a bare specifier resolves inside a profile's node_modules. */
function bareSpecifierResolves(profileDirPath: string, spec: string): boolean {
  const roots = [join(profileDirPath, 'node_modules'), join(profileDirPath, '..', 'node_modules')]
  for (const root of roots) {
    try {
      if (existsSync(join(root, spec))) return true
      // Scoped subpath (pkg/sub) — the package itself is the provider.
      if (spec.includes('/') && spec.startsWith('@')) {
        const parts = spec.split('/')
        if (existsSync(join(root, parts[0]!, parts[1]!))) return true
      }
    } catch { /* keep probing */ }
  }
  return false
}
/** One live dsh instance found by process scan. */
interface RunInfo {
  readonly port: number | null
  /** The real instance process (the node process running dsh). */
  readonly pid: number
  /** Launcher processes hosting the instance (terminal cmd/bash windows). */
  readonly launchers: readonly number[]
}

/**
 * Windows process table as "pid<TAB>command line" lines (powershell +
 * CIM). The command line contains the full node/dsh paths and the
 * --profile/--port flags, so the shared parser below works unchanged.
 */
function windowsProcessLines(): string[] {
  try {
    const script = [
      'Get-CimInstance Win32_Process',
      "| Where-Object { $_.CommandLine -and $_.CommandLine -match 'dsh' }",
      '| ForEach-Object { $_.ProcessId.ToString() + [char]9 + $_.CommandLine }',
    ].join(' ')
    const output = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout: 15_000,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    })
    return output.split(/\r?\n/)
  } catch {
    return []
  }
}

function scanRuns(): Map<string, RunInfo> {
  // Collect every match per profile, then resolve the primary process: the
  // real node process when present (a .cmd/.bat shim or bash wrapper is only
  // its launcher — killing the wrapper alone would orphan the instance),
  // preferring the entry carrying a --port, as before.
  const byProfile = new Map<string, Array<{ port: number | null; pid: number; node: boolean }>>()
  try {
    const output = process.platform === 'win32'
      ? windowsProcessLines()
      : execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' }).split('\n')
    for (const line of output) {
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
      // A line naming node or a .js script is the real instance; a bare shim
      // (dsh.cmd / bash wrapper) is only its launcher.
      const node = /\bnode(?:\.exe)?\b|\b[\w-]+\.js\b/.test(line)
      const list = byProfile.get(profile)
      if (list === undefined) byProfile.set(profile, [{ port, pid, node }])
      else list.push({ port, pid, node })
    }
  } catch {
    /* ps/powershell unavailable: no runs reported */
  }
  const out = new Map<string, RunInfo>()
  for (const [name, matches] of byProfile) {
    const withPort = matches.filter(match => match.port !== null)
    // The primary is a real node process — prefer the one explicitly started
    // with --port (the plugin's own spawns) over a port-less default instance
    // (`dsh web`): stopping the wrong one would take down a profile the user
    // may not have started from this page.
    const node = matches.find(match => match.node && match.port !== null)
      ?? matches.find(match => match.node)
    const primary = node ?? withPort[0] ?? matches[0]!
    const port = primary.port ?? (withPort[0]?.port ?? null)
    out.set(name, {
      port,
      pid: primary.pid,
      // A launcher is only ever a shim/wrapper process (cmd/bash), never
      // another real node instance — killing that would stop a second,
      // independently running instance of the same profile.
      launchers: matches
        .filter(match => match.pid !== primary.pid && !match.node)
        .map(match => match.pid),
    })
  }
  return out
}
/** Result of trying to open a terminal window. */
interface TerminalOpen {
  readonly opened: boolean
  readonly terminal?: string
  readonly command?: string
}

/**
 * Prepend the tool directories the host relies on (the resolved dsh dir when
 * it was found outside PATH, plus the running node's dir) to PATH inside a
 * POSIX terminal command. Mirrors the Windows shim-dir injection: without
 * it, a terminal's bash may not have nvm loaded and `dsh`/node fail with
 * "command not found" — the instance never starts.
 */
function commandWithPath(command: string): string {
  const dirs: string[] = []
  const tool = resolveCommand('dsh')
  if (tool.dir !== null) dirs.push(tool.dir)
  const nodeDir = dirname(process.execPath)
  if (nodeDir !== tool.dir) dirs.push(nodeDir)
  const seen = new Set<string>()
  const unique = dirs.filter(dir => (seen.has(dir) ? false : (seen.add(dir), true)))
  if (unique.length === 0) return command
  return 'export PATH=' + JSON.stringify(unique.join(delimiter) + delimiter + '$PATH') + '; ' + command
}

/**
 * Open a visible terminal window running `command`. The instance then lives
 * and dies with that terminal session — the window keeps the instance in
 * plain sight so the user never forgets a process is running. Linux probes
 * common emulators; macOS uses Terminal.app via osascript; Windows opens a
 * cmd window. Returns opened=false when nothing is available.
 */
async function openInTerminal(command: string): Promise<TerminalOpen> {
  if (process.platform === 'darwin') {
    const final = commandWithPath(command)
    spawn('osascript', ['-e', 'tell application "Terminal" to do script "' + final.replace(/"/g, '\\"') + '"'], { stdio: 'ignore' }).unref()
    return { opened: true, terminal: 'Terminal.app', command: final }
  }
  if (process.platform === 'win32') {
    // A visible cmd window runs the command (`cmd /k` keeps it open).
    // Two compatibility fixes for the "a cmd window suddenly appears"
    // reports: windowsHide suppresses the intermediate `start` launcher
    // window (only the real window shows), and the dsh shim directory is
    // prepended to PATH so `dsh` resolves inside the new window even when
    // it is not on the user's PATH (otherwise the window opens with
    // "'dsh' is not recognized" and the instance never starts).
    const dshShim = resolveCommand('dsh')
    const env = { ...process.env }
    if (dshShim.command !== 'dsh' && dshShim.command !== 'dsh.cmd') {
      env.PATH = dirname(dshShim.command) + (env.PATH !== undefined && env.PATH.length > 0 ? delimiter + env.PATH : '')
    }
    spawn('cmd', ['/c', 'start', '', 'cmd', '/k', command], { stdio: 'ignore', windowsHide: true, env }).unref()
    return { opened: true, terminal: 'cmd', command }
  }
  // The user's explicit choice, then the system default terminal selector
  // (x-terminal-emulator / update-alternatives), then common emulators.
  const envTerminal = process.env.TERMINAL?.trim()
  const candidates = [
    ...(envTerminal !== undefined && envTerminal.length > 0 ? [envTerminal.split(/\s+/)[0]!] : []),
    'x-terminal-emulator', 'gnome-terminal', 'konsole', 'xterm', 'kitty', 'alacritty', 'wezterm',
  ]
  const final = commandWithPath(command)
  for (const bin of candidates) {
    if (!hasBinary(bin)) continue
    const argv = terminalArgs(bin, final)
    try {
      spawn(bin, argv, { stdio: 'ignore', windowsHide: true }).unref()
      return { opened: true, terminal: bin, command: final }
    } catch {
      /* try the next emulator */
    }
  }
  return { opened: false }
}

/** Whether a binary exists on PATH (where on Windows, which elsewhere). */
function hasBinary(bin: string): boolean {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [bin], { stdio: 'ignore', windowsHide: true })
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

/** Marketplace snapshot TTL and cache format version. */
const MARKETPLACE_TTL = 24 * 60 * 60 * 1000
const MARKETPLACE_CACHE_VERSION = 2

/**
 * Negative-cache TTL: after a total source failure the failure reason is
 * served from disk instead of re-running the full GitHub round-trip on
 * every page visit (the reason is typically environmental — proxy or
 * network — and will not change within minutes).
 */
const MARKETPLACE_FAILURE_TTL = 5 * 60 * 1000

/** The maintained awesome-dsh-plugins catalog (structured source of truth). */
const CATALOG_OWNER = 'AdamPlatin123'
const CATALOG_REPO = 'awesome-dsh-plugins'
const CATALOG_BRANCH = 'main'
const CATALOG_RAW = `https://raw.githubusercontent.com/${CATALOG_OWNER}/${CATALOG_REPO}/${CATALOG_BRANCH}`
const CATALOG_API = `https://api.github.com/repos/${CATALOG_OWNER}/${CATALOG_REPO}`
const GITHUB_UA = { 'user-agent': 'dsh-web-plugin-manager' }

/** One structured catalog entry (catalog/plugins/<github-id>.json). */
interface CatalogEntry {
  readonly id?: unknown
  readonly repository?: { readonly full_name?: unknown; readonly url?: unknown }
  readonly package?: { readonly name?: unknown; readonly entry?: unknown }
  readonly curation?: { readonly state?: unknown; readonly category?: unknown; readonly description_zh?: unknown }
  readonly lifecycle?: { readonly state?: unknown }
}

/** Derive the marketplace status label from a catalog entry. */
function catalogStatus(entry: CatalogEntry): string {
  const curation = typeof entry.curation?.state === 'string' ? entry.curation.state : ''
  const lifecycle = typeof entry.lifecycle?.state === 'string' ? entry.lifecycle.state : ''
  if (lifecycle === 'archived') return 'archived'
  if (lifecycle === 'deleted') return 'deleted'
  if (curation === 'listed') return '✅ listed'
  if (curation === 'candidate') return '待测'
  return curation.length > 0 ? curation : ''
}

/**
 * Fetch the structured catalog: enumerate catalog/plugins/*.json via the
 * GitHub contents API (one call), honour catalog/tombstones.json, and parse
 * each entry against the published plugin.schema.json shape. Returns an
 * empty array only when nothing usable could be read.
 */
async function fetchCatalogItems(): Promise<MarketplaceItem[]> {
  const listingResponse = await marketplaceFetch(CATALOG_API + '/contents/catalog/plugins?per_page=100', { headers: GITHUB_UA })
  if (!listingResponse.ok) throw new Error('catalog listing HTTP ' + listingResponse.status)
  const listing = await listingResponse.json() as Array<{ name?: unknown; download_url?: unknown }>
  const files = listing.filter((entry): entry is { name: string; download_url: string } =>
    typeof entry.name === 'string' && entry.name.endsWith('.json') && typeof entry.download_url === 'string')
  if (files.length === 0) throw new Error('catalog listing is empty')

  // Tombstoned ids are blocked from reappearing (policy.readd_policy).
  const tombstoned = new Set<string>()
  try {
    const tombResponse = await marketplaceFetch(CATALOG_RAW + '/catalog/tombstones.json', { headers: GITHUB_UA })
    if (tombResponse.ok) {
      const tomb = await tombResponse.json() as { entries?: unknown }
      if (Array.isArray(tomb.entries)) {
        for (const entry of tomb.entries) {
          const id = typeof entry === 'string' ? entry : (entry as { id?: unknown }).id
          if (typeof id === 'string') tombstoned.add(id)
        }
      }
    }
  } catch { /* tombstones are advisory */ }

  const seen = new Map<string, MarketplaceItem>()
  for (const file of files) {
    try {
      const response = await marketplaceFetch(file.download_url, { headers: GITHUB_UA })
      if (!response.ok) continue
      const entry = await response.json() as CatalogEntry
      const id = typeof entry.id === 'string' ? entry.id : ''
      if (id.length > 0 && tombstoned.has(id)) continue
      const curation = typeof entry.curation?.state === 'string' ? entry.curation.state : ''
      if (curation === 'rejected' || curation === 'removed' || curation === 'blocked') continue
      const lifecycle = typeof entry.lifecycle?.state === 'string' ? entry.lifecycle.state : ''
      if (lifecycle === 'deleted') continue
      const fullName = typeof entry.repository?.full_name === 'string' ? entry.repository.full_name : ''
      const url = typeof entry.repository?.url === 'string' ? entry.repository.url : ''
      if (fullName.length === 0 || url.length === 0) continue
      if (fullName.startsWith('deepseek-ai/')) continue
      const packageName = typeof entry.package?.name === 'string' ? entry.package.name : ''
      const category = typeof entry.curation?.category === 'string' ? entry.curation.category : ''
      const description = typeof entry.curation?.description_zh === 'string' ? entry.curation.description_zh : ''
      const status = catalogStatus(entry)
      const item: MarketplaceItem = {
        name: fullName,
        displayName: fullName.split('/').pop() ?? fullName,
        ...(description.length > 0 ? { description } : {}),
        stars: 0,
        updatedAt: '',
        createdAt: '',
        url,
        status,
        ...(packageName.length > 0 ? { packageName } : {}),
        ...(category.length > 0 ? { category } : {}),
        ...(lifecycle.length > 0 ? { lifecycle } : {}),
      }
      // Deduplicate by repository; a verified listing wins over a candidate.
      const existing = seen.get(fullName)
      const verified = (value: MarketplaceItem | undefined): boolean => (value?.status ?? '').includes('✅')
      if (existing === undefined || (verified(item) && !verified(existing))) {
        seen.set(fullName, item)
      }
    } catch { /* skip one broken entry */ }
  }
  if (seen.size === 0) throw new Error('no usable entries parsed from the catalog')
  return [...seen.values()]
}

/**
 * Fallback source: parse the human-curated PLUGINS.md table
 * (| name | [org/repo](url) | description | status |), tracking the current
 * category section and deduplicating by repository (✅ wins over 待测).
 */
async function fetchMarkdownItems(): Promise<MarketplaceItem[]> {
  const mdResponse = await marketplaceFetch(CATALOG_RAW + '/PLUGINS.md', { headers: GITHUB_UA })
  if (!mdResponse.ok) throw new Error('catalog fetch HTTP ' + mdResponse.status)
  const markdown = await mdResponse.text()
  const rows: Array<{ fullName: string; description: string; status: string; category: string }> = []
  let category = ''
  for (const line of markdown.split('\n')) {
    const section = /^##\s+(.*)$/.exec(line)
    if (section !== null) {
      // Strip the leading category emoji (🔌 / 🧰 / 🎓 / …).
      category = section[1]!.trim().replace(/^\S+\s*/, '')
      continue
    }
    const match = /^\|\s*([^|]+?)\s*\|\s*\[([^|]+?)\]\(https?:\/\/github\.com\/([^/)]+\/[^/)]+)\)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|/.exec(line)
    if (match === null) continue
    const fullName = match[3]!.trim()
    if (fullName.length === 0 || fullName.startsWith('deepseek-ai/')) continue
    rows.push({
      fullName,
      description: match[4]!.trim(),
      status: match[5]!.trim(),
      category,
    })
  }
  if (rows.length === 0) throw new Error('no rows parsed from PLUGINS.md')
  const byName = new Map<string, { description: string; status: string; category: string }>()
  const score = (status: string): number => status.includes('✅') ? 2 : status.includes('已测') ? 1 : 0
  for (const row of rows) {
    const existing = byName.get(row.fullName)
    if (existing === undefined || score(row.status) > score(existing.status)) {
      byName.set(row.fullName, row)
    }
  }
  return [...byName.entries()].map(([fullName, row]) => ({
    name: fullName,
    displayName: fullName.split('/').pop() ?? fullName,
    ...(row.description.length > 0 ? { description: row.description } : {}),
    stars: 0,
    updatedAt: '',
    createdAt: '',
    url: 'https://github.com/' + fullName,
    status: row.status,
    ...(row.category.length > 0 ? { category: row.category } : {}),
  }))
}

/**
 * Merge the two sources into one listing: catalog entries keep their
 * structure (package name, lifecycle) and are enriched with the curated
 * description / evidence status / category from PLUGINS.md when present;
 * PLUGINS.md-only repositories are appended. Deduplication is by repository.
 */
function mergeMarketplace(catalog: readonly MarketplaceItem[], markdown: readonly MarketplaceItem[]): MarketplaceItem[] {
  const mdBy = new Map(markdown.map(item => [item.name, item]))
  const out: MarketplaceItem[] = []
  const seen = new Set<string>()
  for (const item of catalog) {
    const md = mdBy.get(item.name)
    out.push(md !== undefined ? {
      ...item,
      ...(item.description === undefined && md.description !== undefined ? { description: md.description } : {}),
      // A verified evidence status wins over a plain auto-discovered candidate.
      ...((item.status === undefined || item.status.length === 0 || item.status === '待测') && md.status !== undefined ? { status: md.status } : {}),
      ...(item.category === undefined && md.category !== undefined ? { category: md.category } : {}),
    } : item)
    seen.add(item.name)
  }
  for (const item of markdown) {
    if (!seen.has(item.name)) out.push(item)
  }
  return out
}

/**
 * Enrich items with GitHub repository metadata (stars/dates). Unauthenticated
 * API quota is 60/h: on 403/429 enrichment stops and the remaining items
 * reuse metadata from the previous snapshot (zeros when unknown) — the list
 * itself is never dropped because of a rate limit.
 */
async function enrichRepos(items: MarketplaceItem[], prior: Map<string, MarketplaceItem>): Promise<MarketplaceItem[]> {
  let rateLimited = false
  const out: MarketplaceItem[] = []
  for (const item of items) {
    if (rateLimited) {
      const prev = prior.get(item.name)
      out.push(prev !== undefined
        ? { ...item, stars: prev.stars, updatedAt: prev.updatedAt, createdAt: prev.createdAt }
        : item)
      continue
    }
    try {
      const response = await marketplaceFetch('https://api.github.com/repos/' + item.name, { headers: GITHUB_UA })
      if (response.status === 403 || response.status === 429) {
        rateLimited = true
        const prev = prior.get(item.name)
        out.push(prev !== undefined
          ? { ...item, stars: prev.stars, updatedAt: prev.updatedAt, createdAt: prev.createdAt }
          : item)
        continue
      }
      if (response.ok) {
        const repo = await response.json() as { stargazers_count?: unknown; updated_at?: unknown; created_at?: unknown }
        out.push({
          ...item,
          stars: typeof repo.stargazers_count === 'number' ? repo.stargazers_count : 0,
          updatedAt: typeof repo.updated_at === 'string' ? repo.updated_at : '',
          createdAt: typeof repo.created_at === 'string' ? repo.created_at : '',
        })
      } else {
        out.push(item)
      }
    } catch {
      out.push(item)
    }
  }
  return out
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

/** One live loader row's observable state (for runtime diagnostics). */
interface LiveRowState {
  readonly entryId: string
  readonly moduleName: string
  readonly enabled: boolean
  readonly phase: RuntimeEntry['fiberPhase']
  readonly error?: string
}

/** Read the live include-tree rows with their fiber states and errors. */
function liveRowStates(ctx: Context): LiveRowState[] {
  const loader = ctx.get('loader') as { entries(): Iterable<RowEntryLike> } | undefined
  if (loader === undefined) return []
  for (const entry of loader.entries()) {
    if (entry.id !== 'include') continue
    const out: LiveRowState[] = []
    for (const row of entry.subtree?.entries() ?? []) {
      const options = row.options
      if (options === undefined || options.id === undefined || options.group) continue
      let error: string | undefined
      try {
        const fiberError = (row.fiber as { _error?: { message?: unknown } } | undefined)?._error
        if (fiberError?.message !== undefined && typeof fiberError.message === 'string') error = fiberError.message
      } catch { /* error extraction is best-effort */ }
      out.push({
        entryId: options.id,
        moduleName: options.name ?? '',
        enabled: !row.disabled,
        phase: phaseOf(row.fiber?.state),
        ...(error !== undefined ? { error } : {}),
      })
    }
    return out
  }
  return []
}

/**
 * Offline entry view for profiles that are not running: the bundle layer
 * stack and the managed insert rows, all configured-but-not-live. The live
 * loader tree cannot be used for them (it belongs to the running profile).
 * Official in-box bundles (base/web-app/headless) are NOT user-installed
 * plugins — the catalog's "installed" filter must not show them.
 */
function offlineEntries(bundles: readonly string[], insertRows: readonly InsertRow[]): RuntimeEntry[] {
  const out: RuntimeEntry[] = bundles.map((bundle) => ({
    entryId: bundle,
    moduleName: bundle,
    enabled: true,
    fiberPhase: null,
    installed: !(IN_BOX_BUNDLES as readonly string[]).includes(bundle),
    modified: false,
    unmounted: false,
  }))
  for (const row of insertRows) {
    out.push({
      entryId: row.id,
      moduleName: row.name,
      enabled: true,
      fiberPhase: null,
      installed: true,
      modified: row.managed,
      unmounted: false,
    })
  }
  return out
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
        unmounted: false,
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
function cleanupInsertRows(ctx: Context | null, profile: string, packageName: string): void {
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
    if (ops.length > 0 && ctx !== null && profile === hostProfileName()) void applyLiveOps(ctx, ops)
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

/**
 * The name of the profile hosting this running instance, or null when it
 * cannot be determined safely.
 *
 * Sources, in order:
 *   1. the --profile <name> flag in the launch argv (explicit, official);
 *   2. the subcommand form (dsh web / dsh headless) - searched ONLY past
 *      argv[0..1] (node executable + script path): an nvm/volta install
 *      makes the script a symlink named dsh, so argv[1] is the binary's
 *      own path; scanning the whole argv would take it as the profile name
 *      and crash the boot with an unsafe-profile-name error (issue #1);
 *   3. the plugin's own install location (<profile>/node_modules/
 *      dsh-web-plugin-manager, npm/yarn layouts) as a last resort.
 *
 * Any candidate that is not a safe profile name yields null - the caller
 * (apply) treats null as "no host", never crashing the plugin tree.
 */
function hostProfileName(): string | null {
  try {
    const argv = process.argv
    const flagIndex = argv.indexOf('--profile')
    if (flagIndex >= 0 && argv[flagIndex + 1] !== undefined) {
      const flagged = argv[flagIndex + 1]!
      return isSafeProfileName(flagged) ? flagged : null
    }
    // dsh web / dsh headless command mode (no --profile flag): only the
    // args after the node executable and the script path are candidates.
    const candidate = argv.slice(2).find(arg => !arg.startsWith('-') && !arg.endsWith('bin.js') && !arg.includes('node'))
    if (candidate !== undefined && isSafeProfileName(candidate)) return candidate
    // Last resort: derive the hosting profile from the install location
    // (npm/yarn keep <profile>/node_modules/<pkg>; pnpm/link installs
    // resolve elsewhere and simply yield null here).
    return locationProfileName()
  } catch {
    return null
  }
}

/**
 * Derive the hosting profile from the plugin's module location: the first
 * ancestor directory whose package.json is named dsh-profile-<basename>
 * (the official and createProfile naming). null when not found (pnpm and
 * link: installs resolve outside the profile tree).
 */
function locationProfileName(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 10; depth += 1) {
    if (isSafeProfileName(basename(dir))) {
      try {
        const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: unknown }
        if (manifest.name === 'dsh-profile-' + basename(dir)) return basename(dir)
      } catch { /* not a manifest level: keep walking */ }
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  return null
}

/** Whether a profile hosts the running plugin-manager (its dependency). */
function isHostProfile(name: string): boolean {
  // The profile hosting this running instance — renaming or removing it would
  // break the live process. Other profiles that merely install the plugin
  // (e.g. via copyPlugins) remain manageable.
  return hostProfileName() === name
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
          sendJson(res, 200, { ok: true, value: await service.setEnabled(profile, entryId, enabled) })
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
          sendJson(res, 200, { ok: true, value: await service.removeInsert(profile, rowId) })
          return
        }
        case 'checkUpdates': {
          const profile = typeof body['profile'] === 'string' ? body['profile'] : ''
          sendJson(res, 200, { ok: true, value: await service.checkUpdates(profile) })
          return
        }
        case 'analyze': {
          const profile = typeof body['profile'] === 'string' ? body['profile'] : ''
          sendJson(res, 200, { ok: true, value: service.analyze(profile) })
          return
        }
        case 'update': {
          const profile = typeof body['profile'] === 'string' ? body['profile'] : ''
          const name = typeof body['name'] === 'string' ? body['name'] : ''
          sendJson(res, 200, { ok: true, value: await service.update(profile, name) })
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
  for (const op of ['listProfiles', 'list', 'setEnabled', 'install', 'remove', 'removeInsert', 'mount', 'createProfile', 'renameProfile', 'removeProfile', 'copyPlugins', 'startProfile', 'stopProfile', 'marketplace', 'checkUpdates', 'update', 'analyze']) {
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
  // Plugin-owned watcher for the running profile's patch file: manual edits
  // keep applying live even after a toggle unloads the platform HMR service
  // (its own patch watcher is an effect of HMR and does not come back).
  const host = hostProfileName()
  if (host !== null) {
    ensurePatchWatcher(ctx, patchPath(profileDir(host)))
  }
  // webServer is a sibling include-group row; ctx.inject waits for it like
  // the official agent-tool-presentation waits for codeRuntime.
  ctx.inject(['webServer'], (webCtx: Context) => {
    webCtx.effect(() => {
      const disposers = registerRoutes(webCtx, service)
      return () => { for (const dispose of disposers) dispose() }
    }, 'dsh-web-plugin-manager: routes')
  })
  // V2-E: agent tools + install guard, when the host provides the tools
  // service (web profiles do; headless may not — inject simply never fires).
  // The guard denies raw dsh plugin/pnpm mutations from the agent so every
  // install goes through the protected flow (quality gate + rollback).
  ctx.inject(['tools'], (toolsCtx: Context) => {
    toolsCtx.effect(() => {
      const disposers = registerTools(toolsCtx, service, config.profile)
      const guardDisposer = registerPluginGuard(toolsCtx)
      if (guardDisposer !== null) disposers.push(guardDisposer)
      return () => { for (const dispose of disposers) dispose() }
    }, 'dsh-web-plugin-manager: tools')
  })
  // V2-E: the install-rule prompt section, so the model prefers the
  // protected surface before it attempts the raw path.
  ctx.inject(['systemPrompt'], (promptCtx: Context) => {
    promptCtx.effect(() => {
      const sectionDisposer = registerPluginRulePrompt(promptCtx)
      return () => { if (sectionDisposer !== null) sectionDisposer() }
    }, 'dsh-web-plugin-manager: prompt rule')
  })
}

// Function-plugin form: no default export (mixing forms makes the Loader
// discard the named apply). The service class is instantiated inside apply.