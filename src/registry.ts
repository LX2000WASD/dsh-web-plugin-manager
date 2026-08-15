/**
 * Static registry index (Phase A of the marketplace rework).
 *
 * The community DSH-Plugins-Marketplace project publishes a CI-built index
 * of every topic:dsh-plugin repository (registry.json, ~2.2MB / .gz ~700KB)
 * every 2 hours. Consuming it gives the marketplace ~3000 entries with zero
 * GitHub API calls and no rate-limit exposure; the existing curated catalog
 * (awesome-dsh-plugins) overlays quality metadata on top of it.
 *
 * Fallback chain (in order):
 *   1. api.github.com contents (token-aware when GH_TOKEN/GITHUB_TOKEN set)
 *   2. jsDelivr CDN (freshness-checked via `generated_at`, ≤6h)
 *   3. raw.githubusercontent.com
 *   4. local disk cache (last successful full index, any age)
 *   5. GitHub search API topic:dsh-plugin (partial by design; never persisted)
 */

import { gunzipSync } from 'node:zlib'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { marketplaceFetch } from './net.ts'

/** One normalized entry from the static index (or the search fallback). */
export interface RegistryRepo {
  readonly full_name: string
  readonly name: string
  readonly description: string | null
  readonly html_url: string
  readonly stargazers_count: number
  readonly updated_at: string
  readonly default_branch: string
  readonly topics: readonly string[]
  readonly license: string | null
  /** Published npm package name (CI-enriched, when the repo has one). */
  readonly pkg_name?: string
  /** Latest version from the repo's package.json (CI-fetched). */
  readonly version?: string
  /** Category stamp from the CI classifier. */
  readonly category?: string
}

/** The community index project (consumed read-only, never a hard dependency). */
export const REGISTRY_OWNER = 'bradeGithub'
export const REGISTRY_REPO = 'DSH-Plugins-Marketplace'
const REGISTRY_FILE = 'registry.json'

/** DSH's own repository is not a plugin — never listed. */
const EXCLUDED_REPO_NAMES = new Set(['deepseek-harness'])

/** jsDelivr CDN caches can lag hours: older indexes are discarded. */
const REGISTRY_MAX_AGE_MS = 6 * 60 * 60 * 1000
/** Search-API fallback cap: the unauthenticated quota is 10/min, keep it small. */
const SEARCH_MAX_PAGES = 10
const SEARCH_PAGE_SIZE = 100

/** Registry index disk cache (inside the plugin-manager cache dir). */
export function registryCacheFile(): string {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'plugin-manager-cache', 'registry-index.json')
}

interface Source {
  readonly url: string
  readonly gz: boolean
  /** CDN-only: discard indexes older than REGISTRY_MAX_AGE_MS. */
  readonly checkFresh?: boolean
  /** api.github.com: carry an auth token when one is configured. */
  readonly token?: boolean
}

/** Candidate index sources, tried in order. */
function registrySources(): Source[] {
  const base = `${REGISTRY_OWNER}/${REGISTRY_REPO}`
  return [
    { url: `https://api.github.com/repos/${base}/contents/${REGISTRY_FILE}.gz`, gz: true, token: true },
    { url: `https://cdn.jsdelivr.net/gh/${base}@main/${REGISTRY_FILE}.gz`, gz: true, checkFresh: true },
    { url: `https://raw.githubusercontent.com/${base}/main/${REGISTRY_FILE}.gz`, gz: true },
    { url: `https://cdn.jsdelivr.net/gh/${base}@main/${REGISTRY_FILE}`, gz: false, checkFresh: true },
    { url: `https://raw.githubusercontent.com/${base}/main/${REGISTRY_FILE}`, gz: false },
  ]
}

