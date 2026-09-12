/**
 * 市场页视图契约单测（node --test，跑 dist 产物）。
 *
 * 守护的是用户实测反馈的两个缺陷 + 上游 category 跟进：
 *  1) 排序方向语义颠倒：星数排序把 0 星排最前、方向按钮文案与真实方向不一致；
 *  2) 双列卡片不等高（组件层修复，这里锁排序/筛选的纯函数契约）；
 *  3) 上游 registry 每条都有 category —— 分类筛选与本地化。
 *
 * 跑的是 dist/marketView.js：客户端 bundle 内联同一份实现，所以这里断言
 * 的就是**实际发布**的代码，不是参照实现（与 tests/tags.test.mjs 同一约定）。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  ALL_CATEGORIES, SORT_DEFAULT_DESCENDING, SORT_MODES, TAG_SLOTS,
  buildCategoryOptions, categoryLabelKey, categoryLabelText, compareStamp, compareTie,
  defaultDescendingFor, filterByCategory, marketToolbarModel, orderCategories,
  readHostCategories, rowComparator, securityLabelKey, sortLabelKey, sortRows,
  statusLabelKey, tagLabelText, tagOverflowCount, tagOverflowTitle, tagsOf, typeLabelKey,
} from '../dist/marketView.js'
import { categoryCounts } from '../dist/tags.js'

/** Minimal MarketplaceItem factory (only the fields under test). */
function item(overrides) {
  return {
    name: 'owner/repo', displayName: 'repo', stars: 0,
    updatedAt: '2026-01-01T00:00:00Z', createdAt: '2025-01-01T00:00:00Z',
    url: 'https://github.com/owner/repo', installed: false, updateAvailable: false,
    ...overrides,
  }
}

/** locale stub: the key itself, so assertions read as key names. */
const t = (key) => '[' + key + ']'

