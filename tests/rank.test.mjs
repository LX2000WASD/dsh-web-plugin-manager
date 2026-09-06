/**
 * rank.ts 模糊打分单测（node --test，跑 dist 产物）。
 * vendor 自官方 rank-by-name 的语义契约：有序子序列、边界加分、连续命中
 * 强于间隔、前缀排序优先。回归反例：非子序列必须淘汰。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { fuzzyScore, fuzzyFilter } from '../dist/rank.js'

describe('fuzzyScore', () => {
  it('exact match scores and is a prefix', () => {
    const score = fuzzyScore('plugin-manager', 'plugin-manager')
    assert.ok(score !== null && score > 0)
  })

  it('subsequence abbreviations hit (plgmgr → plugin-manager)', () => {
    assert.ok(fuzzyScore('plugin-manager', 'plgmgr') !== null)
    assert.ok(fuzzyScore('plugin-manager', 'pm') !== null)
  })

  it('non-subsequences are rejected', () => {
    assert.equal(fuzzyScore('plugin-manager', 'zzz'), null)
    // m 只出现一次：第二个 m 无处对齐
    assert.equal(fuzzyScore('plugin-manager', 'mgmgr'), null)
  })

  it('query longer than name is rejected; empty query scores 0', () => {
    assert.equal(fuzzyScore('pm', 'pmxx'), null)
    assert.equal(fuzzyScore('plugin-manager', ''), 0)
  })

  it('prefix starts score higher than later starts (boundary - index penalty)', () => {
    const atStart = fuzzyScore('plugin-manager', 'plug')
    const lateStart = fuzzyScore('x-plugin-manager', 'plug')
    assert.ok(atStart !== null && lateStart !== null && atStart > lateStart)
  })

  it('separator boundaries add bonus (m after - in plugin-manager)', () => {
    const boundary = fuzzyScore('plugin-manager', 'm')
    const plain = fuzzyScore('pluginmanager', 'm')
    assert.ok(boundary !== null && plain !== null && boundary > plain)
  })

  it('consecutive hits beat gapped hits (no boundary bonus in play)', () => {
    const consecutive = fuzzyScore('termina', 'term')
    const gapped = fuzzyScore('txermina', 'term')
    assert.ok(consecutive !== null && gapped !== null && consecutive > gapped)
  })

  it('matching is case-insensitive', () => {
    assert.ok(fuzzyScore('Plugin-Manager', 'PM') !== null)
    assert.ok(fuzzyScore('插件管理器 plugin-manager', 'PM') !== null)
  })
})

describe('fuzzyFilter', () => {
  const items = [
    { name: 'dsh-plugin-manager' },
    { name: 'memory-rag' },
    { name: 'plugin-finder' },
    { name: 'terminal-ui' },
  ]

  it('returns null for a blank query (caller keeps its default path)', () => {
    assert.equal(fuzzyFilter(items, item => item.name, '  '), null)
  })

  it('filters to subsequence hits; prefix flag marks startsWith only', () => {
    const hits = fuzzyFilter(items, item => item.name, 'plug')
    assert.ok(hits !== null)
    assert.deepEqual(hits.map(hit => hit.item.name), ['plugin-finder', 'dsh-plugin-manager'])
    // plugin-finder 以 plug 开头（prefix 优先排第一）；dsh-plugin-manager
    // 的 plug 落在分隔符边界上，非前缀。
    assert.equal(hits[0].prefix, true)
    assert.equal(hits[1].prefix, false)
  })

  it('prefix hits outrank higher-alignment non-prefix hits', () => {
    const items2 = [{ name: 'zz-plugin' }, { name: 'plugin' }]
    const hits = fuzzyFilter(items2, item => item.name, 'plugin')
    assert.ok(hits !== null)
    assert.equal(hits[0].item.name, 'plugin')
    assert.equal(hits[0].prefix, true)
  })

  it('equal scores keep the original order (stable sort)', () => {
    const items2 = [{ name: 'tool-a' }, { name: 'tool-b' }]
    const hits = fuzzyFilter(items2, item => item.name, 'tool')
    assert.deepEqual(hits?.map(hit => hit.item.name), ['tool-a', 'tool-b'])
  })
})
