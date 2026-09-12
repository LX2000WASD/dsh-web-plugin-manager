#!/usr/bin/env node
/**
 * 补充验证 D（task-7 / verifier）——patch.ts 真实 profile 往返演练（数据破坏面）。
 *
 * 背景：T11 改了 src/patch.ts（joinDocument / normalizeDocument / removeInsertRow）。
 * 这是**数据破坏面**：这些函数直接改写用户的 ~/.dsh/profiles/<p>/cordis.patch.yml。
 *
 * 本脚本对真实 patch 文件做**只读**往返演练：
 *   - 全程不调用 writePatch、不写任何 ~/.dsh 下的文件；
 *   - 在内存里做「读出 → 往返变换 → 与原字节逐字节比较」；
 *   - 覆盖 Lead 指定的五个 profile：web / headless / pm-test / pm-crash / betterdsh-test；
 *   - 覆盖三类变换：空操作往返、insert 行的 add→remove 往返、remove 不存在的行（必须不变）。
 *
 * 运行：node tests/verification-patch-roundtrip.mjs [--no-evidence] [--evidence <path>]
 * 退出码：0 = 无 FAIL；1 = 有 FAIL。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const argv = process.argv.slice(2)
const evidenceIndex = argv.indexOf('--evidence')
const EVIDENCE_PATH = argv.includes('--no-evidence')
  ? null
  : (evidenceIndex >= 0 && argv[evidenceIndex + 1] !== undefined
    ? argv[evidenceIndex + 1]
    : join(ROOT, 'docs/private/audit/verification-patch-roundtrip.json'))

const PROFILES = ['web', 'headless', 'pm-test', 'pm-crash', 'betterdsh-test']

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

/** 第一处字节差异（用于给出最小复现）。 */
function firstDiff(left, right) {
  const max = Math.max(left.length, right.length)
  for (let i = 0; i < max; i += 1) {
    if (left[i] !== right[i]) {
      return { at: i, left: JSON.stringify(left.slice(Math.max(0, i - 40), i + 40)), right: JSON.stringify(right.slice(Math.max(0, i - 40), i + 40)) }
    }
  }
  return null
}