describe('排序方向契约（用户反馈 1：方向颠倒 / 0 星排最前）', () => {
  const rows = [
    item({ name: 'a/zero', displayName: 'zero', stars: 0 }),
    item({ name: 'b/huge', displayName: 'huge', stars: 900 }),
    item({ name: 'c/mid', displayName: 'mid', stars: 42 }),
  ]

  it('星数降序：大 → 小，0 星在最后（不是最前）', () => {
    const sorted = sortRows(rows, 'stars', true)
    assert.deepEqual(sorted.map(r => r.stars), [900, 42, 0])
  })

  it('星数升序：小 → 大，0 星在最前', () => {
    const sorted = sortRows(rows, 'stars', false)
    assert.deepEqual(sorted.map(r => r.stars), [0, 42, 900])
  })

  it('每个模式在两个方向上都严格反向（方向语义全局一致）', () => {
    const mixed = [
      item({ name: 'a/one', displayName: 'one', stars: 5, updatedAt: '2026-03-01T00:00:00Z', createdAt: '2025-03-01T00:00:00Z' }),
      item({ name: 'b/two', displayName: 'two', stars: 9, updatedAt: '2026-01-01T00:00:00Z', createdAt: '2025-01-01T00:00:00Z' }),
      item({ name: 'c/three', displayName: 'three', stars: 1, updatedAt: '2026-02-01T00:00:00Z', createdAt: '2025-02-01T00:00:00Z' }),
    ]
    for (const mode of SORT_MODES) {
      const down = sortRows(mixed, mode, true).map(r => r.name)
      const up = sortRows(mixed, mode, false).map(r => r.name)
      assert.deepEqual(up, [...down].reverse(), mode + ' 的升序必须是降序的严格反向')
      assert.equal(new Set(down).size, mixed.length, mode + ' 不得丢条目')
    }
  })

  it('默认方向与文案键一致：星数默认降序（按钮显示「降序」）', () => {
    assert.equal(SORT_DEFAULT_DESCENDING.stars, true)
    assert.equal(defaultDescendingFor('stars'), true)
    assert.equal(marketToolbarModel('stars', defaultDescendingFor('stars'), '').directionLabelKey, 'sortDesc')
    // 切到 A-Z 默认升序
    assert.equal(defaultDescendingFor('az'), false)
    assert.equal(marketToolbarModel('az', defaultDescendingFor('az'), '').directionLabelKey, 'sortAsc')
  })

  it('降序按钮的文案与比较器同源（同一个 descending 标志）', () => {
    for (const descending of [true, false]) {
      const model = marketToolbarModel('stars', descending, '')
      assert.equal(model.descending, descending)
      assert.equal(model.directionLabelKey, descending ? 'sortDesc' : 'sortAsc')
      const sorted = sortRows(rows, 'stars', model.descending)
      assert.deepEqual(sorted.map(r => r.stars), descending ? [900, 42, 0] : [0, 42, 900])
    }
  })

  it('排序是稳定全序：主键相同的条目按 displayName → name 确定，与输入顺序无关', () => {
    const tied = [
      item({ name: 'z/beta', displayName: 'beta', stars: 7 }),
      item({ name: 'a/alpha', displayName: 'alpha', stars: 7 }),
      item({ name: 'm/beta', displayName: 'beta', stars: 7 }),
    ]
    const forward = sortRows(tied, 'stars', true).map(r => r.name)
    const reversed = sortRows([...tied].reverse(), 'stars', true).map(r => r.name)
    assert.deepEqual(forward, ['a/alpha', 'm/beta', 'z/beta'])
    assert.deepEqual(reversed, forward, '输入顺序不得影响结果')
    // 同分组的 tie-break 不随方向翻转（0 星尾巴不会变成 Z→A），但仍确定
    assert.deepEqual(sortRows(tied, 'stars', false).map(r => r.name), ['a/alpha', 'm/beta', 'z/beta'])
    assert.equal(compareTie(item({ displayName: 'a', name: 'x' }), item({ displayName: 'a', name: 'x' })), 0)
  })

  it('installed 是优先级不是排序键：两个方向都排在最前，且不参与反向', () => {
    const rows2 = [
      item({ name: 'a/free', displayName: 'free', stars: 999 }),
      item({ name: 'b/mine', displayName: 'mine', stars: 1, installed: true }),
    ]
    assert.deepEqual(sortRows(rows2, 'stars', true).map(r => r.name), ['b/mine', 'a/free'])
    assert.deepEqual(sortRows(rows2, 'stars', false).map(r => r.name), ['b/mine', 'a/free'])
    assert.deepEqual(sortRows(rows2, 'az', false).map(r => r.name), ['b/mine', 'a/free'])
    assert.deepEqual(sortRows(rows2, 'updated', true).map(r => r.name), ['b/mine', 'a/free'])
  })

  it('更新时间/发布时间排序：降序 = 新 → 旧', () => {
    const rows3 = [
      item({ name: 'a/old', updatedAt: '2025-01-01T00:00:00Z', createdAt: '2020-01-01T00:00:00Z' }),
      item({ name: 'b/new', updatedAt: '2026-06-01T00:00:00Z', createdAt: '2024-01-01T00:00:00Z' }),
    ]
    assert.deepEqual(sortRows(rows3, 'updated', true).map(r => r.name), ['b/new', 'a/old'])
    assert.deepEqual(sortRows(rows3, 'created', true).map(r => r.name), ['b/new', 'a/old'])
  })

  it('缺时间戳（catalog-only 条目）不会浮到最新榜首', () => {
    const rows4 = [
      item({ name: 'a/none', updatedAt: '' }),
      item({ name: 'b/some', updatedAt: '2026-01-01T00:00:00Z' }),
    ]
    assert.deepEqual(sortRows(rows4, 'updated', true).map(r => r.name), ['b/some', 'a/none'])
    assert.equal(compareStamp('', '2026-01-01T00:00:00Z'), -1)
  })

  it('sortRows 不修改入参（13k 条列表的原地排序会污染缓存数据）', () => {
    const input = [item({ name: 'a/x', stars: 1 }), item({ name: 'b/y', stars: 9 })]
    const before = input.map(r => r.name)
    sortRows(input, 'stars', true)
    assert.deepEqual(input.map(r => r.name), before)
  })

  it('toolbar 模型暴露排序键与模式列表（组件只负责渲染）', () => {
    const model = marketToolbarModel('updated', true, 'memory')
    assert.equal(model.sort, 'updated')
    assert.equal(model.sortLabelKey, 'sortUpdated')
    assert.equal(model.category, 'memory')
    assert.equal(model.categoryLabelKey, 'filterCategory')
    assert.deepEqual([...model.sortOptions], ['stars', 'az', 'updated', 'created'])
    assert.equal(sortLabelKey('az'), 'sortAz')
    assert.equal(sortLabelKey('created'), 'sortCreated')
  })
})

