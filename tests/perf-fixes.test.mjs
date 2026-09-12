/**
 * task-8 七项 host 快赢的回归单测（node --test，跑 dist 产物）。
 *
 * 每项都断言「行为不变 + 性能机制生效」，其中 M-1 是正确性回归（最高优先）：
 *  - A1  序列化缓存带 bytes 字段，且与 Buffer.byteLength(json) 一致
 *  - A5  gzip 级别 3（体积/正确性仍可解压回原文）
 *  - A6  scanRuns 的 /proc 路径与 ps 路径结果等价；无 /proc 时回退 ps 不抛错
 *  - A7  writeRegistryCache 去缩进后仍能被 readRegistryCache 读回、内容等价
 *  - A8  registryToItem 的 topics 输出不变（functionalTopics 只算一次）
 *  - A9  buildMarketTags 标签输出不变（topics.join 惰性化）
 *  - A10 job 轮询前 1.5s 用 250ms 短间隔（轮询时刻是旧时刻的超集）
 *  - M-1 finalizeListing 管道缓存键必须含 items 内容身份：同 baseAt 传不同
 *        items 时第二次必须返回第二次的 items/message（改前会被旧结果覆盖）
 *  - m-3 installed 索引重建但内容不变时，管道缓存键不前进（不重跑 13k 管线）
 *
 * 纪律：不依赖网络、不写用户真实 ~/.dsh（全部走 mkdtemp 的 DSH_HOME 夹具）。
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { gunzipSync, gzipSync } from 'node:zlib'

import { Context } from '@deepseek-ai/cordis'

import {
  finalizeListing, memoryCacheGeneration, readMemoryCache, writeMemoryCache,
  installedIndexAt, buildInstalledIndex, invalidateInstalledIndex,
  registryToItem,
} from '../dist/marketplaceMerge.js'
import { buildMarketTags, installedKindKey } from '../dist/tags.js'
import { functionalTopics } from '../dist/registry.js'

const require_ = createRequire(import.meta.url)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// ─────────────────────────────────────────── 夹具

/** 最小 MarketplaceItem（字段与 types.ts 的必填项一致）。 */
function item(name, extra = {}) {
  return {
    name,
    displayName: name.split('/').pop(),
    stars: 0,
    updatedAt: '',
    createdAt: '',
    url: 'https://github.com/' + name,
    installed: false,
    updateAvailable: false,
    ...extra,
  }
}

/** 一条 RegistryRepo（registry.json 条目形状）。 */
function repo(fullName, extra = {}) {
  return {
    full_name: fullName,
    name: fullName.split('/').pop(),
    description: null,
    html_url: 'https://github.com/' + fullName,
    stargazers_count: 0,
    updated_at: '',
    default_branch: 'main',
    topics: [],
    license: null,
    ...extra,
  }
}

/**
 * finalizeListing 的结果按 (profile, baseAt, items 身份, dsh.so 戳, installed
 * 索引身份, 记录戳, 屏蔽表, variant) 做了代际缓存，同键直接复用同一对象。
 * 每个用例必须换一个 baseAt / profile，否则会拿到上一个用例的缓存结果。
 */
let seq = 1
function finalizeOptions(items, extra = {}) {
  return {
    profile: 'perf-fixes',
    items,
    baseAt: 1_000_000 + seq++,
    dshSo: null,
    blocked: new Set(),
    variant: 'fresh',
    message: 'test',
    fromCache: false,
    ...extra,
  }
}

// ─────────────────────────────────────────── A1 / A5

