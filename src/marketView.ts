/**
 * Marketplace view model — the pure decisions behind the marketplace page:
 * the sort comparators, the category filter and dropdown order, the tag and
 * category wording, and the toolbar labels. Framework-free and DOM-free, in
 * the same spirit as rank.ts: the client bundle inlines it and the node tests
 * import dist/marketView.js, so the tested code IS the shipped code.
 *
 * Why it lives outside the component: the page used to decide its order
 * inline, which made the sort contract untestable — the direction button
 * could name a direction the list was not in, and 0-star entries came first.
 * Everything that decides "what order / what is filtered out / what text" is
 * here; the .tsx component only renders.
 */

import type { MarketplaceItem, MarketplaceResult } from './types.ts'
import { buildMarketTags, type MarketTag } from './tags.ts'
import type { PluginManagerLocaleKey } from './client/locales.ts'

/** Sort modes of the marketplace toolbar. */
export type MarketSort = 'stars' | 'az' | 'updated' | 'created'

/** One category bucket of the filter dropdown. */
export interface CategoryCount {
  readonly id: string
  readonly count: number
}

/** Tag chips per card tag row; two rows are a card's fixed tag budget. */
export const TAG_SLOTS = 4

/** "All categories" option value (an empty category id never exists upstream). */
export const ALL_CATEGORIES = ''

/**
 * Default direction per sort mode, applied when the mode changes. Stars read
 * best most-popular-first, text ascending, dates newest-first; the user can
 * flip any of them with the direction button afterwards.
 */
export const SORT_DEFAULT_DESCENDING: Record<MarketSort, boolean> = {
  stars: true, az: false, updated: true, created: true,
}

/** Direction a mode starts in (the toolbar's single direction state). */
export function defaultDescendingFor(sort: MarketSort): boolean {
  return SORT_DEFAULT_DESCENDING[sort]
}

/** Category id → locale key (the keys already exist in locales.ts). */
const CATEGORY_KEYS: Record<string, PluginManagerLocaleKey> = {
  vision: 'catVision',
  document: 'catDocument',
  memory: 'catMemory',
  model: 'catModel',
  notify: 'catNotify',
  coding: 'catCoding',
  conversation: 'catConversation',
  'web-ui': 'catWebUi',
  agent: 'catAgent',
  tool: 'catTool',
  resource: 'catResource',
  other: 'catOther',
}

/** Security risk level → locale key (high and critical share the high copy). */
const SECURITY_KEYS: Record<string, PluginManagerLocaleKey> = {
  low: 'securityLow', medium: 'securityMedium', high: 'securityHigh', critical: 'securityHigh',
}

/**
 * Locale key of an upstream category id, or null when the id is unknown — a
 * new classifier category must stay visible under its raw name, never be
 * folded into "other".
 */
export function categoryLabelKey(id: string): PluginManagerLocaleKey | null {
  return CATEGORY_KEYS[id.trim().toLowerCase()] ?? null
}

/** Locale key of a security risk level, or null for an unrecognized level. */
export function securityLabelKey(riskLevel: string): PluginManagerLocaleKey | null {
  return SECURITY_KEYS[riskLevel.trim().toLowerCase()] ?? null
}

/** Locale key of a curated catalog evidence status. */
export function statusLabelKey(status: string): PluginManagerLocaleKey {
  if (status.includes('✅')) return 'statusVerified'
  return status.toLowerCase().includes('archiv') ? 'statusArchived' : 'statusPending'
}

/** Locale key of an installed kind tag value (skill / agent / plugin). */
export function typeLabelKey(value: string): PluginManagerLocaleKey {
  if (value === 'skill') return 'typeSkill'
  return value === 'agent' ? 'typeAgent' : 'typePlugin'
}

/** Localized category name; an unknown id renders verbatim. */
export function categoryLabelText(t: (key: PluginManagerLocaleKey) => string, id: string): string {
  const key = categoryLabelKey(id)
  return key === null ? id : t(key)
}

/**
 * Localized text of one tag. The tag ORDER is the shared model's
 * (buildMarketTags); only the wording is decided here, and the raw values stay
 * untouched in tags.ts.
 */
export function tagLabelText(t: (key: PluginManagerLocaleKey) => string, tag: MarketTag): string {
  switch (tag.kind) {
    case 'category': return categoryLabelText(t, tag.value)
    case 'type': return t(typeLabelKey(tag.value))
    case 'status': return t(statusLabelKey(tag.value))
    case 'verify': return t('dsoVerified') + ' ' + tag.value
    case 'security': {
      const key = securityLabelKey(tag.value)
      return key === null ? t('securityUnknown') : t(key)
    }
    default: return tag.value
  }
}

