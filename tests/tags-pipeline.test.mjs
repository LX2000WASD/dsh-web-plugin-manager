/**
 * host 侧标签管线单测（node --test，跑 dist 产物）。
 *
 * 覆盖 task-3 的四项验收：
 *  1. MarketplaceResult.categories 分类聚合（categoryCounts 聚合与排序、
 *     未知 category 降级、空/空白 category 忽略）；
 *  2. category 透传链路一致性（registryToItem → mergeRegistryWithCurated →
 *     dedupeMarketplace → finalizeListing），聚合取自「最终 listing」；
 *  3. 缓存往返：真实 PluginManagerService 的磁盘缓存命中路径 / 负缓存路径
 *     仍带 categories（旧缓存文件不需要 bump MARKETPLACE_CACHE_VERSION）；
 *  4. 上游对齐：src/registry.ts 的 TOPIC_STOP_WORDS 与 reference 分类器
 *     scripts/build-registry.mjs 逐字一致（reference 缺失时 skip）。
 *
 * 另有 buildMarketTags 的「host 侧只传标签」可行性用例，结论见该 describe。
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { categoryCounts, buildMarketTags } from '../dist/tags.js'
import {
  MARKETPLACE_CACHE_VERSION, dedupeMarketplace, finalizeListing, mergeRegistryWithCurated,
  registryToItem, writeMemoryCache,
} from '../dist/marketplaceMerge.js'
import { TOPIC_STOP_WORDS } from '../dist/registry.js'
import { PluginManagerService } from '../dist/index.js'
import { Context } from '@deepseek-ai/cordis'

/** 一条最小可用的 MarketplaceItem（字段与 types.ts 的必填项一致）。 */
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
 * finalizeListing 的结果按 (profile, baseAt, dsh.so 戳, installed 戳, 记录戳,
 * 屏蔽表, variant) 做了代际缓存，同键直接复用同一个结果对象。用例之间必须
 * 换一个 baseAt，否则后一个用例会拿到前一个的缓存结果。
 */
let baseAtSeq = 1

/**
 * 把进程内镜像置为「过期」（at 传远古时间 → readMemoryCache 返回 null）。
 * 镜像是进程级单例且不随 DSH_HOME 变化，跨用例复用 fixture 时必须先冷掉它，
 * 否则会命中上一个 fixture 的 items。这是 writeMemoryCache 文档化的用法
 * （at 参数就是为了控制镜像年龄）。
 */
function expireMemoryCache() {
  writeMemoryCache([], 'expired-by-test', 0)
}

/** finalizeListing 的最小调用参数（空屏蔽表 / 无 dsh.so 叠加）。 */
function finalizeOptions(items, extra = {}) {
  return {
    profile: '',
    items,
    baseAt: baseAtSeq++,
    dshSo: null,
    blocked: new Set(),
    variant: 'fresh',
    message: 'test',
    fromCache: false,
    ...extra,
  }
}

describe('categoryCounts — 聚合、排序与降级', () => {
  it('按 count 降序，同数按 id 升序', () => {
    const counts = categoryCounts([
      { category: 'tool' }, { category: 'tool' }, { category: 'tool' },
      { category: 'web-ui' }, { category: 'web-ui' },
      { category: 'agent' }, { category: 'memory' },
    ])
    assert.deepEqual(counts, [
      { id: 'tool', count: 3 },
      { id: 'web-ui', count: 2 },
      // 同数（1）按 id 升序：agent < memory
      { id: 'agent', count: 1 },
      { id: 'memory', count: 1 },
    ])
  })

  it('未知（上游新增）分类原样计数，不做白名单裁剪', () => {
    // 上游 3115 条现有 12 类；新增分类必须自动出现在筛选选项里，
    // 客户端不需要跟着发版（降级行为 = 当作普通分类）。
    const counts = categoryCounts([
      { category: 'tool' }, { category: 'quantum-plugin' }, { category: 'quantum-plugin' },
    ])
    assert.deepEqual(counts, [
      { id: 'quantum-plugin', count: 2 },
      { id: 'tool', count: 1 },
    ])
  })

  it('缺字段 / 空串 / 纯空白的 category 被忽略，不产生空桶', () => {
    const counts = categoryCounts([
      { category: 'tool' },
      {},
      { category: '' },
      { category: '   ' },
      { category: undefined },
    ])
    assert.deepEqual(counts, [{ id: 'tool', count: 1 }])
  })

  it('空输入返回空数组', () => {
    assert.deepEqual(categoryCounts([]), [])
    assert.deepEqual(categoryCounts([{}, { category: '' }]), [])
  })
})

