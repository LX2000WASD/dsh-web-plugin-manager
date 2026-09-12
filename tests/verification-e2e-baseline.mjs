#!/usr/bin/env node
/**
 * 补充验证 A（task-7 / verifier）——3099 实例 e2e 基线一键对比。
 *
 * 用途：Lead 重启 3099 加载新 dist 后，直接跑本脚本即可得到「改造前 vs 改造后」
 * 的对照表。改造前基线已固化为常量（见 BASELINE），所以只需要一次采样。
 *
 * 检查项：
 *   - HTTP 状态、响应字节数、暖路径耗时中位数（多次采样）
 *   - gzip 体积（accept-encoding: gzip）
 *   - items 数、total、dropped、blocked、fromCache、source
 *   - categories 字段：是否存在、条数是否与 items 重算一致、是否含脏值
 *   - items 的 category 分布（与改造前基线逐项对比）
 *
 * 运行：
 *   node tests/verification-e2e-baseline.mjs                       # 采样 http://127.0.0.1:3099
 *   node tests/verification-e2e-baseline.mjs --url <url> --profile <name>
 *   node tests/verification-e2e-baseline.mjs --samples 5 --json <out.json>
 *   node tests/verification-e2e-baseline.mjs --no-evidence
 * 退出码：0 = 无 FAIL；1 = 有 FAIL（例如 categories 缺失或与 items 不一致）。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

const argv = process.argv.slice(2)
function argValue(flag, fallback) {
  const at = argv.indexOf(flag)
  return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback
}
const URL_ = argValue('--url', 'http://127.0.0.1:3099/api2/plugin-manager/marketplace')
const PROFILE = argValue('--profile', 'pm-test')
const SAMPLES = Number(argValue('--samples', '5'))
const OUT = argv.includes('--no-evidence') ? null : argValue('--json', join(ROOT, 'docs/private/audit/verification-e2e-baseline.json'))

/**
 * 改造前基线（verifier 在 3099 重启前实测固化）：
 *   采样时间 2026-09-13 01:5x，进程 PID 745780（启动 01:48:57，dist/index.js 重建于 02:07:05 之前）。
 *   暖路径 3 次：0.0862s（冷，含首次解析）/ 0.0167s / 0.0166s。
 */
const BASELINE = {
  sampledAt: '2026-09-13T01:55+08:00',
  processPid: 745780,
  processStarted: '2026-09-13T01:48:57+08:00',
  distIndexRebuilt: '2026-09-13T02:07:05+08:00',
  httpStatus: 200,
  bytes: 7198459,
  warmMs: [86.229, 16.748, 16.568],
  gzipBytes: 1492532,
  gzipMs: 131.748,
  items: 13129,
  total: 13129,
  dropped: 3,
  blocked: 1,
  fromCache: true,
  source: 'registry',
  categories: null,
  categoryDistribution: {
    other: 3263, tool: 2768, 'web-ui': 2053, coding: 1136, memory: 739, conversation: 610,
    vision: 564, resource: 542, agent: 488, model: 400, notify: 366, document: 174,
    单插件: 13, 未分类: 6, '<undefined>': 2, 基础设施: 2, '🗂 文件数据': 1, 远程渠道: 1, 发行版: 1,
  },
}

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
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

async function post(headers) {
  const started = process.hrtime.bigint()
  const response = await fetch(URL_, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ refresh: false, profile: PROFILE }),
  })
  const text = await response.text()
  const ms = Number(process.hrtime.bigint() - started) / 1e6
  return { status: response.status, bytes: Buffer.byteLength(text, 'utf8'), ms, text }
}

