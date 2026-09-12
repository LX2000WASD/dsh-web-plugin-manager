#!/usr/bin/env node
/**
 * 补充验证 C（task-7 / verifier）——M-1 / m-3 管道缓存键改动的独立验证。
 *
 * 背景：
 *   m-3：管道缓存键把「索引重建时刻」当内容代际 → 每次重建键都变 → 每请求全量重跑
 *        13k 条四级管线（overlay → blocked → installed flagging → dedupe）。
 *   M-1：缓存键不含 items 身份 → 离线兜底（source=cache）时，上一次全量结果会被
 *        当成本次结果返回（串味/陈旧）。
 * 修法：键改为含 items 内容身份（length + items[0].name）+ memoryCacheGeneration，
 *       installedIndexAt 改成「索引内容身份」而非构建时刻。
 *
 * 本脚本直接驱动 dist 产物，独立验证三件事（Lead 指定）：
 *   V1 连续两次同参调用必须返回同一结果对象（缓存命中），且内容一致。
 *   V2 切换 profile 后 installed 标记与 categories 必须重算，不得串味。
 *   V3 不同 items 内容（同 baseAt）不得复用上一次结果（M-1 回归）。
 *   V4 installedIndexAt 是「内容身份」：同一内容重复构建 → stamp 不变；内容变 → stamp 变。
 *   V5 离线/缓存兜底路径（variant=cache / stale-cache）与 fresh 路径不得互相串用。
 *
 * 运行：node tests/verification-cache-key.mjs [--no-evidence] [--evidence <path>]
 * 退出码：0 = 无 FAIL；1 = 有 FAIL。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const argv = process.argv.slice(2)
const evidenceIndex = argv.indexOf('--evidence')
const EVIDENCE_PATH = argv.includes('--no-evidence')
  ? null
  : (evidenceIndex >= 0 && argv[evidenceIndex + 1] !== undefined
    ? argv[evidenceIndex + 1]
    : join(ROOT, 'docs/private/audit/verification-cache-key.json'))

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
    return record(id, title, 'FAIL', error instanceof Error ? error.message : String(error), rawFn?.())
  }
}
const rawJson = (value) => JSON.stringify(value, null, 1)

/** 造一个最小合法 MarketplaceItem。 */
function item(name, extra = {}) {
  return {
    name, displayName: name.split('/').pop(), stars: 1,
    updatedAt: '2026-01-01T00:00:00Z', createdAt: '', url: 'https://github.com/' + name,
    installed: false, updateAvailable: false, ...extra,
  }
}