/** Normalize one raw repo record (registry.json or search-API shapes). */
export function normalizeRegistryRepo(raw: unknown): RegistryRepo | null {
  if (raw === null || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const fullName = typeof r.full_name === 'string' ? r.full_name : ''
  if (fullName.length === 0) return null
  const name = typeof r.name === 'string' ? r.name : fullName.split('/').pop() ?? fullName
  if (EXCLUDED_REPO_NAMES.has(name)) return null
  let htmlUrl = ''
  try {
    const u = new URL(String(r.html_url ?? ''))
    if (u.protocol === 'https:' && u.host === 'github.com') htmlUrl = u.href
  } catch { /* keep empty */ }
  const pkgName = typeof r.pkg_name === 'string' && r.pkg_name.length > 0 ? r.pkg_name : undefined
  const version = typeof r.version === 'string' && r.version.length > 0 ? r.version : undefined
  const category = typeof r.category === 'string' && r.category.length > 0 ? r.category : undefined
  return {
    full_name: fullName,
    name,
    description: typeof r.description === 'string' ? r.description : null,
    html_url: htmlUrl,
    stargazers_count: typeof r.stargazers_count === 'number' ? r.stargazers_count : 0,
    updated_at: typeof r.updated_at === 'string' ? r.updated_at : '',
    default_branch: typeof r.default_branch === 'string' ? r.default_branch : 'main',
    topics: Array.isArray(r.topics) ? r.topics.filter((t): t is string => typeof t === 'string') : [],
    license: typeof r.license === 'string'
      ? r.license
      : (r.license !== null && typeof r.license === 'object'
        ? String((r.license as { spdx_id?: unknown }).spdx_id ?? '') || null
        : null),
    ...(pkgName !== undefined ? { pkg_name: pkgName } : {}),
    ...(version !== undefined ? { version } : {}),
    ...(category !== undefined ? { category } : {}),
  }
}

/** Normalize + deduplicate a parsed index payload; null when unusable. */
function collectRepos(raw: unknown): RegistryRepo[] | null {
  if (raw === null || typeof raw !== 'object') return null
  const list = (raw as { repos?: unknown }).repos
  if (!Array.isArray(list) || list.length === 0) return null
  const seen = new Set<string>()
  const out: RegistryRepo[] = []
  for (const entry of list) {
    const repo = normalizeRegistryRepo(entry)
    if (repo === null || seen.has(repo.full_name)) continue
    seen.add(repo.full_name)
    out.push(repo)
  }
  return out.length > 0 ? out : null
}

/** Fetch the index through every network source; null when all fail. */
export async function fetchRegistryRepos(): Promise<RegistryRepo[] | null> {
  for (const source of registrySources()) {
    try {
      const headers: Record<string, string> = { 'user-agent': 'dsh-web-plugin-manager' }
      if (source.token) {
        headers['accept'] = 'application/vnd.github.raw'
        const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
        if (token !== undefined && token.length > 0) headers['authorization'] = `Bearer ${token}`
      }
      const response = await marketplaceFetch(source.url, { headers, redirect: 'follow' })
      if (!response.ok) continue
      const buffer = Buffer.from(await response.arrayBuffer())
      let text: string
      if (source.gz) {
        try {
          text = gunzipSync(buffer).toString('utf8')
        } catch {
          continue
        }
      } else {
        text = buffer.toString('utf8')
      }
      const data = JSON.parse(text) as { generated_at?: unknown; repos?: unknown }
      if (source.checkFresh === true) {
        const age = Date.now() - Date.parse(typeof data.generated_at === 'string' ? data.generated_at : '')
        if (Number.isNaN(age) || age > REGISTRY_MAX_AGE_MS) continue
      }
      const repos = collectRepos(data)
      if (repos !== null) return repos
    } catch { /* try the next source */ }
  }
  return null
}

/** Search-API fallback (topic:dsh-plugin). Partial by design — never cached. */
export async function fetchSearchFallback(): Promise<RegistryRepo[] | null> {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
  const collected: RegistryRepo[] = []
  const seen = new Set<string>()
  const query = encodeURIComponent('topic:dsh-plugin')
  for (let page = 1; page <= SEARCH_MAX_PAGES; page++) {
    try {
      const headers: Record<string, string> = { 'user-agent': 'dsh-web-plugin-manager', accept: 'application/vnd.github+json' }
      if (token !== undefined && token.length > 0) headers['authorization'] = `Bearer ${token}`
      const url = `https://api.github.com/search/repositories?q=${query}&sort=updated&order=desc&per_page=${SEARCH_PAGE_SIZE}&page=${page}`
      const response = await marketplaceFetch(url, { headers })
      if (!response.ok) break
      const data = await response.json() as { items?: unknown }
      if (!Array.isArray(data.items)) break
      let any = false
      for (const entry of data.items) {
        const repo = normalizeRegistryRepo(entry)
        if (repo === null || seen.has(repo.full_name)) continue
        seen.add(repo.full_name)
        collected.push(repo)
        any = true
      }
      if (!any || data.items.length < SEARCH_PAGE_SIZE) break
    } catch {
      break
    }
  }
  return collected.length > 0 ? collected : null
}

/** Last successful full index from disk (any age — better than nothing). */
export function readRegistryCache(): RegistryRepo[] | null {
  try {
    const raw = JSON.parse(readFileSync(registryCacheFile(), 'utf8')) as { repos?: unknown }
    return collectRepos(raw)
  } catch { /* no/broken cache */ }
  return null
}

/** Persist a successful full index (never the search fallback). */
export function writeRegistryCache(repos: RegistryRepo[]): void {
  try {
    mkdirSync(dirname(registryCacheFile()), { recursive: true })
    writeFileSync(registryCacheFile(), JSON.stringify({
      savedAt: new Date().toISOString(),
      count: repos.length,
      repos,
    }, undefined, 2) + '\n')
  } catch { /* cache write is best-effort */ }
}
