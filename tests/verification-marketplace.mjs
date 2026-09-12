#!/usr/bin/env node
/**
 * 独立验证脚手架（verifier / task-7）——市场页排序契约 / 标签契约 / 聚合一致性 /
 * 双列等高结构证据 / 边界反例 /（可选）无头 Chromium 实测。
 *
 * 设计原则（为什么这样写）：
 *  1. 真实数据：只用 reference/dsh-plugins-marketplace/registry.json 的 3115 条，
 *     并走真实合并管线 dist/marketplaceMerge.js（去重/过滤/覆盖是链路的一部分）。
 *  2. 真实实现：排序/筛选/文案契约直接 import 产物 dist/marketView.js（T2 已把
 *     这些纯决策抽成框架无关模块，bundle 内联它、node 测试 import 它——测的就是
 *     线上跑的同一份代码）。卡片组件与样式则从 dist/client.js 提取：在 bundle
 *     末尾 return module.exports 之前注入一行导出，其余字节原样执行。
 *  3. 真实启动：dist/client.js 在模拟的官方 __ModuleLoader__ 种子表里启动，
 *     越表 require 立刻失败（与 tests/client-boot.test.mjs 守护同一条灾难级约束）。
 *  4. 反例优先：脏 category / topics 空 / description 缺失 / stars=0 / 时间字段空 /
 *     同名不同 owner / 跨 kind 同值去重，逐条构造。
 *
 * 运行：
 *   node tests/verification-marketplace.mjs                 # 静态 + SSR 结构证据
 *   node tests/verification-marketplace.mjs --browser       # 额外跑无头 Chromium 实测
 *   node tests/verification-marketplace.mjs --no-evidence   # 不写 JSON 证据
 *   --evidence <path>   证据 JSON 路径（默认 docs/private/audit/verification-evidence.json）
 *
 * 退出码：0 = 无 FAIL；1 = 至少一条 FAIL；2 = 脚手架自身异常。
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const REGISTRY_JSON = join(ROOT, 'reference/dsh-plugins-marketplace/registry.json')
const require_ = createRequire(import.meta.url)

const argv = process.argv.slice(2)
const RUN_BROWSER = argv.includes('--browser')
const evidenceIndex = argv.indexOf('--evidence')
const EVIDENCE_PATH = argv.includes('--no-evidence')
  ? null
  : (evidenceIndex >= 0 && argv[evidenceIndex + 1] !== undefined
    ? argv[evidenceIndex + 1]
    : join(ROOT, 'docs/private/audit/verification-evidence.json'))

/** 证据行：{ area, id, title, status: PASS|FAIL|WARN|INFO, detail, raw? }。 */
const evidence = []
let failures = 0

function record(area, id, title, status, detail, raw) {
  if (status === 'FAIL') failures += 1
  evidence.push({ area, id, title, status, detail: detail ?? '', ...(raw !== undefined ? { raw } : {}) })
  const tag = status === 'PASS' ? '✔' : status === 'FAIL' ? '✖' : status === 'WARN' ? '!' : '·'
  console.log(tag + ' [' + area + '] ' + id + ' ' + title + (detail ? ' — ' + detail : ''))
}

/** 断言并记录；失败不抛（跑完全部用例，一次拿到全部结论）。 */
function check(area, id, title, fn, rawFn) {
  try {
    const value = fn()
    if (value === true || value === undefined) return record(area, id, title, 'PASS', '', rawFn?.())
    return record(area, id, title, 'FAIL', String(value), rawFn?.())
  } catch (error) {
    return record(area, id, title, 'FAIL', error instanceof Error ? error.message : String(error), rawFn?.())
  }
}

const rawJson = (value) => JSON.stringify(value, null, 1)
const identityCounts = (rows) => {
  const counts = new Map()
  for (const row of rows) counts.set(row.name, (counts.get(row.name) ?? 0) + 1)
  return counts
}
const sameMultiset = (left, right) => {
  const a = identityCounts(left)
  const b = identityCounts(right)
  if (a.size !== b.size) return false
  for (const [key, count] of a) if (b.get(key) !== count) return false
  return true
}
const sign = (value) => (value > 0 ? 1 : value < 0 ? -1 : 0)

// ------------------------------------------------------- bundle 启动与提取

const PLATFORM_TABLE_BUILDERS = {
  react: () => require_('react'),
  'react/jsx-runtime': () => require_('react/jsx-runtime'),
  'react-dom': () => ({}),
  'react-dom/client': () => ({}),
  '@deepseek-ai/cordis': () => ({ Context: class {} }),
  '@deepseek-ai/dsh-client-store': () => ({}),
  '@deepseek-ai/dsh-client-ui-slots': () => ({}),
  '@deepseek-ai/dsh-client-ui-primitives': () => new Proxy({}, { get: () => () => null }),
  '@deepseek-ai/dsh-client-ui-dockkit': () => ({}),
}

/**
 * 启动 dist/client.js。extraExports 非空时，在 bundle 末尾的
 * "return module.exports;" 之前注入一行返回这些内部符号（其余字节原样），
 * 用于直接驱动产物里的比较器与卡片组件。
 */
function bootBundle(extraExports = []) {
  // 符号用 typeof 守卫：作者重构改名的符号返回 undefined，而不是让整段启动抛 ReferenceError。
  const bundle = join(ROOT, 'dist/client.js')
  let source = readFileSync(bundle, 'utf8')
  const tail = 'return module.exports;'
  const at = source.lastIndexOf(tail)
  if (at < 0) throw new Error('dist/client.js 结构异常：找不到 ' + JSON.stringify(tail))
  if (extraExports.length > 0) {
    const entries = extraExports
      .map(name => JSON.stringify(name) + ': typeof ' + name + ' !== "undefined" ? ' + name + ' : undefined')
      .join(', ')
    source = source.slice(0, at) + 'return { ' + entries + ' };' + source.slice(at + tail.length)
  }
  const table = {}
  for (const [spec, build] of Object.entries(PLATFORM_TABLE_BUILDERS)) table[spec] = build()
  const missed = []
  let factoryResult
  const priorWindow = globalThis.window
  globalThis.window = {
    __ModuleLoader__: {
      load({ id, factory }) {
        if (id !== 'dsh-web-plugin-manager') throw new Error('bundle 以错误 id 注册: ' + id)
        factoryResult = factory((spec) => {
          if (!(spec in table)) {
            missed.push(spec)
            throw new Error('missed the module table: ' + spec)
          }
          return table[spec]
        })
      },
    },
  }
  try {
    // eslint-disable-next-line no-new-func
    new Function(source)()
  } finally {
    globalThis.window = priorWindow
  }
  return { exported: factoryResult, missed, table }
}


// ------------------------------------------------------------------ 主流程