async function main() {
  console.log('== 3099 e2e 基线对比 ==')
  console.log('URL: ' + URL_ + '  profile: ' + PROFILE + '  samples: ' + String(SAMPLES))

  // Preflight: this script samples a LIVE instance, which only exists during a
  // release check. Without one, the raw fetch failure reads like a broken
  // script — say what is missing and exit 2 (scaffold error, not a FAIL).
  try {
    await fetch(URL_, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refresh: false, profile: PROFILE }) })
  } catch (error) {
    console.error('未检测到可用的测试实例（' + URL_ + '）：' + (error instanceof Error ? error.message : String(error)))
    console.error('本脚本采样真实实例，仅在发布前验证时使用；请先启动一个 profile 实例：')
    console.error('  dsh --profile pm-test --port 3099 --no-open')
    process.exitCode = 2
    return
  }

  const runs = []
  let first = null
  for (let i = 0; i < Math.max(1, SAMPLES); i += 1) {
    const run = await post({})
    runs.push(run)
    if (first === null) first = run
  }
  record('E1', 'HTTP 200 且响应非空',
    first.status === 200 && first.bytes > 0 ? 'PASS' : 'FAIL',
    'status=' + String(first.status) + ' bytes=' + String(first.bytes))

  // 冷/稳态要分开报告（Lead 要求）：本进程的第一次请求是「管线冷」（必须重跑
  // 13k 条四级管线），之后如果管道缓存命中就是「稳态」。m-3 缺陷下稳态会退化成
  // 与冷态同量级（每请求重跑），修复后稳态应显著低于冷态。
  const coldMs = first.ms
  const steadyMs = runs.slice(1).map(run => run.ms)
  const allMs = runs.map(run => run.ms)
  record('E2', '响应体积（对比改造前基线）', 'INFO',
    'bytes=' + String(first.bytes) + '（基线 ' + String(BASELINE.bytes) + '，差 '
      + String(first.bytes - BASELINE.bytes) + '）',
    rawJson({ baseline: BASELINE.bytes, now: first.bytes }))
  record('E3a', '首次请求耗时（本进程管线冷态）', 'INFO',
    coldMs.toFixed(1) + 'ms（基线首请求 ' + BASELINE.warmMs[0].toFixed(1) + 'ms）',
    rawJson({ baselineColdMs: BASELINE.warmMs[0], nowColdMs: Math.round(coldMs * 1000) / 1000 }))
  record('E3b', '稳态耗时（后续请求，管道缓存命中态）', 'INFO',
    (steadyMs.length === 0 ? '无样本' : 'median=' + median(steadyMs).toFixed(1) + 'ms（样本 ' + steadyMs.map(v => v.toFixed(1)).join('/') + '）')
      + ' 基线稳态 median=' + median(BASELINE.warmMs.slice(1)).toFixed(1) + 'ms',
    rawJson({ baselineSteadyMs: BASELINE.warmMs.slice(1), nowSteadyMs: steadyMs.map(v => Math.round(v * 1000) / 1000) }))
  // 稳态/冷态比：m-3 未修时接近 1（每请求重跑管线），修复后应明显 < 1。
  const steadyRatio = steadyMs.length === 0 ? null : median(steadyMs) / coldMs
  const baselineRatio = median(BASELINE.warmMs.slice(1)) / BASELINE.warmMs[0]
  record('E3c', '稳态/冷态耗时比（m-3 判据：修复后应明显 < 1）', 'INFO',
    (steadyRatio === null ? '无样本' : 'now=' + steadyRatio.toFixed(3)) + ' 基线=' + baselineRatio.toFixed(3)
      + (steadyRatio !== null && steadyRatio > 0.7 ? ' ← 稳态≈冷态，提示管道缓存未命中（m-3 未修复或缓存键持续变化）' : ''),
    rawJson({ baselineRatio: Math.round(baselineRatio * 1000) / 1000, nowRatio: steadyRatio === null ? null : Math.round(steadyRatio * 1000) / 1000 }))
  record('E3d', '全部样本耗时明细', 'INFO',
    allMs.map(v => v.toFixed(1)).join('/') + ' ms',
    rawJson(allMs.map(v => Math.round(v * 1000) / 1000)))

  // gzip：node 的 fetch 会自动解压，拿不到线上字节数，改用 curl 采样（与基线口径一致）。
  let gzip = null
  try {
    const { execFileSync } = await import('node:child_process')
    const started = process.hrtime.bigint()
    const out = execFileSync('curl', [
      '-s', '-o', '/dev/null', '-w', '%{http_code} %{size_download}',
      '-X', 'POST', URL_,
      '-H', 'content-type: application/json',
      '-H', 'accept-encoding: gzip',
      '-d', JSON.stringify({ refresh: false, profile: PROFILE }),
    ], { encoding: 'utf8' })
    const ms = Number(process.hrtime.bigint() - started) / 1e6
    const [status, size] = out.trim().split(' ')
    gzip = { status: Number(status), bytes: Number(size), ms }
  } catch (error) {
    gzip = { error: error instanceof Error ? error.message : String(error) }
  }
  record('E4', 'gzip 体积与耗时（curl 口径，与基线一致）', 'INFO',
    gzip?.bytes === undefined ? '未采集: ' + JSON.stringify(gzip)
      : 'gzipBytes=' + String(gzip.bytes) + '（基线 ' + String(BASELINE.gzipBytes) + '） ms=' + gzip.ms.toFixed(1),
    rawJson(gzip))

  let value = null
  try {
    const parsed = JSON.parse(first.text)
    value = parsed?.value ?? parsed
  } catch (error) {
    record('E5', '响应 JSON 可解析', 'FAIL', error instanceof Error ? error.message : String(error))
    return finish()
  }
  record('E5', '响应 JSON 可解析', 'PASS', '外层键=' + JSON.stringify(Object.keys(JSON.parse(first.text))))

  const items = Array.isArray(value.items) ? value.items : []
  record('E6', 'items 数量', 'INFO',
    'items=' + String(items.length) + ' total=' + String(value.total) + '（基线 ' + String(BASELINE.items) + '）',
    rawJson({ items: items.length, total: value.total, dropped: value.dropped, blocked: value.blocked, fromCache: value.fromCache, source: value.source }))
  check('E7', 'items 数量与 total 自洽', () => items.length === value.total || 'items=' + items.length + ' total=' + value.total)
  check('E8', 'items 身份唯一（React key=item.name）', () => {
    const names = new Set(items.map(item => item.name))
    return names.size === items.length || 'unique=' + names.size + ' items=' + items.length
  })

  // categories 字段（T3 的核心交付）
  const categories = value.categories
  check('E9', 'MarketplaceResult.categories 存在且为非空数组',
    () => Array.isArray(categories) && categories.length > 0
      || 'categories=' + JSON.stringify(categories),
    () => rawJson(Array.isArray(categories) ? categories : null))

  if (!Array.isArray(categories)) {
    // 实例尚未重启加载新 dist 时 categories 必然缺失——这是「预期中的未生效」，
    // 不是产品缺陷；标注 WARN 并说明如何区分，避免误判成回归。
    record('E9b', 'categories 缺失的成因判定', 'WARN',
      '当前实例 PID/启动时间早于 dist/index.js 重建时间（见证据 JSON 的 process 字段）时为「未重启」，'
      + '重启后仍缺失才是 T3 回归')
  }
  if (Array.isArray(categories)) {
    const recount = new Map()
    for (const item of items) {
      const id = (item.category ?? '').trim()
      if (id.length === 0) continue
      recount.set(id, (recount.get(id) ?? 0) + 1)
    }
    const hostMap = new Map(categories.map(entry => [entry.id, entry.count]))
    const ids = [...new Set([...hostMap.keys(), ...recount.keys()])]
    const mismatch = ids.filter(id => hostMap.get(id) !== recount.get(id))
    check('E10', 'categories 与 items 逐项重算一致（host 聚合正确）',
      () => mismatch.length === 0 || '不一致=' + JSON.stringify(mismatch.slice(0, 8).map(id => ({ id, host: hostMap.get(id), recount: recount.get(id) }))),
      () => 'host 分类数=' + hostCategories(categories).length + ' 重算分类数=' + recount.size)
    const sum = categories.reduce((total, entry) => total + entry.count, 0)
    const withCategory = items.filter(item => (item.category ?? '').trim().length > 0).length
    check('E11', 'categories 计数之和 == 有 category 的条目数',
      () => sum === withCategory || 'sum=' + sum + ' withCategory=' + withCategory)
    check('E12', 'categories 排序（计数降序、同数 id 升序）', () => {
      for (let i = 1; i < categories.length; i += 1) {
        if (categories[i - 1].count < categories[i].count) return '第 ' + i + ' 项计数上升'
        if (categories[i - 1].count === categories[i].count && categories[i - 1].id > categories[i].id) return '第 ' + i + ' 项同数未按 id 升序'
      }
      return true
    }, () => rawJson(categories))
    const dirty = categories.filter(entry => !/^[a-z][a-z0-9-]*$/.test(entry.id)).map(entry => entry.id)
    record('E13', '脏 category 是否进入聚合（原样保留）', 'INFO',
      '脏值=' + JSON.stringify(dirty), rawJson(categories.filter(entry => dirty.includes(entry.id))))
  }

  // 分类分布对比
  const nowDist = {}
  for (const item of items) {
    const key = item.category === undefined ? '<undefined>' : item.category === '' ? '<empty>' : item.category
    nowDist[key] = (nowDist[key] ?? 0) + 1
  }
  const distDiff = []
  for (const key of new Set([...Object.keys(BASELINE.categoryDistribution), ...Object.keys(nowDist)])) {
    const before = BASELINE.categoryDistribution[key]
    const after = nowDist[key]
    if (before !== after) distDiff.push({ category: key, before: before ?? 0, after: after ?? 0 })
  }
  record('E14', 'items 的 category 分布 vs 改造前基线', distDiff.length === 0 ? 'PASS' : 'WARN',
    distDiff.length === 0 ? '逐项相同（' + Object.keys(nowDist).length + ' 个分类）'
      : '差异=' + JSON.stringify(distDiff),
    rawJson({ baseline: BASELINE.categoryDistribution, now: nowDist }))

  finish()
}