describe('finalizeListing — categories 覆盖最终 listing', () => {
  it('ok:true 的结果始终带 categories（缺省不可选）', async () => {
    const result = await finalizeListing(finalizeOptions([
      item('a/one', { category: 'tool' }),
      item('a/two', { category: 'tool' }),
      item('a/three', { category: 'web-ui' }),
      item('a/four'), // 无 category：不计入聚合，也不产生空桶
    ]))
    assert.equal(result.ok, true)
    assert.deepEqual(result.categories, [
      { id: 'tool', count: 2 },
      { id: 'web-ui', count: 1 },
    ])
    // 聚合是纯投影：计数总和 = 有 category 的条目数。
    const sum = result.categories.reduce((n, c) => n + c.count, 0)
    assert.equal(sum, result.items.filter(i => (i.category ?? '').length > 0).length)
  })

  it('聚合取自去重后的 listing：被消解条目所属分类不再出现', async () => {
    // 两条同 pkg_name（npm 包只能装一次）→ 只留星数高的那条，
    // 另一条的分类若仍出现在筛选选项里，用户会筛出一个空列表。
    const result = await finalizeListing(finalizeOptions([
      item('a/winner', { category: 'tool', packageName: 'same-pkg', stars: 10 }),
      item('a/loser', { category: 'vision', packageName: 'same-pkg', stars: 1 }),
    ]))
    assert.equal(result.total, 1)
    assert.equal(result.dropped, 1)
    assert.deepEqual(result.categories, [{ id: 'tool', count: 1 }])
  })

  it('聚合取自屏蔽过滤之后：被屏蔽仓库的分类不再出现', async () => {
    const result = await finalizeListing(finalizeOptions([
      item('a/visible', { category: 'tool' }),
      item('a/blocked', { category: 'notify' }),
    ], { blocked: new Set(['a/blocked']) }))
    assert.deepEqual(result.items.map(i => i.name), ['a/visible'])
    assert.deepEqual(result.categories, [{ id: 'tool', count: 1 }])
  })

  it('空 listing 的 categories 是空数组（不是 undefined）', async () => {
    const result = await finalizeListing(finalizeOptions([]))
    assert.deepEqual(result.categories, [])
    assert.equal(result.total, 0)
  })
})

describe('category 透传链路 — registryToItem → mergeRegistryWithCurated → dedupe', () => {
  it('registryToItem 透传上游 category，缺字段时不写空值', () => {
    assert.equal(registryToItem(repo('a/one', { category: 'memory' })).category, 'memory')
    assert.equal('category' in registryToItem(repo('a/two')), false)
  })

  it('curated 只补空缺：上游分类器（CI 权威）不被 curated 分类覆盖', () => {
    const merged = mergeRegistryWithCurated(
      [repo('a/one', { category: 'tool' }), repo('a/two')],
      [
        item('a/one', { category: 'PLUGINS.md 章节名' }), // 冲突 → 保留 registry 的
        item('a/two', { category: '🧰 插件集' }),          // registry 缺 → 用 curated 的
      ],
    )
    assert.equal(merged.find(i => i.name === 'a/one').category, 'tool')
    assert.equal(merged.find(i => i.name === 'a/two').category, '🧰 插件集')
  })

  it('dedupeMarketplace 保留胜出条目的 category（被丢弃条目的分类随之消失）', () => {
    const { items, dropped } = dedupeMarketplace([
      item('a/high', { category: 'tool', packageName: 'p', stars: 5 }),
      item('a/low', { category: 'coding', packageName: 'p', stars: 1 }),
    ])
    assert.equal(dropped, 1)
    assert.equal(items.length, 1)
    assert.equal(items[0].category, 'tool')
  })
})