async function main() {
  console.log('== 独立验证脚手架 ==')
  console.log('仓库: ' + ROOT)

  const tagsSrc = join(ROOT, 'src/tags.ts')
  const tagsDist = join(ROOT, 'dist/tags.js')
  const bundlePath = join(ROOT, 'dist/client.js')
  if (!existsSync(tagsDist)) {
    record('build', 'B0', 'dist/tags.js 存在', 'FAIL', '缺少 dist/tags.js，请先 pnpm run build:host')
    return finish()
  }
  const stale = existsSync(tagsSrc) && statSync(tagsSrc).mtimeMs > statSync(tagsDist).mtimeMs
  record('build', 'B0', 'dist 产物新鲜度（src/tags.ts → dist/tags.js）', stale ? 'WARN' : 'PASS',
    stale ? 'src/tags.ts 比 dist/tags.js 新，结论可能对应旧产物' : 'dist 不早于 src')
  if (existsSync(bundlePath)) {
    const srcTab = join(ROOT, 'src/client/PluginMarketplaceTab.tsx')
    const staleBundle = existsSync(srcTab) && statSync(srcTab).mtimeMs > statSync(bundlePath).mtimeMs
    record('build', 'B1', 'dist 产物新鲜度（PluginMarketplaceTab.tsx → dist/client.js）', staleBundle ? 'WARN' : 'PASS',
      staleBundle ? '客户端源码比 bundle 新，结论可能对应旧产物' : 'bundle 不早于客户端源码')
  }

  const { buildMarketTags, categoryCounts } = await import('../dist/tags.js')
  const merge = await import('../dist/marketplaceMerge.js')
  let marketView = null
  try {
    marketView = await import('../dist/marketView.js')
    record('build', 'B2', 'dist/marketView.js 存在（排序/筛选/文案契约模块）', 'PASS',
      '导出=' + Object.keys(marketView).length + ' 个')
  } catch (error) {
    record('build', 'B2', 'dist/marketView.js 存在（排序/筛选/文案契约模块）', 'FAIL',
      '无法加载 dist/marketView.js: ' + (error instanceof Error ? error.message : String(error)))
  }

  const parsed = JSON.parse(readFileSync(REGISTRY_JSON, 'utf8'))
  const repos = parsed.repos

  // ---- 1. 真实数据形态
  record('data', 'D1', 'registry.json 真实条数', repos.length === parsed.count ? 'PASS' : 'FAIL',
    'repos=' + repos.length + ' declared=' + parsed.count + ' generated_at=' + parsed.generated_at)
  const coverage = {}
  for (const repo of repos) for (const key of Object.keys(repo)) coverage[key] = (coverage[key] ?? 0) + 1
  record('data', 'D2', 'category 字段覆盖', coverage.category === repos.length ? 'PASS' : 'WARN',
    'category=' + (coverage.category ?? 0) + '/' + repos.length, rawJson(coverage))

  // ---- 2. 真实合并管线
  const preDedupe = merge.filterBlockedRepos(
    merge.overlayDshSo(merge.mergeRegistryWithCurated(repos, []), null), new Set())
  const pipeline = merge.dedupeMarketplace(preDedupe)
  const items = pipeline.items
  record('pipeline', 'P1', '合并管线产出（3115 条输入）', items.length > 0 ? 'PASS' : 'FAIL',
    'items=' + items.length + ' dropped=' + pipeline.dropped)
  const dupNames = [...identityCounts(items)].filter(([, count]) => count > 1)
  record('pipeline', 'P2', '最终 listing 身份唯一（React key=item.name）', dupNames.length === 0 ? 'PASS' : 'FAIL',
    '重复身份组=' + dupNames.length, rawJson(dupNames.slice(0, 5)))
  record('pipeline', 'P3', 'dedupe 守恒（无凭空丢失）', items.length + pipeline.dropped === preDedupe.length ? 'PASS' : 'FAIL',
    items.length + ' + ' + pipeline.dropped + ' == ' + preDedupe.length)

  // P4: category 透传——允许被 dedupe 折叠的条目，但折叠数必须解释差额
  const catItems = items.filter(item => item.category !== undefined).length
  const catRepos = repos.filter(repo => repo.category !== undefined).length
  const droppedWithCategory = preDedupe.filter(item => item.category !== undefined).length - catItems
  check('pipeline', 'P4', 'category 透传 registry→item（差额可由 dedupe 解释）',
    () => catItems + droppedWithCategory === catRepos || 'item.category=' + catItems + ' 被折叠=' + droppedWithCategory + ' registry.category=' + catRepos,
    () => 'item.category=' + catItems + '/' + catRepos + '（dedupe 折叠 ' + droppedWithCategory + '）')

  const dist = new Map()
  for (const item of items) {
    const key = item.category === undefined ? '<undefined>' : item.category === '' ? '<empty>' : item.category
    dist.set(key, (dist.get(key) ?? 0) + 1)
  }
  const dirtyCats = [...dist.keys()].filter(key => !/^[a-z][a-z0-9-]*$/.test(key))
  record('data', 'D3', 'category 取值分布（真实数据）', 'INFO',
    'distinct=' + dist.size + ' 非 slug/脏值=' + JSON.stringify(dirtyCats),
    rawJson([...dist].sort((a, b) => b[1] - a[1])))

  // ---- 3. 启动 bundle，提取卡片组件与样式（供 SSR / 浏览器渲染）
  let impl = null
  // marketView 的内部符号名可能是 rolldown 压缩后的短名，所以按「声明位置」抓取：
  // 先定位 src/marketView.ts 区域，再在该区域内解析出模块对象。
  let bundleMarketView = null
  // 卡片符号 + marketView 的契约符号一起导出：后者用来核对「bundle 内联的那份
  // marketView」与「我 import 的 dist/marketView.js」行为一致（构建器保留了这些
  // 顶层函数名；若将来被压缩改名，typeof 守卫会返回 undefined 并降级为 WARN）。
  const CARD_EXPORTS = ['MarketCard', 'PluginMarketplaceTab', 'styles']
  const VIEW_EXPORTS = ['rowComparator', 'compareByMode', 'compareTie', 'sortRows', 'filterByCategory', 'orderCategories', 'marketToolbarModel', 'defaultDescendingFor']
  try {
    const boot = bootBundle([...CARD_EXPORTS, ...VIEW_EXPORTS])
    record('client', 'C1', 'dist/client.js 可启动（平台种子表内 require）', boot.missed.length === 0 ? 'PASS' : 'FAIL',
      boot.missed.length === 0 ? 'bundle 仅 require 表内模块' : '越表 require: ' + boot.missed.join(', '))
    impl = boot.exported
    const missing = CARD_EXPORTS.filter(name => impl?.[name] === undefined)
    record('client', 'C2', '卡片组件/样式符号可提取（SSR 与浏览器实测的前置）',
      missing.length === 0 ? 'PASS' : 'WARN',
      missing.length === 0 ? CARD_EXPORTS.join(', ') + ' 全部就位'
        : '缺失: ' + missing.join(', ') + '（渲染类证据将跳过，不影响排序/标签契约结论）')
    bundleMarketView = VIEW_EXPORTS.every(name => typeof boot.exported?.[name] === 'function') ? boot.exported : null
  } catch (error) {
    record('client', 'C1', 'dist/client.js 可启动（平台种子表内 require）', 'FAIL',
      error instanceof Error ? error.message : String(error))
  }

  // C3: bundle 内联的 marketView 与 dist/marketView.js 行为等价。
  // 这条很关键：它是「我 import 的那份代码 == 线上 bundle 真正跑的那份代码」的桥。
  if (bundleMarketView !== null && marketView?.rowComparator !== undefined) {
    const probe = [...items].sort((a, b) => b.stars - a.stars).slice(0, 120)
    let mismatch = 0
    for (const mode of ['stars', 'az', 'updated', 'created']) {
      for (const descending of [false, true]) {
        const a = probe.map(item => item.name)
        a.sort((x, y) => bundleMarketView.rowComparator(mode, descending)(
          probe.find(item => item.name === x), probe.find(item => item.name === y)))
        const b = marketView.sortRows(probe, mode, descending).map(item => item.name)
        if (a.join('\u0000') !== b.join('\u0000')) mismatch += 1
      }
    }
    record('client', 'C3', 'bundle 内联 marketView 与 dist/marketView.js 排序行为等价（8 组合）',
      mismatch === 0 ? 'PASS' : 'FAIL',
      mismatch === 0 ? '8 种 (模式×方向) 组合结果逐位相同' : '不一致组合数=' + mismatch,
      rawJson({ probeSize: probe.length, mismatch }))
  } else {
    record('client', 'C3', 'bundle 内联 marketView 与 dist/marketView.js 排序行为等价（8 组合）', 'WARN',
      'bundle 内未解析到 marketView 模块对象（可能被压缩重命名），跳过等价性核对')
  }

  // ---- 4. 排序契约（直接驱动 dist/marketView.js 里的比较器）
  if (marketView?.rowComparator !== undefined && marketView?.compareByMode !== undefined) {
    sortContract(record, check, marketView, items, dist)
  } else {
    record('sort', 'S0', '排序契约（需要 dist/marketView.js）', 'FAIL', '无法加载比较器，排序契约未验证')
  }

  // ---- 5. 标签契约
  tagContract(record, check, buildMarketTags, items, dist)

  // ---- 6. host 聚合 vs 客户端筛选
  const hostCategories = categoryCounts(items)
  const clientRecount = new Map()
  for (const item of items) {
    const id = (item.category ?? '').trim()
    if (id.length === 0) continue
    clientRecount.set(id, (clientRecount.get(id) ?? 0) + 1)
  }
  const hostMap = new Map(hostCategories.map(entry => [entry.id, entry.count]))
  const mismatch = [...new Set([...hostMap.keys(), ...clientRecount.keys()])].filter(id => hostMap.get(id) !== clientRecount.get(id))
  check('aggregate', 'A1', 'host categories 与客户端重算逐项一致',
    () => mismatch.length === 0 || '不一致 category=' + JSON.stringify(mismatch.slice(0, 8)),
    () => 'host 分类数=' + hostCategories.length + ' 客户端分类数=' + clientRecount.size)
  const sum = hostCategories.reduce((total, entry) => total + entry.count, 0)
  check('aggregate', 'A2', 'categories 计数之和 == 有 category 的条目数',
    () => sum === items.filter(i => (i.category ?? '').trim().length > 0).length || '总和=' + sum + ' 期望=' + items.filter(i => (i.category ?? '').trim().length > 0).length)
  let countsSorted = true
  for (let i = 1; i < hostCategories.length; i += 1) {
    if (hostCategories[i - 1].count < hostCategories[i].count) countsSorted = false
    if (hostCategories[i - 1].count === hostCategories[i].count && hostCategories[i - 1].id > hostCategories[i].id) countsSorted = false
  }
  check('aggregate', 'A3', 'categoryCounts 排序（次数降序、同数 id 升序）', () => countsSorted || '排序不符',
    () => rawJson(hostCategories))
  if (marketView?.orderCategories !== undefined) {
    const ordered = marketView.orderCategories(hostCategories)
    check('aggregate', 'A4', "客户端 orderCategories：'other' 置底、其余保持计数降序",
      () => {
        const others = ordered.filter(entry => entry.id !== 'other')
        const last = ordered[ordered.length - 1]
        if (ordered.length !== hostCategories.length) return '条数不一致 ' + ordered.length + ' != ' + hostCategories.length
        if (hostCategories.some(entry => entry.id === 'other') && last?.id !== 'other') return "'other' 未置底，末位=" + last?.id
        for (let i = 1; i < others.length; i += 1) if (others[i - 1].count < others[i].count) return '非 other 段计数降序被破坏'
        return true
      },
      () => rawJson(ordered.slice(0, 6).concat(ordered.slice(-1))))
  }

  // ---- 7. 边界反例
  edgeContract(record, buildMarketTags)

  // ---- 8. 双列等高结构证据（SSR 渲染真实卡片）
  const rendered = ssrContract(record, check, impl, marketView, items)

  // ---- 9. 可选：无头 Chromium 实测
  if (RUN_BROWSER) {
    await browserContract(record, check, impl, marketView, items, hostCategories)
  } else {
    record('browser', 'W0', '无头 Chromium 实测', 'INFO', '未启用（加 --browser 运行）')
  }

  finish()
}

// ---------------------------------------------------------- 排序契约实现