describe('A1 序列化缓存 bytes 字段', () => {
  let home
  let previousHome

  before(async () => {
    home = await mkdtemp(join(tmpdir(), 'dshpm-perf-a1-'))
    await mkdir(join(home, 'profiles', 'web'), { recursive: true })
    await writeFile(join(home, 'profiles', 'web', 'package.json'),
      JSON.stringify({ name: 'dsh-profile-web', private: true, dependencies: {} }))
    previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = home
  })
  after(async () => {
    process.env.DSH_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  })

  it('marketplaceEnvelope().bytes 与实际 UTF-8 字节数一致（真实 service）', async () => {
    const { PluginManagerService } = await import('../dist/index.js')
    const service = new PluginManagerService(new Context())
    const result = await finalizeListing(finalizeOptions([
      item('中文/插件', { displayName: '插件 🚀', description: 'CJK + emoji' }),
      item('owner/plain', { stars: 3 }),
    ], { variant: 'fresh', message: 'A1' }))
    const envelope = service.marketplaceEnvelope(result)
    assert.equal(envelope.bytes, Buffer.byteLength(envelope.json, 'utf8'), 'bytes 必须等于包络的真实字节数')
    assert.equal(envelope.bytes, Buffer.from(envelope.json, 'utf8').length)
    assert.ok(envelope.bytes > envelope.json.length, '含 CJK/emoji 的包络其字节数应大于字符数')
    assert.match(envelope.json, /^\{"ok":true,"value":/, '包络形状必须是 { ok, value }')
  })

  it('同一结果对象重复取包络：字节数一致且不重新序列化（对象复用）', async () => {
    const { PluginManagerService } = await import('../dist/index.js')
    const service = new PluginManagerService(new Context())
    const result = await finalizeListing(finalizeOptions([item('a/one')], { variant: 'fresh', message: 'A1b' }))
    const first = service.marketplaceEnvelope(result)
    const second = service.marketplaceEnvelope(result)
    assert.equal(second, first, '同一结果对象必须复用同一份序列化缓存')
    assert.equal(second.bytes, first.bytes)
    assert.equal(second.gzip, undefined, 'gzip 必须保持惰性（只有带 gzip 的客户端才付这笔钱）')
  })

  it('真实 listing 包络的 bytes 可由缓存常量替代逐请求计算', () => {
    // 用仓库内 reference 的 registry.json（3115 条真实数据）构造包络形状。
    const registry = JSON.parse(readFileSync(join(ROOT, 'reference/dsh-plugins-marketplace/registry.json'), 'utf8'))
    const items = registry.repos.slice(0, 200).map(registryToItem)
    const json = JSON.stringify({ ok: true, value: { ok: true, items } })
    const cached = { json, bytes: Buffer.byteLength(json, 'utf8') }
    assert.equal(cached.bytes, Buffer.from(cached.json, 'utf8').length)
    assert.ok(cached.bytes > json.length, 'listing 含非 ASCII，字节数应大于字符数')
  })

  it('index.ts 的 marketplace 路由用 serialized.bytes 而不是每请求重算', () => {
    const source = readFileSync(join(ROOT, 'dist/index.js'), 'utf8')
    assert.match(source, /bytes: Buffer\.byteLength\(json, 'utf8'\)/, '缓存建立时必须写 bytes 字段')
    assert.match(source, /serialized\.bytes > GZIP_MIN_BYTES/, '路由必须读缓存里的 bytes')
    // 全文件不得再出现对 serialized.json 的逐请求 byteLength（改前的暖路径开销）。
    assert.equal(source.includes('Buffer.byteLength(serialized.json'), false,
      '暖路径不得再逐请求计算 6.87MB 的 UTF-8 字节数')
  })
})

describe('A5 gzip 级别 3', () => {
  it('级别 3 的产物可解压回原文，且明显小于原文', () => {
    const json = JSON.stringify({ ok: true, value: { items: Array.from({ length: 2000 }, (_, i) => item('owner/plugin-' + i, { description: '重复内容 ' + (i % 50) })) } })
    const raw = Buffer.from(json, 'utf8')
    const packed = gzipSync(raw, { level: 3 })
    assert.ok(packed.length < raw.length / 5, 'gzip(level 3) 应有明显压缩比，实际 ' + packed.length + '/' + raw.length)
    assert.equal(gunzipSync(packed).toString('utf8'), json, '解压必须逐字节等于原文')
  })

  it('dist/index.js 里 gzipSync 带 level 3（GZIP_LEVEL=3）', () => {
    const source = readFileSync(join(ROOT, 'dist/index.js'), 'utf8')
    assert.match(source, /const GZIP_LEVEL = 3/, '必须声明 GZIP_LEVEL = 3')
    assert.match(source, /gzipSync\(Buffer\.from\(serialized\.json, 'utf8'\), \{ level: GZIP_LEVEL \}\)/,
      'marketplace 冷 gzip 路径必须用 GZIP_LEVEL')
  })
})

// ─────────────────────────────────────────── A6

describe('A6 scanRuns：/proc 直读 + ps 回退', () => {
  /** 改前实现（execFileSync ps + 同一解析器），用于等价性对照。 */
  function scanRunsViaPs() {
    const output = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' }).split('\n')
    const byProfile = new Map()
    for (const line of output) {
      let match = /^\s*(\d+)\s+(.*\bdsh\b.*--profile\s+(\S+))/.exec(line)
      let profile
      let pid
      if (match !== null) { pid = Number(match[1]); profile = match[3] } else {
        match = /^\s*(\d+)\s+.*\bbin\.js\s+(\S+)/.exec(line)
        if (match !== null) { pid = Number(match[1]); profile = match[2] }
      }
      if (profile === undefined || pid === undefined) continue
      const portMatch = /--port\s+(\d+)/.exec(line)
      const port = portMatch === null ? null : Number(portMatch[1])
      const node = /\bnode(?:\.exe)?\b|\b[\w-]+\.js\b/.test(line)
      const list = byProfile.get(profile)
      if (list === undefined) byProfile.set(profile, [{ port, pid, node }])
      else list.push({ port, pid, node })
    }
    const out = new Map()
    for (const [name, matches] of byProfile) {
      const withPort = matches.filter(m => m.port !== null)
      const node = matches.find(m => m.node && m.port !== null) ?? matches.find(m => m.node)
      const primary = node ?? withPort[0] ?? matches[0]
      const port = primary.port ?? (withPort[0]?.port ?? null)
      out.set(name, { port, pid: primary.pid, launchers: matches.filter(m => m.pid !== primary.pid && !m.node).map(m => m.pid) })
    }
    return out
  }
  const norm = (map) => [...map.entries()].map(([k, v]) => k + '=' + v.pid + ':' + v.port + ':[' + v.launchers.join(',') + ']').sort()

  let scanRuns

  before(async () => {
    // 用一次子进程验证「dist/profiles.js 在无 /proc 时会回退 ps」需要改全局
    // 状态；这里直接 import 当前平台的实现，再用一个子进程跑 mock 场景。
    ;({ scanRuns } = await import('../dist/profiles.js'))
  })

  it('/proc 路径与 ps 路径在真实进程表上结果等价（Linux）', { skip: process.platform !== 'linux' }, () => {
    const viaPs = norm(scanRunsViaPs())
    const viaNew = norm(scanRuns())
    assert.deepEqual(viaNew, viaPs, '/proc 与 ps 两条路径的 Map 必须逐项等价')
    // 本机至少有一个 dsh 实例（测试进程自身的宿主）——若为空，说明解析器坏了。
    assert.ok(viaNew.length > 0, '真实进程表里应至少识别出一个 dsh profile 实例')
  })

  it('无 /proc 时回退 ps 且不抛错（子进程里把 /proc 读失败）', () => {
    // 子进程内把 fs.readdirSync 对 '/proc' 的调用改为抛错 → procProcessLines()
    // 返回 null → scanRuns 必须走 ps 分支并给出与 ps 对照相同的结果。
    const script = [
      "import { createRequire } from 'node:module'",
      "const require_ = createRequire(import.meta.url)",
      "const fs = require_('node:fs')",
      "const realReaddir = fs.readdirSync",
      "fs.readdirSync = (p, ...rest) => { if (p === '/proc') { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e } return realReaddir(p, ...rest) }",
      "const { scanRuns } = await import(process.argv[1])",
      "const map = scanRuns()",
      "console.log(JSON.stringify([...map.entries()].map(([k, v]) => k + '=' + v.pid + ':' + v.port).sort()))",
    ].join('\n')
    const distProfiles = new URL('../dist/profiles.js', import.meta.url).href
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script, distProfiles], { encoding: 'utf8' })
    const viaFallback = JSON.parse(out.trim())
    const viaPs = norm(scanRunsViaPs()).map(s => s.replace(/:\[[^\]]*\]$/, ''))
    assert.deepEqual(viaFallback, viaPs, '无 /proc 时必须回退 ps 并得到相同结果')
  })

  it('dist/profiles.js 里 /proc 分支在 ps 之前、且 ps 仍作为回退保留', () => {
    const source = readFileSync(join(ROOT, 'dist/profiles.js'), 'utf8')
    assert.match(source, /function procProcessLines\(\)/, '必须存在 /proc 读取实现')
    assert.match(source, /procProcessLines\(\) \?\? execFileSync\('ps'/, '/proc 失败必须回退 execFileSync ps')
    const procAt = source.indexOf('procProcessLines() ?? execFileSync')
    assert.ok(procAt > 0 && source.indexOf("process.platform === 'win32'") < procAt, 'Windows 分支必须仍在最前')
  })
})

