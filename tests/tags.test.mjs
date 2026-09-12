/**
 * src/tags.ts 契约单测（node --test，跑 dist 产物）。
 *
 * 这是市场页标签机制的共享契约：host 侧用 categoryCounts 做分类聚合，
 * client 侧用 buildMarketTags 渲染卡片标签。两边共用同一实现，所以这里
 * 锁死顺序、去重、tone 映射与边界行为——任何一侧改动都靠这些用例兜底。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildMarketTags, categoryCounts, installedKindKey, marketTagKey } from '../dist/tags.js'

describe('buildMarketTags', () => {
  it('按 category → type → status → verify → security → topic 排序', () => {
    const tags = buildMarketTags({
      category: 'tool',
      installed: true,
      installedKind: 'skill',
      status: '✅',
      verification: { level: 3, label: 'feature-tested' },
      security: { riskLevel: 'low', status: 'scanned' },
      topics: ['markdown', 'export'],
    })
    assert.deepEqual(tags.map(tag => tag.kind), ['category', 'type', 'status', 'verify', 'security', 'topic', 'topic'])
    assert.deepEqual(tags.map(tag => tag.value), ['tool', 'skill', '✅', 'L3', 'low', 'markdown', 'export'])
  })

  it('未安装条目不产生 type 标签，且没有 category 时首位是后续 kind', () => {
    const tags = buildMarketTags({ installed: false, installedKind: 'skill', topics: ['t'] })
    assert.deepEqual(tags.map(tag => tag.kind), ['topic'])
  })

  it('跨 kind 同值去重，保留高优先级者', () => {
    const tags = buildMarketTags({ category: 'memory', topics: ['MEMORY', 'notes'] })
    assert.deepEqual(tags.map(tag => tag.kind + ':' + tag.value), ['category:memory', 'topic:notes'])
  })

  it('空值与纯空白被丢弃', () => {
    const tags = buildMarketTags({ category: '   ', status: '', topics: ['', '  ', 'ok'] })
    assert.deepEqual(tags.map(tag => tag.value), ['ok'])
  })

  it('status 映射 tone：✅ 成功 / archived 警告 / 其他中性，title 保留原文', () => {
    assert.equal(buildMarketTags({ status: '✅ 已测' })[0].tone, 'success')
    assert.equal(buildMarketTags({ status: 'archived' })[0].tone, 'warning')
    assert.equal(buildMarketTags({ status: '待测' })[0].tone, 'neutral')
    assert.equal(buildMarketTags({ status: '✅ 已测' })[0].title, '✅ 已测')
  })

  it('verify 携带 level，L2 起为 success，title 用 label', () => {
    const [low] = buildMarketTags({ verification: { level: 1, label: 'found' } })
    assert.equal(low.kind, 'verify')
    assert.equal(low.value, 'L1')
    assert.equal(low.level, 1)
    assert.equal(low.tone, 'neutral')
    assert.equal(low.title, 'found')
    const [high] = buildMarketTags({ verification: { level: 4, label: 'feature-tested' } })
    assert.equal(high.tone, 'success')
  })

  it('security 映射 tone，status=skipped 时不出标签', () => {
    assert.deepEqual(buildMarketTags({ security: { riskLevel: 'low', status: 'ok' } }).map(t => t.tone), ['success'])
    assert.deepEqual(buildMarketTags({ security: { riskLevel: 'medium', status: 'ok' } }).map(t => t.tone), ['warning'])
    assert.deepEqual(buildMarketTags({ security: { riskLevel: 'high', status: 'ok' } }).map(t => t.tone), ['danger'])
    assert.deepEqual(buildMarketTags({ security: { riskLevel: 'critical', status: 'ok' } }).map(t => t.tone), ['danger'])
    assert.deepEqual(buildMarketTags({ security: { riskLevel: 'unknown', status: 'ok' } }).map(t => t.tone), ['neutral'])
    assert.deepEqual(buildMarketTags({ security: { riskLevel: 'low', status: 'skipped' } }), [])
  })

  it('topics 默认只取前 2 条，可配置，且 title 是完整列表', () => {
    const topics = ['a', 'b', 'c', 'd']
    const tags = buildMarketTags({ topics })
    assert.deepEqual(tags.map(t => t.value), ['a', 'b'])
    assert.equal(tags[0].title, 'a, b, c, d')
    assert.deepEqual(buildMarketTags({ topics }, { topicLimit: 3 }).map(t => t.value), ['a', 'b', 'c'])
    assert.deepEqual(buildMarketTags({ topics }, { topicLimit: 0 }), [])
  })

  it('非字符串 topic 元素被 String() 兜住（上游数据源换形状不崩页）', () => {
    const tags = buildMarketTags({ topics: [1, 'ok', null] }, { topicLimit: 3 })
    assert.deepEqual(tags.map(tag => tag.value), ['1', 'ok', 'null'])
  })

  it('缺字段（catalog-only 条目）不崩且只出已有标签', () => {
    assert.deepEqual(buildMarketTags({}), [])
    assert.deepEqual(buildMarketTags({ status: '✅' }).map(t => t.kind), ['status'])
  })

  it('marketTagKey 稳定且含 kind', () => {
    const [tag] = buildMarketTags({ category: 'tool' })
    assert.equal(marketTagKey(tag), 'category:tool')
  })
})

describe('installedKindKey', () => {
  it('映射三种已安装类型，未知值落到 plugin', () => {
    assert.equal(installedKindKey('skill'), 'skill')
    assert.equal(installedKindKey('agent-preset'), 'agent')
    assert.equal(installedKindKey('cordis-plugin'), 'plugin')
    assert.equal(installedKindKey(undefined), 'plugin')
    assert.equal(installedKindKey('weird'), 'plugin')
  })
})

describe('categoryCounts', () => {
  it('按出现次数降序、同数按 id 升序，忽略空分类', () => {
    const counts = categoryCounts([
      { category: 'tool' }, { category: 'tool' }, { category: 'web-ui' },
      { category: 'memory' }, { category: 'web-ui' }, { category: undefined }, { category: '  ' },
    ])
    assert.deepEqual(counts, [
      { id: 'tool', count: 2 },
      { id: 'web-ui', count: 2 },
      { id: 'memory', count: 1 },
    ])
  })

  it('空列表返回空数组', () => {
    assert.deepEqual(categoryCounts([]), [])
  })

  it('未知上游分类原样计数（客户端筛选不需要预置白名单）', () => {
    assert.deepEqual(categoryCounts([{ category: 'brand-new-cat' }]), [{ id: 'brand-new-cat', count: 1 }])
  })
})
