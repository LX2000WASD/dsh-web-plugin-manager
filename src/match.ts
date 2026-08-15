/**
 * Free-text marketplace matching for the plugin_search tool: tokenize a
 * natural-language query and rank marketplace entries by weighted hits
 * (name 3 / topics 2 / description 1, stars as tiebreaker). Pure functions —
 * no framework imports, unit-testable.
 */

import type { MarketplaceItem } from './types.ts'

/** Split a query into lowercase tokens (alphanumeric + CJK runs). */
export function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fa5]+/)
    .filter(token => token.length > 0)
}

/** Weighted score of one entry against query tokens. */
export function scoreItem(item: MarketplaceItem, tokens: readonly string[]): number {
  let score = 0
  const name = item.displayName.toLowerCase()
  const fullName = item.name.toLowerCase()
  const description = (item.description ?? '').toLowerCase()
  const topics = (item.topics ?? []).map(topic => topic.toLowerCase())
  for (const token of tokens) {
    if (name.includes(token) || fullName.includes(token)) score += 3
    // Topic hits: short tokens (ai/api/ui) match exactly only — the old
    // reverse substring (token.includes(topic)) hit unrelated entries for
    // every 2-3 letter topic (audit).
    if (token.length <= 3
      ? topics.includes(token)
      : topics.some(topic => topic.includes(token))) score += 2
    if (description.includes(token)) score += 1
  }
  return score
}

/**
 * Rank marketplace entries against a free-text query. An empty query returns
 * the top entries by stars. Ties break by star count.
 */
export function findPluginMatches(
  items: readonly MarketplaceItem[],
  query: string,
  limit: number,
): MarketplaceItem[] {
  const tokens = tokenize(query)
  if (tokens.length === 0) {
    return [...items].sort((a, b) => b.stars - a.stars).slice(0, limit)
  }
  return items
    .map(item => ({ item, score: scoreItem(item, tokens) }))
    .filter(entry => entry.score > 0)
    .sort((a, b) => b.score - a.score || b.item.stars - a.item.stars)
    .slice(0, limit)
    .map(entry => entry.item)
}
