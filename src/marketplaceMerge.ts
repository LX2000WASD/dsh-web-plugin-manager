/**
 * Marketplace pipeline: everything between the raw sources and the REST
 * response — catalog/markdown fetch, registry merge, star enrichment,
 * installed-flagging, dsh.so overlay, blocklist filter and same-package
 * dedupe (index.ts keeps only the cache closures and route wiring).
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { GITHUB_UA, marketplaceFetch } from './net.ts'
import {
  fetchSearchFallback, functionalTopics, readRegistryCache, writeRegistryCache,
  type DshSoEntry, type RegistryRepo,
} from './registry.ts'
import { loadKindRecords, normalizeRepoRef, pruneGhostRecords, slugDirName, type KindRecord } from './kinds.ts'
import { dshHome, isSafeProfileName, profileDir, readManifest } from './paths.ts'
import { readPackageInfo } from './installFlow.ts'
import { compareVersions } from './match.ts'
import type { MarketplaceItem } from './types.ts'

/** Marketplace snapshot TTL and cache format version. */
export const MARKETPLACE_TTL = 24 * 60 * 60 * 1000
export const MARKETPLACE_CACHE_VERSION = 3

/**
 * In-process marketplace mirror: the merged listing is profile-independent,
 * so profile switches (which only recompute installed flags) read this
 * instead of the ~1.7MB disk file. TTL mirrors the disk cache; invalidated
 * on every fresh fetch (writeCache).
 */
export let marketplaceMemoryCache: { at: number; items: MarketplaceItem[]; source?: string } | null = null
/** Serialization tail for concurrent marketplace refreshes (audit M13). */
export let marketplaceRefreshTail: Promise<void> = Promise.resolve()

/** The in-memory mirror record (see readMemoryCache). */
export interface MemoryCache {
  at: number
  items: MarketplaceItem[]
  source?: string
}

/** Read the in-process mirror, or null when cold/expired (MARKETPLACE_TTL). */
export function readMemoryCache(): MemoryCache | null {
  if (marketplaceMemoryCache !== null && Date.now() - marketplaceMemoryCache.at < MARKETPLACE_TTL) {
    return marketplaceMemoryCache
  }
  return null
}

/** Publish a fresh listing to the in-process mirror (on every fresh fetch). */
export function writeMemoryCache(items: MarketplaceItem[], source: string): void {
  marketplaceMemoryCache = { at: Date.now(), items, source }
}

/**
 * Serialize concurrent marketplace refreshes (audit M13): the caller awaits
 * `previous` (every earlier refresh finished), runs its walk, and MUST call
 * `release` so the next queued refresh can start.
 */
export function beginMarketplaceRefresh(): { previous: Promise<void>; release(): void } {
  const previous = marketplaceRefreshTail
  let release: () => void = () => { /* noop */ }
  marketplaceRefreshTail = new Promise<void>(resolve => { release = resolve })
  return { previous, release }
}

/**
 * Negative-cache TTL: after a total source failure the failure reason is
 * served from disk instead of re-running the full GitHub round-trip on
 * every page visit (the reason is typically environmental — proxy or
 * network — and will not change within minutes).
 */
export const MARKETPLACE_FAILURE_TTL = 5 * 60 * 1000

/** The maintained awesome-dsh-plugins catalog (structured source of truth). */
export const CATALOG_OWNER = 'AdamPlatin123'
export const CATALOG_REPO = 'awesome-dsh-plugins'
export const CATALOG_BRANCH = 'main'
export const CATALOG_RAW = `https://raw.githubusercontent.com/${CATALOG_OWNER}/${CATALOG_REPO}/${CATALOG_BRANCH}`
export const CATALOG_API = `https://api.github.com/repos/${CATALOG_OWNER}/${CATALOG_REPO}`

/** One structured catalog entry (catalog/plugins/<github-id>.json). */
export interface CatalogEntry {
  readonly id?: unknown
  readonly repository?: { readonly full_name?: unknown; readonly url?: unknown }
  readonly package?: { readonly name?: unknown; readonly entry?: unknown }
  readonly curation?: { readonly state?: unknown; readonly category?: unknown; readonly description_zh?: unknown }
  readonly lifecycle?: { readonly state?: unknown }
}

