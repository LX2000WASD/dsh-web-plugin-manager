/**
 * Static plugin dependency / conflict / compatibility analysis for one
 * profile — the package-manager-grade checks the quality gate alone cannot
 * cover.
 *
 * The quality gate (src/index.ts qualityIssues) verifies one package in
 * isolation (declared imports vs manifest). This module looks at the whole
 * profile:
 *
 *  - dependency graph: every plugin entry's imports, resolved against the
 *    providers installed in the profile (package names + exports subpaths);
 *  - availability: an import whose provider is missing, disabled in the
 *    patch, or failed at runtime;
 *  - conflicts: duplicate patch row ids, services registered by more than
 *    one plugin (source-scan of `new Service(ctx, 'x')` /
 *    `ctx.provide('x')`), and dependency cycles;
 *  - compatibility: peerDependencies (e.g. @deepseek-ai/cordis) checked
 *    against the resolved versions;
 *  - load order: a topological order of the dependency graph (for
 *    understanding and triage — cordis activation itself is
 *    service-availability driven, not order driven).
 *
 * The analysis is offline (works for any profile, running or not). The host
 * additionally feeds runtime observations (active services, fiber states,
 * fiber errors) into the same report shape.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AnalyzeEdge, AnalyzeIssue, AnalyzePackage, AnalyzeResult } from './types.ts'

/** Specifiers the loader provides without any plugin declaring them. */
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