// ─────────────────────────────────────────── A7

describe('A7 registry 磁盘缓存去缩进', () => {
  let home
  let previousHome
  let registry

  before(async () => {
    home = await mkdtemp(join(tmpdir(), 'dshpm-perf-a7-'))
    previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = home
    registry = await import('../dist/registry.js')
  })
  after(async () => {
    process.env.DSH_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  })

  it('写出的缓存是紧凑 JSON，且 readRegistryCache 能读回等价内容', () => {
    const repos = [repo('owner/alpha', { topics: ['memory'], pkg_name: 'alpha' }), repo('owner/beta')]
    registry.writeRegistryCache(repos)
    const path = registry.registryCacheFile()
    const text = readFileSync(path, 'utf8')
    assert.equal(text.includes('\n  '), false, '缓存文件不得再带缩进（紧凑 JSON）')
    assert.equal(text.endsWith('\n'), true, '保留尾换行')
    const parsed = JSON.parse(text)
    assert.equal(parsed.count, 2)
    const roundTrip = registry.readRegistryCache()
    assert.ok(Array.isArray(roundTrip), 'readRegistryCache 必须能读回')
    assert.deepEqual(roundTrip.map(r => r.full_name), ['owner/alpha', 'owner/beta'])
    // 与缩进形式的语义完全等价（除空白外逐字节相同）。
    assert.deepEqual(JSON.parse(JSON.stringify(parsed)), JSON.parse(JSON.stringify(JSON.parse(JSON.stringify(parsed, undefined, 2)))))
    assert.deepEqual(roundTrip[0].topics, ['memory'])
    assert.equal(roundTrip[0].pkg_name, 'alpha')
  })

  it('紧凑形式比缩进 2 更小（磁盘收益的机制断言）', () => {
    const repos = Array.from({ length: 200 }, (_, i) => repo('owner/repo-' + i, { description: 'd'.repeat(60), topics: ['memory', 'search'] }))
    const compact = JSON.stringify({ savedAt: 'x', count: repos.length, repos }) + '\n'
    const pretty = JSON.stringify({ savedAt: 'x', count: repos.length, repos }, undefined, 2) + '\n'
    assert.ok(compact.length < pretty.length * 0.85, '紧凑形式应至少小 15%，实际 ' + compact.length + ' vs ' + pretty.length)
    registry.writeRegistryCache(repos)
    const written = readFileSync(registry.registryCacheFile(), 'utf8')
    assert.ok(written.length <= compact.length + 60, '落盘体积应贴近紧凑形式（仅 savedAt 时间戳有差异）')
  })
})