/** Derive the marketplace status label from a catalog entry. */
export function catalogStatus(entry: CatalogEntry): string {
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
export async function fetchCatalogItems(): Promise<MarketplaceItem[]> {
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
  // Bounded concurrency: every entry is its own HTTP round trip — a serial
  // loop paid list-size × RTT on every refresh. 8 workers keep us polite
  // toward the catalog host without a serial tail; each entry parses
  // independently, so one failure skips only itself.
  const WORKERS = 8
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(WORKERS, files.length) }, async () => {
    while (cursor < files.length) {
      const file = files[cursor]!
      cursor += 1
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
          installed: false,
          updateAvailable: false,
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
  }))
  if (seen.size === 0) throw new Error('no usable entries parsed from the catalog')
  return [...seen.values()]
}

/**
 * Fallback source: parse the human-curated PLUGINS.md table
 * (| name | [org/repo](url) | description | status |), tracking the current
 * category section and deduplicating by repository (✅ wins over 待测).
 */
export async function fetchMarkdownItems(): Promise<MarketplaceItem[]> {
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
    installed: false,
    updateAvailable: false,
    ...(row.category.length > 0 ? { category: row.category } : {}),
  }))
}

/**
 * Merge the two sources into one listing: catalog entries keep their
 * structure (package name, lifecycle) and are enriched with the curated
 * description / evidence status / category from PLUGINS.md when present;
 * PLUGINS.md-only repositories are appended. Deduplication is by repository.
 */
export function mergeMarketplace(catalog: readonly MarketplaceItem[], markdown: readonly MarketplaceItem[]): MarketplaceItem[] {
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
 *
 * Bounded worker pool (2, cursor mode): a serial loop paid list-size × RTT on
 * every fresh listing. Two workers halve that without burning the shared
 * per-IP quota faster in bursts. Results are written by index so the output
 * order always matches the input. The rate-limit flag is only consulted
 * BEFORE starting a fetch: responses already in flight when the flag is set
 * are processed normally, and every entry claimed after it is set falls back
 * to the prior snapshot without a request.
 */
export async function enrichRepos(items: MarketplaceItem[], prior: Map<string, MarketplaceItem>): Promise<MarketplaceItem[]> {
  let rateLimited = false
  const out = new Array<MarketplaceItem>(items.length)
  const fallback = (item: MarketplaceItem): MarketplaceItem => {
    const prev = prior.get(item.name)
    return prev !== undefined
      ? { ...item, stars: prev.stars, updatedAt: prev.updatedAt, createdAt: prev.createdAt }
      : item
  }
  const WORKERS = 2
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const idx = cursor++
      const item = items[idx]!
      if (rateLimited) {
        out[idx] = fallback(item)
        continue
      }
      try {
        const response = await marketplaceFetch('https://api.github.com/repos/' + item.name, { headers: GITHUB_UA })
        if (response.status === 403 || response.status === 429) {
          rateLimited = true
          out[idx] = fallback(item)
          continue
        }
        if (response.ok) {
          const repo = await response.json() as { stargazers_count?: unknown; updated_at?: unknown; created_at?: unknown }
          out[idx] = {
            ...item,
            stars: typeof repo.stargazers_count === 'number' ? repo.stargazers_count : 0,
            updatedAt: typeof repo.updated_at === 'string' ? repo.updated_at : '',
            createdAt: typeof repo.created_at === 'string' ? repo.created_at : '',
          }
        } else {
          out[idx] = item
        }
      } catch {
        out[idx] = item
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(WORKERS, items.length) }, () => worker()))
  return out
}

/** Identity of a git-cache clone dir (mirrors prepareInstallSource naming: github.com-owner-repo). */
export function gitCacheIdentity(source: string): string | null {
  // The clone cache strips a trailing .git from the dir name
  // (prepareInstallSource) — the identity must too, or the installed
  // detection misses `git+https://…repo.git` sources (audit).
  const match = /github\.com[-/]([^/\s]+?)[-/]([^/\s]+?)(?:\.git)?$/i.exec(source)
  return match !== null ? `github.com-${match[1]!.toLowerCase()}-${match[2]!.toLowerCase()}` : null
}