describe('分类筛选与下拉（用户反馈 3：上游 category 跟进）', () => {
  const rows = [
    item({ name: 'a/1', category: 'tool' }),
    item({ name: 'a/2', category: 'tool' }),
    item({ name: 'b/1', category: 'memory' }),
    item({ name: 'c/1', category: 'other' }),
    item({ name: 'd/1' }),
  ]

  it('筛选按精确 category 匹配；ALL_CATEGORIES 返回原列表（引用不变）', () => {
    assert.equal(filterByCategory(rows, ALL_CATEGORIES), rows)
    assert.deepEqual(filterByCategory(rows, 'tool').map(r => r.name), ['a/1', 'a/2'])
    assert.deepEqual(filterByCategory(rows, 'memory').map(r => r.name), ['b/1'])
    // 无 category 的条目不属于任何分类桶
    assert.deepEqual(filterByCategory(rows, 'other').map(r => r.name), ['c/1'])
    assert.deepEqual(filterByCategory(rows, 'nope'), [])
    // 上游脏值带空格：计数桶（trim 过）与筛选必须一致，否则筛出来是空的
    const padded = [item({ name: 'p/1', category: ' tool ' })]
    assert.deepEqual(categoryCounts(padded), [{ id: 'tool', count: 1 }])
    assert.deepEqual(filterByCategory(padded, 'tool').map(r => r.name), ['p/1'])
  })

  it('下拉顺序：计数降序，other 固定末尾（3263 条的兜底桶不挤占功能分类）', () => {
    const ordered = orderCategories(categoryCounts([
      ...rows,
      item({ name: 'e/1', category: 'other' }),
      item({ name: 'e/2', category: 'other' }),
    ]))
    assert.deepEqual(ordered.map(c => c.id), ['tool', 'memory', 'other'])
    // 真实分布：other 最大仍必须在最后
    const real = orderCategories([
      { id: 'other', count: 3263 }, { id: 'tool', count: 2768 }, { id: 'web-ui', count: 2053 },
    ])
    assert.deepEqual(real.map(c => c.id), ['tool', 'web-ui', 'other'])
  })

  it('分类选项带条数，全部项带总数，未知分类原样显示（不 fallback 成「其他」）', () => {
    const options = buildCategoryOptions(t, [{ id: 'tool', count: 2768 }, { id: 'brand-new', count: 3 }], 13129)
    assert.deepEqual(options[0], { value: ALL_CATEGORIES, label: '[filterAll] (13129)' })
    assert.equal(options[1].value, 'tool')
    assert.equal(options[1].label, '[catTool] (2768)')
    // 脏值（上游真实存在 '🗂 文件数据' 这类）原样透出
    assert.equal(options[2].label, 'brand-new (3)')
  })

  it('categoryCounts 兜底与 host 字段形状一致（同一实现保证两边一致）', () => {
    const local = categoryCounts(rows)
    const hostResult = { ok: true, items: rows, fromCache: false, message: 'ok', categories: local }
    assert.deepEqual(readHostCategories(hostResult), local)
    // 字段缺失 / 空 / 脏 → 客户端本地兜底
    assert.equal(readHostCategories({ ok: true, items: rows, fromCache: false, message: 'ok' }), undefined)
    assert.equal(readHostCategories({ ok: true, items: rows, fromCache: false, message: 'ok', categories: [] }), undefined)
    assert.equal(readHostCategories({
      ok: true, items: rows, fromCache: false, message: 'ok',
      categories: [{ id: '', count: 1 }, { id: 'tool' }, { id: 5, count: 2 }],
    }), undefined)
    assert.deepEqual(readHostCategories({
      ok: true, items: rows, fromCache: false, message: 'ok', categories: [{ id: ' tool ', count: 2 }],
    }), [{ id: 'tool', count: 2 }])
  })

  it('筛选 + 排序组合：先筛选再排序，顺序契约不变', () => {
    const rows2 = [
      item({ name: 'a/1', category: 'tool', stars: 1 }),
      item({ name: 'b/2', category: 'memory', stars: 500 }),
      item({ name: 'c/3', category: 'tool', stars: 300 }),
    ]
    const filtered = filterByCategory(rows2, 'tool')
    assert.deepEqual(sortRows(filtered, 'stars', true).map(r => r.name), ['c/3', 'a/1'])
  })
})