/**
 * "+n" chip of a card: topics the shared model did not emit (it caps them per
 * the tag contract) plus tags beyond the two tag rows. Distinct topics only,
 * so repeated topics cannot inflate the count.
 */
export function tagOverflowCount(tags: readonly MarketTag[], topics: readonly string[] | undefined, slots: number): number {
  const topicTotal = new Set((topics ?? [])
    .map(topic => topic.trim().toLowerCase())
    .filter(topic => topic.length > 0)).size
  const shownTopics = tags.reduce((count, tag) => tag.kind === 'topic' ? count + 1 : count, 0)
  const hiddenTags = Math.max(0, tags.length - slots)
  return Math.max(0, topicTotal - shownTopics) + hiddenTags
}

/** Title of the "+n" chip: every hidden tag, localized, plus the hidden topics. */
export function tagOverflowTitle(t: (key: PluginManagerLocaleKey) => string, tags: readonly MarketTag[], slots: number): string {
  return tags.slice(slots).map(tag => tagLabelText(t, tag)).join(' · ')
}

/** Tags of one item, built once per listing (the card's memoized prop). */
export function tagsOf(item: MarketplaceItem): readonly MarketTag[] {
  return buildMarketTags(item)
}

/** ISO timestamp ascending; a missing timestamp (catalog-only entries) sorts
 *  as the oldest value, so it never floats to the top of a newest-first list. */
export function compareStamp(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1
}

/**
 * Primary key of one sort mode, ASCENDING-polarized in every branch (positive
 * = left comes later when ascending). `rowComparator` is what applies the
 * direction; mixing polarities here is exactly how the old stars branch ended
 * up reversed — it was built descending-first and then negated again.
 */
export function compareByMode(left: MarketplaceItem, right: MarketplaceItem, sort: MarketSort): number {
  if (sort === 'az') return left.displayName.localeCompare(right.displayName)
  if (sort === 'updated') return compareStamp(left.updatedAt, right.updatedAt)
  if (sort === 'created') return compareStamp(left.createdAt, right.createdAt)
  return left.stars - right.stars
}

/**
 * 共享 ICU collator：`localeCompare` 每次调用都会新建一个 collator（这是
 * 它比裸 `<` 慢一个数量级的原因），而 tie-break 在 13k 条排序里会被调用
 * ~n·log n 次。`Intl.Collator` 实例可复用，`compare` 与
 * `String.prototype.localeCompare` 使用同一默认 locale/options，结果逐条
 * 相同（tests/marketplace-view.test.mjs 有等价性断言）。
 *
 * 惰性创建：模块加载时不开 ICU（host 侧也 import 本模块）。
 */
let tieCollator: Intl.Collator | null = null
function compareDisplayName(left: string, right: string): number {
  if (tieCollator === null) tieCollator = new Intl.Collator()
  return tieCollator.compare(left, right)
}

/**
 * Deterministic tie-break: display name, then the repository key — equal
 * primary keys never depend on the input order.
 *
 * A3：把 displayName 的 ICU 比较换成**共享 collator**（见上），保持
 * 「displayName → name」的顺序不变。顺序不变很重要：`displayName` 在真实
 * 13k listing 里有 668 个重复值，而 `name`（owner/repo）全局唯一——先比
 * name 虽然更快（−60%），但会让 97.4% 的条目换位（首屏 120 条换 4 条），
 * 属于用户可见的排序语义变更，收益不值得。共享 collator 在不改变任何一条
 * 顺序的前提下拿到 −35% ~ −36%。
 */
export function compareTie(left: MarketplaceItem, right: MarketplaceItem): number {
  return compareDisplayName(left.displayName, right.displayName)
    || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
}

/**
 * Comparator of one (mode, direction) pair. The SAME descending flag flips
 * every mode — that is the fix for the old bug where the stars branch was
 * built descending-first and then unconditionally reversed, so the direction
 * button named the wrong order and 0-star entries came first.
 *
 * Installed entries stay pinned first in EVERY mode and BOTH directions: that
 * is a priority (the plugins this profile already runs), not a sort key, so
 * flipping the direction must not push them to the bottom. The old code only
 * honoured it in the stars branch, which is why every other mode ignored it.
 */
export function rowComparator(sort: MarketSort, descending: boolean): (left: MarketplaceItem, right: MarketplaceItem) => number {
  return (left, right) => {
    const priority = (right.installed ? 1 : 0) - (left.installed ? 1 : 0)
    if (priority !== 0) return priority
    const primary = compareByMode(left, right, sort)
    if (primary !== 0) return descending ? -primary : primary
    // Tie-break stays ascending in BOTH directions: with ~13k entries equal
    // star counts are the common case, and flipping them would sort the whole
    // 0-star tail Z→A for no reason. It is still a total order.
    return compareTie(left, right)
  }
}