/** Lowercase directory-entry set of one directory (empty when missing). */
export function dirNameSet(dir: string): Set<string> {
  try {
    const out = new Set<string>()
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) out.add(entry.name.toLowerCase())
    }
    return out
  } catch {
    return new Set()
  }
}

/** One registry-index entry in the wire MarketplaceItem shape. */
export function registryToItem(repo: RegistryRepo): MarketplaceItem {
  return {
    name: repo.full_name,
    displayName: repo.name,
    ...(repo.description !== null && repo.description.length > 0 ? { description: repo.description } : {}),
    stars: repo.stargazers_count,
    updatedAt: repo.updated_at,
    createdAt: '',
    url: repo.html_url.length > 0 ? repo.html_url : 'https://github.com/' + repo.full_name,
    ...(functionalTopics(repo.topics).length > 0 ? { topics: functionalTopics(repo.topics) } : {}),
    ...(repo.pkg_name !== undefined ? { packageName: repo.pkg_name } : {}),
    ...(repo.version !== undefined ? { latestVersion: repo.version } : {}),
    ...(repo.category !== undefined ? { category: repo.category } : {}),
    installed: false,
    updateAvailable: false,
  }
}

/**
 * Merge the curated layer (catalog + PLUGINS.md) onto the registry base:
 * curated status / description / category / packageName / lifecycle win on
 * conflicts, and curated-only repositories are appended.
 */
export function mergeRegistryWithCurated(registry: readonly RegistryRepo[], curated: readonly MarketplaceItem[]): MarketplaceItem[] {
  const by = new Map(curated.map(item => [item.name, item]))
  const out: MarketplaceItem[] = []
  const seen = new Set<string>()
  for (const repo of registry) {
    const item = registryToItem(repo)
    const curatedItem = by.get(repo.full_name)
    if (curatedItem !== undefined) {
      out.push({
        ...item,
        ...(curatedItem.description !== undefined && item.description === undefined ? { description: curatedItem.description } : {}),
        // A verified evidence status wins over an unverified registry entry.
        ...((item.status === undefined || item.status.length === 0 || item.status === '待测') && curatedItem.status !== undefined ? { status: curatedItem.status } : {}),
        ...(item.category === undefined && curatedItem.category !== undefined ? { category: curatedItem.category } : {}),
        ...(item.packageName === undefined && curatedItem.packageName !== undefined ? { packageName: curatedItem.packageName } : {}),
        ...(curatedItem.lifecycle !== undefined ? { lifecycle: curatedItem.lifecycle } : {}),
      })
    } else {
      out.push(item)
    }
    seen.add(repo.full_name)
  }
  for (const item of curated) {
    if (!seen.has(item.name)) {
      out.push(item)
      seen.add(item.name)
    }
  }
  return out
}

/** Server-side installed index for one profile (built once per listing). */
export interface InstalledIndex {
  /** Lowercase npm package name → installed version. */
  readonly packageVersions: ReadonlyMap<string, string>
  /** Lowercase owner/repo from package manifests (bidirectional) → version. */
  readonly repoVersions: ReadonlyMap<string, string>
  /** git-cache identity (github.com-owner-repo) → version. */
  readonly gitVersions: ReadonlyMap<string, string>
  /** Directory names under ~/.dsh/skills (lowercase). */
  readonly skills: ReadonlySet<string>
  /** Directory names under ~/.dsh/.agent-presets (lowercase). */
  readonly presets: ReadonlySet<string>
}

/**
 * Process-level cache for buildInstalledIndex: flagMarketplaceItems runs on
 * every marketplace request path (including profile switches, which only
 * recompute installed flags) and each rebuild costs one readFileSync +
 * JSON.parse per dependency. A short TTL collapses request-path jitter
 * (a page load fires several listings) into one build; installs/removes/
 * updates invalidate explicitly at their single choke point in installFlow,
 * so an external change is visible at most one TTL later — 5s is
 * imperceptible for a marketplace listing.
 */
const INSTALLED_INDEX_TTL = 5_000
const installedIndexCache = new Map<string, { at: number; index: InstalledIndex | null }>()

/**
 * Drop the cached installed index for one profile (every profile when no
 * name is given). Called by installFlow after a successful install/remove/
 * update so the next marketplace request rebuilds immediately instead of
 * serving a stale installed/updateAvailable flag for up to the TTL.
 * Enabling/disabling (setEnabled) does not change installed-ness and must
 * NOT invalidate.
 */
