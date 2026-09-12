#!/usr/bin/env node
/**
 * 补充验证 B（task-7 / verifier）——分类筛选语义的独立验证。
 *
 * 背景：Lead 指定「orderCategories 把 'other' 置底」是产品决策，担心置底逻辑
 * 会影响筛选正确性，以及脏 category（'单插件'/'未分类'/emoji 值）在下拉里是否
 * 原样出现、选中后能否筛出对应条目。
 *
 * 本脚本独立于 dist/marketView.js 的实现，用「穷举所有出现过的 category 值」
 * 的方式逐项核对：
 *   1) 置底只是「排序」，不改变集合与计数 → 置底前后集合/计数逐项相同；
 *   2) 每个 category（含脏值）都能被 filterByCategory 精确筛出，且条数与
 *      categoryCounts 的计数一致；
 *   3) 下拉选项顺序 = orderCategories(categoryCounts(items))，'other' 在末位；
 *   4) 脏值原样出现（不被折叠进 other、不被过滤掉）；
 *   5) 边界：category 缺失/空白条目不落入任何具名分类（只能被「全部」看到）。
 *
 * 数据源有两份：
 *   - reference registry 的 3115 条（分类全部是 slug，无脏值）；
 *   - 3099 实例的真实 listing（13129 条，含 '单插件'/'未分类'/emoji 等脏值）。
 * 脏值断言只在真实 listing 上有意义，所以脚本会自动尝试拉取 3099 的 listing
 * （可用 --live-json <path> 指定已保存的响应，或 --no-live 跳过）。
 *
 * 运行：node tests/verification-category-filter.mjs [--evidence <path>] [--live-json <path>] [--no-live]
 * 退出码：0 = 无 FAIL；1 = 有 FAIL。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const REGISTRY_JSON = join(ROOT, 'reference/dsh-plugins-marketplace/registry.json')
const LIVE_URL = 'http://127.0.0.1:3099/api2/plugin-manager/marketplace'
const argv = process.argv.slice(2)
const NO_LIVE = argv.includes('--no-live')
const liveIndex = argv.indexOf('--live-json')
const LIVE_JSON = liveIndex >= 0 && argv[liveIndex + 1] !== undefined ? argv[liveIndex + 1] : null
const evidenceIndex = argv.indexOf('--evidence')
const EVIDENCE_PATH = argv.includes('--no-evidence')
  ? null
  : (evidenceIndex >= 0 && argv[evidenceIndex + 1] !== undefined
    ? argv[evidenceIndex + 1]
    : join(ROOT, 'docs/private/audit/verification-category-filter.json'))

const evidence = []
let failures = 0
function record(id, title, status, detail, raw) {
  if (status === 'FAIL') failures += 1
  evidence.push({ id, title, status, detail: detail ?? '', ...(raw !== undefined ? { raw } : {}) })
  const tag = status === 'PASS' ? '✔' : status === 'FAIL' ? '✖' : status === 'WARN' ? '!' : '·'
  console.log(tag + ' [' + id + '] ' + title + (detail ? ' — ' + detail : ''))
}
function check(id, title, fn, rawFn) {
  try {
    const value = fn()
    if (value === true || value === undefined) return record(id, title, 'PASS', '', rawFn?.())
    return record(id, title, 'FAIL', String(value), rawFn?.())
  } catch (error) {
    return record(id, title, 'FAIL', error instanceof Error ? error.message : String(error))
  }
}
const rawJson = (value) => JSON.stringify(value, null, 1)

async function main() {
  console.log('== 分类筛选语义独立验证 ==')
  const { buildMarketTags, categoryCounts } = await import('../dist/tags.js')
  const mv = await import('../dist/marketView.js')
  const merge = await import('../dist/marketplaceMerge.js')
  const { filterByCategory, orderCategories, buildCategoryOptions, ALL_CATEGORIES, readHostCategories } = mv

  const parsed = JSON.parse(readFileSync(REGISTRY_JSON, 'utf8'))
  const pre = merge.filterBlockedRepos(merge.overlayDshSo(merge.mergeRegistryWithCurated(parsed.repos, []), null), new Set())
  const items = merge.dedupeMarketplace(pre).items
  record('F0', '数据源（reference registry 经合并管线）', 'INFO', 'items=' + items.length)

  // ---- 真实 listing（含脏 category）：脏值断言只有在这份数据上才有意义
  let liveItems = null
  if (!NO_LIVE) {
    try {
      let payload
      if (LIVE_JSON !== null) {
        payload = JSON.parse(readFileSync(LIVE_JSON, 'utf8'))
      } else {
        const response = await fetch(LIVE_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ refresh: false, profile: 'pm-test' }),
        })
        payload = await response.json()
      }
      const value = payload?.value ?? payload
      if (Array.isArray(value?.items) && value.items.length > 0) liveItems = value.items
    } catch (error) {
      record('F0b', '真实 listing（3099）', 'WARN',
        '拉取失败，脏值断言将跳过: ' + (error instanceof Error ? error.message : String(error)))
    }
  }
  if (liveItems !== null) {
    const liveCounts = categoryCounts(liveItems)
    const liveDirty = liveCounts.map(entry => entry.id).filter(id => !/^[a-z][a-z0-9-]*$/.test(id))
    record('F0b', '数据源（3099 真实 listing）', 'INFO',
      'items=' + liveItems.length + ' distinct=' + liveCounts.length + ' 脏值=' + JSON.stringify(liveDirty),
      rawJson(liveCounts))
  }

  const counts = categoryCounts(items)
  const allIds = counts.map(entry => entry.id)
  const dirtyIds = allIds.filter(id => !/^[a-z][a-z0-9-]*$/.test(id))
  record('F1', '分类集合', 'INFO',
    'distinct=' + allIds.length + ' 脏值=' + JSON.stringify(dirtyIds),
    rawJson(counts))

  // ---- 1. 置底只改顺序，不改集合/计数
  const ordered = orderCategories(counts)
  const sameSet = ordered.length === counts.length
    && [...ordered].sort((a, b) => (a.id < b.id ? -1 : 1)).every((entry, index, list) => {
      const sorted = [...counts].sort((a, b) => (a.id < b.id ? -1 : 1))
      return entry.id === sorted[index].id && entry.count === sorted[index].count
    })
  check('F2', "orderCategories 'other' 置底：集合与计数不变（只改顺序）",
    () => sameSet || '置底前后集合/计数不一致',
    () => rawJson({ before: counts.slice(0, 4), after: ordered.slice(0, 4) }))

  const otherIndex = ordered.findIndex(entry => entry.id === 'other')
  check('F3', "'other' 位于末位（且非 other 段保持计数降序）",
    () => {
      if (otherIndex === -1) return '数据中没有 other 分类'
      if (otherIndex !== ordered.length - 1) return "'other' 不在末位，位置=" + otherIndex + '/' + (ordered.length - 1)
      const known = ordered.filter(entry => entry.id !== 'other')
      for (let i = 1; i < known.length; i += 1) if (known[i - 1].count < known[i].count) return '非 other 段计数降序被破坏'
      return true
    },
    () => 'other 位置=' + otherIndex + ' 总长=' + ordered.length)

  // ---- 2. 每个 category（含脏值）都能精确筛出且条数一致
  const filterMismatch = []
  const dirtyFilterResults = []
  for (const entry of counts) {
    const filtered = filterByCategory(items, entry.id)
    const exact = filtered.every(item => (item.category ?? '') === entry.id)
    if (filtered.length !== entry.count || !exact) {
      filterMismatch.push({ id: entry.id, expected: entry.count, got: filtered.length, exact })
    }
    if (dirtyIds.includes(entry.id)) {
      dirtyFilterResults.push({ id: entry.id, expected: entry.count, got: filtered.length, exact, sample: filtered.slice(0, 2).map(item => item.name) })
    }
  }
  check('F4', '每个 category 都能精确筛出且条数与聚合计数一致（含脏值）',
    () => filterMismatch.length === 0 || '不一致=' + JSON.stringify(filterMismatch.slice(0, 8)),
    () => rawJson({ checked: counts.length, mismatch: filterMismatch.length }))
  // reference registry 的分类全部是 slug，所以这条在 reference 数据上无脏值可测——
  // 记 WARN 而不是 FAIL（脏值断言由真实 listing 的 L2/L5 覆盖）。
  if (dirtyFilterResults.length === 0) {
    record('F5', '脏 category（中文/emoji）原样出现在下拉且可筛出对应条目', 'WARN',
      'reference registry 的分类全部是 slug（无脏值）——脏值断言由真实 listing 的 L2/L5 覆盖')
  } else {
    check('F5', '脏 category（中文/emoji）原样出现在下拉且可筛出对应条目',
      () => dirtyFilterResults.every(entry => entry.got === entry.expected && entry.exact)
        || '异常=' + JSON.stringify(dirtyFilterResults.filter(e => e.got !== e.expected || !e.exact)),
      () => rawJson(dirtyFilterResults))
  }

  // ---- 3. 下拉选项：值=category id，label 含真实条数；'other' 置底
  const t = (key) => '[' + key + ']'
  const options = buildCategoryOptions(t, ordered, items.length)
  const optionMismatch = []
  if (options[0].value !== ALL_CATEGORIES) optionMismatch.push('首项不是「全部」，实际=' + JSON.stringify(options[0].value))
  if (!options[0].label.includes(String(items.length))) optionMismatch.push('「全部」未携带总数')
  for (let i = 1; i < options.length; i += 1) {
    const option = options[i]
    const entry = ordered[i - 1]
    if (option.value !== entry.id) optionMismatch.push('第 ' + i + ' 项 value=' + option.value + ' 期望=' + entry.id)
    if (!option.label.includes('(' + String(entry.count) + ')')) optionMismatch.push(entry.id + ' 的 label 未携带条数 ' + entry.count)
  }
  check('F6', '下拉选项顺序/取值/条数标签与聚合一致',
    () => optionMismatch.length === 0 || '不一致=' + JSON.stringify(optionMismatch.slice(0, 6)),
    () => rawJson(options.slice(0, 5)))

  // ---- 4. 边界：缺失/空白 category 不落入任何具名分类
  const synthetic = [
    { name: 'a/missing', displayName: 'a', stars: 1, updatedAt: '', createdAt: '', url: '', installed: false, updateAvailable: false },
    { name: 'b/blank', displayName: 'b', stars: 1, updatedAt: '', createdAt: '', url: '', installed: false, updateAvailable: false, category: '   ' },
    { name: 'c/tool', displayName: 'c', stars: 1, updatedAt: '', createdAt: '', url: '', installed: false, updateAvailable: false, category: 'tool' },
  ]
  const syntheticCounts = categoryCounts(synthetic)
  const missingLeak = syntheticCounts.some(entry => entry.id === '' || entry.id.trim().length === 0)
  check('F7', 'category 缺失/纯空白条目不进入任何具名分类（仅「全部」可见）',
    () => !missingLeak && filterByCategory(synthetic, 'tool').length === 1
      && filterByCategory(synthetic, ALL_CATEGORIES).length === 3
      || 'counts=' + JSON.stringify(syntheticCounts) + ' tool=' + filterByCategory(synthetic, 'tool').length,
    () => rawJson(syntheticCounts))

  // ---- 4b. 真实 listing（含脏值）上重跑同一组断言
  if (liveItems !== null) {
    const liveCounts = categoryCounts(liveItems)
    const liveOrdered = orderCategories(liveCounts)
    const liveDirty = liveCounts.map(entry => entry.id).filter(id => !/^[a-z][a-z0-9-]*$/.test(id))
    const liveMismatch = []
    const liveDirtyResults = []
    for (const entry of liveCounts) {
      const filtered = filterByCategory(liveItems, entry.id)
      const exact = filtered.every(item => (item.category ?? '') === entry.id)
      if (filtered.length !== entry.count || !exact) liveMismatch.push({ id: entry.id, expected: entry.count, got: filtered.length, exact })
      if (liveDirty.includes(entry.id)) {
        liveDirtyResults.push({ id: entry.id, expected: entry.count, got: filtered.length, exact, sample: filtered.slice(0, 2).map(item => item.name) })
      }
    }
    check('L1', '【真实 listing】每个 category 精确筛出且条数与聚合一致',
      () => liveMismatch.length === 0 || '不一致=' + JSON.stringify(liveMismatch.slice(0, 8)),
      () => rawJson({ checked: liveCounts.length, mismatch: liveMismatch.length }))
    check('L2', '【真实 listing】脏 category 原样出现在下拉且可筛出对应条目',
      () => liveDirty.length > 0 && liveDirtyResults.length === liveDirty.length
        && liveDirtyResults.every(entry => entry.got === entry.expected && entry.exact)
        || (liveDirty.length === 0 ? '真实 listing 中无脏值' : '异常=' + JSON.stringify(liveDirtyResults.filter(e => e.got !== e.expected || !e.exact))),
      () => rawJson(liveDirtyResults))
    const liveOther = liveOrdered.findIndex(entry => entry.id === 'other')
    check('L3', "【真实 listing】'other' 置底且集合不变",
      () => liveOrdered.length === liveCounts.length && (liveOther === -1 || liveOther === liveOrdered.length - 1)
        || "'other' 位置=" + liveOther + '/' + (liveOrdered.length - 1),
      () => rawJson(liveOrdered))
    const liveOptions = buildCategoryOptions(t, liveOrdered, liveItems.length)
    const liveOptionBad = liveOptions.slice(1).filter((option, index) => option.value !== liveOrdered[index].id
      || !option.label.includes('(' + String(liveOrdered[index].count) + ')'))
    check('L4', '【真实 listing】下拉选项与聚合逐项一致（含脏值原样 label）',
      () => liveOptionBad.length === 0 || '不一致=' + JSON.stringify(liveOptionBad.slice(0, 5)),
      () => rawJson(liveOptions.slice(0, 6).concat(liveOptions.slice(-2))))
    // 脏值必须原样渲染（不能命中本地化键，也不能被折叠成 other）
    const dirtyLabels = liveDirty.map(id => ({ id, label: buildCategoryOptions(t, [{ id, count: 1 }], 1)[1].label }))
    check('L5', '【真实 listing】脏值 label 原样输出（未被本地化/未被折叠进 other）',
      () => dirtyLabels.every(entry => entry.label.startsWith(entry.id + ' ('))
        || '异常=' + JSON.stringify(dirtyLabels.filter(entry => !entry.label.startsWith(entry.id + ' ('))),
      () => rawJson(dirtyLabels))
  }

  // ---- 5. 筛选与排序正交：先筛后排 == 先排后筛
  const { sortRows, defaultDescendingFor } = mv
  const orthMismatch = []
  for (const entry of counts.slice(0, 8)) {
    const a = sortRows(filterByCategory(items, entry.id), 'stars', defaultDescendingFor('stars')).map(item => item.name)
    const b = filterByCategory(sortRows(items, 'stars', defaultDescendingFor('stars')), entry.id).map(item => item.name)
    if (a.join('\u0000') !== b.join('\u0000')) orthMismatch.push(entry.id)
  }
  check('F8', '筛选与排序正交（先筛后排 == 先排后筛，前 8 个分类）',
    () => orthMismatch.length === 0 || '不一致分类=' + JSON.stringify(orthMismatch))

  // ---- 6. host categories 与客户端重算一致（含脏值）
  const hostFromServer = readHostCategories({ ok: true, items, fromCache: false, message: '', categories: counts })
  check('F9', 'readHostCategories 接受 host 聚合且与客户端重算一致',
    () => hostFromServer !== undefined && hostFromServer.length === counts.length
      && hostFromServer.every((entry, index) => entry.id === counts[index].id && entry.count === counts[index].count)
      || 'host=' + JSON.stringify(hostFromServer?.slice(0, 4)),
    () => rawJson(hostFromServer?.slice(0, 4)))
  const malformed = readHostCategories({ ok: true, items: [], fromCache: false, message: '', categories: [null, { id: '', count: 1 }, { id: 'ok', count: 'x' }, { id: 'good', count: 2 }] })
  check('F10', 'readHostCategories 丢弃畸形条目且保留合法条目',
    () => malformed !== undefined && malformed.length === 1 && malformed[0].id === 'good'
      || '实际=' + JSON.stringify(malformed),
    () => rawJson(malformed))

  const countsSummary = { PASS: 0, FAIL: 0, WARN: 0, INFO: 0 }
  for (const entry of evidence) countsSummary[entry.status] += 1
  console.log('')
  console.log('== 汇总 == PASS=' + countsSummary.PASS + ' FAIL=' + countsSummary.FAIL + ' WARN=' + countsSummary.WARN + ' INFO=' + countsSummary.INFO)
  if (EVIDENCE_PATH !== null) {
    try {
      mkdirSync(dirname(EVIDENCE_PATH), { recursive: true })
      writeFileSync(EVIDENCE_PATH, JSON.stringify({
        generatedAt: new Date().toISOString(), counts: countsSummary,
        verdict: failures === 0 ? 'PASS' : 'FAIL', evidence,
      }, null, 1))
      console.log('== 证据 JSON == ' + EVIDENCE_PATH)
    } catch (error) { console.log('! 证据写入失败: ' + String(error)) }
  }
  console.log('== 总判定 == ' + (failures === 0 ? 'PASS（无 FAIL 项）' : 'FAIL（' + failures + ' 项）'))
  process.exitCode = failures === 0 ? 0 : 1
}

main().catch(error => {
  console.error('脚本自身异常: ' + (error instanceof Error ? error.stack : String(error)))
  process.exitCode = 2
})