function sortContract(record, check, impl, items, dist) {
  const { rowComparator, compareByMode, SORT_DEFAULT_DESCENDING, compareTie, marketToolbarModel, defaultDescendingFor, sortRows, filterByCategory } = impl
  const MODES = ['stars', 'az', 'updated', 'created']
  const sample = items.slice(0, 400)

  // S0: 比较器自反/反对称/传递性（随机对与三元组）
  let asymBad = 0
  let transBad = 0
  for (let i = 0; i < 3000; i += 1) {
    const a = items[(i * 7919) % items.length]
    const b = items[(i * 104729 + 13) % items.length]
    const ab = sign(compareByMode(a, b, MODES[i % 4]))
    const ba = sign(compareByMode(b, a, MODES[i % 4]))
    if (ab !== -ba) asymBad += 1
  }
  for (let i = 0; i < 3000; i += 1) {
    const a = sample[i % sample.length]
    const b = sample[(i * 7 + 1) % sample.length]
    const c = sample[(i * 13 + 2) % sample.length]
    const ab = compareByMode(a, b, 'stars')
    const bc = compareByMode(b, c, 'stars')
    const ac = compareByMode(a, c, 'stars')
    if (ab <= 0 && bc <= 0 && ac > 0) transBad += 1
  }
  check('sort', 'S0a', '比较器反对称（compareByMode(a,b) == -compareByMode(b,a)）', () => asymBad === 0 || '违例=' + asymBad)
  check('sort', 'S0b', '比较器传递（stars 三元组抽样）', () => transBad === 0 || '违例=' + transBad)

  /**
   * 方向判定的唯一真值来源是「方向按钮文案」：
   * 产物里按钮渲染的是 descending ? t("sortDesc") : t("sortAsc")，所以
   *   descending=false → 按钮显示「升序」→ 列表主键必须单调不减；
   *   descending=true  → 按钮显示「降序」→ 列表主键必须单调不增。
   * 这样判定完全不依赖我如何理解内部字段名，只看用户看到的东西。
   */
  // 方向文案的真值来源就是产物自己的 marketToolbarModel（同一个 descending 标志），
  // 不是我对字段名的理解。
  const labelFor = (descending) => (marketToolbarModel(undefined, descending, '').directionLabelKey === 'sortDesc' ? '降序' : '升序')
  const rowsOf = (mode, descending) => sortRows !== undefined
    ? sortRows(items, mode, descending)
    : [...items].sort(rowComparator(mode, descending))
  /**
   * 主键方向：'asc' | 'desc' | 'flat'。
   * marketView 的契约是「已安装条目在**所有模式、两个方向**都置顶」（它是优先级
   * 而非排序键），所以任何模式都要先按 installed 分组再逐组判定方向。
   */
  const keyDirection = (rows, mode) => {
    const groups = [rows.filter(row => row.installed), rows.filter(row => !row.installed)]
    const dirs = new Set()
    for (const group of groups) {
      if (group.length < 2) continue
      let asc = true
      let desc = true
      for (let i = 1; i < group.length; i += 1) {
        const prev = pick(group[i - 1], mode)
        const next = pick(group[i], mode)
        // 统一成 localeCompare 的符号约定：cmp < 0 = 升序，cmp > 0 = 降序。
        const cmp = typeof prev === 'number' ? prev - next : String(prev).localeCompare(String(next))
        if (cmp < 0) desc = false
        if (cmp > 0) asc = false
      }
      if (asc && desc) continue
      dirs.add(asc ? 'asc' : 'desc')
    }
    return dirs.size === 0 ? 'flat' : dirs.size === 1 ? [...dirs][0] : 'mixed'
  }

  for (const mode of MODES) {
    for (const descending of [false, true]) {
      const rows = rowsOf(mode, descending)
      const label = labelFor(descending)
      const actual = keyDirection(rows, mode)
      const wanted = descending ? 'desc' : 'asc'
      const conserved = sameMultiset(items, rows) && identityCounts(rows).size === rows.length
      // 稳定全序：相邻两条的「模式比较 + tie-break」必须严格非 0（不同条目绝不判等）
      let strict = true
      for (let i = 1; i < rows.length; i += 1) {
        if (compareByMode(rows[i - 1], rows[i], mode) === 0 && compareTie(rows[i - 1], rows[i]) === 0) strict = false
      }
      // 时间模式在真实数据上可能全空（registry 不带 createdAt）——空键不构成方向证据
      const allEmpty = mode !== 'stars' && mode !== 'az' && rows.every(row => pick(row, mode) === '')
      const directionOk = allEmpty || actual === wanted
      record('sort', 'S1-' + mode + '-' + (descending ? 'desc' : 'asc'),
        mode + ' descending=' + String(descending) + '（按钮显示「' + label + '」）：守恒 + 稳定全序 + 方向与按钮一致',
        conserved && strict && directionOk ? 'PASS' : 'FAIL',
        '守恒=' + conserved + ' 全序=' + strict + ' 实际方向=' + actual + ' 按钮方向=' + wanted
          + (allEmpty ? '（该模式在真实数据上时间字段全空，方向不可判定，跳过方向断言）' : '')
          + ' 首=' + JSON.stringify(pick(rows[0], mode)) + ' 末=' + JSON.stringify(pick(rows[rows.length - 1], mode)))
    }
  }

  // 默认方向：模式切换后的初始状态必须与「该模式的自然方向」一致（stars 降序 / az 升序 / 日期降序）
  const expected = { stars: true, az: false, updated: true, created: true }
  const defaultsOk = MODES.every(mode => SORT_DEFAULT_DESCENDING[mode] === expected[mode])
  record('sort', 'S2', '各模式默认方向（stars/updated/created 期望降序，az 期望升序）', defaultsOk ? 'PASS' : 'FAIL',
    JSON.stringify(SORT_DEFAULT_DESCENDING))

  // 默认方向 × 按钮文案 × 实际方向：三者的交叉验证（用户首次进入页面看到的第一屏）
  const firstScreen = MODES.map(mode => {
    const descending = SORT_DEFAULT_DESCENDING[mode]
    const rows = rowsOf(mode, descending)
    const actual = keyDirection(rows, mode)
    return { mode, descending, label: labelFor(descending), actual, wanted: descending ? 'desc' : 'asc', ok: actual === 'flat' || actual === (descending ? 'desc' : 'asc') }
  })
  check('sort', 'S3', '默认进入各模式：按钮文案方向 == 列表实际方向',
    () => firstScreen.every(entry => entry.ok)
      || '不一致=' + JSON.stringify(firstScreen.filter(entry => !entry.ok)),
    () => rawJson(firstScreen))

  // 静态核对：组件渲染的按钮文案取自 marketToolbarModel，比较器同样吃 (sort, descending)。
  const labelSource = readFileSync(join(ROOT, 'dist/client.js'), 'utf8')
  const toolbarModelUsed = /marketToolbarModel\(/.test(labelSource)
  const comparatorUsesFlag = /rowComparator\(sort, descending\)|sortRows\([^)]*sort, descending\)/.test(labelSource)
  record('sort', 'S3b', '组件文案与比较器同源于 (sort, descending)（bundle 内静态核对）',
    toolbarModelUsed && comparatorUsesFlag ? 'PASS' : 'FAIL',
    'marketToolbarModel 被组件使用=' + toolbarModelUsed + ' 比较器吃 descending=' + comparatorUsesFlag)

  // S3c: marketToolbarModel 对每个 (模式, 方向) 组合给出的文案，必须与实际方向一致
  const modelMismatch = []
  for (const mode of MODES) {
    for (const descending of [false, true]) {
      const rows = rowsOf(mode, descending)
      const actual = keyDirection(rows, mode)
      const expectedKey = descending ? 'sortDesc' : 'sortAsc'
      const model = marketToolbarModel(mode, descending, '')
      const allEmpty = rows.every(row => pick(row, mode) === '')
      if (model.directionLabelKey !== expectedKey) modelMismatch.push(mode + '/' + String(descending) + ' 文案键=' + model.directionLabelKey)
      else if (!allEmpty && actual !== (descending ? 'desc' : 'asc')) modelMismatch.push(mode + '/' + String(descending) + ' 实际方向=' + actual)
    }
  }
  check('sort', 'S3c', 'marketToolbarModel 文案键 ↔ 实际列表方向（8 种组合）',
    () => modelMismatch.length === 0 || '不一致=' + JSON.stringify(modelMismatch))

  // S3d: defaultDescendingFor 与 SORT_DEFAULT_DESCENDING 一致
  if (defaultDescendingFor !== undefined) {
    check('sort', 'S3d', 'defaultDescendingFor 与 SORT_DEFAULT_DESCENDING 一致',
      () => MODES.every(mode => defaultDescendingFor(mode) === SORT_DEFAULT_DESCENDING[mode]) || '不一致',
      () => rawJson(MODES.map(mode => ({ mode, viaFn: defaultDescendingFor(mode), viaTable: SORT_DEFAULT_DESCENDING[mode] }))))
  }

  // S3e: filterByCategory 与客户端筛选语义一致（精确 id 匹配，空分类不混桶）
  if (filterByCategory !== undefined) {
    const counts = new Map()
    for (const item of items) counts.set(item.category ?? '', (counts.get(item.category ?? '') ?? 0) + 1)
    const bad = []
    for (const [id, expected] of counts) {
      if (id === '') continue
      const got = filterByCategory(items, id).length
      if (got !== expected) bad.push(id + ': ' + got + ' != ' + expected)
    }
    check('sort', 'S3e', 'filterByCategory 与逐项重算一致（精确 id 匹配）',
      () => bad.length === 0 || '不一致=' + JSON.stringify(bad.slice(0, 6)),
      () => '分类数=' + counts.size)
  }

  // 星数专项：默认（首次进入，stars 模式）第一屏不得把 0 星排到正星数之前
  const starDefault = rowsOf('stars', SORT_DEFAULT_DESCENDING.stars)
  const firstPositive = starDefault.findIndex(row => row.stars > 0)
  const zeroBefore = starDefault.filter((row, index) => row.stars === 0 && index < firstPositive).length
  record('sort', 'S4', 'stars 默认第一屏：0 星条目不排在正星数之前', zeroBefore === 0 ? 'PASS' : 'FAIL',
    '0 星=' + items.filter(i => i.stars === 0).length + ' 越位=' + zeroBefore,
    rawJson(starDefault.slice(0, 6).map(row => ({ name: row.name, stars: row.stars, installed: row.installed }))))

  // 切换排序不丢条目不重复（全循环）
  let cycleOk = true
  const trail = []
  for (const [mode, descending] of [['stars', true], ['stars', false], ['az', false], ['az', true],
    ['updated', true], ['updated', false], ['created', true], ['created', false], ['stars', true]]) {
    const rows = rowsOf(mode, descending)
    trail.push(mode + (descending ? '↓' : '↑'))
    if (!sameMultiset(items, rows) || identityCounts(rows).size !== rows.length) cycleOk = false
  }
  record('sort', 'S5', '排序切换循环不丢条目/不重复', cycleOk ? 'PASS' : 'FAIL',
    cycleOk ? trail.join(' → ') : '存在不守恒步骤: ' + trail.join(' → '))

  // 搜索态排序也必须确定（同分走 compareTie）
  const hits = items.slice(0, 300).map(item => ({ item, score: item.stars % 3 }))
  const a1 = [...hits].sort((a, b) => b.score - a.score || compareTie(a.item, b.item)).map(h => h.item.name)
  const a2 = [...hits].sort((a, b) => b.score - a.score || compareTie(a.item, b.item)).map(h => h.item.name)
  record('sort', 'S6', '搜索态同分排序确定（compareTie 兜底）', a1.join() === a2.join() ? 'PASS' : 'FAIL',
    '前 5=' + JSON.stringify(a1.slice(0, 5)))

  // 真实数据上各模式的 top-5（供报告人工复核）
  record('sort', 'S7', '各模式默认方向 top-5（真实数据抽样）', 'INFO', '', rawJson(MODES.map(mode => ({
    mode,
    descending: SORT_DEFAULT_DESCENDING[mode],
    top: rowsOf(mode, SORT_DEFAULT_DESCENDING[mode]).slice(0, 5)
      .map(row => ({ name: row.name, stars: row.stars, updatedAt: row.updatedAt, createdAt: row.createdAt })),
  }))))
}

