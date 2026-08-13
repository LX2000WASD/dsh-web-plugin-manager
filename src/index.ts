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
 *  - the profile's installed dependencies (`package.json`).
 *
 * Write side:
 *  - enable/disable edits the profile's `cordis.patch.yml` through the
 *    managed-block mechanism (src/patch.ts) — reversible, reviewable, never
 *    rewrites user content;
 *  - install/remove shells out to the official `dsh plugin` CLI, which owns
 *    the pnpm reconcile of `dsh.profile.bundles`.
 */

import { execFile } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type {
  CommandResult, ManagedPackage, MutationResult, PluginManagerSnapshot,
  ProfileInfo, RuntimeEntry,
} from './types.ts'
import { addDisableBlock, hasManagedDisable, removeDisableBlock, writePatch } from './patch.ts'

export type * from './types.ts'

/** Route prefix for the REST surface. */
export const ROUTE_PREFIX = '/api2/plugin-manager'

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

    const entries: RuntimeEntry[] = []
    for (const entry of this.ctx.loader.entries()) {
      if (entry.options.group) continue
      const state = entry.fiber?.state
      const phase = state === undefined
        ? null
        : state === 0 ? 'pending' : state === 1 ? 'loading' : state === 2 ? 'active'
        : state === 3 ? 'failed' : state === 4 ? null : 'unloading'
      entries.push({
        entryId: entry.id,
        moduleName: entry.options.name,
        enabled: !entry.disabled,
        fiberPhase: phase,
      })
    }

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

    return {
      profile: { name: profile, path: dir, bundles, dependencies: packages.map(p => p.name) },
      entries,
      packages,
    }
  }

  /** Enable or disable one Loader entry via the managed patch block. */
  setEnabled(profile: string, entryId: string, enabled: boolean): MutationResult {
    const dir = profileDir(profile)
    if (!existsSync(dir)) return { ok: false, message: `profile not found: ${profile}` }
    // Loader entry ids carry the include-group prefix (include:minimal); a
    // targeted patch row addresses the plain row id (minimal).
    const rowId = entryId.startsWith('include:') ? entryId.slice('include:'.length) : entryId
    if (rowId.includes(':')) return { ok: false, message: `unsupported entry id: ${JSON.stringify(entryId)}` }
    try {
      const current = readPatch(dir)
      const next = enabled
        ? removeDisableBlock(current, rowId)
        : addDisableBlock(current, rowId)
      if (next !== current) writePatch(patchPath(dir), next)
      return {
        ok: true,
        message: enabled
          ? `enabled ${rowId} (restart required)`
          : `disabled ${rowId} (restart required)`,
      }
    } catch (error: unknown) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Install a bundle via dsh plugin (preserving in-box bundles). */
  async install(profile: string, spec: string): Promise<CommandResult> {
    const before = readBundles(profile)
    const result = await runDshPlugin(profile, 'add', [spec], process.cwd())
    if (result.ok) restoreInBoxBundles(profile, before)
    return result
  }

  /** Remove an installed bundle via dsh plugin (preserving in-box bundles). */
  async remove(profile: string, name: string): Promise<CommandResult> {
    const before = readBundles(profile)
    const result = await runDshPlugin(profile, 'remove', [name], process.cwd())
    if (result.ok) restoreInBoxBundles(profile, before)
    return result
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
  for (const op of ['listProfiles', 'list', 'setEnabled', 'install', 'remove']) {
    disposers.push(webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/${op}`, handler: handler(op) as unknown as WebRoute['handler'] }))
  }
  return disposers
}

/** Plugin entry: mount the service and (when web is present) the routes. */
export const name = 'plugin-manager'
export const inject = ['loader']

export function apply(ctx: Context): void {
  const service = new PluginManagerService(ctx)
  // webServer is a sibling include-group row; ctx.inject waits for it like
  // the official agent-tool-presentation waits for codeRuntime.
  ctx.inject(['webServer'], (webCtx: Context) => {
    webCtx.effect(() => {
      const disposers = registerRoutes(webCtx, service)
      return () => { for (const dispose of disposers) dispose() }
    }, 'dsh-plugin-manager: routes')
  })
}

// Function-plugin form: no default export (mixing forms makes the Loader
// discard the named apply). The service class is instantiated inside apply.