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
import { isBuiltin } from 'node:module'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { Context, Service } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import z from '@deepseek-ai/schemastery'
import type {
  BackupDiffEntry, BackupDiffResult, BackupFile, BackupProfile, CommandResult, InsertRow, KindListView, ManagedPackage,
  MarketplaceItem, MarketplaceResult, MutationResult, PluginManagerSnapshot, ProfileInfo, RuntimeEntry, StartResult,
  UpdateCheckResult, UpdateInfo,
} from './types.ts'
import {
  addDisableBlock, addInsertRow, applyRowDisabled, applyRowEnabled,
  hasManagedDisable, readInsertRows, readManagedIds, removeDisableBlock,
  removeInsertRow, writePatch,
} from './patch.ts'
import { analyzeProfile, OFFICIAL_DEP_ALLOWED, scanImports, scanNodeModulesNames, scanPackageImports } from './analyze.ts'
import type { AnalyzeIssue, AnalyzeResult } from './types.ts'
import { applyLiveOps, closePatchWatcher, ensurePatchWatcher, type StackOp } from './live.ts'
import { registerPluginGuard, registerPluginRulePrompt } from './guard.ts'
import {
  addBlockedRepo, detectRepoType, installPreset, installSkill, isUnderRoot, loadBlockedRepos,
  loadKindRecords, looksLikeDshPlugin, normalizeRepoRef, presetsDirPath, pruneGhostRecords, removeBlockedRepo, removeKindRecord,
  renameRetry, rmRetry, saveKindRecord, skillsDirPath, slugDirName, type KindRecord,
} from './kinds.ts'
import {
  agentPresetsOf, archiveOwnedPresets, cleanupOwnedPresets, formatArchiveResult, formatCleanupResult, formatRestoreResult,
  pluginInstalledInOtherProfiles, restoreArchivedPresets,
} from './presets.ts'
import { marketplaceFetch } from './net.ts'
import { compareVersions, isGitSourceSpec, updateSpec } from './match.ts'
import { isTrustedRequest, readJsonBody } from './rest.ts'
import {
  fetchDshSoIndex, fetchRegistryRepos, fetchSearchFallback, functionalTopics, readRegistryCache, writeRegistryCache,
  type DshSoEntry, type RegistryRepo,
} from './registry.ts'
import { registerTools } from './tools.ts'
import { buildFilteredEnv, scanRequirements } from './scan.ts'
import { createInstallSession, dropInstallSession, filterAnswers, getInstallSession } from './installSession.ts'


import {
  dshHome, hostProfileName, isHostProfile, isOfficialProfile, isSafeProfileName,
  OFFICIAL_PROFILES, patchPath, profileDir, readBundles, readManifest, readPatch, slugify,
  enqueueMutation, OUR_PACKAGE_NAME,
} from './paths.ts'
import { commandEnv, execFileTimeout, resolveCommand, resolveExec, runDshPlugin } from './childproc.ts'
import {
  findFreePort, hasBinary, IN_BOX_BUNDLES, openInTerminal, PATCH_TEMPLATE, pidAlive,
  PNPM_WORKSPACE_TEMPLATE, probePort, restoreInBoxBundles,
  scanRunsCached, type RunInfo, type TerminalOpen,
} from './profiles.ts'
import {
  beginMarketplaceRefresh, blockedMeta, buildInstalledIndex, dedupeMarketplace, dirNameSet,
  enrichRepos, fetchCatalogItems, fetchMarkdownItems, filterBlockedRepos, flagMarketplaceItems,
  gitCacheIdentity, MARKETPLACE_CACHE_VERSION, MARKETPLACE_FAILURE_TTL, MARKETPLACE_TTL,
  mergeMarketplace, mergeRegistryWithCurated, overlayDshSo, readMemoryCache, registryToItem,
  writeMemoryCache,
} from './marketplaceMerge.ts'
import {
  acceptLanguageLocale, checkPackageUpdate, gitCommitFromLock, gitPullToRemote, gitRemoteState,
  gitSpecFromCache, installProtected, installWithSource, installWithSourceInner, isGitCloneSpec,
  isGitRepo, npmLatestVersion, parseLocalSource, readPackageInfo, removeProtected,
  removeProtectedInner, resolveInstalledName, toGitSpec, updateProtected,
} from './installFlow.ts'

// Public API surface (the dshpm CLI imports these from index; the git-source
// tests import toGitSpec/gitCommitFromLock from dist/index.js).
export { OUR_PACKAGE_NAME } from './paths.ts'
export {
  installProtected, installWithSource, removeProtected, toGitSpec, updateProtected,
  gitCommitFromLock,
} from './installFlow.ts'

export type * from './types.ts'

/** Route prefix for the REST surface. */
export const ROUTE_PREFIX = '/api2/plugin-manager'



/** Management service (also registered as ctx.pluginManager for host peers). */
export class PluginManagerService extends Service {
  static inject = ['loader']

  constructor(ctx: Context) {
    super(ctx, 'pluginManager')
  }