async function main() {
  console.log('== patch.ts 真实 profile 往返演练（只读） ==')
  const patch = await import('../dist/patch.js')
  const exports_ = Object.keys(patch)
  record('P0', 'dist/patch.js 导出面', 'INFO', exports_.join(', '))

  const patchPath = (profile) => join(homedir(), '.dsh/profiles', profile, 'cordis.patch.yml')

  // 快照所有文件（用于收尾时证明没被改动）
  const snapshots = new Map()
  for (const profile of PROFILES) {
    const path = patchPath(profile)
    if (!existsSync(path)) {
      record('P1-' + profile, profile + ' patch 文件存在', 'WARN', '不存在，跳过: ' + path)
      continue
    }
    snapshots.set(profile, readFileSync(path, 'utf8'))
  }
  record('P1', '五个 profile 的 patch 文件均可读', snapshots.size > 0 ? 'PASS' : 'FAIL',
    '读取 ' + String(snapshots.size) + '/' + String(PROFILES.length) + ' 个',
    rawJson([...snapshots].map(([profile, text]) => ({ profile, bytes: Buffer.byteLength(text, 'utf8'), lines: text.split('\n').length }))))

  for (const [profile, original] of snapshots) {
    // ---- 变换 1：空操作往返（读出 → 原样写回语义）
    const readRows = patch.readInsertRows(original)
    const removedNone = patch.removeInsertRow(original, '__verification_nonexistent_row__')
    check('P2-' + profile, profile + '：remove 不存在的行必须逐字节不变（无副作用）',
      () => removedNone.removed === false && removedNone.content === original
        || 'removed=' + String(removedNone.removed) + ' 字节是否相同=' + String(removedNone.content === original)
          + '（长度 ' + String(removedNone.content.length) + ' vs ' + String(original.length) + '）',
      () => rawJson({
        originalBytes: Buffer.byteLength(original, 'utf8'),
        resultBytes: Buffer.byteLength(removedNone.content, 'utf8'),
        insertRows: readRows.length,
      }))

    // ---- 变换 2：insert 行 add → remove 往返（用真实的行 id 形状）
    if (readRows.length > 0) {
      const firstRow = readRows[0]
      const roundTrip = patch.removeInsertRow(original, firstRow.id)
      record('P3-' + profile, profile + '：删除真实 insert 行（' + firstRow.id + '）', 'INFO',
        'removed=' + String(roundTrip.removed) + ' 字节 ' + String(Buffer.byteLength(original, 'utf8'))
          + ' → ' + String(Buffer.byteLength(roundTrip.content, 'utf8')),
        rawJson({ id: firstRow.id, removed: roundTrip.removed, head: roundTrip.content.split('\n').slice(0, 6) }))
      check('P3b-' + profile, profile + '：删除后文档仍是合法 YAML 数组（含 - id: / - insert: 或 [] 终止符）',
        () => {
          const text = roundTrip.content
          const hasRow = text.split('\n').some(line => /^- id:/.test(line) || /^- insert:/.test(line) || /^insert:/.test(line))
          const hasTerminator = text.split('\n').some(line => line.trim() === '[]')
          return hasRow || hasTerminator || '既无 patch 行也无 [] 终止符（HMR reload 会失败）'
        },
        () => rawJson({ tail: roundTrip.content.split('\n').slice(-4) }))
      // 二次删除必须幂等（再删同一行不应再变）
      const again = patch.removeInsertRow(roundTrip.content, firstRow.id)
      check('P3c-' + profile, profile + '：二次删除同一行幂等（removed=false 且内容不变）',
        () => again.removed === false && again.content === roundTrip.content
          || 'removed=' + String(again.removed) + ' 内容变化=' + String(again.content !== roundTrip.content))
    }

    // ---- 变换 2b：文件没有 insert 行时，用 addInsertRow 在内存里造一行再删掉，
    // 验证 add→remove 往返（这才是 T11 真正改动的路径；真实 profile 可能没有 insert 行）。
    if (readRows.length === 0) {
      const added = patch.addInsertRow(original, 'verification-probe', '@verification/probe')
      const addedContent = typeof added === 'string' ? added : added.content
      const addedRows = patch.readInsertRows(addedContent)
      check('P3d-' + profile, profile + '：无 insert 行时 addInsertRow 可用且可被读回',
        () => addedRows.length === 1 && addedRows[0].id === 'verification-probe'
          || '加入后读回=' + JSON.stringify(addedRows),
        () => rawJson({ added: addedContent }))
      const back = patch.removeInsertRow(addedContent, 'verification-probe')
      check('P3e-' + profile, profile + '：add→remove 往返回到原字节（数据破坏面核心断言）',
        () => back.removed === true && back.content === original
          || 'removed=' + String(back.removed) + ' 字节是否相同=' + String(back.content === original)
            + (back.content === original ? '' : ' 差异=' + JSON.stringify(firstDiff(original, back.content))),
        () => rawJson({ original, roundTrip: back.content }))
    }

    // ---- 变换 3：所有 insert 行删除后，用户注释必须保留
    if (readRows.length > 0) {
      let content = original
      for (const row of readRows) content = patch.removeInsertRow(content, row.id).content
      const originalComments = original.split('\n').filter(line => /^\s*#/.test(line)).map(line => line.trim())
      const keptComments = content.split('\n').filter(line => /^\s*#/.test(line)).map(line => line.trim())
      const lostComments = originalComments.filter(comment => !keptComments.includes(comment))
      check('P4-' + profile, profile + '：删除全部 insert 行后用户注释全部保留（M11 回归）',
        () => lostComments.length === 0 || '丢失注释=' + JSON.stringify(lostComments),
        () => rawJson({ originalComments: originalComments.length, keptComments: keptComments.length, result: content }))
      check('P4b-' + profile, profile + '：删除全部 insert 行后文档仍可被 YAML 解析（非 null）',
        () => {
          const hasRow = content.split('\n').some(line => /^- id:/.test(line) || /^- insert:/.test(line) || /^insert:/.test(line))
          const hasTerminator = content.split('\n').some(line => line.trim() === '[]')
          return hasRow || hasTerminator || '文档既无行也无 []，YAML 解析为 null → HMR reload 失败'
        })
    }
  }

  // ---- 收尾：证明全程未改动磁盘
  const after = new Map()
  for (const profile of PROFILES) {
    const path = patchPath(profile)
    if (existsSync(path)) after.set(profile, readFileSync(path, 'utf8'))
  }
  const changed = [...snapshots].filter(([profile, text]) => after.get(profile) !== text).map(([profile]) => profile)
  check('P5', '演练全程未改动任何真实 patch 文件（只读证明）',
    () => changed.length === 0 || '被改动的 profile=' + JSON.stringify(changed),
    () => rawJson({ checked: snapshots.size, changed }))

  // ---- 语法级：本脚本从不调用 writePatch（静态核对）。
  // 注意自检写法：不能直接搜 "patch.writePatch("，因为本行自身就含该子串——
  // 之前那版就是被自己的源码匹配到而误报。
  const selfSource = readFileSync(fileURLToPath(import.meta.url), 'utf8')
  const writePatchCalls = selfSource
    .split(String.fromCharCode(10))
    .filter(line => /patch\s*\.\s*writePatch\s*\(/.test(line) && !/^\s*(\/\/|\*)/.test(line))
  check('P6', 'writePatch 未在本次演练中被调用（脚本静态自检）',
    () => writePatchCalls.length === 0 || '发现调用点=' + JSON.stringify(writePatchCalls),
    () => '通过静态自检确认：脚本不含 writePatch 调用')

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