describe('缓存往返 — 真实 service 的磁盘缓存 / 负缓存路径都带 categories', () => {
  let fixture

  /** 建一个隔离的 DSH_HOME（含 profiles/web 与 plugin-manager-cache）。 */
  async function makeHome(tag) {
    const home = await mkdtemp(join(tmpdir(), 'dshpm-tags-' + tag + '-'))
    await mkdir(join(home, 'profiles', 'web'), { recursive: true })
    await writeFile(join(home, 'profiles', 'web', 'package.json'),
      JSON.stringify({ name: 'dsh-profile-web', private: true, dependencies: {} }))
    return home
  }

  /** 写一份 dsh.so 索引磁盘缓存（非空条目 → 命中缓存，测试内不打网络）。 */
  async function writeDshSoCache(home) {
    const cacheDir = join(home, 'plugin-manager-cache')
    await mkdir(cacheDir, { recursive: true })
    await writeFile(join(cacheDir, 'dshso-index.json'), JSON.stringify({
      savedAt: new Date().toISOString(),
      entries: [{ name: '__fixture-never-on-network__', verification: { level: 3, label: 'L3' } }],
    }))
  }

  before(async () => { fixture = await makeHome('cache') })
  after(async () => { await rm(fixture, { recursive: true, force: true }) })

  it('命中 24h 磁盘缓存时 categories 仍在（旧缓存文件无需 bump 版本）', async () => {
    const previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = fixture
    expireMemoryCache() // 进程级镜像不随 DSH_HOME 变化，先冷掉再测磁盘路径
    try {
      await writeDshSoCache(fixture)
      // 手写一份「旧安装」形态的缓存文件：缓存体是 ITEM 列表，不含
      // categories（该字段是响应包络上的派生物）。版本用当前值即可 ——
      // 本用例正是要证明「不 bump 版本也不会丢字段」。
      await writeFile(join(fixture, 'plugin-manager-cache', 'marketplace.json'), JSON.stringify({
        version: MARKETPLACE_CACHE_VERSION,
        fetchedAt: new Date().toISOString(),
        source: 'registry',
        items: [
          item('a/one', { category: 'tool' }),
          item('a/two', { category: 'tool' }),
          item('a/three', { category: 'web-ui' }),
        ],
      }) + '\n')

      const service = new PluginManagerService(new Context())
      const result = await service.marketplace('web', false)
      assert.equal(result.ok, true)
      assert.equal(result.fromCache, true)
      assert.equal(result.message, 'served from cache')
      assert.equal(result.total, 3)
      assert.deepEqual(result.categories, [
        { id: 'tool', count: 2 },
        { id: 'web-ui', count: 1 },
      ])
    } finally {
      process.env.DSH_HOME = previousHome
    }
  })

  it('命中进程内镜像时 categories 仍在（镜像优先于磁盘）', async () => {
    const home = await makeHome('memory')
    const previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      // 磁盘上故意不放 marketplace.json：若实现绕过镜像读磁盘，就会走到
      // 抓取/失败分支而不是 cache。镜像里的分类与磁盘用例不同，可区分来源。
      writeMemoryCache([
        item('m/one', { category: 'memory' }),
        item('m/two', { category: 'agent' }),
        item('m/three', { category: 'agent' }),
      ], 'registry', Date.now())
      await writeDshSoCache(home)

      const service = new PluginManagerService(new Context())
      const result = await service.marketplace('web', false)
      assert.equal(result.ok, true)
      assert.equal(result.fromCache, true)
      assert.equal(result.message, 'served from cache')
      assert.deepEqual(result.categories, [
        { id: 'agent', count: 2 },
        { id: 'memory', count: 1 },
      ])
    } finally {
      process.env.DSH_HOME = previousHome
      await rm(home, { recursive: true, force: true })
    }
  })

  it('负缓存（近期全源失败）响应带空 categories', async () => {
    const home = await makeHome('negative')
    const previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = home
    expireMemoryCache() // 同上：必须让上一个 fixture 的镜像过期，才能走到失败分支
    try {
      // 无可用 listing + 5 分钟内的失败记录 → 走负缓存分支，不打网络。
      await mkdir(join(home, 'plugin-manager-cache'), { recursive: true })
      await writeFile(join(home, 'plugin-manager-cache', 'marketplace-failure.json'), JSON.stringify({
        fetchedAt: new Date().toISOString(),
        message: 'no sources',
      }) + '\n')

      const service = new PluginManagerService(new Context())
      const result = await service.marketplace('web', false)
      assert.equal(result.ok, false)
      assert.equal(result.fromCache, false)
      assert.match(result.message, /negative cache/)
      assert.deepEqual(result.categories, [])
      assert.deepEqual(result.items, [])
    } finally {
      process.env.DSH_HOME = previousHome
      await rm(home, { recursive: true, force: true })
    }
  })
})