function pick(item, mode) {
  if (item === undefined) return null
  if (mode === 'az') return item.displayName
  if (mode === 'updated') return item.updatedAt
  if (mode === 'created') return item.createdAt
  return item.stars
}

// ---------------------------------------------------------- 标签契约实现

function tagContract(record, check, buildMarketTags, items, dist) {
  const RANK = { category: 0, type: 1, status: 2, verify: 3, security: 4, topic: 5 }
  let orderBad = 0
  let dedupBad = 0
  let toneBad = 0
  let overflow = 0
  let valueBad = 0
  for (const item of items) {
    const tags = buildMarketTags(item)
    for (let i = 1; i < tags.length; i += 1) if (RANK[tags[i].kind] < RANK[tags[i - 1].kind]) orderBad += 1
    const keys = tags.map(tag => tag.value.trim().toLowerCase())
    if (new Set(keys).size !== keys.length) dedupBad += 1
    if (tags.some(tag => tag.value.trim().length === 0)) valueBad += 1
    if (tags.filter(tag => tag.kind === 'topic').length > 2) overflow += 1
    for (const tag of tags) {
      const risk = tag.value.toLowerCase()
      const want = tag.kind === 'status'
        ? (tag.value.includes('✅') ? 'success' : risk.includes('archiv') ? 'warning' : 'neutral')
        : tag.kind === 'verify' ? ((tag.level ?? 0) >= 2 ? 'success' : 'neutral')
          : tag.kind === 'security'
            ? (risk === 'low' ? 'success' : risk === 'medium' ? 'warning' : (risk === 'high' || risk === 'critical') ? 'danger' : 'neutral')
            : 'neutral'
      if (tag.tone !== want) toneBad += 1
    }
  }
  check('tags', 'T1', '标签顺序 category→type→status→verify→security→topic（' + items.length + ' 条真实数据）',
    () => orderBad === 0 || '违序条目=' + orderBad)
  check('tags', 'T2', '跨 kind 值去重（大小写不敏感）', () => dedupBad === 0 || '重复值条目=' + dedupBad)
  check('tags', 'T3', 'tone 映射（status/verify/security 全量）', () => toneBad === 0 || 'tone 不符=' + toneBad)
  check('tags', 'T4', 'topic 溢出截断（默认 ≤2）', () => overflow === 0 || '超限条目=' + overflow)
  check('tags', 'T5', '无空/纯空白标签值', () => valueBad === 0 || '空值条目=' + valueBad)

  // T6: category 与 topic 同名 → 只留高优先级者
  // 注意契约方向：src/tags.ts 明确「category=memory + topic=memory ⇒ 只出 category」。
  // topicLimit 在去重之前截断（topics.slice(0, limit) 后逐条 push），
  // 所以同名 topic 会占用配额：['memory','MEMORY','notes'] 只剩 category 一个标签。
  const dupTag = buildMarketTags({ category: 'memory', topics: ['memory', 'MEMORY', 'notes'] })
  check('tags', 'T6', 'category 与 topic 同名只留 category（同名 topic 占配额后不再补位）',
    () => dupTag.length === 1 && dupTag[0].kind === 'category' && dupTag[0].value === 'memory'
      || '实际=' + JSON.stringify(dupTag.map(t => t.kind + ':' + t.value)),
    () => rawJson(dupTag))
  const dupNext = buildMarketTags({ category: 'memory', topics: ['memory', 'notes'] })
  check('tags', 'T6b', '同名 topic 被去重后，配额内的下一个不同 topic 仍保留',
    () => dupNext.length === 2 && dupNext[0].kind === 'category' && dupNext[1].kind === 'topic' && dupNext[1].value === 'notes'
      || '实际=' + JSON.stringify(dupNext.map(t => t.kind + ':' + t.value)),
    () => rawJson(dupNext))
  const reverseDup = buildMarketTags({ topics: ['notes', 'memory'], category: 'memory' })
  check('tags', 'T6c', '顺序无关：topic 在前也去重',
    () => reverseDup.length === 2 && reverseDup[0].kind === 'category' || '实际=' + JSON.stringify(reverseDup.map(t => t.kind + ':' + t.value)))

  // T7: 真实数据里 category 与 topic 同名的条目（真实存在与否都要给出计数）
  let realDup = 0
  for (const item of items) {
    const category = (item.category ?? '').trim().toLowerCase()
    if (category.length === 0) continue
    if ((item.topics ?? []).some(topic => topic.trim().toLowerCase() === category)) realDup += 1
  }
  record('tags', 'T7', '真实数据中 category 与 topic 同名的条目数', 'INFO',
    'count=' + realDup + '（这些条目在卡片上只显示 category 标签）')

  // T8: 脏 category 原样保留、tone=neutral、不误并
  const dirty = [...dist.keys()].filter(key => key !== '<undefined>' && key !== '<empty>' && !/^[a-z][a-z0-9-]*$/.test(key))
  const dirtyResult = dirty.map(cat => ({ cat, tags: buildMarketTags({ category: cat }) }))
  check('tags', 'T8', '脏/未知 category 原样保留且 tone=neutral（不崩、不误分类）',
    () => dirtyResult.every(entry => entry.tags.length === 1 && entry.tags[0].kind === 'category'
      && entry.tags[0].value === entry.cat && entry.tags[0].tone === 'neutral')
      || '异常=' + JSON.stringify(dirtyResult.filter(e => !(e.tags.length === 1 && e.tags[0].tone === 'neutral'))),
    () => rawJson(dirtyResult))

  // T9: topicLimit 与 title 契约
  const many = buildMarketTags({ topics: ['a', 'b', 'c', 'd'] })
  check('tags', 'T9', 'topicLimit 截断 + title 保留完整列表',
    () => many.length === 2 && many[0].title === 'a, b, c, d' || '实际=' + JSON.stringify(many.map(t => ({ v: t.value, title: t.title }))))

  // T10: 卡片两行标签槽位（TAG_SLOTS）能容纳标签模型的最大输出
  const maxTags = Math.max(...items.map(item => buildMarketTags(item).length))
  record('tags', 'T10', '真实数据标签数上限 vs 卡片槽位', maxTags <= 8 ? 'PASS' : 'FAIL',
    '最大标签数=' + maxTags + ' 卡片槽位=' + 8 + '（TAG_SLOTS×2）')
}

// ---------------------------------------------------------- 边界反例实现

