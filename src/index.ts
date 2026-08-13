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

import { execFile } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context, Service } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import z from '@deepseek-ai/schemastery'
import type {
  CommandResult, InsertRow, ManagedPackage, MutationResult, PluginManagerSnapshot,
  ProfileInfo, RuntimeEntry,
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
    return typeof manifest.name === 'string' ? manifest.name : 'dsh-plugin-manager'
  } catch {
    return 'dsh-plugin-manager'
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
      })
    }
    return out.sort((a, b) => a.name.localeCompare(b.name))
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
        managedDisabledIds: isBundle && hasManagedDisable(patchPath(dir), name)
          ? [name]
          : [],
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

  /**
   * Install a plugin via dsh plugin (preserving in-box bundles). After a
   * successful add, the real package name is resolved from the manifest
   * (V2-C: pnpm dependency values may be path/git source strings; the
   * dependency key is the package name). A non-bundle plugin (no dsh.bundle
   * declaration) is then mounted as a managed insert row — config HMR applies
   * it live, no restart.
   */
  async install(profile: string, spec: string): Promise<CommandResult> {
    const before = readBundles(profile)
    const result = await runDshPlugin(profile, 'add', [spec], process.cwd())
    if (!result.ok) return result
    restoreInBoxBundles(profile, before)
    const installed = resolveInstalledName(profile, spec)
    if (installed === null || exportsBundlePatch(profile, installed)) {
      return { ...result, installed: installed !== null ? [installed] : [] }
    }
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
          + `\n[plugin-manager] mounted ${installed} as insert row ${rowId} (live via config HMR)`,
      }
    } catch (error: unknown) {
      return {
        ...result,
        installed: [installed],
        output: result.output + `\n[plugin-manager] install ok but insert row failed: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }

  /** Remove an installed bundle via dsh plugin (preserving in-box bundles). */
  async remove(profile: string, name: string): Promise<CommandResult> {
    const before = readBundles(profile)
    const result = await runDshPlugin(profile, 'remove', [name], process.cwd())
    if (result.ok) restoreInBoxBundles(profile, before)
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

/** Read the current bundle list of a profile. */
function readBundles(profile: string): string[] {
  const manifest = readManifest(profileDir(profile))
  const dsh = (manifest['dsh'] ?? {}) as Record<string, unknown>
  const profileManifest = (dsh['profile'] ?? {}) as Record<string, unknown>
  const bundles = Array.isArray(profileManifest['bundles']) ? profileManifest['bundles'] as string[] : []
  return [...bundles]
}

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
  for (const op of ['listProfiles', 'list', 'setEnabled', 'install', 'remove', 'removeInsert']) {
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
    }, 'dsh-plugin-manager: routes')
  })
  // V2-E: agent tools, when the host provides the tools service (web
  // profiles do; headless may not — inject simply never fires).
  ctx.inject(['tools'], (toolsCtx: Context) => {
    toolsCtx.effect(() => {
      const disposers = registerTools(toolsCtx, service, config.profile)
      return () => { for (const dispose of disposers) dispose() }
    }, 'dsh-plugin-manager: tools')
  })
}

// Function-plugin form: no default export (mixing forms makes the Loader
// discard the named apply). The service class is instantiated inside apply.