// ─────────────────────────────────────────── A8 / A9

describe('A8 registryToItem：topics 只算一次且输出不变', () => {
  it('过滤掉生态通用词、最多 8 个、顺序不变', () => {
    const topics = ['ai', 'dsh-plugin', 'memory', 'search', 'vector', 'rag', 'sqlite', 'cache', 'extra-1', 'extra-2']
    const out = registryToItem(repo('owner/x', { topics }))
    assert.deepEqual(out.topics, functionalTopics(topics))
    assert.deepEqual(out.topics, ['memory', 'search', 'vector', 'rag', 'sqlite', 'cache', 'extra-1', 'extra-2'])
    assert.equal(out.topics.length, 8, '上限 8 个')
  })

  it('无有效 topic 时不产生 topics 字段（不是空数组）', () => {
    const out = registryToItem(repo('owner/y', { topics: ['ai', 'dsh', 'llm'] }))
    assert.equal('topics' in out, false, '全部被过滤掉时必须省略字段（保持改前的 spread 语义）')
    assert.equal(registryToItem(repo('owner/z')).topics, undefined)
  })

  it('其余字段与改前形状一致（回归护栏）', () => {
    const out = registryToItem(repo('owner/w', {
      description: 'hello', stargazers_count: 12, updated_at: '2026-01-01T00:00:00Z',
      topics: ['memory'], pkg_name: 'w-pkg', version: '1.2.3', category: 'tool',
    }))
    assert.deepEqual(out, {
      name: 'owner/w', displayName: 'w', description: 'hello', stars: 12,
      updatedAt: '2026-01-01T00:00:00Z', createdAt: '',
      url: 'https://github.com/owner/w', topics: ['memory'],
      packageName: 'w-pkg', latestVersion: '1.2.3', category: 'tool',
      installed: false, updateAvailable: false,
    })
  })

  it('dist 产物里 functionalTopics 每条只调用一次', () => {
    const source = readFileSync(join(ROOT, 'dist/marketplaceMerge.js'), 'utf8')
    const start = source.indexOf('export function registryToItem(repo)')
    assert.ok(start > 0, '找不到 registryToItem')
    // 函数体以「4 空格缩进的 }」结束（tsc 产物的顶层函数缩进）。
    // 函数体以「列 0 的 }」结束（tsc 产物的顶层函数缩进）。
    const end = source.indexOf('\n}', start)
    assert.ok(end > start, '找不到 registryToItem 的结尾')
    // 去掉行注释再数：注释里也会提到这个函数名。
    const body = source.slice(start, end).split('\n').filter(line => !line.trim().startsWith('//')).join('\n')
    const calls = body.match(/functionalTopics\(/g) ?? []
    assert.equal(calls.length, 1, 'registryToItem 里 functionalTopics 只能出现一次，实际：' + calls.length)
  })
})

describe('A9 buildMarketTags：topics.join 惰性化且标签输出不变', () => {
  // statusTone / securityTone 在 src/tags.ts 里是模块私有（未导出），这里
  // 按当前契约逐字复制 —— 本用例是「标签输出」的金标准快照。
  const statusTone = (status) => status.includes('✅') ? 'success' : status.toLowerCase().includes('archiv') ? 'warning' : 'neutral'
  const securityTone = (riskLevel) => {
    const risk = riskLevel.toLowerCase()
    if (risk === 'low') return 'success'
    if (risk === 'medium') return 'warning'
    if (risk === 'high' || risk === 'critical') return 'danger'
    return 'neutral'
  }

  /** 改前实现：无条件 join（其余逻辑与 src/tags.ts 的当前实现逐行一致）。 */
  function buildTagsOld(item, options) {
    const limit = options?.topicLimit ?? 2
    const out = []
    const seen = new Set()
    const push = (tag) => {
      const key = tag.value.trim().toLowerCase()
      if (key.length === 0 || seen.has(key)) return
      seen.add(key)
      out.push(tag)
    }
    const category = (item.category ?? '').trim()
    if (category.length > 0) push({ kind: 'category', value: category, tone: 'neutral' })
    if (item.installed === true) push({ kind: 'type', value: installedKindKey(item.installedKind), tone: 'neutral' })
    const status = (item.status ?? '').trim()
    if (status.length > 0) push({ kind: 'status', value: status, tone: statusTone(status), title: status })
    if (item.verification !== undefined) {
      push({ kind: 'verify', value: 'L' + String(item.verification.level), level: item.verification.level, tone: item.verification.level >= 2 ? 'success' : 'neutral', title: item.verification.label })
    }
    if (item.security !== undefined && item.security.status !== 'skipped') {
      push({ kind: 'security', value: item.security.riskLevel, tone: securityTone(item.security.riskLevel), title: item.security.status })
    }
    const topics = item.topics ?? []
    const topicTitle = topics.join(', ')
    let emitted = 0
    for (const topic of topics) {
      if (emitted >= Math.max(0, limit)) break
      const value = String(topic).trim()
      if (value.length === 0) continue
      push({ kind: 'topic', value, tone: 'neutral', title: topicTitle })
      emitted += 1
    }
    return out
  }

  const cases = [
    { name: 'a/plain', topics: ['memory', 'search'] },
    { name: 'a/with-space', topics: ['  memory  ', 'search'] },
    { name: 'a/empty-topic', topics: ['', 'memory'] },
    { name: 'a/whitespace-only', topics: ['   '] },
    { name: 'a/no-topics' },
    { name: 'a/category-dup', category: 'memory', topics: ['memory', 'search'] },
    { name: 'a/installed', installed: true, installedKind: 'skill', topics: ['x', 'y', 'z'] },
    { name: 'a/verify', verification: { level: 3, label: 'L3' }, security: { status: 'audited', riskLevel: 'low' }, topics: ['one'] },
    { name: 'a/number-topic', topics: [42, 'real'] },
  ]

  it('逐条输出与改前实现完全一致（JSON 全等）', () => {
    for (const input of cases) {
      const now = buildMarketTags(input)
      const before = buildTagsOld(input)
      assert.deepEqual(JSON.parse(JSON.stringify(now)), JSON.parse(JSON.stringify(before)), '标签输出变化: ' + input.name)
    }
  })

  it('topic 标签的 title 仍是整条 topics 的 ", " 连接（惰性化不改内容）', () => {
    const tags = buildMarketTags({ topics: ['memory', 'search', 'vector'] })
    const topics = tags.filter(t => t.kind === 'topic')
    assert.equal(topics.length, 2, '默认上限 2 个 topic 标签')
    for (const tag of topics) assert.equal(tag.title, 'memory, search, vector')
  })

  it('没有 topic 标签被 emit 时完全不 join（惰性化生效）', () => {
    // 用一个会抛错的数组替身：一旦实现仍然 join，本用例立刻失败。
    const hostile = ['memory', 'search']
    hostile.join = () => { throw new Error('topics.join 被调用了，但没有任何 topic 标签需要 title') }
    // limit 0 → 循环在第一次迭代就 break，永远不该 join。
    assert.deepEqual(buildMarketTags({ topics: hostile }, { topicLimit: 0 }).filter(t => t.kind === 'topic'), [])
    // 全部为空/空白 → 一个 topic 都不 emit。
    assert.deepEqual(buildMarketTags({ topics: ['   ', ''] }).filter(t => t.kind === 'topic'), [])
  })

  it('有 topic 标签被 emit 时只 join 一次（title 内容正确）', () => {
    let joins = 0
    const topics = ['memory', 'search']
    const spy = new Proxy(topics, {
      get(target, prop, receiver) {
        if (prop === 'join') return (...args) => { joins += 1; return Array.prototype.join.apply(target, args) }
        return Reflect.get(target, prop, receiver)
      },
    })
    const tags = buildMarketTags({ topics: spy })
    assert.equal(tags.filter(t => t.kind === 'topic').length, 2)
    assert.equal(joins, 1, '同一轮内 join 只应执行一次（缓存到 topicTitle）')
  })

  it('导出面未变（Lead 冻结契约的护栏）', async () => {
    const tags = await import('../dist/tags.js')
    assert.deepEqual(Object.keys(tags).sort(), ['buildMarketTags', 'categoryCounts', 'installedKindKey', 'marketTagKey'])
  })
})

// ─────────────────────────────────────────── A10

describe('A10 job 轮询短间隔', () => {
  /** 从 dist/client.js 的 bundle 里取出 jobPollDelayMs（平台种子表内启动）。 */
  function loadPollSchedule() {
    const PLATFORM = {
      'react': () => require_('react'),
      'react/jsx-runtime': () => require_('react/jsx-runtime'),
      'react-dom': () => ({}),
      'react-dom/client': () => ({}),
      '@deepseek-ai/cordis': () => ({ Context: class {} }),
      '@deepseek-ai/dsh-client-store': () => ({}),
      '@deepseek-ai/dsh-client-ui-slots': () => ({}),
      '@deepseek-ai/dsh-client-ui-primitives': () => new Proxy({}, { get: () => () => null }),
      '@deepseek-ai/dsh-client-ui-dockkit': () => ({}),
    }
    let source = readFileSync(join(ROOT, 'dist/client.js'), 'utf8')
    const tail = 'return module.exports;'
    const at = source.lastIndexOf(tail)
    assert.ok(at > 0, 'dist/client.js 结构异常：找不到 ' + JSON.stringify(tail))
    source = source.slice(0, at) + 'return { jobPollDelayMs, JOB_POLL_MS, JOB_POLL_FAST_MS };' + source.slice(at + tail.length)
    const missed = []
    let exported
    const priorWindow = globalThis.window
    globalThis.window = {
      __ModuleLoader__: {
        load({ id, factory }) {
          assert.equal(id, 'dsh-web-plugin-manager')
          exported = factory((spec) => {
            if (!(spec in PLATFORM)) { missed.push(spec); throw new Error('missed the module table: ' + spec) }
            return PLATFORM[spec]()
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
    assert.deepEqual(missed, [], 'bundle require 了平台模块表之外的模块: ' + missed.join(', '))
    return exported
  }

  it('轮询时刻是改前（每 1.5s）时刻的超集：任何 settle 时刻都不会更晚被感知', () => {
    const { jobPollDelayMs, JOB_POLL_MS, JOB_POLL_FAST_MS } = loadPollSchedule()
    assert.equal(JOB_POLL_MS, 1500)
    assert.equal(JOB_POLL_FAST_MS, 250)
    /** 虚拟时钟：返回 (感知延迟, 轮询次数)。t=0 先查一次。 */
    const simulate = (settleAt, delayOf) => {
      let t = 0
      let polls = 1
      for (let waited = 0; ;) {
        if (t >= settleAt) return { latency: t, polls }
        const d = delayOf(waited)
        waited += d
        t += d
        polls += 1
      }
    }
    for (let settle = 0; settle <= 6000; settle += 1) {
      const before = simulate(settle, () => JOB_POLL_MS)
      const after = simulate(settle, jobPollDelayMs)
      assert.ok(after.latency <= before.latency, 'settle=' + settle + 'ms 时感知延迟变差: ' + before.latency + ' → ' + after.latency)
    }
    // 短任务的实测收益：settle=100ms 时从 1.5s 降到 250ms。
    assert.equal(simulate(100, jobPollDelayMs).latency, 250)
    assert.equal(simulate(100, () => JOB_POLL_MS).latency, 1500)
    // 长任务回落到原节奏（不引入额外的最坏情况延迟）。
    assert.equal(simulate(5000, jobPollDelayMs).latency, simulate(5000, () => JOB_POLL_MS).latency)
  })

  it('额外轮询有界：单任务最多多打 5 次', () => {
    const { jobPollDelayMs, JOB_POLL_MS } = loadPollSchedule()
    let extra = 0
    for (let settle = 0; settle <= 60_000; settle += 250) {
      const count = (delayOf) => { let t = 0; let n = 1; for (let waited = 0; t < settle;) { const d = delayOf(waited); waited += d; t += d; n += 1 } return n }
      extra = Math.max(extra, count(jobPollDelayMs) - count(() => JOB_POLL_MS))
    }
    assert.ok(extra <= 5, '额外轮询次数应 ≤5，实际 ' + extra)
  })
})

// ─────────────────────────────────────────── M-1 / m-3（正确性回归）

describe('M-1 finalizeListing 管道缓存键含 items 内容身份', () => {
  let home
  let previousHome

  before(async () => {
    home = await mkdtemp(join(tmpdir(), 'dshpm-perf-m1-'))
    await mkdir(join(home, 'profiles', 'web'), { recursive: true })
    await writeFile(join(home, 'profiles', 'web', 'package.json'),
      JSON.stringify({ name: 'dsh-profile-web', private: true, dependencies: {} }))
    previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = home
  })
  after(async () => {
    process.env.DSH_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  })

  it('同 baseAt 两次调用传不同 items：第二次必须返回第二次的 items/message', async () => {
    const baseAt = 987_654_321
    const options = (items, message, variant) => ({
      profile: 'm1', items, baseAt, dshSo: null, blocked: new Set(), variant, message, fromCache: false,
    })
    const full = await finalizeListing(options([item('a/one', { stars: 1 })], 'A: 全量注册表', 'fresh'))
    assert.deepEqual(full.items.map(i => i.name), ['a/one'])
    assert.equal(full.message, 'A: 全量注册表')
    // 真实触发路径：registry 链「网络 → readRegistryCache() → search 兜底」，
    // 网络失败时 source='cache' 且 baseAt 仍是镜像时间戳 —— 改前这里直接
    // 返回上面的 full（items/message/fromCache 全部张冠李戴）。
    const fallback = await finalizeListing(options([item('b/two', { stars: 2 })], 'B: search 兜底（部分数据）', 'stale-cache'))
    assert.deepEqual(fallback.items.map(i => i.name), ['b/two'], '第二次调用被第一次的结果覆盖了')
    assert.equal(fallback.message, 'B: search 兜底（部分数据）')
    assert.notEqual(fallback, full, '不同 items 不得复用同一个结果对象（它还会 key 序列化缓存）')
  })

  it('items 长度不同也视为不同代际（即使首条同名）', async () => {
    const baseAt = 111_222_333
    const options = (items, message) => ({ profile: 'm1b', items, baseAt, dshSo: null, blocked: new Set(), variant: 'fresh', message, fromCache: false })
    const one = await finalizeListing(options([item('a/one')], '一条'))
    const two = await finalizeListing(options([item('a/one'), item('a/two')], '两条'))
    assert.equal(one.total, 1)
    assert.equal(two.total, 2, '条目数变化必须使缓存失效')
    assert.equal(two.message, '两条')
  })

  it('同 baseAt 同 items：仍然命中缓存（性能不能倒退）', async () => {
    const baseAt = 444_555_666
    const options = () => ({ profile: 'm1c', items: [item('a/one')], baseAt, dshSo: null, blocked: new Set(), variant: 'fresh', message: 'same', fromCache: false })
    const first = await finalizeListing(options())
    const second = await finalizeListing(options())
    assert.equal(second, first, '内容未变时必须复用同一结果对象（序列化缓存也依赖它）')
  })

  it('memoryCacheGeneration 单调递增，且与写入的镜像内容对应', () => {
    const before = memoryCacheGeneration()
    writeMemoryCache([item('m/one')], 'test')
    const afterFirst = memoryCacheGeneration()
    assert.ok(afterFirst > before, 'writeMemoryCache 必须推进 generation')
    assert.equal(memoryCacheGeneration(), afterFirst, '未写入时 generation 不得自行变化')
    writeMemoryCache([item('m/two')], 'test')
    assert.ok(memoryCacheGeneration() > afterFirst, '第二次写入必须再次推进')
    assert.equal(readMemoryCache().items[0].name, 'm/two')
  })
})

describe('m-3 installed 索引：内容不变则缓存键不前进', () => {
  let home
  let previousHome

  before(async () => {
    home = await mkdtemp(join(tmpdir(), 'dshpm-perf-m3-'))
    await mkdir(join(home, 'profiles', 'web'), { recursive: true })
    await writeFile(join(home, 'profiles', 'web', 'package.json'),
      JSON.stringify({ name: 'dsh-profile-web', private: true, dependencies: {} }))
    previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = home
  })
  after(async () => {
    process.env.DSH_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  })

  it('同一份内容重复构建 → 身份戳不变（改前每次重建都会前进）', () => {
    const first = buildInstalledIndex('web')
    const stamp1 = installedIndexAt('web')
    // 强制重建（等价于 5s TTL 到期）：内容完全一样。
    invalidateInstalledIndex('web')
    const second = buildInstalledIndex('web')
    assert.notEqual(second, first, '重建必须产生新对象（否则本用例无意义）')
    assert.equal(installedIndexAt('web'), stamp1, '内容不变时身份戳不得前进（m-3）')
  })

  it('依赖集合变化 → 身份戳前进（安装后 flags 必须重算）', async () => {
    invalidateInstalledIndex('web')
    const before = installedIndexAt('web')
    await writeFile(join(home, 'profiles', 'web', 'package.json'),
      JSON.stringify({ name: 'dsh-profile-web', private: true, dependencies: { 'left-pad': '^1.0.0' } }))
    invalidateInstalledIndex('web')
    buildInstalledIndex('web')
    assert.notEqual(installedIndexAt('web'), before, '依赖变化必须使身份戳前进')
    await writeFile(join(home, 'profiles', 'web', 'package.json'),
      JSON.stringify({ name: 'dsh-profile-web', private: true, dependencies: {} }))
    invalidateInstalledIndex('web')
  })

  it('内容未变时 finalizeListing 不重跑管线（同一结果对象）', async () => {
    const baseAt = 777_888_999
    const options = () => ({
      profile: 'm3', items: [item('a/one', { stars: 3 })], baseAt,
      dshSo: null, blocked: new Set(), variant: 'fresh', message: 'm3', fromCache: false,
    })
    const first = await finalizeListing(options())
    // 模拟 5s TTL 到期后的重建（内容不变）。
    invalidateInstalledIndex('m3')
    buildInstalledIndex('m3')
    const second = await finalizeListing(options())
    assert.equal(second, first, 'TTL 重建但内容不变时不得重跑管线（m-3）')
  })
})