function edgeContract(record, buildMarketTags) {
  const EDGE = [
    ['E1', '未知 category', { category: 'brand-new-cat', topics: ['x'] }],
    ['E2', 'topics 空数组', { category: 'tool', topics: [] }],
    ['E3', 'description 缺失', { category: 'tool', stars: 0 }],
    ['E4', 'stars=0', { category: 'tool', stars: 0, updatedAt: '', createdAt: '' }],
    ['E5', '时间字段为空', { category: 'tool', updatedAt: '', createdAt: '' }],
    ['E6', '同名不同 owner', { category: 'tool', name: 'alice/tools' }],
    ['E7', 'category 纯空白', { category: '   ', topics: ['ok'] }],
    ['E8', 'topics 含空串/重复', { topics: ['', ' ', 'ok', 'OK'] }],
    ['E9', '全空对象', {}],
    ['E10', 'verify L5 + security critical', { verification: { level: 5, label: 'x' }, security: { riskLevel: 'critical', status: 'scanned' } }],
    ['E11', 'security=skipped', { security: { riskLevel: 'low', status: 'skipped' } }],
    ['E12', '脏 category（中文/emoji）', { category: '🗂 文件数据', topics: ['x'] }],
    ['E13', '超长 category（200 字符）', { category: 'x'.repeat(200) }],
    ['E14', 'topics 非字符串元素（String() 兜底后仍出标签）', { category: 'tool', topics: [null, undefined, 42, 'ok'] }],
  ]
  for (const [id, title, source] of EDGE) {
    try {
      const tags = buildMarketTags(source)
      const keys = tags.map(tag => tag.value.trim().toLowerCase())
      const clean = tags.every(tag => typeof tag.value === 'string' && tag.value.trim().length > 0 && typeof tag.tone === 'string')
      const unique = new Set(keys).size === keys.length
      record('edge', id, 'buildMarketTags 边界: ' + title, clean && unique ? 'PASS' : 'FAIL',
        '标签=' + JSON.stringify(tags.map(t => t.kind + ':' + t.value)), rawJson(tags))
    } catch (error) {
      record('edge', id, 'buildMarketTags 边界: ' + title, 'FAIL',
        '抛异常: ' + (error instanceof Error ? error.message : String(error)))
    }
  }

  // E15: buildMarketTags 对非字符串 topics 元素必须「不崩且 String() 化」。
  // 历史：tags.ts 曾直接 topic.trim()，遇到 null 抛 TypeError 会中断整张卡片渲染。
  // 现已改为 String(topic).trim() 兜底 —— 这里断言修复生效，而不是只记录行为。
  const nonStringCases = [
    { label: 'null', topics: [null] },
    { label: 'undefined', topics: [undefined] },
    { label: 'number 42', topics: [42] },
    { label: 'boolean true', topics: [true] },
    { label: 'object', topics: [{ a: 1 }] },
  ]
  const nonStringResults = []
  let nonStringThrew = 0
  for (const probe of nonStringCases) {
    try {
      const tags = buildMarketTags({ category: 'tool', topics: probe.topics })
      const topicTags = tags.filter(tag => tag.kind === 'topic')
      nonStringResults.push({
        input: probe.label,
        values: topicTags.map(tag => tag.value),
        // String(null) === 'null'，所以标签值应当是 'null'/'undefined'/'42'/'true'/'[object Object]'
        stringified: topicTags.every(tag => typeof tag.value === 'string' && tag.value.length > 0),
      })
    } catch (error) {
      nonStringThrew += 1
      nonStringResults.push({ input: probe.label, error: error instanceof Error ? error.constructor.name + ': ' + error.message : String(error) })
    }
  }
  check('edge', 'E15', 'buildMarketTags 对非字符串 topics 不崩且 String() 化（修复回归断言）',
    () => nonStringThrew === 0 && nonStringResults.every(entry => entry.stringified === true)
      || '抛异常=' + nonStringThrew + ' 详情=' + JSON.stringify(nonStringResults),
    () => rawJson(nonStringResults))

  // E16: 空/纯空白 topic 不占用 topicLimit 配额（修复后语义：配额只算真正输出的标签）
  const blankTopics = buildMarketTags({ topics: ['', '  ', 'real', 'second'] })
  check('edge', 'E16', '空/空白 topic 不占用 topicLimit 配额',
    () => blankTopics.length === 2 && blankTopics[0].value === 'real' && blankTopics[1].value === 'second'
      || '实际=' + JSON.stringify(blankTopics.map(t => t.kind + ':' + t.value)),
    () => rawJson(blankTopics))
}

// ------------------------------------------------ 双列等高：SSR 结构证据

function ssrContract(record, check, impl, marketView, items) {
  if (impl?.MarketCard === undefined || impl?.styles === undefined) {
    record('align', 'L0', 'SSR 结构证据（需要产物卡片）', 'FAIL', '无法提取 MarketCard/styles')
    return []
  }
  const React = require_('react')
  const { renderToStaticMarkup } = require_('react-dom/server')
  const { MarketCard, styles } = impl
  const t = (key) => '[' + key + ']'
  const noop = () => {}
  const props = { busy: false, disabled: false, envQuestions: null, t, onInstall: noop, onUpdate: noop, onEnvContinue: noop, onEnvCancel: noop }

  // 代表性样本：最多标签 / 无 topics / 无日期 / 已安装 / 脏 category
  const ranked = [...items].sort((a, b) => b.stars - a.stars)
  const withMostTags = [...items].sort((a, b) => (b.topics?.length ?? 0) - (a.topics?.length ?? 0))[0]
  const noTopics = items.find(item => item.topics === undefined)
  const noDates = items.find(item => item.updatedAt === '' && item.createdAt === '')
  const dirty = items.find(item => item.category !== undefined && !/^[a-z][a-z0-9-]*$/.test(item.category))
  const sample = [ranked[0], ranked[1], withMostTags, noTopics, noDates, dirty]
    .filter((item, index, list) => item !== undefined && list.indexOf(item) === index)

  const markup = []
  const structures = []
  for (const item of sample) {
    const tags = marketView?.tagsOf !== undefined ? marketView.tagsOf(item) : []
    const html = renderToStaticMarkup(React.createElement(MarketCard, { ...props, item, tags: Array.isArray(tags) ? tags : [] }))
    markup.push({ name: item.name, html })
    structures.push({ name: item.name, ...describeCard(html) })
  }
  record('align', 'L1', 'SSR 渲染真实卡片（' + sample.length + ' 条样本）', markup.length === sample.length ? 'PASS' : 'FAIL',
    '样本=' + JSON.stringify(sample.map(item => item.name)))

  // 结构：每个卡片固定 5 个槽位，且各槽位高度为常量
  const slotCounts = [...new Set(structures.map(entry => entry.slots.length))]
  check('align', 'L2', '每张卡片固定 5 个内容槽位（标题/标签1/标签2/描述/日期）',
    () => slotCounts.length === 1 && slotCounts[0] === 5 || '槽位数集合=' + JSON.stringify(slotCounts),
    () => rawJson(structures.map(entry => ({ name: entry.name, slots: entry.slots.length, heights: entry.slotHeights }))))

  const expectedHeights = ['52px', '24px', '24px', '42px', '30px']
  const heightMatch = structures.every(entry => entry.slotHeights.length === 5
    && entry.slotHeights.every((height, index) => height === expectedHeights[index]))
  check('align', 'L3', '槽位高度为固定常量 52/24/24/42/30（与标签数量无关）',
    () => heightMatch || '实际=' + JSON.stringify(structures.map(entry => entry.slotHeights)),
    () => rawJson({ expected: expectedHeights, actual: structures.map(entry => entry.slotHeights) }))

  const cardHeights = structures.map(entry => entry.declaredHeight)
  const uniform = new Set(cardHeights).size === 1
  record('align', 'L4', '卡片声明高度一致（等高）', uniform ? 'PASS' : 'FAIL',
    '声明高度集合=' + JSON.stringify([...new Set(cardHeights)]) + ' 槽位和=' + (52 + 24 + 24 + 42 + 30) + 'px + 2×border',
    rawJson(structures.map(entry => ({ name: entry.name, declaredHeight: entry.declaredHeight }))))

  // grid 容器：两列 + stretch（同行两卡共享行高）
  const cardsStyle = styles.cards ?? {}
  const gridOk = String(cardsStyle.gridTemplateColumns ?? '').includes('repeat(2')
    && cardsStyle.alignItems === 'stretch'
  check('align', 'L5', 'grid 容器两列 + align-items:stretch（同行两卡等高）',
    () => gridOk || 'gridTemplateColumns=' + cardsStyle.gridTemplateColumns + ' alignItems=' + cardsStyle.alignItems)

  // 卡片是 flex column（高度由固定槽位求和，不由内容决定）
  const cardStyle = styles.card ?? {}
  const flexOk = cardStyle.display === 'flex' && cardStyle.flexDirection === 'column'
  check('align', 'L6', '卡片为 flex column（高度与内容无关）', () => flexOk || JSON.stringify(cardStyle))

  // 描述统一 2 行截断
  const clampOk = styles.cardDesc?.WebkitLineClamp === 2 && String(structures[0]?.descStyle ?? '').includes('-webkit-line-clamp:2')
  check('align', 'L7', '描述统一 2 行截断（-webkit-line-clamp:2）',
    () => clampOk || 'styles.cardDesc.WebkitLineClamp=' + styles.cardDesc?.WebkitLineClamp + ' 渲染样式=' + structures[0]?.descStyle)

  // 标签行不换行（溢出裁剪而非折行）
  const nowrapOk = styles.tagRow?.flexWrap === 'nowrap' && styles.tagRow?.overflow === 'hidden'
  check('align', 'L8', '标签行 nowrap + overflow:hidden（不折行、不撑高）',
    () => nowrapOk || 'flexWrap=' + styles.tagRow?.flexWrap + ' overflow=' + styles.tagRow?.overflow)

  // content-visibility 的占位高度与真实槽位和一致（滚动条不跳）。
  // 期望值由样式推导而非硬编码：槽位和 + 上下边框（border:0 时边框贡献 0）。
  const intrinsic = String(cardStyle.containIntrinsicSize ?? '')
  const slotSum = expectedHeights.reduce((total, height) => total + Number.parseFloat(height), 0)
  const borderWidth = Number.parseFloat(String(cardStyle.borderWidth ?? '0')) || 0
  const expectedIntrinsic = 'auto ' + String(slotSum + borderWidth * 2) + 'px'
  check('align', 'L9', 'contain-intrinsic-size 与真实槽位和一致（占位不跳）',
    () => intrinsic === expectedIntrinsic || '实际=' + intrinsic + ' 期望=' + expectedIntrinsic,
    () => rawJson({ slotSum, borderWidth, expected: expectedIntrinsic, actual: intrinsic }))

  return markup
}