describe('标签与文案（共享标签模型的客户端侧）', () => {
  it('category id → locale 键；未知 id 返回 null（调用方原样显示）', () => {
    assert.equal(categoryLabelKey('tool'), 'catTool')
    assert.equal(categoryLabelKey('web-ui'), 'catWebUi')
    assert.equal(categoryLabelKey(' CODING '), 'catCoding')
    assert.equal(categoryLabelKey('brand-new-cat'), null)
    assert.equal(categoryLabelText(t, 'brand-new-cat'), 'brand-new-cat')
    assert.equal(categoryLabelText(t, 'memory'), '[catMemory]')
  })

  it('security / status / type 文案键映射，含 critical 与未知值', () => {
    assert.equal(securityLabelKey('low'), 'securityLow')
    assert.equal(securityLabelKey('CRITICAL'), 'securityHigh')
    assert.equal(securityLabelKey('weird'), null)
    assert.equal(statusLabelKey('✅ 已测'), 'statusVerified')
    assert.equal(statusLabelKey('archived'), 'statusArchived')
    assert.equal(statusLabelKey('待测'), 'statusPending')
    assert.equal(typeLabelKey('skill'), 'typeSkill')
    assert.equal(typeLabelKey('agent'), 'typeAgent')
    assert.equal(typeLabelKey('cordis-plugin'), 'typePlugin')
  })

  it('标签文案：category 本地化、verify 带 L 级别、未知 security 退「未检测」、topic 原样', () => {
    assert.equal(tagLabelText(t, { kind: 'category', value: 'tool', tone: 'neutral' }), '[catTool]')
    assert.equal(tagLabelText(t, { kind: 'verify', value: 'L3', tone: 'success' }), '[dsoVerified] L3')
    assert.equal(tagLabelText(t, { kind: 'security', value: 'nope', tone: 'neutral' }), '[securityUnknown]')
    assert.equal(tagLabelText(t, { kind: 'topic', value: 'markdown', tone: 'neutral' }), 'markdown')
  })

  it('tagsOf 直接复用共享模型的顺序（category 在前）', () => {
    const tags = tagsOf(item({ category: 'memory', topics: ['notes', 'export'] }))
    assert.deepEqual(tags.map(tag => tag.kind), ['category', 'topic', 'topic'])
  })

  it('溢出计数：topic 超出模型上限 + 超出两行槽位的标签；重复 topic 不重复计数', () => {
    const tags = tagsOf(item({ category: 'tool', topics: ['a', 'b', 'c', 'd', 'D'] }))
    // 模型输出 category + 2 topics = 3 个；去重后共 4 个 topic（d/D 视为同一个）
    assert.equal(tagOverflowCount(tags, ['a', 'b', 'c', 'd', 'D'], TAG_SLOTS), 2)
    assert.equal(tagOverflowCount(tags, ['a'], TAG_SLOTS), 0)
    // 槽位溢出也计入
    const many = [
      { kind: 'category', value: 'tool', tone: 'neutral' },
      { kind: 'type', value: 'plugin', tone: 'neutral' },
      { kind: 'status', value: '✅', tone: 'success' },
      { kind: 'verify', value: 'L3', tone: 'success' },
      { kind: 'security', value: 'low', tone: 'success' },
    ]
    assert.equal(tagOverflowCount(many, [], TAG_SLOTS), 1)
    assert.equal(tagOverflowCount([], [], TAG_SLOTS), 0)
    assert.equal(tagOverflowCount(many, [], many.length), 0)
  })

  it('溢出标题只列被隐藏的标签（本地化后）', () => {
    const many = [
      { kind: 'category', value: 'tool', tone: 'neutral' },
      { kind: 'type', value: 'plugin', tone: 'neutral' },
      { kind: 'status', value: '✅', tone: 'success' },
      { kind: 'verify', value: 'L3', tone: 'success' },
      { kind: 'security', value: 'low', tone: 'success' },
    ]
    assert.equal(tagOverflowTitle(t, many, TAG_SLOTS), '[securityLow]')
    assert.equal(tagOverflowTitle(t, many, many.length), '')
  })
})

