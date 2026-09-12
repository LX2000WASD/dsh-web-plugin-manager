/**
 * match.ts 纯函数单测（node --test，跑 dist 产物）：
 *   pnpm run build:host && node --test tests/
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { tokenize, scoreItem, findPluginMatches, compareVersions } from '../dist/match.js'

/** Minimal MarketplaceItem fixture. */
const item = (overrides) => ({
  name: 'owner/repo-name',
  displayName: 'Repo Name',
  description: 'A plugin for managing things',
  stars: 100,
  updatedAt: '2024-01-01T00:00:00Z',
  createdAt: '',
  url: 'https://github.com/owner/repo-name',
  installed: false,
  updateAvailable: false,
  topics: ['dsh-plugin', 'agent'],
  ...overrides,
})

describe('tokenize', () => {
  it('splits on non-alphanumeric, lowercases', () => {
    assert.deepEqual(tokenize('Hello World 插件'), ['hello', 'world', '插件'])
  })
  it('keeps CJK runs as single tokens', () => {
    assert.deepEqual(tokenize('搜索技能'), ['搜索技能'])
  })
  it('returns [] for empty / symbol-only queries', () => {
    assert.deepEqual(tokenize(''), [])
    assert.deepEqual(tokenize('!!!'), [])
  })
})

describe('scoreItem', () => {
  it('name hit scores 3', () => {
    assert.equal(scoreItem(item({ displayName: 'Chat Search' }), ['search']), 3)
  })
  it('topic hit scores 2', () => {
    assert.equal(scoreItem(item({ topics: ['dsh-plugin', 'agent'] }), ['agent']), 2)
  })
  it('description hit scores 1', () => {
    assert.equal(scoreItem(item({ description: 'manages plugins' }), ['manages']), 1)
  })
  it('name + topic + description accumulate', () => {
    const entry = item({ displayName: 'Plugin Manager', topics: ['plugin'], description: 'a plugin manager' })
    assert.equal(scoreItem(entry, ['plugin']), 3 + 2 + 1)
  })
  it('no hit scores 0', () => {
    assert.equal(scoreItem(item(), ['zzz-nonexistent']), 0)
  })
  it('short topic tokens match exactly, not as reverse substrings (audit)', () => {
    // 'ai-agent' contains 'ai' as a substring — the old reverse match scored it.
    assert.equal(scoreItem(item({ topics: ['ai'] }), ['ai-agent']), 0)
    assert.equal(scoreItem(item({ topics: ['ai'] }), ['ai']), 2)
    // long tokens keep substring semantics (description emptied so the
    // topic is the only hit source)
    assert.equal(scoreItem(item({ topics: ['dsh-plugin'], description: '' }), ['plugin']), 2)
  })
})

describe('findPluginMatches', () => {
  const items = [
    item({ name: 'a/search', displayName: 'Search Tool', stars: 10 }),
    item({ name: 'b/other', displayName: 'Other', stars: 500 }),
    item({ name: 'c/chat-search', displayName: 'Chat Search', stars: 300, topics: ['search'] }),
  ]
  it('empty query returns top by stars', () => {
    const result = findPluginMatches(items, '', 2)
    assert.deepEqual(result.map(e => e.name), ['b/other', 'c/chat-search'])
  })
  it('query ranks weighted hits, tie breaks by stars', () => {
    const result = findPluginMatches(items, 'search', 10)
    // Chat Search: name 3 + topic 2 = 5; Search Tool: name 3 = 3
    assert.deepEqual(result.map(e => e.name), ['c/chat-search', 'a/search'])
  })
  it('limit slices the result', () => {
    assert.equal(findPluginMatches(items, 'search', 1).length, 1)
  })
  it('non-matching query returns []', () => {
    assert.deepEqual(findPluginMatches(items, 'unrelated', 10), [])
  })
})

describe('compareVersions — semver §11.4 prerelease ordering', () => {
  it('orders prerelease identifiers per the spec', () => {
    // The canonical semver.org §11.4 chain, ascending.
    const chain = [
      '1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta',
      '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0',
    ]
    for (let i = 0; i < chain.length - 1; i += 1) {
      assert.equal(compareVersions(chain[i], chain[i + 1]), -1, chain[i] + ' < ' + chain[i + 1])
      assert.equal(compareVersions(chain[i + 1], chain[i]), 1, chain[i + 1] + ' > ' + chain[i])
    }
  })
  it('treats numeric identifiers as LOWER than alphanumeric (§11.4.3)', () => {
    // Regression: the comparison was inverted, so checkUpdates offered a
    // "1.0.0-alpha -> 1.0.0-1" downgrade as an available update.
    assert.equal(compareVersions('1.0.0-1', '1.0.0-alpha'), -1)
    assert.equal(compareVersions('1.0.0-alpha', '1.0.0-1'), 1)
    assert.equal(compareVersions('2.0.0-1', '2.0.0-alpha'), -1)
  })
  it('ranks a release above its prereleases', () => {
    assert.equal(compareVersions('1.0.0', '1.0.0-rc.2'), 1)
    assert.equal(compareVersions('1.0.0-rc.2', '1.0.0'), -1)
  })
  it('ignores build metadata (semver §10)', () => {
    assert.equal(compareVersions('1.0.0+build.7', '1.0.0'), 0)
    assert.equal(compareVersions('1.0.0-rc.1+sha.abc', '1.0.0-rc.1'), 0)
  })
  it('compares numeric prerelease fields numerically, not lexically', () => {
    assert.equal(compareVersions('1.0.0-rc.10', '1.0.0-rc.9'), 1)
  })
})