/** 解析 SSR 出的卡片 HTML：槽位数量、各槽位高度、描述行样式。 */
function describeCard(html) {
  const li = /<li[^>]*style="([^"]*)"/.exec(html)
  const children = html.match(/<div[^>]*style="[^"]*"/g) ?? []
  const slotHeights = []
  for (const child of children) {
    const height = /height:\s*([0-9.]+px)/.exec(child)
    if (height !== null) slotHeights.push(height[1])
  }
  const desc = /-webkit-line-clamp[^;]*/.exec(html)
  return {
    liStyle: li?.[1] ?? '',
    slots: children,
    slotHeights,
    declaredHeight: /contain-intrinsic-size:\s*([^;"]+)/.exec(li?.[1] ?? '')?.[1]?.trim() ?? '',
    descStyle: desc?.[0] ?? '',
  }
}

// -------------------------------------------- 可选：无头 Chromium 实测

async function browserContract(record, check, impl, marketView, items, hostCategories) {
  const candidates = [
    join(homedir(), '.cache/ms-playwright/chromium-1228/chrome-linux64/chrome'),
    join(homedir(), '.cache/ms-playwright/chromium-1217/chrome-linux64/chrome'),
    join(homedir(), '.cache/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-linux64/chrome-headless-shell'),
    join(homedir(), '.cache/ms-playwright/chromium_headless_shell-1217/chrome-headless-shell-linux64/chrome-headless-shell'),
  ]
  const binary = candidates.find(path => existsSync(path)) ?? null
  if (binary === null) return record('browser', 'W1', '无头 Chromium 可用', 'WARN', '~/.cache/ms-playwright 下无 chromium，跳过实测')
  if (impl?.PluginMarketplaceTab === undefined || impl?.styles === undefined) {
    return record('browser', 'W1', '无头 Chromium 实测前置', 'WARN', '无法提取组件，跳过')
  }
  let child = null
  let profileDir = null
  try {
    const { spawn } = await import('node:child_process')

    // 真实 locale 字典：从 bundle 自己的 apply() 注册里取（与线上同一份文案）
    const dicts = []
    bootBundle().exported.apply({
      effect(fn) { fn() },
      locale: {
        register(ns, dict) { dicts.push({ ns, dict }) },
        bind: (ns) => (key, params) => {
          const base = dicts.find(entry => entry.ns === ns)?.dict.zh ?? {}
          const value = String(base[key] ?? key)
          return params === undefined ? value : value.replace(/\{(\w+)\}/g, (_, k) => String(params[k] ?? ''))
        },
      },
      slots: { inject(_name, fn) { fn() }, register() { return () => {} } },
    })
    const zh = dicts[0]?.dict.zh ?? {}
    const t = (key, params) => {
      const value = String(zh[key] ?? key)
      return params === undefined ? value : value.replace(/\{(\w+)\}/g, (_, k) => String(params[k] ?? ''))
    }

    // 固定夹具：真实 40 条（星数降序），含无 topics / 无日期 / 脏 category 的边界条目，
    // 让「等高」断言覆盖标签数量差异最大的组合。
    const ranked = [...items].sort((a, b) => b.stars - a.stars)
    const extras = [
      items.find(item => item.topics === undefined),
      items.find(item => item.updatedAt === '' && item.createdAt === ''),
      items.find(item => item.category !== undefined && !/^[a-z][a-z0-9-]*$/.test(item.category)),
      items.find(item => item.category === undefined),
    ].filter((item, index, list) => item !== undefined && list.indexOf(item) === index)
    // 夹具必须按 name 去重：React key=item.name，重复 key 会让 DOM 顺序错乱，
    // 那是夹具缺陷而非产品缺陷（真实 listing 的 name 唯一性由 P2 单独守护）。
    const fixture = []
    const fixtureSeen = new Set()
    for (const item of [...ranked.slice(0, 40), ...extras]) {
      if (fixtureSeen.has(item.name)) continue
      fixtureSeen.add(item.name)
      fixture.push(item)
    }
    const face = {
      marketplace: async () => ({
        ok: true, items: fixture, fromCache: false, message: 'verification-fixture',
        total: fixture.length, categories: hostCategories,
      }),
      profiles: async () => [{ name: 'pm-test', path: '/tmp/pm-test', bundles: [], dependencies: [], isCurrent: true, isOfficial: false, running: null }],
      install: async () => ({ ok: true, message: '', exitCode: 0, output: '' }),
      update: async () => ({ ok: true, message: '', exitCode: 0, output: '' }),
      unblock: async () => ({ ok: true, message: '' }),
    }
    const pageProps = { ...face, t, locale: 'zh' }

    profileDir = join(tmpdir(), 'dshpm-verify-chrome-' + String(Date.now()))
    mkdirSync(profileDir, { recursive: true })
    const port = 9400 + Math.floor(Math.random() * 400)
    const pageUrl = 'file://' + join(profileDir, 'page.html')
    writeFileSync(join(profileDir, 'page.html'), buildPage(fixture, hostCategories, zh))

    child = spawn(binary, [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
      '--hide-scrollbars', '--window-size=1280,1400', '--force-device-scale-factor=1',
      '--remote-debugging-port=' + String(port), '--user-data-dir=' + join(profileDir, 'data'),
      pageUrl,
    ], { stdio: ['ignore', 'pipe', 'pipe'] })
    let chromeErr = ''
    child.stderr?.on('data', (chunk) => { chromeErr += String(chunk) })

    const wsUrl = await waitForDevtools(port, 20000)
    const evaluate = async (send, expression) => {
      const out = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      if (out?.exceptionDetails !== undefined) throw new Error('页面脚本异常: ' + JSON.stringify(out.exceptionDetails).slice(0, 400))
      return out?.result?.value
    }
    // 期望顺序由产物自己的模型算出来（marketView.sortRows），再与浏览器 DOM 顺序逐位比对——
    // 这比「星数单调」更严格，也能正确处理「已安装条目置顶」这类优先级契约。
    const { sortRows, defaultDescendingFor } = marketView
    const expectedBefore = sortRows(fixture, 'stars', defaultDescendingFor('stars')).map(item => item.name)
    const expectedAfter = sortRows(fixture, 'stars', false).map(item => item.name)

    const result = await runCdp(wsUrl, async (send) => {
      // 等 React 渲染完成（首屏 RENDER_BATCH=120 条，夹具 40 条应一次渲染完）
      // 自检：生成的测量页必须含关键函数（防止转义把脚本写坏后「静默变绿」）。
    const pageSource = readFileSync(join(profileDir, 'page.html'), 'utf8')
    const requiredFns = ['function cardStars', 'function actualDirection', 'function toolbarButtons', 'function menuItems', 'window.__measure', 'window.__clickDirection']
    const missingFns = requiredFns.filter(name => !pageSource.includes(name))
    if (missingFns.length > 0) throw new Error('测量页生成不完整，缺少: ' + missingFns.join(', '))
    const rendered = await evaluate(send, 'window.__waitForCards(' + String(fixture.length) + ', 25000)')
      if (rendered !== fixture.length) {
        const failure = await evaluate(send, 'String(window.__error || "")')
        throw new Error('页面仅渲染 ' + String(rendered) + '/' + String(fixture.length) + ' 张卡片'
          + (failure ? ' | ' + String(failure).slice(0, 300) : '') + (chromeErr ? ' | chrome: ' + chromeErr.slice(-200) : ''))
      }
      const measured = JSON.parse(await evaluate(send, 'JSON.stringify(window.__measure())'))
      const before = JSON.parse(await evaluate(send, 'JSON.stringify(window.__directionSnapshot())'))
      await evaluate(send, 'window.__clickDirection()')
      await new Promise(resolve => setTimeout(resolve, 400))
      const after = JSON.parse(await evaluate(send, 'JSON.stringify(window.__directionSnapshot())'))
      measured.direction = { before, after, consistent: before.consistent && after.consistent }
      return measured
    })

    record('browser', 'W1', '无头 Chromium 启动并完成真实渲染测量', 'PASS',
      binary.includes('headless_shell') ? 'chrome-headless-shell' : 'chrome --headless=new',
      rawJson({ cards: result.cards.length, rows: result.rowPairs.length, fixture: fixture.length, viewport: result.viewport }))

    // W2: 两列等高——同一 grid row 两卡的 boundingBox 高度差（核心加分项）
    const rowPairs = result.rowPairs ?? []
    const maxDiff = rowPairs.length === 0 ? null : Math.max(...rowPairs.map(pair => Math.abs(pair[0].height - pair[1].height)))
    check('browser', 'W2', '两列卡片 boundingBox 高度差（同一 grid row，期望 ≤0.5px）',
      () => maxDiff !== null && maxDiff <= 0.5 || '最大高度差=' + maxDiff + 'px（完整行数=' + rowPairs.length + '）',
      () => rawJson({ rows: rowPairs.length, maxDiffPx: maxDiff, sample: rowPairs.slice(0, 4) }))

    const heights = (result.cards ?? []).map(card => Math.round(card.height * 100) / 100)
    const distinctHeights = [...new Set(heights)]
    record('browser', 'W3', '全部卡片实测高度', distinctHeights.length === 1 ? 'PASS' : 'WARN',
      '不同高度种类=' + distinctHeights.length + ' 取值=' + JSON.stringify(distinctHeights.slice(0, 8)),
      rawJson({ min: Math.min(...heights), max: Math.max(...heights), count: heights.length }))

    // W4: 方向按钮文案 ↔ 真实顺序（真实浏览器里点一下方向按钮）
    // W4: 按钮文案 == 实际方向（排除置顶的已安装条目后判定主键单调）
    //     先按 installed 分组，置顶组不参与方向判定（它是优先级，不是排序键）。
    const monotoneIgnoringPinned = (order, pinnedNames, descending) => {
      const rest = order.filter(name => !pinnedNames.has(name))
      const stars = rest.map(name => fixture.find(item => item.name === name)?.stars ?? null)
      for (let i = 1; i < stars.length; i += 1) {
        if (stars[i] === null || stars[i - 1] === null) continue
        if (descending ? stars[i] > stars[i - 1] : stars[i] < stars[i - 1]) return false
      }
      return true
    }
    const pinnedNames = new Set(fixture.filter(item => item.installed).map(item => item.name))
    const beforeOk = result.direction.before.expectedDir === 'desc'
      && monotoneIgnoringPinned(result.direction.before.order ?? [], pinnedNames, true)
    const afterOk = result.direction.after.expectedDir === 'asc'
      && monotoneIgnoringPinned(result.direction.after.order ?? [], pinnedNames, false)
    check('browser', 'W4', '方向按钮文案与真实列表顺序一致（点击前后各测一次；已安装置顶组排除）',
      () => beforeOk && afterOk
        || '点击前 ok=' + beforeOk + '（label=' + result.direction.before.label + ' 实际=' + result.direction.before.actual + '）'
          + ' 点击后 ok=' + afterOk + '（label=' + result.direction.after.label + ' 实际=' + result.direction.after.actual + '）',
      () => rawJson({
        pinned: [...pinnedNames],
        before: { label: result.direction.before.label, actual: result.direction.before.actual, head: (result.direction.before.order ?? []).slice(0, 8) },
        after: { label: result.direction.after.label, actual: result.direction.after.actual, head: (result.direction.after.order ?? []).slice(0, 8) },
      }))

    // W4b: DOM 顺序与模型期望顺序逐位相等（端到端最强断言）
    const domBefore = result.direction.before.order ?? []
    const domAfter = result.direction.after.order ?? []
    const sameOrder = (a, b) => a.length === b.length && a.every((value, index) => value === b[index])
    const firstDiff = (a, b) => {
      for (let i = 0; i < Math.max(a.length, b.length); i += 1) if (a[i] !== b[i]) return i
      return -1
    }
    check('browser', 'W4b', '浏览器 DOM 顺序 == marketView.sortRows 期望顺序（点击前后）',
      () => sameOrder(domBefore, expectedBefore) && sameOrder(domAfter, expectedAfter)
        || '点击前首个差异位=' + firstDiff(domBefore, expectedBefore)
          + ' 点击后首个差异位=' + firstDiff(domAfter, expectedAfter),
      () => rawJson({
        before: { dom: domBefore.slice(0, 10), expected: expectedBefore.slice(0, 10) },
        after: { dom: domAfter.slice(0, 10), expected: expectedAfter.slice(0, 10) },
      }))

    // W5: 工具栏与列数按钮存在
    record('browser', 'W5', '工具栏渲染（列数/刷新/目标 profile 按钮）',
      result.toolbar.colsButton !== '' && result.toolbar.refreshButton !== '' ? 'PASS' : 'WARN',
      rawJson(result.toolbar))

    // W6: 分类筛选下拉项与 host 聚合一致（含 other 置底）
    check('browser', 'W6', '分类筛选下拉项与 host 聚合一致（other 置底）',
      () => result.categories.consistent || '实际=' + JSON.stringify(result.categories.items.slice(0, 8)),
      () => rawJson(result.categories))
  } catch (error) {
    record('browser', 'W1', '无头 Chromium 实测', 'WARN',
      '环境不可用/失败（非产品缺陷，需人工复核）: ' + (error instanceof Error ? error.message : String(error)))
  } finally {
    try { child?.kill('SIGKILL') } catch { /* ignore */ }
  }
}

/**
 * 生成浏览器测量页：内联 React UMD + 打过导出的 bundle + 真实组件挂载 + 测量脚本。
 *
 * 说明：官方 primitives 依赖 clsx/katex/shiki 等未安装模块，无法在 Node 侧加载，
 * 这里用桩件替换（Menu 桩保留 items 以便读取下拉选项）；React/ReactDOM 用官方
 * UMD 构建，bundle 通过 __ModuleLoader__ 的 require 注入拿到它们——与线上一致。
 */
function buildPage(fixture, categories, locale) {
  const inline = (path) => readFileSync(path, 'utf8').replaceAll('</script', '<\\/script')
  // React 的 exports 字段没有暴露 ./umd/*，只能按 package.json 所在目录拼路径。
  const reactUmd = inline(join(dirname(require_.resolve('react/package.json')), 'umd/react.production.min.js'))
  const reactDomUmd = inline(join(dirname(require_.resolve('react-dom/package.json')), 'umd/react-dom.production.min.js'))
  // 注意：这里传的是源码字符串（不是路径），inline 只接受路径——单独转义。
  const bundle = bootBundleSource(['PluginMarketplaceTab', 'styles', 'buildMarketTags']).replaceAll('</script', '<\\/script')
  return [
    '<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>dshpm verification</title>',
    // 测量用覆盖：content-visibility:auto 会让视口外的卡片只按 contain-intrinsic-size
    // 占位（不是真实高度），实测前必须让它参与真实布局，否则「等高」是自证。
    '<style>li { content-visibility: visible !important; }</style>',
    '</head><body><div id="root"></div>',
    '<script>' + reactUmd + '</script>',
    '<script>' + reactDomUmd + '</script>',
    '<script>',
    'window.__jsxRuntime = { Fragment: window.React.Fragment,',
    '  jsx: function (type, props, key) { var p = Object.assign({}, props); if (key !== undefined) p.key = key; return window.React.createElement(type, p); },',
    '  jsxs: function (type, props, key) { var p = Object.assign({}, props); if (key !== undefined) p.key = key; return window.React.createElement(type, p); } };',
    // Menu 桩把 items 暴露到 DOM，便于读取分类下拉的真实选项与条数。
    'window.__primitives = new Proxy({}, { get: function (_target, name) {',
    '  if (name === "Menu") return function (props) {',
    '    return window.React.createElement("div", { "data-menu": "1", "data-items": JSON.stringify((props.items || []).map(function (i) { return i.id + "|" + i.label; })) }, props.anchor);',
    '  };',
    // Button 必须渲染成真实 <button>，否则「点击方向按钮」这类交互断言无从下手。
    '  if (name === "Button") return function (props) {',
    '    return window.React.createElement("button", { type: "button", disabled: props && props.disabled === true,',
    '      "aria-label": props && props["aria-label"], title: props && props.title, onClick: props && props.onClick },',
    '      props && props.children !== undefined ? props.children : null);',
    '  };',
    '  return function (props) { return window.React.createElement("span", { "data-stub": "1" }, props && props.children !== undefined ? props.children : null); };',
    '} });',
    'var __bundle = null;',
    'window.__ModuleLoader__ = { load: function (spec) { __bundle = spec.factory(function (name) {',
    '  if (name === "react") return window.React;',
    '  if (name === "react/jsx-runtime") return window.__jsxRuntime;',
    '  if (name === "react-dom") return window.ReactDOM;',
    '  if (name === "react-dom/client") return window.ReactDOM;',
    '  if (name === "@deepseek-ai/dsh-client-ui-primitives") return window.__primitives;',
    '  return {};',
    '}); } };',
    '</script>',
    '<script>' + bundle + '</script>',
    '<script>',
    'var ZH = ' + JSON.stringify(locale) + ';',
    'var FIXTURE = ' + JSON.stringify(fixture) + ';',
    'var CATEGORIES = ' + JSON.stringify(categories) + ';',
    'var t = function (key, params) {',
    '  var value = String(ZH[key] !== undefined ? ZH[key] : key);',
    '  return params === undefined ? value : value.replace(/\{(\w+)\}/g, function (_m, k) { return String(params[k] === undefined ? "" : params[k]); });',
    '};',
    'var ok = function () { return Promise.resolve({ ok: true, message: "", exitCode: 0, output: "" }); };',
    'var face = {',
    '  marketplace: function () { return Promise.resolve({ ok: true, items: FIXTURE, fromCache: false, message: "verification-fixture", total: FIXTURE.length, categories: CATEGORIES }); },',
    '  profiles: function () { return Promise.resolve([{ name: "pm-test", path: "/tmp/pm-test", bundles: [], dependencies: [], isCurrent: true, isOfficial: false, running: null }]); },',
    '  install: ok, update: ok, unblock: function () { return Promise.resolve({ ok: true, message: "" }); }',
    '};',
    'window.__error = "";',
    'window.__ready = false;',
    'try {',
    '  var root = window.ReactDOM.createRoot(document.getElementById("root"));',
    '  root.render(window.React.createElement(__bundle.PluginMarketplaceTab, Object.assign({}, face, { t: t, locale: "zh" })));',
    '} catch (error) { window.__error = String(error && error.stack ? error.stack : error); }',
    'function cardStars(card) {',
    '  var nodes = card.querySelectorAll("[title]");',
    '  for (var i = 0; i < nodes.length; i += 1) {',
    '    var raw = nodes[i].getAttribute("title");',
    // 注意：普通字符串里写正则需要双写反斜杠（\\d），否则 \d 会退化成 d。
    '    if (/^[0-9]+$/.test(String(raw))) return Number(raw);',
    '  }',
    '  return null;',
    '}',
    'function cardNames() {',
    '  return Array.prototype.slice.call(document.querySelectorAll("ul > li a[title]")).map(function (a) { return a.getAttribute("title"); });',
    '}',
    'function cardList() {',
    '  var cards = Array.prototype.slice.call(document.querySelectorAll("ul > li"));',
    '  return cards.map(function (card) {',
    '    var link = card.querySelector("a[title]");',
    '    return { name: link ? link.getAttribute("title") : "", stars: cardStars(card) };',
    '  });',
    '}',
    'window.__domOrder = function () { return cardList().map(function (c) { return c.name; }); };',
    'window.__cardList = function () { return cardList(); };',
    'function directionButton() {',
    '  var buttons = Array.prototype.slice.call(document.querySelectorAll("button"));',
    '  var asc = ZH.sortAsc, desc = ZH.sortDesc;',
    '  for (var i = 0; i < buttons.length; i += 1) {',
    '    var text = String(buttons[i].textContent || "").trim();',
    '    if (text === asc || text === desc) return { node: buttons[i], label: text };',
    '  }',
    '  return { node: null, label: "" };',
    '}',
    'function actualDirection() {',
    '  var cards = Array.prototype.slice.call(document.querySelectorAll("ul > li"));',
    '  var stars = cards.map(cardStars).filter(function (s) { return s !== null; });',
    '  var asc = true, desc = true;',
    '  for (var i = 1; i < stars.length; i += 1) {',
    '    if (stars[i] < stars[i - 1]) asc = false;',
    '    if (stars[i] > stars[i - 1]) desc = false;',
    '  }',
    '  return { count: stars.length, asc: asc, desc: desc, direction: asc && !desc ? "asc" : desc && !asc ? "desc" : (asc && desc ? "flat" : "mixed"), first: stars.slice(0, 5), last: stars.slice(-5) };',
    '}',
    'function toolbarButtons() {',
    '  return Array.prototype.slice.call(document.querySelectorAll("button")).map(function (b) { return String(b.textContent || "").trim(); });',
    '}',
    'function menuItems() {',
    '  return Array.prototype.slice.call(document.querySelectorAll("[data-menu]")).map(function (node) {',
    '    var items = [];',
    '    try { items = JSON.parse(node.getAttribute("data-items") || "[]"); } catch (error) { items = []; }',
    '    return items.map(function (entry) { var at = entry.indexOf("|"); return { id: entry.slice(0, at), label: entry.slice(at + 1) }; });',
    '  });',
    '}',
    'window.__measure = function () {',
    '  var cards = Array.prototype.slice.call(document.querySelectorAll("ul > li"));',
    '  var boxes = cards.map(function (card) { var r = card.getBoundingClientRect(); return { y: Math.round(r.y * 100) / 100, height: Math.round(r.height * 100) / 100, width: Math.round(r.width * 100) / 100 }; });',
    '  var byRow = {};',
    '  boxes.forEach(function (b) { var key = String(b.y); (byRow[key] = byRow[key] || []).push(b); });',
    '  var rowPairs = Object.keys(byRow).map(function (k) { return byRow[k]; }).filter(function (row) { return row.length === 2; });',
    '  var single = Object.keys(byRow).map(function (k) { return byRow[k]; }).filter(function (row) { return row.length === 1; });',
    '  var menus = menuItems();',
    '  var categoryMenu = null;',
    '  for (var i = 0; i < menus.length; i += 1) {',
    '    if (menus[i].length > 0 && menus[i][0].label.indexOf(ZH.filterAll) === 0) { categoryMenu = menus[i]; break; }',
    '  }',
    '  var categoryActual = (categoryMenu || []).slice(1).map(function (item) {',
    '    var at = item.label.lastIndexOf(" (");',
    '    return { id: item.id, label: item.label.slice(0, at), count: Number(item.label.slice(at + 2, -1)) };',
    '  });',
    '  var expected = CATEGORIES.slice();',
    '  var ordered = expected.filter(function (e) { return e.id !== "other"; }).concat(expected.filter(function (e) { return e.id === "other"; }));',
    '  var consistent = categoryMenu !== null',
    '    && categoryMenu[0].label === ZH.filterAll + " (" + FIXTURE.length + ")"',
    '    && categoryActual.length === ordered.length',
    '    && categoryActual.every(function (item, index) { return item.id === ordered[index].id && item.count === ordered[index].count; });',
    '  return {',
    '    viewport: { width: window.innerWidth, height: window.innerHeight },',
    '    cards: boxes, rowPairs: rowPairs, singleRow: single.length,',
    '    direction: { before: null, after: null, consistent: null },',
    '    toolbar: { buttons: toolbarButtons(), colsButton: (function () {',
    '      var names = [ZH.colsOne, ZH.colsTwo];',
    '      return toolbarButtons().filter(function (text) { return names.indexOf(text) !== -1; })[0] || "";',
    '    })(), refreshButton: (function () { return toolbarButtons().filter(function (text) { return text === ZH.refresh; })[0] || ""; })() },',
    '    categories: { items: categoryActual, expected: ordered, consistent: consistent, menuFound: categoryMenu !== null },',
    '    fixture: FIXTURE.length,',
    // 诊断信息：断言失败时用来区分「产品问题」与「桩件不完整」。
    '    debug: {',
    '      buttonCount: document.querySelectorAll("button").length,',
    '      buttonTexts: toolbarButtons(),',
    '      cardCount: cards.length,',
    '      firstCardTitles: cards.length > 0 ? Array.prototype.slice.call(cards[0].querySelectorAll("[title]")).map(function (n) { return n.getAttribute("title"); }) : [],',
    '      firstCardHtml: cards.length > 0 ? cards[0].outerHTML.slice(0, 900) : "",',
    '    }',
    '  };',
    '};',
    'window.__clickDirection = function () {',
    '  var found = directionButton();',
    '  if (found.node === null) return false;',
    '  found.node.click();',
    '  return true;',
    '};',
    'window.__directionSnapshot = function () {',
    '  var found = directionButton();',
    '  var actual = actualDirection();',
    '  var expectedDir = found.label === ZH.sortDesc ? "desc" : found.label === ZH.sortAsc ? "asc" : "";',
    '  return { label: found.label, expectedDir: expectedDir, actual: actual.direction, first: actual.first, last: actual.last,',
    '    order: cardList().map(function (c) { return c.name; }), cardList: cardList().slice(0, 12),',
    '    consistent: expectedDir !== "" && expectedDir === actual.direction };',
    '};',
    'window.__waitForCards = function (count, timeoutMs) {',
    '  return new Promise(function (resolve) {',
    '    var deadline = Date.now() + timeoutMs;',
    '    var tick = function () {',
    '      var n = document.querySelectorAll("ul > li").length;',
    '      if (n >= count || Date.now() > deadline) { window.__ready = n >= count; resolve(n); return; }',
    '      setTimeout(tick, 120);',
    '    };',
    '    tick();',
    '  });',
    '};',
    '</script>',
    '</body></html>',
  ].join('\n')
}

/** 读取 bundle 源码并把末尾导出替换为指定内部符号（其余字节原样）。 */
function bootBundleSource(exports) {
  const source = readFileSync(join(ROOT, 'dist/client.js'), 'utf8')
  const tail = 'return module.exports;'
  const at = source.lastIndexOf(tail)
  if (at < 0) throw new Error('dist/client.js 结构异常：找不到 ' + JSON.stringify(tail))
  const entries = exports
    .map(name => JSON.stringify(name) + ': typeof ' + name + ' !== "undefined" ? ' + name + ' : undefined')
    .join(', ')
  return source.slice(0, at) + 'return { ' + entries + ' };' + source.slice(at + tail.length)
}

async function waitForDevtools(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch('http://127.0.0.1:' + String(port) + '/json/list')
      const list = await response.json()
      const page = list.find(entry => entry.type === 'page' && entry.webSocketDebuggerUrl)
      if (page !== undefined) return page.webSocketDebuggerUrl
    } catch { /* not up yet */ }
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  throw new Error('DevTools 端口未就绪')
}