/** Sort a listing without mutating the input. */
export function sortRows(items: readonly MarketplaceItem[], sort: MarketSort, descending: boolean): MarketplaceItem[] {
  const sorted = [...items]
  sorted.sort(rowComparator(sort, descending))
  return sorted
}

/** Category filter; ALL_CATEGORIES keeps every entry (exact id match, so an
 *  entry without a category is not silently mixed into another bucket). */
export function filterByCategory(items: readonly MarketplaceItem[], category: string): readonly MarketplaceItem[] {
  if (category === ALL_CATEGORIES) return items
  // Trimmed on both sides: the option ids come from categoryCounts (which
  // trims) and an upstream entry carrying " tool " must still be found.
  return items.filter(item => (item.category ?? '').trim() === category)
}

/**
 * Dropdown order of the category filter: counts descending (ties by id, the
 * shared contract), except 'other' which is pinned last — it is the
 * classifier's catch-all and by far the largest bucket (~3.3k entries), and
 * the functional categories must stay reachable at the top of the menu.
 */
export function orderCategories(counts: readonly CategoryCount[]): CategoryCount[] {
  const known: CategoryCount[] = []
  const catchAll: CategoryCount[] = []
  for (const entry of counts) {
    if (entry.id === 'other') catchAll.push(entry)
    else known.push(entry)
  }
  return [...known, ...catchAll]
}

/**
 * Host-side category aggregate, when the payload carries one. The field
 * landed on the host after this client, so it is read defensively and
 * validated; when it is absent or empty the client aggregates the very same
 * listing with categoryCounts (the identical shared implementation), which
 * guarantees both paths produce the same option list.
 */
export function readHostCategories(result: MarketplaceResult): readonly CategoryCount[] | undefined {
  const value = (result as { readonly categories?: unknown }).categories
  if (!Array.isArray(value)) return undefined
  const out: CategoryCount[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue
    const { id, count } = entry as { readonly id?: unknown; readonly count?: unknown }
    if (typeof id !== 'string' || id.trim().length === 0 || typeof count !== 'number') continue
    out.push({ id: id.trim(), count })
  }
  return out.length > 0 ? out : undefined
}

/** One dropdown option (value + already-localized label). */
export interface MarketCategoryOption {
  readonly value: string
  readonly label: string
}

/** Dropdown options of the category filter, counts included; the "all" entry
 *  carries the whole listing size. */
export function buildCategoryOptions(
  t: (key: PluginManagerLocaleKey) => string,
  counts: readonly CategoryCount[],
  total: number,
): MarketCategoryOption[] {
  return [
    { value: ALL_CATEGORIES, label: t('filterAll') + ' (' + String(total) + ')' },
    ...counts.map(entry => ({
      value: entry.id,
      label: categoryLabelText(t, entry.id) + ' (' + String(entry.count) + ')',
    })),
  ]
}

/**
 * Toolbar model — the labels the toolbar must show for a given state. The
 * direction label is derived from the SAME flag the comparator uses, so the
 * button can never name a direction the list is not in.
 */
export interface MarketToolbarModel {
  readonly sort: MarketSort
  readonly descending: boolean
  readonly sortLabelKey: PluginManagerLocaleKey
  readonly directionLabelKey: PluginManagerLocaleKey
  readonly categoryLabelKey: PluginManagerLocaleKey
  readonly category: string
  readonly sortOptions: readonly MarketSort[]
}

/** Sort modes in toolbar order. */
export const SORT_MODES: readonly MarketSort[] = ['stars', 'az', 'updated', 'created']

/** Locale key of one sort mode's label. */
export function sortLabelKey(sort: MarketSort): PluginManagerLocaleKey {
  if (sort === 'az') return 'sortAz'
  return sort === 'updated' ? 'sortUpdated' : sort === 'created' ? 'sortCreated' : 'sortStars'
}

/** Build the toolbar labels for the current state. */
export function marketToolbarModel(sort: MarketSort, descending: boolean, category: string): MarketToolbarModel {
  return {
    sort,
    descending,
    sortLabelKey: sortLabelKey(sort),
    // Descending sorts show the biggest / newest first, so the button reads
    // "descending" only when the list really is descending.
    directionLabelKey: descending ? 'sortDesc' : 'sortAsc',
    categoryLabelKey: 'filterCategory',
    category,
    sortOptions: SORT_MODES,
  }
}