/** Bare specifiers imported by one JS file (relative/node: excluded). */
export function scanImports(filePath: string): string[] {
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

/** Service names registered/provided in one JS file (best-effort scan). */
function scanServices(filePath: string): { registered: string[]; injected: string[] } {
  try {
    const code = readFileSync(filePath, 'utf8')
    const registered = new Set<string>()
    const injected = new Set<string>()
    const providePattern = /(?:new\s+Service\([^)]*,\s*|ctx\.provide\(\s*|this\.provide\(\s*)['"]([^'"]+)['"]/g
    for (const match of code.matchAll(providePattern)) registered.add(match[1]!)
    const injectPattern = /(?:static\s+inject|inject)\s*=\s*\[([^\]]*)\]/g
    for (const match of code.matchAll(injectPattern)) {
      for (const name of match[1]!.split(',')) {
        const trimmed = name.trim().replace(/^['"]|['"]$/g, '')
        if (trimmed.length > 0) injected.add(trimmed)
      }
    }
    return { registered: [...registered], injected: [...injected] }
  } catch {
    return { registered: [], injected: [] }
  }
}

/** Resolve a package's entry file (exports["."].default, main, module, index.js). */
export function packageEntry(pkgDir: string, manifest: Record<string, unknown>): string | null {
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

/** Parse one package manifest defensively. */
function readManifest(dir: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

/** Simple semver compare: major.minor.patch (ignores prerelease ordering). */
function compareVersions(a: string, b: string): number {
  const clean = (value: string): string => value.trim().replace(/^[v=~^]/, '')
  const pa = clean(a).split('.')
  const pb = clean(b).split('.')
  for (let i = 0; i < 3; i += 1) {
    const na = Number.parseInt(pa[i] ?? '0', 10)
    const nb = Number.parseInt(pb[i] ?? '0', 10)
    if (na !== nb) return na < nb ? -1 : 1
  }
  return 0
}

/** Whether an installed version satisfies a semver range (simplified). */
function satisfiesRange(installed: string, range: string): boolean {
  const spec = range.trim()
  // Exact / caret / tilde / star / comparison-operator forms on the first
  // two components; complex ranges (||, hyphen, x-ranges) fall back to a
  // loose "at least the base" check instead of false negatives.
  if (spec === '*' || spec === '') return true
  if (spec.startsWith('>=')) return compareVersions(installed, spec.slice(2)) >= 0
  if (spec.startsWith('<=')) return compareVersions(installed, spec.slice(2)) <= 0
  if (spec.startsWith('>')) return compareVersions(installed, spec.slice(1)) > 0
  if (spec.startsWith('<')) return compareVersions(installed, spec.slice(1)) < 0
  const req = spec.replace(/^[~^=]/, '')
  if (compareVersions(installed, req) < 0) return false
  const major = Number.parseInt(req.split('.')[0] ?? '0', 10)
  const installedMajor = Number.parseInt(installed.split('.')[0] ?? '0', 10)
  if (spec.startsWith('^')) return installedMajor === major || major === 0
  if (spec.startsWith('~')) {
    const minor = Number.parseInt(req.split('.')[1] ?? '0', 10)
    const installedMinor = Number.parseInt(installed.split('.')[1] ?? '0', 10)
    return installedMajor === major && installedMinor === minor
  }
  return compareVersions(installed, req) === 0
}

/** Resolve a bare specifier to a provider package name (longest match). */
function providerOf(specifier: string, providers: Map<string, string>): string | undefined {
  const parts = specifier.split('/')
  for (let i = parts.length; i >= 1; i -= 1) {
    let candidate = parts.slice(0, i).join('/')
    if (candidate.startsWith('@') && i === 1) continue // '@scope' alone is not a package
    const hit = providers.get(candidate)
    if (hit !== undefined) return hit
  }
  return undefined
}

/** One analyzed package's raw data before issue collection. */
interface RawPackage {
  name: string
  isBundle: boolean
  version?: string
  imports: string[]
  services: string[]
  injects: string[]
  rowId?: string
  disabled: boolean
  entryPath: string | null
}

/**
 * Analyze one profile directory offline: build the dependency graph and
 * collect availability / conflict / compatibility issues.
 *
 * @param profileDir - absolute profile directory.
 * @param bundles - the profile's dsh.profile.bundles layer stack.
 * @param patchContent - the profile's cordis.patch.yml content (for disabled
 *   rows and duplicate-id detection), may be ''.
 * @param disabledNames - package names whose rows are disabled (host may pass
 *   the live view; offline callers can pass an empty set).
 * @param extraIssues - runtime observations fed by the host (fiber failures,
 *   pending injects), appended to the report.
 */
export function analyzeProfile(
  profileDir: string,
  bundles: readonly string[],
  patchContent: string,
  disabledNames: ReadonlySet<string>,
  extraIssues: readonly AnalyzeIssue[] = [],
): AnalyzeResult {
  const nodeModules = join(profileDir, 'node_modules')
  // Providers: every installed package's specifier (name + exports subpaths)
  // → package name; plus the package name → directory for entry resolution.
  const providers = new Map<string, string>()
  const providerDirs = new Map<string, string>()
  const providerManifests = new Map<string, Record<string, unknown>>()
  const collectProvider = (dir: string): void => {
    const manifest = readManifest(dir)
    const name = typeof manifest['name'] === 'string' ? manifest['name'] : ''
    if (name.length === 0) return
    // The profile's own node_modules wins over the shared fallback.
    if (!providerDirs.has(name)) {
      providerDirs.set(name, dir)
      providerManifests.set(name, manifest)
      providers.set(name, name)
      const exportsField = manifest['exports'] as Record<string, unknown> | undefined
      if (exportsField !== undefined && typeof exportsField === 'object') {
        for (const key of Object.keys(exportsField)) {
          if (key.startsWith('.')) providers.set(name + key.slice(1), name)
        }
      }
    }
  }
  // The shared profiles/node_modules fallback resolves the official core
  // packages (@deepseek-ai/cordis, dsh-*) — peerDependencies on them must be
  // checked against this table too.
  const fallbackModules = join(dirname(profileDir), 'node_modules')
  const scanRoot = (root: string): void => {
    try {
      for (const entry of readdirSafe(root)) {
        if (entry.name.startsWith('.')) continue
        const dir = join(root, entry.name)
        // pnpm links installed packages as symlinks — a Dirent reports those
        // as symbolic links, not directories.
        if (entry.isDirectory() || entry.isSymbolicLink()) {
          if (entry.name.startsWith('@')) {
            for (const scoped of readdirSafe(dir)) {
              if (scoped.isDirectory() || scoped.isSymbolicLink()) collectProvider(join(dir, scoped.name))
            }
          } else {
            collectProvider(dir)
          }
        }
      }
    } catch { /* node_modules missing: analysis degrades to manifest-only */ }
  }
  scanRoot(nodeModules)
  if (fallbackModules !== nodeModules) scanRoot(fallbackModules)

  // Build the analyzed package list from the profile's own dependencies.
  const packages: RawPackage[] = []
  const manifest = readManifest(profileDir) as { dependencies?: Record<string, string> }
  const deps = manifest.dependencies ?? {}
  const insertIds = new Set<string>()
  const idRows = new Map<string, string[]>() // duplicate-row-id detection
  for (const line of patchContent.split('\n')) {
    const match = /^-\s*id:\s*([^\s]+)/.exec(line)
    if (match !== null) {
      const id = match[1]!
      const list = idRows.get(id) ?? []
      list.push(id)
      idRows.set(id, list)
    }
    const insert = /^\s{4}- id:\s*([^\s]+)/.exec(line)
    if (insert !== null) insertIds.add(insert[1]!)
  }
  for (const name of Object.keys(deps)) {
    const providerDir = providerDirs.get(name)
    const pkgManifest = providerDir !== undefined ? providerManifests.get(name) ?? {} : readManifest(join(nodeModules, name))
    const dsh = (pkgManifest['dsh'] ?? {}) as Record<string, unknown> | undefined
    const isBundle = (dsh?.bundle as Record<string, unknown> | undefined)?.patch !== undefined
      || bundles.includes(name)
    const entryPath = providerDir !== undefined ? packageEntry(providerDir, pkgManifest) : null
    const services = entryPath !== null ? scanServices(entryPath) : { registered: [], injected: [] }
    packages.push({
      name,
      isBundle,
      ...(typeof pkgManifest['version'] === 'string' ? { version: pkgManifest['version'] } : {}),
      imports: entryPath !== null ? scanImports(entryPath) : [],
      services: services.registered,
      injects: services.injected,
      rowId: bundles.includes(name) ? name : (insertIds.has(slugify(name)) ? slugify(name) : undefined),
      disabled: disabledNames.has(name),
      entryPath,
    })
  }

  // Dependency edges + availability issues.
  const edges: AnalyzeEdge[] = []
  const byName = new Map(packages.map(pkg => [pkg.name, pkg]))
  const issues: AnalyzeIssue[] = []
  // Declared dependencies resolve inside the package's own node_modules
  // (link installs keep their deps at their real location) — a declared
  // import is a resolved intent, not a missing dependency.
  const declaredByPackage = new Map<string, Set<string>>()
  for (const pkg of packages) {
    const providerDir = providerDirs.get(pkg.name)
    const pkgManifest = providerDir !== undefined ? providerManifests.get(pkg.name) ?? {} : readManifest(join(nodeModules, pkg.name))
    const declared = new Set<string>([
      ...Object.keys((pkgManifest['dependencies'] ?? {}) as Record<string, unknown>),
      ...Object.keys((pkgManifest['peerDependencies'] ?? {}) as Record<string, unknown>),
    ])
    declaredByPackage.set(pkg.name, declared)
  }
  for (const pkg of packages) {
    if (pkg.entryPath === null) continue
    const declared = declaredByPackage.get(pkg.name) ?? new Set<string>()
    for (const spec of pkg.imports) {
      if (LOADER_PROVIDED.has(spec)) continue
      const provider = providerOf(spec, providers)
      if (provider === undefined) {
        const declaredPrefix = [...declared].some(name => spec === name || spec.startsWith(name + '/'))
        if (declaredPrefix) continue
        issues.push({
          kind: 'missing-import',
          from: pkg.name,
          message: pkg.name + ' imports ' + spec + ' but no installed package provides it'
            + (pkg.name === spec ? '' : ' (declare it or install the provider)'),
        })
        continue
      }
      if (provider === pkg.name) continue
      edges.push({ from: pkg.name, to: provider, specifier: spec })
    }
  }

  // Disabled dependency: edge whose target row is disabled.
  for (const edge of edges) {
    const target = byName.get(edge.to)
    if (target !== undefined && target.disabled) {
      issues.push({
        kind: 'disabled-dependency',
        from: edge.from,
        to: edge.to,
        message: edge.from + ' depends on ' + edge.to + ' whose row is disabled — it may fail to activate',
      })
    }
  }

  // Duplicate patch row ids.
  for (const [id, rows] of idRows) {
    if (rows.length > 1) {
      issues.push({
        kind: 'duplicate-row-id',
        message: 'patch row id ' + id + ' appears ' + rows.length + ' times (the loader refuses duplicate ids)',
      })
    }
  }

  // Peer compatibility: peerDependencies vs installed/resolved versions.
  for (const pkg of packages) {
    const providerDir = providerDirs.get(pkg.name)
    const pkgManifest = providerDir !== undefined ? providerManifests.get(pkg.name) ?? {} : readManifest(join(nodeModules, pkg.name))
    const peers = (pkgManifest['peerDependencies'] ?? {}) as Record<string, string>
    for (const [peer, range] of Object.entries(peers)) {
      // NOTE: the loader-provided whitelist does NOT apply here — the
      // whitelist concerns import declarations, while a peerDependency is a
      // VERSION constraint on a resolved package and must be checked.
      const peerDir = providerDirs.get(peer)
      const peerManifest = peerDir !== undefined ? providerManifests.get(peer) ?? {} : readManifest(join(nodeModules, peer))
      const peerVersion = typeof peerManifest['version'] === 'string' ? peerManifest['version'] : undefined
      if (peerVersion === undefined || peerVersion.length === 0) continue
      if (!satisfiesRange(peerVersion, range)) {
        issues.push({
          kind: 'peer-mismatch',
          from: pkg.name,
          to: peer,
          message: pkg.name + ' requires ' + peer + ' ' + range + ' but ' + peerVersion + ' is installed',
        })
      }
    }
  }

  // Service conflicts: the same service name registered by several plugins.
  const serviceOwners = new Map<string, string[]>()
  for (const pkg of packages) {
    for (const service of pkg.services) {
      const owners = serviceOwners.get(service) ?? []
      owners.push(pkg.name)
      serviceOwners.set(service, owners)
    }
  }
  for (const [service, owners] of serviceOwners) {
    if (owners.length > 1) {
      issues.push({
        kind: 'service-conflict',
        message: 'service ' + service + ' is registered by ' + owners.join(' and ') + ' (later registrations shadow earlier ones)',
      })
    }
  }

  // Dependency cycles (DFS over edges).
  const adjacency = new Map<string, string[]>()
  for (const edge of edges) {
    const list = adjacency.get(edge.from) ?? []
    list.push(edge.to)
    adjacency.set(edge.from, list)
  }
  const cycles = findCycles(adjacency)
  for (const cycle of cycles) {
    issues.push({
      kind: 'circular-dependency',
      cycle,
      message: 'circular plugin dependency: ' + cycle.join(' → ') + ' — activation may stall',
    })
  }

  // Topological order (Kahn), cycles broken at their first member.
  const topoOrder = topoSort(adjacency, packages.map(pkg => pkg.name))

  return {
    ok: issues.length === 0,
    packages: packages.map(({ entryPath: _ignored, ...rest }) => rest),
    edges,
    topoOrder,
    issues: [...issues, ...extraIssues],
  }
}

/** Find one representative cycle per strongly connected component (small N). */
function findCycles(adjacency: Map<string, string[]>): string[][] {
  const nodes = [...adjacency.keys()]
  const cycles: string[][] = []
  const seen = new Set<string>()
  for (const start of nodes) {
    if (seen.has(start)) continue
    const stack: string[] = []
    const visiting = new Set<string>()
    const walk = (node: string): boolean => {
      if (seen.has(node)) return false
      if (visiting.has(node)) {
        const index = stack.indexOf(node)
        if (index >= 0) {
          const cycle = stack.slice(index).concat(node)
          cycles.push(cycle)
          for (const member of cycle) seen.add(member)
        }
        return true
      }
      visiting.add(node)
      stack.push(node)
      for (const next of adjacency.get(node) ?? []) {
        if (walk(next)) return true
      }
      stack.pop()
      visiting.delete(node)
      return false
    }
    walk(start)
    seen.add(start)
  }
  return cycles
}

/** Kahn topological order; nodes with cycles are appended in input order. */
function topoSort(adjacency: Map<string, string[]>, all: readonly string[]): string[] {
  const indegree = new Map<string, number>()
  for (const node of all) indegree.set(node, 0)
  for (const list of adjacency.values()) {
    for (const target of list) indegree.set(target, (indegree.get(target) ?? 0) + 1)
  }
  const queue = all.filter(node => (indegree.get(node) ?? 0) === 0)
  const order: string[] = []
  while (queue.length > 0) {
    const node = queue.shift()!
    order.push(node)
    for (const next of adjacency.get(node) ?? []) {
      indegree.set(next, (indegree.get(next) ?? 1) - 1)
      if (indegree.get(next) === 0) queue.push(next)
    }
  }
  for (const node of all) {
    if (!order.includes(node)) order.push(node)
  }
  return order
}

/** Turn a package name into a safe row id (mirrors src/index.ts slugify). */
function slugify(name: string): string {
  return name.replace(/^@/, '').replace(/[^a-z0-9-]/gi, '-').toLowerCase()
}

/** Read directory entries defensively (symlinks included). */
function readdirSafe(path: string): { name: string; isDirectory(): boolean; isSymbolicLink(): boolean }[] {
  try {
    return readdirSync(path, { withFileTypes: true }) as unknown as {
      name: string
      isDirectory(): boolean
      isSymbolicLink(): boolean
    }[]
  } catch {
    return []
  }
}