export function invalidateInstalledIndex(profile?: string): void {
  if (profile === undefined) installedIndexCache.clear()
  else installedIndexCache.delete(profile)
}

/** Build the installed index for one profile; null when the profile is unusable. */
export function buildInstalledIndex(profile: string): InstalledIndex | null {
  const cached = installedIndexCache.get(profile)
  if (cached !== undefined && Date.now() - cached.at < INSTALLED_INDEX_TTL) return cached.index
  const index = buildInstalledIndexUncached(profile)
  installedIndexCache.set(profile, { at: Date.now(), index })
  return index
}

/** Uncached build (the original per-dependency read walk; see the cache above). */
function buildInstalledIndexUncached(profile: string): InstalledIndex | null {
  if (profile.length === 0 || !isSafeProfileName(profile)) return null
  const dir = profileDir(profile)
  if (!existsSync(dir)) return null
  const manifest = readManifest(dir) as { dependencies?: Record<string, string> }
  const deps = manifest.dependencies ?? {}
  const packageVersions = new Map<string, string>()
  const repoVersions = new Map<string, string>()
  const gitVersions = new Map<string, string>()
  for (const name of Object.keys(deps)) {
    const info = readPackageInfo(dir, name)
    const version = info.version ?? ''
    packageVersions.set(name.toLowerCase(), version)
    if (info.repository !== undefined) {
      const ref = normalizeRepoRef(info.repository)
      if (ref !== null) repoVersions.set(ref, version)
    }
    const source = deps[name]
    if (source !== undefined) {
      const identity = gitCacheIdentity(source)
      if (identity !== null) gitVersions.set(identity, version)
    }
  }
  return {
    packageVersions,
    repoVersions,
    gitVersions,
    skills: dirNameSet(join(dshHome(), 'skills')),
    presets: dirNameSet(join(dshHome(), '.agent-presets')),
  }
}

/**
 * Detect whether one marketplace item is installed in the profile:
 * 0. kind install records (marketplace-installed skills/presets/plugins);
 * 1. repository identity (bidirectional — package name may differ from repo);
 * 2. package name (registry pkg_name or repo basename — the common npm==repo);
 * 3. git-cache clone identity (link:<plugin-manager-src>/github.com-o-r);
 * 4. skills / agent-presets directories (~/.dsh/skills|.agent-presets/<slug>).
 * Update availability compares the installed version against the registry
 * index version (CI-fetched from the repo's package.json) — strictly newer
 * only, so repo rollbacks never report a false update.
 */
export function flagItemInstalled(item: MarketplaceItem, index: InstalledIndex | null, records: ReadonlyMap<string, KindRecord>): MarketplaceItem {
  if (index === null) return { ...item, installed: false, updateAvailable: false }
  let installed = false
  let version: string | undefined
  let installedKind: string | undefined
  const hit = (found: boolean, hitVersion?: string): void => {
    if (!found) return
    installed = true
    if (version === undefined && hitVersion !== undefined && hitVersion.length > 0) version = hitVersion
  }
  // 0. install records (marketplace-installed of any kind)
  const record = records.get(item.name.toLowerCase())
  if (record !== undefined) {
    installed = true
    installedKind = record.type
    if (record.version !== null && record.version.length > 0) version = record.version
  }
  // 1. repository identity
  const repoRef = item.name.toLowerCase()
  hit(index.repoVersions.has(repoRef), index.repoVersions.get(repoRef))
  // 2. package name
  const candidates = new Set<string>()
  if (item.packageName !== undefined && item.packageName.length > 0) candidates.add(item.packageName.toLowerCase())
  candidates.add(item.displayName.toLowerCase())
  for (const candidate of candidates) {
    hit(index.packageVersions.has(candidate), index.packageVersions.get(candidate))
  }
  // 3. git-cache clone identity
  const gitId = `github.com-${item.name.toLowerCase().replace('/', '-')}`
  hit(index.gitVersions.has(gitId), index.gitVersions.get(gitId))
  // 4. skills / presets directories
  const slug = slugDirName(item.displayName)
  if (index.skills.has(slug) || index.presets.has(slug)) hit(true)
  const updateAvailable = installed
    && version !== undefined
    && item.latestVersion !== undefined
    && compareVersions(version, item.latestVersion) < 0
  return {
    ...item,
    installed,
    ...(version !== undefined ? { installedVersion: version } : {}),
    ...(installedKind !== undefined ? { installedKind } : {}),
    updateAvailable,
  }
}