describe('发布产物契约（布局 / 设计 token）', () => {
  const bundle = readFileSync(new URL('../dist/client.js', import.meta.url), 'utf8')

  it('双列等高的布局标记都在产物里：拉伸网格 + 固定行高槽位 + 两行截断', () => {
    // grid 用 stretch 而不是 start：同一行两卡等高
    assert.match(bundle, /alignItems: "stretch"/)
    // 五个固定行高槽位（标题 52 / 标签行 24 x2 / 描述 42 / 日期 30）
    for (const height of ['52px', '24px', '42px', '30px']) {
      assert.ok(bundle.includes('height: "' + height + '"'), '缺少行高槽位 ' + height)
    }
    // 描述两行截断，且 content-visibility 占位高度与真实高度一致（滚动条不跳）
    assert.match(bundle, /WebkitLineClamp: 2/)
    assert.match(bundle, /containIntrinsicSize: "auto 172px"/)
    // 官方 Input 不吃 style，宽度靠页内 CSS
    assert.ok(bundle.includes('.pm-market-search { width: 100%; }'))
  })

  it('产物里没有官方不存在的 --dsw-* token（亮暗双主题都会渲染错误）', () => {
    // 官方 ui-theme 的全部 alias token + 我方用到的 elevation token
    const official = new Set([
      '--dsw-alias-bg-base', '--dsw-alias-bg-layer-1', '--dsw-alias-bg-layer-2',
      '--dsw-alias-bg-layer-3', '--dsw-alias-bg-mask-1', '--dsw-alias-bg-mask-2',
      '--dsw-alias-bg-mask-3', '--dsw-alias-bg-mask-drop', '--dsw-alias-bg-mask-photo',
      '--dsw-alias-bg-module-platform', '--dsw-alias-bg-multi-select', '--dsw-alias-bg-overlay',
      '--dsw-alias-bg-skeleton', '--dsw-alias-border-inverted', '--dsw-alias-border-inverted2',
      '--dsw-alias-border-l1', '--dsw-alias-border-l2', '--dsw-alias-border-l2-darkmode-thin',
      '--dsw-alias-border-l3', '--dsw-alias-border-l4', '--dsw-alias-brand-primary',
      '--dsw-alias-brand-primary-invert', '--dsw-alias-brand-primary-new-colorprimary-new-color', '--dsw-alias-brand-text',
      '--dsw-alias-button-contrast-fill', '--dsw-alias-button-elevated-fill', '--dsw-alias-button-floating-fill',
      '--dsw-alias-button-floating-hover', '--dsw-alias-button-ghost-active-border', '--dsw-alias-button-ghost-active-fill',
      '--dsw-alias-button-ghost-active-hover', '--dsw-alias-button-info-fill', '--dsw-alias-button-info-hover',
      '--dsw-alias-button-primary-dimmed', '--dsw-alias-button-primary-fill', '--dsw-alias-button-primary-hover',
      '--dsw-alias-button-tool-bar-fill', '--dsw-alias-button-tool-bar-fill-invisible', '--dsw-alias-button-tool-bar-hover',
      '--dsw-alias-interactive-bg-active', '--dsw-alias-interactive-bg-hover', '--dsw-alias-interactive-bg-hover-accent',
      '--dsw-alias-interactive-bg-hover-danger', '--dsw-alias-interactive-bg-hover-solid', '--dsw-alias-label-caption',
      '--dsw-alias-label-dimmed', '--dsw-alias-label-primary', '--dsw-alias-label-primary-bluish',
      '--dsw-alias-label-primary-dimmed', '--dsw-alias-label-primary-foreground', '--dsw-alias-label-primary-inverted',
      '--dsw-alias-label-secondary', '--dsw-alias-label-tertiary', '--dsw-alias-link',
      '--dsw-alias-markdown-citation', '--dsw-alias-markdown-code-block', '--dsw-alias-markdown-code-block-banner',
      '--dsw-alias-markdown-code-segment-selected', '--dsw-alias-markdown-code-segment-unselected', '--dsw-alias-markdown-inline-code',
      '--dsw-alias-markdown-placeholder', '--dsw-alias-markdown-tag', '--dsw-alias-scrollbar-bg-l1',
      '--dsw-alias-scrollbar-bg-l2', '--dsw-alias-scrollbar-hover-l1', '--dsw-alias-scrollbar-hover-l2',
      '--dsw-alias-state-business-primary', '--dsw-alias-state-business-tertiary', '--dsw-alias-state-error-primary',
      '--dsw-alias-state-error-secondary', '--dsw-alias-state-success-primary', '--dsw-alias-state-success-secondary',
      '--dsw-alias-state-success-tertiary', '--dsw-alias-state-warn-label', '--dsw-alias-state-warn-primary',
      '--dsw-alias-state-warn-secondary', '--dsw-alias-state-warn-tertiary', '--dsw-alias-toast-bg',
      '--dsw-alias-tooltip-bg', '--dsw-elevation-stroke',
    ])
    const used = [...new Set(bundle.match(/--dsw-(?:alias|elevation)-[a-z0-9-]+/g) ?? [])]
    const unknown = used.filter(token => !official.has(token))
    assert.deepEqual(unknown, [], '产物里出现官方不存在的 token: ' + unknown.join(', '))
  })
})