function hostCategories(categories) {
  return categories
}

function finish() {
  const counts = { PASS: 0, FAIL: 0, WARN: 0, INFO: 0 }
  for (const entry of evidence) counts[entry.status] += 1
  console.log('')
  console.log('== 汇总 == PASS=' + counts.PASS + ' FAIL=' + counts.FAIL + ' WARN=' + counts.WARN + ' INFO=' + counts.INFO)
  const failed = evidence.filter(entry => entry.status === 'FAIL')
  if (failed.length > 0) {
    console.log('== 失败项 ==')
    for (const entry of failed) console.log('  ✖ [' + entry.id + '] ' + entry.title + ' — ' + entry.detail)
  }
  if (OUT !== null) {
    try {
      mkdirSync(dirname(OUT), { recursive: true })
      writeFileSync(OUT, JSON.stringify({
        generatedAt: new Date().toISOString(), url: URL_, profile: PROFILE,
        baseline: BASELINE, counts, verdict: failures === 0 ? 'PASS' : 'FAIL', evidence,
      }, null, 1))
      console.log('== 证据 JSON == ' + OUT)
    } catch (error) { console.log('! 证据写入失败: ' + String(error)) }
  }
  console.log('== 总判定 == ' + (failures === 0 ? 'PASS（无 FAIL 项）' : 'FAIL（' + failures + ' 项）'))
  process.exitCode = failures === 0 ? 0 : 1
}

main().catch(error => {
  console.error('脚本自身异常: ' + (error instanceof Error ? error.stack : String(error)))
  process.exitCode = 2
})