/**
 * Flag every item with a bounded worker pool (registry lists can reach
 * thousands of entries; serial stat/read would stall the first paint).
 */
export async function flagMarketplaceItems(items: readonly MarketplaceItem[], profile: string): Promise<MarketplaceItem[]> {
  await pruneGhostRecords()
  const index = buildInstalledIndex(profile)
  const records = await loadKindRecords()
  const out = new Array<MarketplaceItem>(items.length)
  const workers = Math.min(12, items.length)
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const idx = cursor++
      out[idx] = flagItemInstalled(items[idx]!, index, records)
    }
  }
  await Promise.all(Array.from({ length: workers }, () => worker()))
  return out
}

/** Overlay the dsh.so verification/security metadata onto the listing. */
export function overlayDshSo(items: readonly MarketplaceItem[], dshSo: readonly DshSoEntry[] | null): MarketplaceItem[] {
  if (dshSo === null || dshSo.length === 0) return [...items]
  // dsh.so keys entries by the repo basename (no owner segment), so a
  // basename shared by several owners (alice/tools vs bob/tools) cannot be
  // attributed safely — skip the overlay for duplicated basenames instead of
  // mis-tagging one owner with the other's metadata (audit).
  const nameCounts = new Map<string, number>()
  for (const item of items) {
    const key = item.displayName.toLowerCase()
    nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1)
  }
  const byName = new Map(dshSo.map(entry => [entry.name.toLowerCase(), entry]))
  return items.map(item => {
    const key = item.displayName.toLowerCase()
    if (nameCounts.get(key) !== 1) return item
    const overlay = byName.get(key)
    if (overlay === undefined) return item
    return {
      ...item,
      ...(overlay.verification !== undefined
        ? { verification: { level: overlay.verification.level, label: overlay.verification.label } }
        : {}),
      ...(overlay.security !== undefined
        ? { security: { riskLevel: overlay.security.riskLevel, status: overlay.security.status } }
        : {}),
    }
  })
}

/**
 * Filter out repositories marked as non-installable (detected as neither
 * plugin nor skill nor preset). Applied to every listing path — the 24h
 * cache, fresh fetches and the last-resort cache all go through the same
 * filter, so a blocked repo stays hidden until explicitly unblocked.
 */
export function filterBlockedRepos(items: readonly MarketplaceItem[], blocked: ReadonlySet<string>): MarketplaceItem[] {
  if (blocked.size === 0) return [...items]
  return items.filter(item => !blocked.has(normalizeRepoRef(item.name) ?? item.name))
}

/** Blocked-repo summary carried on every listing response. */
export function blockedMeta(blocked: ReadonlySet<string>): { blocked?: number; blockedRepos?: string[] } {
  return blocked.size > 0
    ? { blocked: blocked.size, blockedRepos: [...blocked].slice(0, 20) }
    : {}
}

/**
 * Same-package deduplication: the same npm package cannot be installed
 * twice, so entries sharing a pkg_name collapse to one — the installed one
 * wins (including manually installed low-star repos), otherwise the
 * higher-star entry. The dropped count is surfaced to the client.
 */
export function dedupeMarketplace(items: readonly MarketplaceItem[]): { items: MarketplaceItem[]; dropped: number } {
  const rank = (item: MarketplaceItem): number => (item.installed ? 1e12 : 0) + item.stars
  const byKey = new Map<string, MarketplaceItem>()
  let dropped = 0
  for (const item of items) {
    const key = item.packageName !== undefined && item.packageName.length > 0
      ? 'pkg:' + item.packageName.toLowerCase()
      : 'repo:' + item.name.toLowerCase()
    const prev = byKey.get(key)
    if (prev === undefined) {
      byKey.set(key, item)
      continue
    }
    if (rank(item) > rank(prev)) byKey.set(key, item)
    dropped++
  }
  return { items: [...byKey.values()], dropped }
}