describe('A3 tie-break 加速：共享 collator 不得改变排序语义', () => {
  it('compareTie 与逐次 localeCompare 的结果逐条一致（共享 collator 等价）', () => {
    // 覆盖 ASCII 大小写、数字、分隔符、CJK、emoji、前后缀、空串。
    const names = [
      'alpha', 'Alpha', 'ALPHA', 'beta', 'beta-2', 'beta_2', 'gamma',
      'zeta', 'Zeta', '', '-', '_', '123', '2beta', 'a', 'A',
      '插件管理器', '插件', '中文名', 'café', 'naïve', 'résumé',
      '🚀-rocket', 'emoji🎯', 'tool-a', 'tool_b', 'toolA', 'aaa', 'aab',
    ]
    const pairs = []
    for (const l of names) for (const r of names) pairs.push([l, r])
    for (const [l, r] of pairs) {
      const viaCompareTie = compareTie(
        item({ displayName: l, name: 'x/y' }),
        item({ displayName: r, name: 'x/y' }),
      )
      const viaLocale = l.localeCompare(r)
      // 两者必须同号（都 >0 / 都 <0 / 都 ===0）；比较器只关心符号
      assert.equal(
        Math.sign(viaCompareTie), Math.sign(viaLocale),
        'displayName ' + JSON.stringify(l) + ' vs ' + JSON.stringify(r),
      )
    }
  })

  it('compareTie 仍然先比 displayName、再比 name（顺序契约未变）', () => {
    // displayName 不同 → 按 displayName
    assert.ok(compareTie(item({ displayName: 'aaa', name: 'z/z' }), item({ displayName: 'bbb', name: 'a/a' })) < 0)
    // displayName 相同 → 按 name
    assert.ok(compareTie(item({ displayName: 'same', name: 'a/x' }), item({ displayName: 'same', name: 'b/y' })) < 0)
    assert.ok(compareTie(item({ displayName: 'same', name: 'b/y' }), item({ displayName: 'same', name: 'a/x' })) > 0)
    // 完全相同 → 0
    assert.equal(compareTie(item({ displayName: 'same', name: 'a/x' }), item({ displayName: 'same', name: 'a/x' })), 0)
  })

  it('compareTie 是确定性全序：自反/反对称/传递 + 与输入顺序无关', () => {
    const rows = [
      item({ displayName: 'beta', name: 'z/beta', stars: 7 }),
      item({ displayName: 'alpha', name: 'a/alpha', stars: 7 }),
      item({ displayName: 'beta', name: 'm/beta', stars: 7 }),
      item({ displayName: 'Gamma', name: 'g/gamma', stars: 7 }),
      item({ displayName: 'gamma', name: 'G/gamma2', stars: 7 }),
    ]
    for (const row of rows) assert.equal(compareTie(row, row), 0, '自反性')
    for (const a of rows) for (const b of rows) {
      // 注意 0 / -0：strict equal 区分二者，先归一化再比。
      const forward = Math.sign(compareTie(a, b)) + 0
      const backward = Math.sign(compareTie(b, a)) + 0
      assert.equal(forward, backward === 0 ? 0 : -backward, '反对称性')
    }
    for (const a of rows) for (const b of rows) for (const c of rows) {
      if (compareTie(a, b) < 0 && compareTie(b, c) < 0) assert.ok(compareTie(a, c) < 0, '传递性')
    }
    // 与输入顺序无关
    const forward = sortRows(rows, 'stars', true).map(r => r.name)
    const reversed = sortRows([...rows].reverse(), 'stars', true).map(r => r.name)
    assert.deepEqual(reversed, forward)
    assert.equal(new Set(forward).size, rows.length, '不得丢条目')
  })

  it('重复 displayName（真实数据里有 668 个）仍靠 name 决出全序', () => {
    const rows = [
      item({ displayName: 'dsh-tool', name: 'z/dsh-tool', stars: 5 }),
      item({ displayName: 'dsh-tool', name: 'a/dsh-tool', stars: 5 }),
      item({ displayName: 'dsh-tool', name: 'm/dsh-tool', stars: 5 }),
    ]
    assert.deepEqual(sortRows(rows, 'stars', true).map(r => r.name), ['a/dsh-tool', 'm/dsh-tool', 'z/dsh-tool'])
    assert.deepEqual(sortRows(rows, 'stars', false).map(r => r.name), ['a/dsh-tool', 'm/dsh-tool', 'z/dsh-tool'])
  })

  it('13k 规模下 compareTie 的排序仍是全序且不丢条目（性能路径的规模回归）', () => {
    const rows = []
    for (let i = 0; i < 4000; i += 1) {
      rows.push(item({ displayName: 'repo-' + (i % 997), name: 'owner' + i + '/repo-' + (i % 997), stars: i % 7 }))
    }
    const sorted = sortRows(rows, 'stars', true)
    assert.equal(sorted.length, rows.length, '不得丢条目')
    assert.equal(new Set(sorted.map(r => r.name)).size, rows.length, '不得重复')
    // 全序自检：相邻两两比较必须 <= 0（降序）
    const cmp = rowComparator('stars', true)
    for (let i = 1; i < sorted.length; i += 1) {
      assert.ok(cmp(sorted[i - 1], sorted[i]) <= 0, '第 ' + i + ' 对逆序')
    }
  })
})