describe('上游对齐 — TOPIC_STOP_WORDS 与分类器权威来源一致', () => {
  const LOCAL_SOURCE = 'src/registry.ts'
  const UPSTREAM_SOURCE = 'reference/dsh-plugins-marketplace/scripts/build-registry.mjs'

  /** 抽取 \`marker ... endMarker\` 区间内所有引号字符串（找不到返回 null）。 */
  function extractQuoted(text, marker, endMarker, quote) {
    const start = text.indexOf(marker)
    if (start < 0) return null
    const end = text.indexOf(endMarker, start + marker.length)
    if (end < 0) return null
    const block = text.slice(start + marker.length, end)
    const re = new RegExp(quote + '([^' + quote + '\\\\]*)' + quote, 'g')
    return [...block.matchAll(re)].map(match => match[1])
  }

  async function readIfPresent(path) {
    return existsSync(path) ? await readFile(path, 'utf8') : null
  }

  it('本地词表与上游逐字一致（75 条）', async (t) => {
    const upstreamText = await readIfPresent(UPSTREAM_SOURCE)
    if (upstreamText === null) {
      // reference/ 是只读的生态参考仓库，可能未随工作区分发。
      t.skip(UPSTREAM_SOURCE + ' 不存在（生态参考未分发），跳过逐字比对')
      return
    }
    const localText = await readFile(LOCAL_SOURCE, 'utf8')
    const local = extractQuoted(localText, 'TOPIC_STOP_WORDS = new Set([', '])', "'")
    const upstream = extractQuoted(upstreamText, 'const TOPIC_STOP_WORDS = new Set([', ']);', '"')
    assert.ok(local !== null && local.length > 0, '未能从 ' + LOCAL_SOURCE + ' 解析词表')
    assert.ok(upstream !== null && upstream.length > 0, '未能从上游文件解析词表')

    // 顺序也要一致：两边都是人工维护的同一张表，顺序漂移说明有人手改了单侧。
    assert.deepEqual(local, upstream, 'TOPIC_STOP_WORDS 与上游分类器不一致')
    assert.equal(local.length, TOPIC_STOP_WORDS.size)
    // 集合语义与源码字面量一致（防止解析出的数组与导出集合脱节）。
    assert.deepEqual([...TOPIC_STOP_WORDS].sort(), [...local].sort())
  })

  it('上游分类器的分类 id 集合是 12 类（新增分类时本用例提示同步检查）', async (t) => {
    const upstreamText = await readIfPresent(UPSTREAM_SOURCE)
    if (upstreamText === null) {
      t.skip(UPSTREAM_SOURCE + ' 不存在（生态参考未分发），跳过分类集合比对')
      return
    }
    const ids = [...upstreamText.matchAll(/\bid:\s*"([^"]+)"/g)].map(match => match[1])
    // CATEGORY_RULES 里 resource 出现两次（前置强特征 + 后置兜底）。
    const unique = [...new Set(ids)]
    assert.deepEqual(unique, [
      'vision', 'memory', 'notify', 'resource', 'document', 'coding',
      'web-ui', 'tool', 'model', 'conversation', 'agent',
    ])
    // 兜底分类 id：无匹配 → "other"。
    assert.match(upstreamText, /const CATEGORY_OTHER = "other"/)
    // host 侧对分类不做白名单：上面 11 个 + other = 12 类全部原样透传，
    // 未知（未来新增）分类同样原样计数（见 categoryCounts 用例）。
    assert.ok(TOPIC_STOP_WORDS.size > 0)
  })
})

describe('host 侧「只传标签」可行性（结论：不做，保持现状）', () => {
  it('buildMarketTags 是纯客户端投影，host 传 category 已足够', () => {
    // 结论：host 侧不需要新增「预构建标签数组」的 wire 字段。
    //  - buildMarketTags 只读 item 上已有的 category/installed/status/
    //    verification/security/topics，纯函数、无 host 依赖；
    //  - host 只多传一个 categories 聚合（本任务），客户端筛选选项即可与
    //    卡片一致；标签本身仍在客户端按需构建（渲染时才有 locale/tone 需求）。
    // 若改为 host 传标签数组：payload 从 1.7MB 再涨（每条约 3-6 个标签对象），
    // 且会把 locale 无关的 tone/顺序契约固化进缓存与响应包络，收益为负。
    const source = item('a/one', {
      category: 'memory',
      topics: ['memory', 'recall'],
      installed: true,
      installedKind: 'skill',
    })
    const tags = buildMarketTags(source)
    assert.deepEqual(tags.map(tag => tag.kind), ['category', 'type', 'topic'])
    assert.deepEqual(tags.map(tag => tag.value), ['memory', 'skill', 'recall'])
  })

  it('categories 与逐条 buildMarketTags 的分类投影一致（同一份 category 字段）', () => {
    const items = [
      item('a/one', { category: 'tool' }),
      item('a/two', { category: 'tool' }),
      item('a/three', { category: 'vision' }),
      item('a/four'),
    ]
    // 聚合 = 逐条 category 标签的计数（客户端本地兜底与 host 聚合同源）。
    const fromTags = new Map()
    for (const entry of items) {
      for (const tag of buildMarketTags(entry)) {
        if (tag.kind !== 'category') continue
        fromTags.set(tag.value, (fromTags.get(tag.value) ?? 0) + 1)
      }
    }
    assert.deepEqual(
      categoryCounts(items),
      [...fromTags.entries()].map(([id, count]) => ({ id, count }))
        .sort((a, b) => b.count - a.count || (a.id < b.id ? -1 : 1)),
    )
  })
})