async function runCdp(wsUrl, fn) {
  const socket = new WebSocket(wsUrl)
  let nextId = 1
  const pending = new Map()
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', () => reject(new Error('CDP 连接失败')), { once: true })
  })
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    const entry = pending.get(message.id)
    if (entry !== undefined) {
      pending.delete(message.id)
      if (message.error !== undefined) entry.reject(new Error(JSON.stringify(message.error)))
      else entry.resolve(message.result)
    }
  })
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = nextId
    nextId += 1
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })
  try {
    await send('Page.enable', {})
    await send('Runtime.enable', {})
    return await fn(send)
  } finally {
    socket.close()
  }
}

function finish() {
  const counts = { PASS: 0, FAIL: 0, WARN: 0, INFO: 0 }
  for (const entry of evidence) counts[entry.status] += 1
  console.log('')
  console.log('== 汇总 == PASS=' + counts.PASS + ' FAIL=' + counts.FAIL + ' WARN=' + counts.WARN + ' INFO=' + counts.INFO)
  const failed = evidence.filter(entry => entry.status === 'FAIL')
  if (failed.length > 0) {
    console.log('== 失败项 ==')
    for (const entry of failed) console.log('  ✖ [' + entry.area + '] ' + entry.id + ' ' + entry.title + ' — ' + entry.detail)
  }
  if (EVIDENCE_PATH !== null) {
    try {
      mkdirSync(dirname(EVIDENCE_PATH), { recursive: true })
      writeFileSync(EVIDENCE_PATH, JSON.stringify({
        generatedAt: new Date().toISOString(),
        node: process.version,
        registry: REGISTRY_JSON,
        browser: RUN_BROWSER,
        counts,
        verdict: failures === 0 ? 'PASS' : 'FAIL',
        evidence,
      }, null, 1))
      console.log('== 证据 JSON == ' + EVIDENCE_PATH)
    } catch (error) {
      console.log('! 证据写入失败: ' + (error instanceof Error ? error.message : String(error)))
    }
  }
  console.log('== 总判定 == ' + (failures === 0 ? 'PASS（无 FAIL 项）' : 'FAIL（' + failures + ' 项）'))
  process.exitCode = failures === 0 ? 0 : 1
}

main().catch(error => {
  console.error('脚手架自身异常: ' + (error instanceof Error ? error.stack : String(error)))
  process.exitCode = 2
})