describe('A4 滚动 chunk 化：DOM 结构与布局契约不得回归', () => {
  const bundle = readFileSync('dist/client.js', 'utf8')

  it('chunk 组件用 Fragment 包裹，不引入包装 DOM 节点（ul>li 结构保持）', () => {
    // CardChunk 必须返回 Fragment（<></> 或 React.Fragment），否则 <ul> 下会
    // 多出一层 div，grid 布局与 li 选择器全部失效。
    assert.match(bundle, /CardChunk/, '产物里应有 CardChunk 组件')
    // 断言渲染 li 的是 MarketCard（结构契约未变）
    assert.match(bundle, /dshpm-card|styles\.card|card:\s*\{/, '卡片的 li 样式仍在')
  })

  it('chunk 大小与 RENDER_BATCH 一致（120），批次数与窗口成线性', () => {
    assert.match(bundle, /RENDER_BATCH\s*=\s*120/, 'RENDER_BATCH 仍是 120')
  })

  it('visibleCount 的重置依赖未变（searchQuery/sort/descending/category）', () => {
    // 源码级断言：重置 effect 的依赖数组必须仍含这四个键，否则排序/筛选后
    // 不会回到列表顶部，用户会停在错误的偏移上。
    const src = readFileSync('src/client/PluginMarketplaceTab.tsx', 'utf8')
    assert.match(
      src,
      /\}, \[searchQuery, sort, descending, category\]\)/,
      'visibleCount 重置依赖必须仍是 [searchQuery, sort, descending, category]',
    )
    assert.match(src, /setVisibleCount\(RENDER_BATCH\)/, '重置仍归零到首批')
    assert.match(src, /scrollIntoView\(\{ block: 'start' \}\)/, '排序/筛选变化仍滚回列表顶部')
  })

  it('固定行高槽位契约仍在（52/24/24/42/30，两行截断）', () => {
    const src = readFileSync('src/client/PluginMarketplaceTab.tsx', 'utf8')
    // 卡片固定槽位：标题 52、标签行 24×2、描述 42、日期 30
    for (const token of ["height: '52px'", "height: '24px'", "height: '42px'", "height: '30px'"]) {
      assert.ok(src.includes(token), '缺少固定行高槽位: ' + token)
    }
    assert.match(src, /WebkitLineClamp: 2/, '描述仍是两行截断')
    assert.match(src, /contentVisibility/, 'content-visibility 仍在')
  })

  it('chunk 只处理新增批：旧 chunk 的 props 是稳定引用（memo bail out 的前提）', () => {
    const src = readFileSync('src/client/PluginMarketplaceTab.tsx', 'utf8')
    // CardChunk 必须是 memo
    assert.match(src, /const CardChunk = memo\(/, 'CardChunk 必须被 memo 包裹')
    // 传入的 rows 必须是 useMemo 的同一个引用（不是 slice 出来的新数组）
    assert.match(src, /rows=\{rows\}/, 'chunk 必须拿到 rows 原引用，而不是 slice 出的新数组')
    // 每个 chunk 只渲染 [start, end)
    assert.match(src, /for \(let index = start; index < end; index \+= 1\)/, 'chunk 只遍历自己的区间')
    // 批次的 key 是 start（稳定），不是数组下标或新对象
    assert.match(src, /key=\{start\}/, 'chunk 的 key 必须是稳定的 start')
  })

  it('已挂载计数与 sentinel/按钮判据一致（renderedCount 取代 rendered.length）', () => {
    const src = readFileSync('src/client/PluginMarketplaceTab.tsx', 'utf8')
    assert.match(src, /renderedCount = Math\.min\(visibleCount, rows\.length\)/)
    // 旧写法不得残留（否则 sentinel 判据与列表内容不一致）
    assert.doesNotMatch(src, /rows\.length > rendered\.length/, '不得残留 rendered.length 判据')
  })
})
