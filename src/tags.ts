/**
 * Marketplace tag model — shared by the host pipeline and the client card
 * renderer, pure and framework-free (unit-testable from dist, like rank.ts).
 *
 * Why this module exists: the tags a card shows used to be assembled inline
 * in the card component from whatever fields the payload happened to carry,
 * in payload order. The upstream registry index (bradeGithub/
 * DSH-Plugins-Marketplace) now publishes an authoritative per-repository
 * `category` and maintains its own TOPIC_STOP_WORDS list, so the tag set is
 * built here instead: one ordered, de-duplicated source of truth that both
 * sides share.
 *
 * Ordering contract (importance, highest first) — the renderer prints tags in
 * array order and never re-sorts:
 *   category → type → status → verify → security → topic
 * `category` leads because it is the upstream classifier (the only
 * functional label available for every entry, installed or not); quality
 * signals follow; free-form topics trail.
 */

/** Tag kinds, in render order. */
export type MarketTagKind =
  /** Upstream registry classifier id (tool / memory / web-ui / …). */
  | 'category'
  /** Installed kind: skill | agent-preset | cordis plugin (installed only). */
  | 'type'
  /** Curated catalog evidence status (adp). */
  | 'status'
  /** dsh.so independent verification level. */
  | 'verify'
  /** dsh.so automated security scan result. */
  | 'security'
  /** Functional GitHub topic (eco-generic labels filtered upstream). */
  | 'topic'

/** Locale-neutral tone; the client maps it to the official --dsw-* tokens. */
export type MarketTagTone = 'neutral' | 'success' | 'warning' | 'danger'

/** One display tag. `value` is raw — the client localizes known values. */
export interface MarketTag {
  readonly kind: MarketTagKind
  readonly value: string
  /** Verification level for `verify` tags (1..5); absent on other kinds. */
  readonly level?: number
  readonly tone: MarketTagTone
  /** Full, untruncated text for the `title` attribute. */
  readonly title?: string
}

/** The item fields the tag builder reads (keeps the dependency narrow). */
export interface MarketTagSource {
  readonly category?: string
  readonly installed?: boolean
  readonly installedKind?: string
  readonly status?: string
  readonly verification?: { readonly level: number; readonly label: string }
  readonly security?: { readonly riskLevel: string; readonly status: string }
  readonly topics?: readonly string[]
}

/** Curated catalog evidence status → tone (and the client's short label). */
function statusTone(status: string): MarketTagTone {
  if (status.includes('✅')) return 'success'
  if (status.toLowerCase().includes('archiv')) return 'warning'
  return 'neutral'
}

/** dsh.so risk level → tone. */
function securityTone(riskLevel: string): MarketTagTone {
  const risk = riskLevel.toLowerCase()
  if (risk === 'low') return 'success'
  if (risk === 'medium') return 'warning'
  if (risk === 'high' || risk === 'critical') return 'danger'
  return 'neutral'
}

/** Installed kind → the client's `type*` locale key suffix. */
export function installedKindKey(kind: string | undefined): string {
  if (kind === 'skill') return 'skill'
  if (kind === 'agent-preset') return 'agent'
  return 'plugin'
}

/**
 * Build the ordered tag list of one marketplace item.
 *
 * - `topicLimit` caps how many topics are emitted (default 2; the card
 *   appends its own "+n" overflow chip from `topics.length`).
 * - Values are de-duplicated case-insensitively across kinds, keeping the
 *   highest-priority occurrence: an entry whose category is `memory` and
 *   which also carries the topic `memory` shows the category tag only.
 * - Empty / whitespace-only values are dropped.
 */
export function buildMarketTags(
  item: MarketTagSource,
  options?: { readonly topicLimit?: number },
): MarketTag[] {
  const limit = options?.topicLimit ?? 2
  const out: MarketTag[] = []
  const seen = new Set<string>()

  const push = (tag: MarketTag): void => {
    const key = tag.value.trim().toLowerCase()
    if (key.length === 0 || seen.has(key)) return
    seen.add(key)
    out.push(tag)
  }

  const category = (item.category ?? '').trim()
  if (category.length > 0) push({ kind: 'category', value: category, tone: 'neutral' })

  if (item.installed === true) {
    push({ kind: 'type', value: installedKindKey(item.installedKind), tone: 'neutral' })
  }

  const status = (item.status ?? '').trim()
  if (status.length > 0) {
    push({ kind: 'status', value: status, tone: statusTone(status), title: status })
  }

  if (item.verification !== undefined) {
    push({
      kind: 'verify',
      value: 'L' + String(item.verification.level),
      level: item.verification.level,
      tone: item.verification.level >= 2 ? 'success' : 'neutral',
      title: item.verification.label,
    })
  }

  if (item.security !== undefined && item.security.status !== 'skipped') {
    push({
      kind: 'security',
      value: item.security.riskLevel,
      tone: securityTone(item.security.riskLevel),
      title: item.security.status,
    })
  }

  // Empty / whitespace topics must not consume the topic budget: the cap
  // applies to tags actually emitted (the card counts what it can show).
  const topics = item.topics ?? []
  // Lazy join (A9): the title is only read by the first topic tag that is
  // actually emitted. Joining up front paid for a temporary string on every
  // item — 13132 items ≈ 0.26MB of garbage per build even when no topic tag
  // survives the cap / de-dupe (only 7366/13132 items carry topics at all).
  let topicTitle: string | undefined
  let emitted = 0
  for (const topic of topics) {
    if (emitted >= Math.max(0, limit)) break
    // Defensive String(): the payload is upstream JSON (registry index), and a
    // non-string element used to throw a TypeError here and abort the whole
    // card render. Callers sanitize today; this keeps a future source swap
    // from turning a data-shape change into a crashed page.
    const value = String(topic).trim()
    if (value.length === 0) continue
    if (topicTitle === undefined) topicTitle = topics.join(', ')
    push({ kind: 'topic', value, tone: 'neutral', title: topicTitle })
    emitted += 1
  }

  return out
}

/** Stable React key of one tag. */
export function marketTagKey(tag: MarketTag): string {
  return tag.kind + ':' + tag.value
}

/**
 * Count entries per upstream category, most frequent first (ties by id).
 * Feeds the client's category filter, so the option list always matches the
 * categories actually present in the listing — a new upstream category shows
 * up without a client change.
 */
export function categoryCounts(items: readonly MarketTagSource[]): Array<{ readonly id: string; readonly count: number }> {
  const counts = new Map<string, number>()
  for (const item of items) {
    const id = (item.category ?? '').trim()
    if (id.length === 0) continue
    counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([id, count]) => ({ id, count }))
    .sort((left, right) => right.count - left.count || (left.id < right.id ? -1 : 1))
}