  /** List every profile under $DSH_HOME/profiles (directories with package.json). */
  listProfiles(): ProfileInfo[] {
    const root = join(dshHome(), 'profiles')
    const runs = scanRunsCached()
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
      renameRetry(oldDir, newDir)
      return { ok: true, message: "renamed " + oldName + " to " + newName }
    } catch (error: unknown) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Delete a custom profile directory (never the hosting profile). */
  removeProfile(name: string): MutationResult {
    if (!isSafeProfileName(name)) return { ok: false, message: "invalid profile name: " + JSON.stringify(name) }
    if (isOfficialProfile(name)) return { ok: false, message: "official profiles (web/headless) are not managed here" }
    const dir = profileDir(name)
    if (!existsSync(dir)) return { ok: false, message: "profile not found: " + name }
    if (isHostProfile(name)) return { ok: false, message: "cannot remove the running profile (" + name + ")" }
    try {
      rmRetry(dir)
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
    // Cached scan (3s TTL): this guard does not need a fresh process table —
    // a full scan stalls the event loop for seconds on Windows (powershell
    // CIM query), and an externally started instance becomes visible at most
    // one TTL later.
    const running = scanRunsCached().get(name)
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
        const exec = resolveExec(tool, ['--profile', name, '--port', String(port)])
        const child = spawn(exec.command, exec.args, {
          cwd: process.cwd(),
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
          env: commandEnv(tool.dir),
          ...(exec.verbatim ? { windowsVerbatimArguments: true } : {}),
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
   * Sources, in order of value:
   *   1. the static registry index (topic:dsh-plugin, ~3000 repos, CI-built,
   *      zero API calls) — fetched through a multi-source fallback chain
   *      (src/registry.ts) with a local disk cache;
   *   2. the curated awesome-dsh-plugins catalog (status / packageName /
   *      curated description) — overlaid onto registry entries, with its
   *      own-only entries appended;
   *   3. PLUGINS.md (legacy curated table) — merged into the catalog layer;
   *   4. GitHub search API — only when every index source is unusable
   *      (partial by design, never persisted).
   *
   * Caching: a 24h disk cache (merged items, profile-independent) plus an
   * in-process mirror so profile switches (which only recompute installed
   * flags) never re-read the ~1.7MB file; a 5-minute negative cache records
   * total source failure; the search fallback never persists. refresh=1 is
   * the only way to force a network round-trip.
   *
   * Installed flags are computed server-side per request for the queried
   * profile (package-name / repository / git-cache / skills+presets probing),
   * so "installed" is correct even for plugins installed before the manager.
   */
  /**
   * Marketplace listing. Concurrent refreshes are serialized: the source
   * walk + cache write is last-write-wins, and parallel walks would let an
   * older response overwrite a newer one (audit M13).
   */
  async marketplace(profile: string, refresh: boolean): Promise<MarketplaceResult> {
    if (refresh) {
      const gate = beginMarketplaceRefresh()
      await gate.previous
      try {
        return await this.marketplaceInner(profile, true)
      } finally {
        gate.release()
      }
    }
    return this.marketplaceInner(profile, false)
  }

  private async marketplaceInner(profile: string, refresh: boolean): Promise<MarketplaceResult> {
    const cacheDir = join(dshHome(), 'plugin-manager-cache')
    const cachePath = join(cacheDir, 'marketplace.json')
    const failurePath = join(cacheDir, 'marketplace-failure.json')
    mkdirSync(cacheDir, { recursive: true })
    const readCache = (): { fetchedAt?: string; items: MarketplaceItem[]; source?: string } => {
      // In-process mirror first: the listing is profile-independent, so
      // profile switches (flag recomputation) skip the disk read entirely.
      const memory = readMemoryCache()
      if (memory !== null) {
        return {
          fetchedAt: new Date(memory.at).toISOString(),
          items: memory.items,
          source: memory.source,
        }
      }
      try {
        const cached = JSON.parse(readFileSync(cachePath, 'utf8')) as { version?: unknown; fetchedAt?: unknown; items?: unknown; source?: unknown }
        // Cache format changed (item shape / source layout): ignore old files.
        if (cached.version !== MARKETPLACE_CACHE_VERSION) return { items: [] }
        const fetchedAt = typeof cached.fetchedAt === 'string' ? cached.fetchedAt : ''
        const items = Array.isArray(cached.items) ? cached.items as MarketplaceItem[] : []
        const source = typeof cached.source === 'string' ? cached.source : undefined
        return { fetchedAt, items, source }
      } catch { /* no/ broken cache */ }
      return { items: [] }
    }
    const writeCache = (items: MarketplaceItem[], source: string): void => {
      writeMemoryCache(items, source)
      // Atomic write (tmp + rename): two concurrent refreshes must not
      // interleave into a truncated file (audit M13).
      const tmpPath = cachePath + '.tmp'
      writeFileSync(tmpPath, JSON.stringify({
        version: MARKETPLACE_CACHE_VERSION,
        fetchedAt: new Date().toISOString(),
        source,
        items,
      }, undefined, 2) + '\n')
      renameSync(tmpPath, cachePath)
      try { rmSync(tmpPath, { force: true }) } catch { /* best-effort */ }
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
    const blocked = await loadBlockedRepos()
    if (!refresh) {
      const cached = readCache()
      const fetchedAt = Date.parse(cached.fetchedAt ?? '')
      if (!Number.isNaN(fetchedAt) && Date.now() - fetchedAt < MARKETPLACE_TTL && cached.items.length > 0) {
        // The cached listing may predate the dsh.so overlay (or the overlay
        // fields were dropped by an older cache version) — overlay from the
        // disk-cached dsh.so index (fast, no network when the TTL holds).
        const dshSo = await fetchDshSoIndex().catch(() => null)
        const items = overlayDshSo(cached.items, dshSo)
        const { items: deduped, dropped } = dedupeMarketplace(await flagMarketplaceItems(filterBlockedRepos(items, blocked), profile))
        return {
          ok: true,
          items: deduped,
          cachedAt: cached.fetchedAt,
          fromCache: true,
          message: 'served from cache',
          ...(cached.source !== undefined ? { source: cached.source } : {}),
          ...(dropped > 0 ? { dropped } : {}),
          ...blockedMeta(blocked),
          total: deduped.length,
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
    // Keep previous metadata (stars/dates) for catalog-only entries when the
    // GitHub API is rate-limited during enrichment.
    const prior = new Map<string, MarketplaceItem>(readCache().items.map(item => [item.name, item]))
    let catalogError: string | null = null
    let markdownError: string | null = null
    // Fetch sources independently and CONCURRENTLY: the registry index, the
    // structured catalog, the legacy PLUGINS.md and the dsh.so overlay
    // complement each other — one failing must not empty the list. Refresh
    // latency becomes the slowest source instead of the sum of all four.
    const [registryFetch, catalogFetch, markdownFetch, dshSo] = await Promise.all([
      fetchRegistryRepos().catch((error: unknown) => {
        console.warn('[plugin-manager] registry index unavailable: ' + (error instanceof Error ? error.message : String(error)))
        return null
      }),
      fetchCatalogItems().catch((error: unknown) => {
        catalogError = error instanceof Error ? error.message : String(error)
        return []
      }),
      fetchMarkdownItems().catch((error: unknown) => {
        markdownError = error instanceof Error ? error.message : String(error)
        return []
      }),
      // dsh.so registry: independent verification (L1–L5) + security scan
      // metadata, overlaid onto matching entries (never an install source).
      fetchDshSoIndex().catch((error: unknown) => {
        console.warn('[plugin-manager] dsh.so index unavailable: ' + (error instanceof Error ? error.message : String(error)))
        return null
      }),
    ])
    const registryItems = registryFetch !== null ? registryFetch.repos : null
    const registryCacheable = registryFetch !== null && registryFetch.cacheable
    const catalogItems = catalogFetch
    const markdownItems = markdownFetch
    const curated = mergeMarketplace(catalogItems, markdownItems)
    // Registry base: network index → disk cache → search fallback (partial,
    // never persisted). The catalog-only path remains when all fail.
    let base: RegistryRepo[] | null = registryItems
    let source: string = 'registry'
    if (base === null) {
      base = readRegistryCache()
      if (base !== null) source = 'cache'
      else {
        base = await fetchSearchFallback()
        if (base !== null) source = 'search'
      }
    } else if (registryCacheable) {
      // Only freshness-verified sources persist (audit M14): an unverified
      // api/raw response must not overwrite a good disk cache.
      writeRegistryCache(base)
    }
    let items: MarketplaceItem[]
    if (base !== null) {
      items = mergeRegistryWithCurated(base, curated)
    } else {
      items = curated
      source = 'catalog'
    }
    items = overlayDshSo(items, dshSo)
    // Registry entries already carry stars/dates — only catalog-only entries
    // (metadata unknown) need GitHub enrichment, so the rate limit is rarely
    // reached even with a 3000-entry listing.
    const unknowns = items.filter(item => item.stars === 0 && item.updatedAt.length === 0)
    if (unknowns.length > 0) {
      const extras = await enrichRepos(unknowns, prior)
      const byName = new Map(extras.map(item => [item.name, item]))
      items = items.map(item => byName.get(item.name) ?? item)
    }
    if (items.length > 0) {
      // Persist only complete listings (registry or catalog); the search
      // fallback is partial and must not downgrade a good cache.
      if (source !== 'search') writeCache(items, source)
      const note = [
        'registry: ' + (registryItems !== null ? 'ok' : 'unavailable'),
        catalogError === null ? 'catalog' : 'catalog unavailable (' + catalogError + ')',
        markdownError === null ? 'PLUGINS.md' : 'PLUGINS.md unavailable (' + markdownError + ')',
      ].join('; ')
      const flagged = await flagMarketplaceItems(filterBlockedRepos(items, blocked), profile)
      const { items: deduped, dropped } = dedupeMarketplace(flagged)
      return {
        ok: true,
        items: deduped,
        fromCache: false,
        message: 'fetched ' + deduped.length + ' plugins (' + note + ')',
        source,
        ...(dropped > 0 ? { dropped } : {}),
        ...blockedMeta(blocked),
        total: deduped.length,
      }
    }
    // Last resort: the on-disk cache (any age — better than an empty list).
    const cached = readCache()
    if (cached.items.length > 0) {
      const dshSo = await fetchDshSoIndex().catch(() => null)
      const { items: flagged, dropped } = dedupeMarketplace(await flagMarketplaceItems(filterBlockedRepos(overlayDshSo(cached.items, dshSo), blocked), profile))
      return {
        ok: true,
        items: flagged,
        cachedAt: cached.fetchedAt,
        fromCache: true,
        message: 'sources unavailable; served from cache: ' + (catalogError ?? markdownError ?? 'unknown'),
        ...(cached.source !== undefined ? { source: cached.source } : {}),
        ...(dropped > 0 ? { dropped } : {}),
        ...blockedMeta(blocked),
        total: flagged.length,
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
        running: scanRunsCached().get(profile) ?? null,
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
    return enqueueMutation(() => this.mountInner(profile, packageName))
  }

  private async mountInner(profile: string, packageName: string): Promise<MutationResult> {
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
    // A managed disable block we wrote when this plugin was disabled is not a
    // user row: drop it first, or readManagedIds misjudges it as user-owned
    // and re-mounting after a disable dies with id collision.
    const cleaned = removeDisableBlock(current, rowId)
    const base = cleaned !== current ? cleaned : current
    // Never clobber an existing row (user-written or another plugin's) that
    // already owns this id — the loader refuses duplicate ids and the whole
    // tree fails.
    const existing = readInsertRows(base).find(row => row.id === rowId && row.name !== packageName)
    const userOwns = readManagedIds(base).has(rowId)
    if (existing !== undefined || userOwns) {
      return {
        ok: false,
        message: 'row id ' + rowId + ' is already used'
          + (existing !== undefined ? ' by ' + existing.name : ' by a user row')
          + ' (id collision — mount under a different id or remove the other row)'
      }
    }
    const next = addInsertRow(base, rowId, packageName)
    if (next === base) return { ok: false, message: packageName + ' is already mounted' }
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
    return enqueueMutation(() => this.setEnabledInner(profile, entryId, enabled))
  }

  private async setEnabledInner(profile: string, entryId: string, enabled: boolean): Promise<MutationResult> {
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
      // Plugin-owned agent presets follow the plugin's liveness: disabling
      // archives the owned presets (moved out of the picker, zero data loss),
      // re-enabling restores them. Only the running profile's live toggle
      // counts — a file-only edit for another profile must not move global
      // presets (the plugin may still be live there).
      const presetNote = await this.presetLifecycleNote(profile, entryId, enabled, live.ok)
      const state = enabled ? 'enabled' : 'disabled'
      return {
        ok: true,
        message: live.ok
          ? `${state} ${entryId} (applied live)` + presetNote
          : `${state} ${entryId} (file updated; ${live.message ?? 'restart to apply'})`,
      }
    } catch (error: unknown) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * Archive (disable) or restore (re-enable) the plugin's owned agent
   * presets for the running profile, returning a summary suffix for the
   * result message. Skips when the row's package cannot be resolved, when
   * another profile still installs the plugin (presets are global), or when
   * the toggle was file-only. Never throws — a failure degrades to a note.
   */
  private async presetLifecycleNote(profile: string, entryId: string, enabled: boolean, liveOk: boolean): Promise<string> {
    if (profile !== hostProfileName() || !liveOk) return ''
    // Resolve the row's package name: the live tree first (bundle/insert
    // rows carry a name), then the patch's insert rows (the persistent mount
    // record — robust against live-tree drift after toggle cycles).
    const liveName = liveRowStates(this.ctx).find(row => row.entryId === entryId)?.moduleName ?? ''
    const moduleName = liveName.length > 0
      ? liveName
      : readInsertRows(readPatch(profileDir(profile))).find(row => row.id === entryId)?.name ?? ''
    if (moduleName.length === 0) return ''
    try {
      if (enabled) {
        const result = restoreArchivedPresets(presetsDirPath(), moduleName)
        const note = formatRestoreResult(moduleName, result)
        return note.length > 0 ? '\n' + note : ''
      }
      if (pluginInstalledInOtherProfiles(profile, moduleName)) {
        return '\n[plugin-manager] preset archive skipped for ' + moduleName + ': still installed in another profile'
      }
      const result = archiveOwnedPresets(presetsDirPath(), moduleName)
      const note = formatArchiveResult(moduleName, result)
      return note.length > 0 ? '\n' + note : ''
    } catch (error) {
      return '\n[plugin-manager] preset lifecycle failed: ' + (error instanceof Error ? error.message : String(error))
    }
  }

  /** Stop a running instance of a custom profile (never the current one). */
  async stopProfile(name: string): Promise<MutationResult> {
    // Cached scan (3s TTL) for the initial lookup: correctness of the stop
    // comes from the pidAlive polling loop below, not from scan freshness —
    // a full process-table scan here would stall the event loop for seconds
    // on Windows before the kill is even attempted.
    const run = scanRunsCached().get(name)
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
      // Wait for the process to exit (up to ~5s). Probed with kill(pid, 0) —
      // a full process-table scan per 400ms tick would block the event loop
      // for seconds in total on Windows (powershell CIM query).
      const deadline = Date.now() + 5_000
      for (;;) {
        if (Date.now() > deadline) break
        await new Promise(resolve => setTimeout(resolve, 400))
        if (!pidAlive(run.pid)) {
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
  async install(profile: string, spec: string, answers?: Record<string, string>, locale?: 'zh' | 'en'): Promise<CommandResult> {
    return installWithSource(this.ctx, profile, spec, answers, locale)
  }

  /**
   * Copy installed plugins from one profile to another (custom-plugin
   * transfer). Each package is reinstalled into the target using its
   * recorded install source (path/git/tarball/name).
   */
  async copyPlugins(fromProfile: string, toProfile: string, names: readonly string[]): Promise<CommandResult> {
    if (!existsSync(profileDir(fromProfile))) return { ok: false, exitCode: 1, output: "source profile not found: " + fromProfile }
    if (!existsSync(profileDir(toProfile))) return { ok: false, exitCode: 1, output: "target profile not found: " + toProfile }
    // The whole transfer runs as ONE mutation: installProtected is not
    // enqueued itself, and a per-package loop outside the mutex would race
    // with concurrent install/remove/update on the target profile — both
    // pnpm manifest snapshots and patch rows would be lost (audit C3).
    return enqueueMutation(async () => {
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
    })
  }

  /** Remove an installed package via dsh plugin (preserving in-box bundles). */
  async remove(profile: string, name: string): Promise<CommandResult> {
    return removeProtected(this.ctx, profile, name)
  }

  /**
   * Kind-install overview for the Skills & Presets page: install records
   * (ghost records pruned) plus the on-disk skill / preset directories
   * (including non-record installs).
   */
  async listKinds(): Promise<KindListView> {
    await pruneGhostRecords()
    const records = await loadKindRecords()
    return {
      records: [...records.entries()].map(([repo, record]) => ({ repo, ...record })),
      skills: [...dirNameSet(skillsDirPath())].sort(),
      presets: [...dirNameSet(presetsDirPath())].sort(),
    }
  }

  /**
   * Export a backup file: install manifests for one profile (or all) plus
   * the marketplace kind records. A reinstallable LIST, not data/config —
   * patch user config, node_modules entities, credentials are excluded.
   */
  async backupExport(profileFilter: string): Promise<BackupFile> {
    const profiles: BackupProfile[] = []
    const root = join(dshHome(), 'profiles')
    for (const entry of readdirSafe(root)) {
      if (!entry.isDirectory() || entry.name === 'node_modules') continue
      if (profileFilter.length > 0 && entry.name !== profileFilter) continue
      const dir = join(root, entry.name)
      const manifest = readManifest(dir) as {
        dependencies?: Record<string, string>
        dsh?: { profile?: { bundles?: string[] } }
      }
      const dependencies = manifest.dependencies ?? {}
      const bundles = manifest.dsh?.profile?.bundles ?? []
      if (bundles.length === 0 && Object.keys(dependencies).length === 0) continue
      profiles.push({ name: entry.name, bundles, dependencies })
    }
    const records = await loadKindRecords()
    let appVersion = 'unknown'
    try {
      const manifest = JSON.parse(
        readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'),
      ) as { version?: unknown }
      if (typeof manifest.version === 'string') appVersion = manifest.version
    } catch { /* version is advisory */ }
    return {
      app: OUR_PACKAGE_NAME,
      appVersion,
      exportedAt: new Date().toISOString(),
      profiles,
      kinds: [...records.entries()].map(([repo, record]) => ({ repo, ...record })),
    }
  }

  /**
   * Diff a backup against the current installation state. Local-path sources
   * (link:/file:/absolute) that no longer exist are unrestorable, not
   * missing — reinstalling them would only fail.
   */
  async backupDiff(backup: BackupFile, targetProfile: string): Promise<BackupDiffResult> {
    const missing: BackupDiffEntry[] = []
    const already: string[] = []
    const missingProfiles: string[] = []
    const unrestorable: string[] = []
    // Ghost records (dirs deleted externally) would be judged "already
    // installed" and skip the reinstall — prune first (audit n1).
    await pruneGhostRecords()
    // Kind records (global skills/presets).
    const records = await loadKindRecords()
    for (const kind of backup.kinds) {
      if (records.has(kind.repo)) {
        already.push(kind.repo)
        continue
      }
      if (!/^[a-z0-9._-]+\/[a-z0-9._-]+$/i.test(kind.repo) || kind.repo.includes('\\') || kind.repo.includes(':')) {
        // Local-path source: restorable only while the directory still exists
        // on this machine (a cross-machine restore cannot reach it).
        if (existsSync(kind.repo)) {
          missing.push({ profile: '', name: kind.repo, source: kind.repo, kind: kind.type })
        } else {
          unrestorable.push(kind.repo + ' (local-path source)')
        }
        continue
      }
      missing.push({ profile: '', name: kind.repo, source: 'https://github.com/' + kind.repo, kind: kind.type })
    }
    // Profile dependencies.
    for (const bp of backup.profiles) {
      if (targetProfile.length > 0 && bp.name !== targetProfile) continue
      if (!existsSync(profileDir(bp.name))) {
        missingProfiles.push(bp.name)
        continue
      }
      const manifest = readManifest(profileDir(bp.name)) as { dependencies?: Record<string, string> }
      const deps = manifest.dependencies ?? {}
      for (const [name, source] of Object.entries(bp.dependencies)) {
        if (deps[name] !== undefined) {
          already.push(bp.name + '/' + name)
          continue
        }
        if (/^(link|file):/.test(source) || source.startsWith('/')) {
          const localPath = source.replace(/^(link|file):/, '')
          if (!existsSync(localPath)) {
            unrestorable.push(bp.name + '/' + name + ' (local source gone: ' + localPath + ')')
            continue
          }
        }
        missing.push({ profile: bp.name, name, source, kind: 'cordis-plugin' })
      }
    }
    return { ok: true, missing, already, missingProfiles, unrestorable }
  }

  /**
   * Restore a backup: reinstall every missing entry through the protected
   * install chain (quality gate + rollback apply). Failures do not abort the
   * batch — each entry is reported, and the overall result is failed when
   * any entry failed. The WHOLE batch runs as one mutation (same reasoning
   * as copyPlugins, audit C3): a per-entry loop of separately enqueued
   * installs would let concurrent install/remove/update interleave between
   * entries and interleave manifest snapshots and patch rows.
   */
  async backupRestore(backup: BackupFile, targetProfile: string): Promise<CommandResult> {
    const diff = await this.backupDiff(backup, targetProfile)
    if (diff.missing.length === 0) {
      return {
        ok: diff.unrestorable.length === 0,
        exitCode: diff.unrestorable.length === 0 ? 0 : 1,
        output: 'nothing to restore'
          + (diff.unrestorable.length > 0 ? '\nunrestorable:\n  ' + diff.unrestorable.join('\n  ') : ''),
      }
    }
    return enqueueMutation(async () => {
      const outputs: string[] = []
      let ok = true
      for (const entry of diff.missing) {
        // Kind installs (skill/preset) ignore the profile; cordis goes into it.
        const profile = entry.kind === 'cordis-plugin' ? entry.profile : (targetProfile.length > 0 ? targetProfile : 'web')
        try {
          // Inner (non-enqueuing) variant: the batch already holds the mutex.
          const result = await installWithSourceInner(this.ctx, profile, entry.source)
          if (!result.ok && result.awaiting !== undefined) {
            // The repository needs install-time env vars the backup cannot
            // carry — say exactly which, so the restore is not a dead end
            // (audit m4).
            outputs.push('[' + entry.name + '] PAUSED: needs environment variable(s) '
              + result.awaiting.questions.map(q => q.id).join(', ')
              + ' — install it manually from the marketplace/Manage tab and provide them')
            ok = false
          } else {
            outputs.push('[' + entry.name + '] ' + (result.ok ? 'restored' : 'FAILED: ' + result.output.slice(0, 300)))
            if (!result.ok) ok = false
          }
        } catch (error: unknown) {
          outputs.push('[' + entry.name + '] FAILED: ' + (error instanceof Error ? error.message : String(error)))
          ok = false
        }
      }
      if (diff.unrestorable.length > 0) {
        outputs.push('unrestorable:\n  ' + diff.unrestorable.join('\n  '))
        ok = false
      }
      return { ok, exitCode: ok ? 0 : 1, output: outputs.join('\n') }
    })
  }

  /**
   * Execute one machine-fixable health-check action. A-level actions (safe
   * defaults) run directly; B-level (conflict disables) are sent here only
   * after the user confirmed in the UI. Serialized by the mutation mutex;
   * inner calls use the un-wrapped service methods to avoid queue nesting.
   */
  async fixIssue(profile: string, action: string, target: string): Promise<MutationResult> {
    return enqueueMutation(() => this.fixIssueInner(profile, action, target))
  }

  private async fixIssueInner(profile: string, action: string, target: string): Promise<MutationResult> {
    const dir = profileDir(profile)
    if (!existsSync(dir)) return { ok: false, message: `profile not found: ${profile}` }
    switch (action) {
      case 'enable-entry':
        return this.setEnabledInner(profile, target, true)
      case 'disable-entry':
        return this.setEnabledInner(profile, target, false)
      case 'remove-duplicate-rows': {
        const current = readPatch(dir)
        const lines = current.split('\n')
        // The first matching row is kept; every later `- id: <target>` row is
        // dropped TOGETHER with its indented children — a line-only filter
        // left the duplicate's child rows attached to the kept row, producing
        // duplicate YAML keys / misplaced `disabled` (audit M10).
        let firstIdx = -1
        for (let i = 0; i < lines.length; i += 1) {
          const match = /^-\s*id:\s*(\S+)/.exec(lines[i]!)
          if (match !== null && match[1] === target) { firstIdx = i; break }
        }
        if (firstIdx === -1) {
          return { ok: false, message: 'no rows found for id ' + target + ' (re-run the check)' }
        }
        const out: string[] = []
        let dropping = false
        for (let i = 0; i < lines.length; i += 1) {
          const line = lines[i]!
          if (i === firstIdx) { out.push(line); dropping = false; continue }
          const match = /^-\s*id:\s*(\S+)/.exec(line)
          if (match !== null && match[1] === target) { dropping = true; continue }
          if (dropping) {
            if (/^\s/.test(line)) continue // duplicate row's indented children
            dropping = false
          }
          out.push(line)
        }
        if (out.length === lines.length) {
          return { ok: false, message: 'no duplicate rows found for id ' + target + ' (re-run the check)' }
        }
        writePatch(patchPath(dir), out.join('\n'))
        return {
          ok: true,
          message: 'removed duplicate rows for id ' + target + ' (first kept; applied via the patch watcher, or on next start)',
        }
      }
      case 'remove-official-copy': {
        if (!target.startsWith('@deepseek-ai/')) {
          return { ok: false, message: target + ' is not an official package; refusing to remove it' }
        }
        // Only a plain scoped package name may be targeted: `..`/`/` in the
        // target would escape node_modules through join() (audit M1).
        if (!/^@deepseek-ai\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(target)) {
          return { ok: false, message: target + ' is not a valid package name; refusing to remove it' }
        }
        const pkgDir = join(dir, 'node_modules', target)
        if (!resolve(pkgDir).startsWith(resolve(join(dir, 'node_modules')) + sep)) {
          return { ok: false, message: target + ' escapes node_modules; refusing to remove it' }
        }
        if (existsSync(pkgDir)) rmSync(pkgDir, { recursive: true, force: true })
        const manifest = readManifest(dir) as { dependencies?: Record<string, string> }
        if (manifest.dependencies?.[target] !== undefined) {
          delete manifest.dependencies[target]
          writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest, undefined, 2) + '\n')
        }
        return { ok: true, message: 'removed duplicate official copy ' + target + ' from the profile (host fallback now resolves it)' }
      }
      default:
        return { ok: false, message: 'unknown fix action: ' + action }
    }
  }

  /**
   * Run every A-level (safe-default) fix from a fresh analysis. B-level
   * suggestions are left for the per-issue confirm flow. Serialized by the
   * mutation mutex.
   */
  async fixAll(profile: string): Promise<CommandResult> {
    return enqueueMutation(async () => {
      const dir = profileDir(profile)
      if (!existsSync(dir)) return { ok: false, exitCode: 1, output: 'profile not found: ' + profile }
      // Same disabled-row source as analyze(): an empty set pretends nothing
      // is disabled, so auto-fix would "repair" deliberate disables.
      const liveRows = profile === hostProfileName() ? liveRowStates(this.ctx) : []
      const disabledNames = new Set(liveRows.filter(row => !row.enabled).map(row => row.moduleName))
      const analysis = analyzeProfile(dir, readBundles(profile), readPatch(dir), disabledNames, [])
      const auto = analysis.issues.filter(issue => issue.fix !== undefined && !issue.fix!.confirm)
      if (auto.length === 0) return { ok: true, exitCode: 0, output: 'nothing to auto-fix' }
      const outputs: string[] = []
      let ok = true
      for (const issue of auto) {
        const fix = issue.fix!
        const result = await this.fixIssueInner(profile, fix.action, fix.target)
        outputs.push('[' + fix.label + '] ' + (result.ok ? 'fixed' : 'FAILED: ' + result.message))
        if (!result.ok) ok = false
      }
      return { ok, exitCode: ok ? 0 : 1, output: outputs.join('\n') }
    })
  }

  /**
   * Uninstall a marketplace-kind install through its record: skills/presets
   * delete their directories (path-containment guarded), cordis plugins
   * remove each recorded package through the protected path (dependency +
   * insert rows), then the record itself is removed.
   */
  async uninstallKind(profile: string, repo: string): Promise<CommandResult> {
    const key = normalizeRepoRef(repo)
    if (key === null) return { ok: false, exitCode: 1, output: 'invalid repo: ' + repo }
    const records = await loadKindRecords()
    const record = records.get(key)
    if (record === undefined) {
      return {
        ok: false,
        exitCode: 1,
        output: 'no install record for ' + key + ' (records cover marketplace-installed plugins/skills/presets;'
          + ' manual installs are managed in the Manage tab)',
      }
    }
    const log: string[] = []
    if (record.type === 'skill' || record.type === 'agent-preset') {
      const root = record.type === 'skill' ? skillsDirPath() : presetsDirPath()
      const names = record.names !== null && record.names.length > 0
        ? record.names
        : record.name !== null ? [record.name] : []
      let removed = 0
      // Agent presets: prefer the host roster service — its remove() clears
      // a settings default that pointed at the preset and keeps standing
      // sessions intact; a direct rm of a default preset would break every
      // new session until the default is unset (host-side semantics). The
      // CLI has no host ctx and falls back to direct removal.
      const hostService = record.type === 'agent-preset' ? agentPresetsOf(this.ctx) : undefined
      try {
        for (const name of names) {
          const target = join(root, name)
          if (hostService !== undefined) {
            try {
              const rows = await hostService.list()
              if (rows.some(row => row.id === name)) {
                await hostService.remove(name)
                log.push('removed ' + target + ' (host)')
                removed++
                continue
              }
            } catch { /* host removal failed — fall through to direct removal */ }
          }
          if (isUnderRoot(target, root) && existsSync(target)) {
            rmSync(target, { recursive: true, force: true })
            log.push('removed ' + target)
            removed++
          }
        }
        if (removed === 0 && record.location !== null && record.location !== root && isUnderRoot(record.location, root) && existsSync(record.location)) {
          rmSync(record.location, { recursive: true, force: true })
          log.push('removed ' + record.location)
        }
      } catch (error: unknown) {
        // A locked/busy directory (Windows) must NOT lose the install
        // record — the state would claim uninstalled while files remain
        // (audit M6). Keep the record and report the failure.
        return {
          ok: false,
          exitCode: 1,
          output: 'uninstall failed for ' + key + ' (' + record.type + '): '
            + (error instanceof Error ? error.message : String(error))
            + (log.length > 0 ? '\n' + log.join('\n') : '')
            + '\n[plugin-manager] the install record was kept — re-run after releasing the directory.',
        }
      }
      await removeKindRecord(key)
      return {
        ok: true,
        exitCode: 0,
        output: 'uninstalled ' + key + ' (' + record.type + ')' + (log.length > 0 ? '\n' + log.join('\n') : ''),
      }
    }
    if (record.type === 'cordis-plugin') {
      // The record carries the profile the plugin was installed into —
      // fall back to it when the caller passes none (audit m3).
      const targetProfile = profile.length > 0 ? profile : (record.profile ?? '')
      if (targetProfile.length === 0) {
        return {
          ok: false,
          exitCode: 1,
          output: 'cordis plugin uninstall needs a target profile — use the Manage tab or dshpm uninstall-kind --profile <name>',
        }
      }
      const names = record.names !== null && record.names.length > 0
        ? record.names
        : record.name !== null ? [record.name] : []
      if (names.length === 0) {
        return { ok: false, exitCode: 1, output: 'install record for ' + key + ' has no package names' }
      }
      // One mutation for the whole batch (same reasoning as copyPlugins,
      // audit C3): separately enqueued per-name removals would let a
      // concurrent install/toggle interleave between names and interleave
      // manifest snapshots and patch rows. Inner (non-enqueuing) variant —
      // the batch already holds the mutex.
      const outputs: string[] = []
      let ok = true
      await enqueueMutation(async () => {
        for (const name of names) {
          const result = await removeProtectedInner(this.ctx, targetProfile, name)
          outputs.push(result.output)
          if (!result.ok) ok = false
        }
      })
      if (!ok) {
        // A failed package removal must keep the record — the package is
        // still installed (audit M6).
        return {
          ok: false,
          exitCode: 1,
          output: outputs.join('\n\n')
            + '\n[plugin-manager] uninstall incomplete — the install record was kept; re-run after fixing the failures.',
        }
      }
      await removeKindRecord(key)
      return { ok, exitCode: ok ? 0 : 1, output: outputs.join('\n\n') }
    }
    // instructions / unknown kinds: record cleanup only
    await removeKindRecord(key)
    return { ok: true, exitCode: 0, output: 'removed install record for ' + key }
  }

  /** Remove one managed insert row (non-bundle plugin, live unmount). */
  async removeInsert(profile: string, rowId: string): Promise<MutationResult> {
    return enqueueMutation(() => this.removeInsertInner(profile, rowId))
  }

  private async removeInsertInner(profile: string, rowId: string): Promise<MutationResult> {
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
  async update(profile: string, name: string, locale?: 'zh' | 'en'): Promise<CommandResult> {
    return updateProtected(profile, name, locale)
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
      // The one static sweep feeds BOTH purposes: its result carries the
      // load-failure extras, and the pending-dependency diagnostics derived
      // from it are appended to that same result — a second full sweep
      // (the dominant /analyze cost) would only duplicate this output.
      const analysis = analyzeProfile(dir, bundles, patch, disabledNames, extra)
      const pendingIssues: AnalyzeIssue[] = []
      for (const pkg of analysis.packages) {
        if (pkg.injects.length === 0) continue
        const row = liveRows.find(live => live.moduleName === pkg.name)
        if (row === undefined || row.phase !== 'pending') continue
        const missing = pkg.injects.filter(name => !activeServices.has(name) && name !== 'loader' && name !== 'webServer')
        if (missing.length > 0) {
          pendingIssues.push({
            kind: 'pending-dependency',
            from: pkg.name,
            message: pkg.name + ' is pending: it injects ' + missing.join(', ')
              + ' but no active service provides it (install or enable the provider, or check its own failure)',
          })
        }
      }
      return pendingIssues.length === 0
        ? analysis
        : { ...analysis, issues: [...analysis.issues, ...pendingIssues] }
    }
    return analyzeProfile(dir, bundles, patch, disabledNames, extra)
  }
}




/** One live dsh instance found by process scan. */


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





/** Read directory entries defensively (missing root → empty). */
function readdirSafe(path: string): { name: string; isDirectory(): boolean }[] {
  try {
    return readdirSync(path, { withFileTypes: true }) as unknown as { name: string; isDirectory(): boolean }[]
  } catch {
    return []
  }
}

/** Bodies at or below this size go out uncompressed (gzip overhead > savings). */
const GZIP_MIN_BYTES = 1024

// ── Job registry for long REST operations (install/update/remove/…) ──

/**
 * A pnpm-lifecycle REST operation tracked for client polling. The POST
 * returns the job id immediately instead of holding the HTTP request open
 * for a 10-minute install (browser/proxy timeouts would detach the client
 * while the server keeps working, and a retry would stack a second queued
 * mutation). The client polls `job` until it settles.
 */
interface JobRecord {
  readonly id: string
  readonly startedAt: number
  settled: boolean
  result?: unknown
  error?: string
}

/** Settled jobs stay queryable this long (a poll after that reads "expired"). */
const JOBS_TTL_MS = 30 * 60 * 1000
/** Upper bound on simultaneously pending jobs (stacked clicks get refused). */
const JOBS_MAX_PENDING = 4
const jobs = new Map<string, JobRecord>()
let jobSeq = 0

/** Drop settled jobs past the TTL (lazy, on every job touch). */
function pruneJobs(): void {
  const now = Date.now()
  for (const [id, job] of jobs) {
    if (job.settled && now - job.startedAt > JOBS_TTL_MS) jobs.delete(id)
  }
}

/**
 * Start a long operation as a tracked job. Bounded: more than
 * JOBS_MAX_PENDING simultaneously pending jobs means a client is stacking
 * clicks faster than pnpm can settle — refuse instead of queueing more.
 */
function startJob(run: () => Promise<unknown>): { ok: true; jobId: string } | { ok: false; message: string } {
  pruneJobs()
  const pending = [...jobs.values()].filter(job => !job.settled).length
  if (pending >= JOBS_MAX_PENDING) {
    return { ok: false, message: 'another install/update is still running ('
      + pending + ' in flight) — wait for it to finish before starting another' }
  }
  const id = 'job-' + Date.now().toString(36) + '-' + (++jobSeq).toString(36)
  const job: JobRecord = { id, startedAt: Date.now(), settled: false }
  jobs.set(id, job)
  void run().then(
    (result) => { job.settled = true; job.result = result },
    (error: unknown) => { job.settled = true; job.error = error instanceof Error ? error.message : String(error) },
  )
  return { ok: true, jobId: id }
}

/** Respond helper for startJob results: 200 + job id, or 429 + busy error. */
function respondJob(
  respond: (status: number, value: unknown) => void,
  job: ReturnType<typeof startJob>,
): void {
  if (!job.ok) {
    respond(429, { ok: false, error: { code: 'busy', message: job.message } })
    return
  }
  respond(200, { ok: true, value: { jobId: job.jobId } })
}

/**
 * Write a JSON response, gzipping large bodies when the client accepts it.
 * The marketplace listing is ~1.7MB of JSON (~200KB gzipped) — the main win;
 * gzipSync keeps the writer one-shot (no stream plumbing) at a tens-of-ms
 * CPU cost that only large payloads pay. Vary: Accept-Encoding keeps
 * intermediate caches from serving the gzipped body to a client that did not
 * ask for it.
 */
function sendJson(
  res: { writeHead(status: number, headers: Record<string, string>): void; end(body?: string | Uint8Array): void },
  status: number,
  value: unknown,
  acceptEncoding?: string,
): void {
  const body = JSON.stringify(value)
  if (acceptEncoding !== undefined
    && acceptEncoding.toLowerCase().includes('gzip')
    && Buffer.byteLength(body, 'utf8') > GZIP_MIN_BYTES) {
    res.writeHead(status, {
      'content-type': 'application/json',
      'content-encoding': 'gzip',
      'vary': 'Accept-Encoding',
    })
    res.end(gzipSync(Buffer.from(body, 'utf8')))
    return
  }
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(body)
}

/** Mount the REST surface. Returns the route disposers (may be empty). */
export function registerRoutes(ctx: Context, service: PluginManagerService): (() => void)[] {
  const webServer = ctx.get('webServer') as { register(route: WebRoute): () => void } | undefined
  if (webServer === undefined) return []

  const handler = (op: string) => async (req: NodeJS.ReadableStream & { url?: string }, res: { writeHead(status: number, headers: Record<string, string>): void; end(body?: string | Uint8Array): void }): Promise<void> => {
    // The client's accept-encoding, threaded into every respond() below so
    // large JSON payloads (the marketplace listing) go out gzipped.
    const acceptEncoding = String((req as { headers?: Record<string, string | string[] | undefined> }).headers?.['accept-encoding'] ?? '')
    const respond = (status: number, value: unknown): void => sendJson(res, status, value, acceptEncoding)
    try {
      // Trust fence (CSRF / DNS-rebinding), mirroring the official /api
      // trust model: POST + application/json only, and the Host must be
      // loopback (or an explicitly trusted host). A cross-site page cannot
      // read responses but can drive mutations — same threat as the official
      // api-request-trust.ts fence.
      const method = (req as { method?: string }).method ?? ''
      if (method !== 'POST') {
        respond(405, { ok: false, error: { code: 'method-not-allowed', message: 'POST only' } })
        return
      }
      const contentType = String((req as { headers?: Record<string, string | string[] | undefined> }).headers?.['content-type'] ?? '').toLowerCase()
      if (!contentType.includes('application/json')) {
        respond(415, { ok: false, error: { code: 'unsupported-media-type', message: 'application/json required' } })
        return
      }
      if (!isTrustedRequest(req as { headers?: Record<string, string | string[] | undefined> })) {
        respond(403, { ok: false, error: { code: 'forbidden', message: 'untrusted request' } })
        return
      }
      const body = (await readJsonBody(req)) as Record<string, unknown>
      switch (op) {
        case 'listProfiles': {
          respond(200, { ok: true, value: service.listProfiles() })
          return
        }
        case 'list': {
          const profile = typeof body['profile'] === 'string' ? body['profile'] : ''
          respond(200, { ok: true, value: service.list(profile) })
          return
        }
        case 'setEnabled': {
          const profile = typeof body['profile'] === 'string' ? body['profile'] : ''
          const entryId = typeof body['entryId'] === 'string' ? body['entryId'] : ''
          const enabled = body['enabled'] === true
          respond(200, { ok: true, value: await service.setEnabled(profile, entryId, enabled) })
          return
        }
        case 'install': {
          const profile = typeof body['profile'] === 'string' ? body['profile'] : ''
          const spec = typeof body['spec'] === 'string' ? body['spec'] : ''
          const rawAnswers = body['answers']
          const answers = rawAnswers !== null && typeof rawAnswers === 'object' && !Array.isArray(rawAnswers)
            ? Object.fromEntries(
                Object.entries(rawAnswers as Record<string, unknown>).filter(
                  (entry): entry is [string, string] => typeof entry[1] === 'string',
                ),
              )
            : undefined
          const locale = acceptLanguageLocale(String((req as { headers?: Record<string, string | string[] | undefined> }).headers?.['accept-language'] ?? ''))
          respondJob(respond, startJob(() => service.install(profile, spec, answers, locale)))
          return
        }
        case 'remove': {
          const profile = typeof body['profile'] === 'string' ? body['profile'] : ''
          const name = typeof body['name'] === 'string' ? body['name'] : ''
          respondJob(respond, startJob(() => service.remove(profile, name)))
          return
        }
        case 'uninstallKind': {
          const profile = typeof body['profile'] === 'string' ? body['profile'] : ''
          const repo = typeof body['repo'] === 'string' ? body['repo'] : ''
          respondJob(respond, startJob(() => service.uninstallKind(profile, repo)))
          return
        }
        case 'listKinds': {
          respond(200, { ok: true, value: await service.listKinds() })
          return
        }
        case 'backupExport': {
          const profile = typeof body['profile'] === 'string' ? body['profile'] : ''
          respond(200, { ok: true, value: await service.backupExport(profile) })
          return
        }
        case 'backupDiff': {
          const profile = typeof body['profile'] === 'string' ? body['profile'] : ''
          const backup = body['backup'] as BackupFile | undefined
          if (backup === undefined || typeof backup !== 'object' || !Array.isArray(backup.profiles)) {
            respond(400, { ok: false, error: { code: 'bad-backup', message: 'backup payload is not a valid backup file' } })
            return
          }
          respond(200, { ok: true, value: await service.backupDiff(backup, profile) })
          return
        }
        case 'backupRestore': {
          const profile = typeof body['profile'] === 'string' ? body['profile'] : ''
          const backup = body['backup'] as BackupFile | undefined
          if (backup === undefined || typeof backup !== 'object' || !Array.isArray(backup.profiles)) {
            respond(400, { ok: false, error: { code: 'bad-backup', message: 'backup payload is not a valid backup file' } })
            return
          }
          respondJob(respond, startJob(() => service.backupRestore(backup, profile)))
          return
        }
        case 'unblockRepo': {
          const repo = typeof body['repo'] === 'string' ? body['repo'] : ''
          const key = normalizeRepoRef(repo)
          if (key === null) {
            respond(200, { ok: true, value: { ok: false, message: 'invalid repo: ' + repo } })
            return
          }
          await removeBlockedRepo(key)
          respond(200, { ok: true, value: { ok: true, message: 'unblocked ' + key } })
          return
        }
        case 'createProfile': {
          const name = typeof body['name'] === 'string' ? body['name'] : ''
          const template = typeof body['template'] === 'string' ? body['template'] : 'web'
          respond(200, { ok: true, value: await service.createProfile(name, template) })
          return
        }
        case 'stopProfile': {
          const name = typeof body['name'] === 'string' ? body['name'] : ''
          respond(200, { ok: true, value: await service.stopProfile(name) })
          return
        }
        case 'marketplace': {
          const profile = typeof body['profile'] === 'string' ? body['profile'] : ''
          const refresh = body['refresh'] === true
          respond(200, { ok: true, value: await service.marketplace(profile, refresh) })
          return
        }
        case 'startProfile': {
          const name = typeof body['name'] === 'string' ? body['name'] : ''
          respond(200, { ok: true, value: await service.startProfile(name) })
          return
        }
        case 'copyPlugins': {
          const from = typeof body['from'] === 'string' ? body['from'] : ''
          const to = typeof body['to'] === 'string' ? body['to'] : ''
          const names = Array.isArray(body['names']) ? body['names'] as string[] : []
          respondJob(respond, startJob(() => service.copyPlugins(from, to, names)))
          return
        }
        case 'renameProfile': {
          const oldName = typeof body['oldName'] === 'string' ? body['oldName'] : ''
          const newName = typeof body['newName'] === 'string' ? body['newName'] : ''
          respond(200, { ok: true, value: service.renameProfile(oldName, newName) })
          return
        }
        case 'removeProfile': {
          const name = typeof body['name'] === 'string' ? body['name'] : ''
          respond(200, { ok: true, value: service.removeProfile(name) })
          return
        }
        case 'removeInsert': {
          const profile = typeof body['profile'] === 'string' ? body['profile'] : ''
          const rowId = typeof body['rowId'] === 'string' ? body['rowId'] : ''
          respond(200, { ok: true, value: await service.removeInsert(profile, rowId) })
          return
        }
        case 'mount': {
          const profile = typeof body['profile'] === 'string' ? body['profile'] : ''
          const packageName = typeof body['packageName'] === 'string' ? body['packageName'] : ''
          respond(200, { ok: true, value: await service.mount(profile, packageName) })
          return
        }
        case 'checkUpdates': {
          const profile = typeof body['profile'] === 'string' ? body['profile'] : ''
          respond(200, { ok: true, value: await service.checkUpdates(profile) })
          return
        }
        case 'analyze': {
          const profile = typeof body['profile'] === 'string' ? body['profile'] : ''
          respond(200, { ok: true, value: service.analyze(profile) })
          return
        }
        case 'fixIssue': {
          const profile = typeof body['profile'] === 'string' ? body['profile'] : ''
          const action = typeof body['action'] === 'string' ? body['action'] : ''
          const target = typeof body['target'] === 'string' ? body['target'] : ''
          respond(200, { ok: true, value: await service.fixIssue(profile, action, target) })
          return
        }
        case 'fixAll': {
          const profile = typeof body['profile'] === 'string' ? body['profile'] : ''
          respond(200, { ok: true, value: await service.fixAll(profile) })
          return
        }
        case 'update': {
          const profile = typeof body['profile'] === 'string' ? body['profile'] : ''
          const name = typeof body['name'] === 'string' ? body['name'] : ''
          const locale = acceptLanguageLocale(String((req as { headers?: Record<string, string | string[] | undefined> }).headers?.['accept-language'] ?? ''))
          respondJob(respond, startJob(() => service.update(profile, name, locale)))
          return
        }
        case 'job': {
          // Long-operation poll (install/update/remove/… return { jobId }).
          const id = typeof body['id'] === 'string' ? body['id'] : ''
          const job = jobs.get(id)
          if (job === undefined) {
            respond(200, { ok: true, value: { done: true, missing: true } })
            return
          }
          if (!job.settled) {
            respond(200, { ok: true, value: { done: false } })
            return
          }
          if (job.error !== undefined) {
            respond(200, { ok: true, value: { done: true, error: job.error } })
            return
          }
          respond(200, { ok: true, value: { done: true, result: job.result } })
          return
        }
        default:
          respond(404, { ok: false, error: { code: 'unknown-op', message: op } })
      }
    } catch (error: unknown) {
      respond(400, {
        ok: false,
        error: { code: 'bad-request', message: error instanceof Error ? error.message : String(error) },
      })
    }
  }

  const disposers: (() => void)[] = []
  for (const op of ['listProfiles', 'list', 'setEnabled', 'install', 'remove', 'uninstallKind', 'listKinds', 'unblockRepo', 'backupExport', 'backupDiff', 'backupRestore', 'removeInsert', 'mount', 'createProfile', 'renameProfile', 'removeProfile', 'copyPlugins', 'startProfile', 'stopProfile', 'marketplace', 'checkUpdates', 'update', 'analyze', 'fixIssue', 'fixAll', 'job']) {
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
    // Final unload must stop the watcher too: the fs handle would otherwise
    // outlive the plugin and keep recomposing into a dead loader tree.
    ctx.effect(() => () => { closePatchWatcher() }, 'dsh-web-plugin-manager: patch watcher')
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
      // Parameter-order adapter: the service takes (profile, refresh), the
      // tool host takes (refresh, profile).
      const disposers = registerTools(toolsCtx, {
        list: (profile) => service.list(profile),
        setEnabled: (profile, entryId, enabled) => service.setEnabled(profile, entryId, enabled),
        install: (profile, spec) => service.install(profile, spec),
        remove: (profile, name) => service.remove(profile, name),
        removeInsert: (profile, rowId) => service.removeInsert(profile, rowId),
        marketplace: (refresh, profile) => service.marketplace(profile, refresh),
      }, config.profile)
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