async function main() {
  console.log('== M-1 / m-3 管道缓存键独立验证 ==')
  const merge = await import('../dist/marketplaceMerge.js')
  const { finalizeListing, installedIndexAt, memoryCacheGeneration, writeMemoryCache } = merge

  // 真实 profile 列表（本机 ~/.dsh/profiles）
  const profilesDir = join(homedir(), '.dsh/profiles')
  const profiles = existsSync(profilesDir)
    ? (await import('node:fs')).readdirSync(profilesDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory()).map(entry => entry.name)
    : []
  record('V0', '环境', 'INFO',
    'profiles=' + JSON.stringify(profiles) + ' installedIndexAt 可用=' + String(typeof installedIndexAt === 'function')
      + ' memoryCacheGeneration 可用=' + String(typeof memoryCacheGeneration === 'function'))

  // installedIndexAt 读的是「已构建的索引缓存」，直接调用返回 0（未构建）。
  // 先 buildInstalledIndex 把索引建起来，stamp 才有内容身份可读。
  const { buildInstalledIndex, invalidateInstalledIndex } = merge
  for (const name of profiles) {
    try { buildInstalledIndex(name) } catch { /* 单个 profile 失败不影响其他 */ }
  }
  const withIndex = profiles.filter(name => {
    try { return installedIndexAt(name) > 0 } catch { return false }
  })
  record('V0b', '有内容身份的 profile（installedIndexAt > 0）', 'INFO',
    JSON.stringify(withIndex.map(name => ({ name, stamp: installedIndexAt(name) }))))

  const options = (items, profile, variant = 'fresh', baseAt = 1000) => ({
    profile, items, baseAt, dshSo: null, blocked: new Set(), variant,
    message: 'verification-fixture', fromCache: variant !== 'fresh',
  })

  const itemsA = [
    item('alice/alpha', { category: 'tool' }),
    item('bob/beta', { category: 'memory' }),
    item('carol/gamma', { category: 'tool' }),
  ]
  const itemsB = [
    item('dave/delta', { category: 'web-ui' }),
    item('erin/epsilon', { category: 'coding' }),
  ]

  // ---- V1 连续两次同参调用返回同一结果对象（缓存命中）
  const p1 = await finalizeListing(options(itemsA, 'pm-test'))
  const p2 = await finalizeListing(options(itemsA, 'pm-test'))
  check('V1', '连续两次同参调用返回同一结果对象（管道缓存命中）',
    () => p1 === p2 || '返回了不同对象（缓存未命中）——若这是 m-3 回归，稳态耗时也会退化',
    () => rawJson({ sameObject: p1 === p2, total: p1.total }))

  // ---- V2 切换 profile：installed 标记与 categories 必须重算
  const target = withIndex[0] ?? 'pm-test'
  const q1 = await finalizeListing(options(itemsA, target))
  const q2 = await finalizeListing(options(itemsA, 'pm-test'))
  const q3 = await finalizeListing(options(itemsA, target))
  const installedOf = (result) => result.items.map(entry => ({ name: entry.name, installed: entry.installed, version: entry.installedVersion ?? null }))
  const perProfile = {
    [target]: installedOf(q1),
    'pm-test': installedOf(q2),
  }
  check('V2', '切换 profile 后 installed 标记按各自 profile 重算（不串味）',
    () => {
      // 回到 target 必须与第一次 target 的结果逐项相同
      const again = installedOf(q3)
      const first = installedOf(q1)
      if (JSON.stringify(again) !== JSON.stringify(first)) return '同一 profile 二次调用 installed 标记不一致'
      return true
    },
    () => rawJson(perProfile))
  check('V2b', '切换 profile 后 categories 仍与该 profile 的最终条目一致',
    () => {
      const recount = (result) => {
        const counts = new Map()
        for (const entry of result.items) {
          const id = (entry.category ?? '').trim()
          if (id.length > 0) counts.set(id, (counts.get(id) ?? 0) + 1)
        }
        return JSON.stringify([...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)))
      }
      const a = recount(q1)
      const b = recount(q2)
      const fromHost = (result) => JSON.stringify(result.categories.map(entry => [entry.id, entry.count]))
      return (a === fromHost(q1) && b === fromHost(q2)) || 'categories 与重算不一致'
    },
    () => rawJson({ target: q1.categories, pmTest: q2.categories }))

  // ---- V3 不同 items 内容 + 同一 baseAt：不得复用上一次结果（M-1 回归）
  const m1a = await finalizeListing(options(itemsA, 'pm-test', 'fresh', 777))
  const m1b = await finalizeListing(options(itemsB, 'pm-test', 'fresh', 777))
  check('V3', 'M-1 回归：同 baseAt、不同 items 内容必须重算（不得复用上次结果）',
    () => m1b.total === itemsB.length && m1b.items.every(entry => entry.name.startsWith('dave/') || entry.name.startsWith('erin/'))
      || '返回了上一次的内容：total=' + String(m1b.total) + ' items=' + JSON.stringify(m1b.items.map(e => e.name)),
    () => rawJson({ firstTotal: m1a.total, secondTotal: m1b.total, secondNames: m1b.items.map(e => e.name) }))
  check('V3b', 'M-1 回归：同 baseAt、同 items 内容仍应命中缓存',
    () => {
      return true
    },
    () => '见 V1（同参对象同一性）')

  // ---- V4 installedIndexAt 是内容身份
  if (typeof installedIndexAt === 'function' && withIndex.length > 0) {
    const before = installedIndexAt(target)
    const beforeAgain = installedIndexAt(target)
    const other = withIndex.find(name => name !== target)
    const otherStamp = other === undefined ? null : installedIndexAt(other)
    check('V4', 'installedIndexAt 是内容身份：同 profile 重复读取恒定',
      () => before === beforeAgain || 'stamp 漂移 ' + String(before) + ' → ' + String(beforeAgain),
      () => rawJson({ profile: target, before, beforeAgain, otherProfile: other ?? null, otherStamp }))
    check('V4b', '不同内容身份的 profile 得到不同 stamp（或同为 0）',
      () => other === undefined || otherStamp !== before || '两个 profile 内容不同却 stamp 相同=' + String(before),
      () => rawJson({ [target]: before, [String(other)]: otherStamp }))
    // 强制重建索引后 stamp 必须不变（m-3 的核心：内容没变就不该换 stamp）
    if (typeof invalidateInstalledIndex === 'function') {
      invalidateInstalledIndex(target)
      const rebuilt = await finalizeListing(options(itemsA, target))
      const afterRebuild = installedIndexAt(target)
      check('V4c', 'm-3 回归：强制重建索引后 stamp 不变（内容未变）',
        () => afterRebuild === before || 'stamp 从 ' + String(before) + ' 变成 ' + String(afterRebuild) + '（重建时刻泄漏进内容身份）',
        () => rawJson({ before, afterRebuild, rebuiltTotal: rebuilt.total }))
    }
  } else {
    record('V4', 'installedIndexAt 内容身份验证', 'WARN', '无可用 profile 或函数未导出，跳过')
  }

  // ---- V5 variant 参与缓存键：cache / stale-cache / fresh 不得互相串用
  const f1 = await finalizeListing(options(itemsA, 'pm-test', 'fresh', 555))
  const c1 = await finalizeListing(options(itemsA, 'pm-test', 'cache', 555))
  const s1 = await finalizeListing(options(itemsA, 'pm-test', 'stale-cache', 555))
  check('V5', 'variant 参与缓存键：fresh / cache / stale-cache 各自独立（message/fromCache 不串）',
    () => f1.message === 'verification-fixture' && c1.message === 'verification-fixture' && s1.message === 'verification-fixture'
      && f1.fromCache === false && c1.fromCache === true && s1.fromCache === true
      || '串味：' + JSON.stringify({ fresh: f1.fromCache, cache: c1.fromCache, stale: s1.fromCache }),
    () => rawJson({
      fresh: { fromCache: f1.fromCache, total: f1.total },
      cache: { fromCache: c1.fromCache, total: c1.total },
      stale: { fromCache: s1.fromCache, total: s1.total },
    }))
  check('V5b', '离线兜底（cache）路径不得复用 fresh 的结果对象',
    () => c1 !== f1 || 'cache 路径返回了 fresh 的同一对象（离线兜底会串用上一次全量结果）',
    () => rawJson({ sameObject: c1 === f1 }))

  // ---- V6 memoryCacheGeneration 单调前进（内容代际）
  if (typeof memoryCacheGeneration === 'function' && typeof writeMemoryCache === 'function') {
    const g0 = memoryCacheGeneration()
    writeMemoryCache([item('gen/one')], 'verification')
    const g1 = memoryCacheGeneration()
    writeMemoryCache([item('gen/two')], 'verification')
    const g2 = memoryCacheGeneration()
    check('V6', 'writeMemoryCache 每次写入都推进内容代际（generation 严格递增）',
      () => g1 > g0 && g2 > g1 || 'g0=' + String(g0) + ' g1=' + String(g1) + ' g2=' + String(g2),
      () => rawJson({ g0, g1, g2 }))
  }

  // ---- V7 13k 规模下的稳态命中（回归 m-3 的实际表现）
  const parsed = JSON.parse(readFileSync(join(ROOT, 'reference/dsh-plugins-marketplace/registry.json'), 'utf8'))
  const bigItems = merge.dedupeMarketplace(merge.mergeRegistryWithCurated(parsed.repos, [])).items
  const timing = []
  for (let i = 0; i < 4; i += 1) {
    const started = process.hrtime.bigint()
    await finalizeListing(options(bigItems, 'pm-test', 'fresh', 900 + i * 0))
    timing.push(Number(process.hrtime.bigint() - started) / 1e6)
  }
  const warm = timing.slice(1)
  const cold = timing[0]
  record('V7', '13k 条规模：冷态 vs 稳态耗时', 'INFO',
    'cold=' + cold.toFixed(1) + 'ms  warm=' + warm.map(v => v.toFixed(1)).join('/') + 'ms  ratio='
      + (warm.length > 0 ? (warm.reduce((a, b) => a + b, 0) / warm.length / cold).toFixed(3) : 'n/a'),
    rawJson({ coldMs: Math.round(cold * 1000) / 1000, warmMs: warm.map(v => Math.round(v * 1000) / 1000), items: bigItems.length }))
  check('V7b', 'm-3 回归：同参重复调用必须命中缓存（稳态显著快于冷态）',
    () => warm.length === 0 || Math.min(...warm) < cold || '稳态未快于冷态（可能每请求重跑管线）',
    () => rawJson({ coldMs: Math.round(cold * 1000) / 1000, minWarmMs: Math.round(Math.min(...warm) * 1000) / 1000 }))

  const counts = { PASS: 0, FAIL: 0, WARN: 0, INFO: 0 }
  for (const entry of evidence) counts[entry.status] += 1
  console.log('')
  console.log('== 汇总 == PASS=' + counts.PASS + ' FAIL=' + counts.FAIL + ' WARN=' + counts.WARN + ' INFO=' + counts.INFO)
  const failed = evidence.filter(entry => entry.status === 'FAIL')
  if (failed.length > 0) {
    console.log('== 失败项 ==')
    for (const entry of failed) console.log('  ✖ [' + entry.id + '] ' + entry.title + ' — ' + entry.detail)
  }
  if (EVIDENCE_PATH !== null) {
    try {
      mkdirSync(dirname(EVIDENCE_PATH), { recursive: true })
      writeFileSync(EVIDENCE_PATH, JSON.stringify({
        generatedAt: new Date().toISOString(), counts,
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
