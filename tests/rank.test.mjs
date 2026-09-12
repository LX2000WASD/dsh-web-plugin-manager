/**
 * rank.ts 模糊打分单测（node --test，跑 dist 产物）。
 * vendor 自官方 rank-by-name 的语义契约：有序子序列、边界加分、连续命中
 * 强于间隔、前缀排序优先。回归反例：非子序列必须淘汰。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { charMask, fuzzyScore, fuzzyFilter, fuzzyScoreLowered } from '../dist/rank.js'

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

describe('A2 掩码预筛（性能优化不得改变语义；缓冲复用实测更慢已放弃）', () => {
  // 覆盖 ASCII 大小写、分隔符、数字、CJK、emoji、空串、超长 query 等边界。
  const haystacks = [
    'plugin-manager', 'dsh-terminal-panel', 'memory-rag', 'trmnl',
    'Plugin-Manager', 'PLUGIN_MANAGER', 'tool_a', 'tool-b', 'a', '',
    '插件管理器 plugin-manager', '插件管理器', 'café-résumé', 'naïve',
    '123-456', 'a-b_c-d', '🚀-rocket', 'emoji🎯target', 'xx', 'zzz',
  ]
  const queries = [
    '', ' ', 'a', 'e', 'p', 'pm', 'plgmgr', 'plugin', 'manager', 'mgr',
    'dsh', 'term', 'terminal', 'trmnl', 'rag', 'memory', 'tool', 'a-b',
    '123', '456', 'zzz', 'xyzzy', '🚀', '🎯', '插件', '管理', 'café', 'naive',
    'PLUGIN', 'Plugin', 'a_b', 'a-b_c-d', 'naïve', 'manager-plugin',
  ]

  it('掩码版与朴素版对同一批查询逐条分数完全一致', () => {
    for (const hay of haystacks) {
      const hayMask = charMask(hay)
      for (const query of queries) {
        const needle = query.trim().toLowerCase()
        // 朴素版：不传掩码（等价于 A2 之前的调用方式）
        const plain = fuzzyScoreLowered(hay, needle)
        // 掩码版：传两个掩码
        const masked = fuzzyScoreLowered(hay, needle, hayMask, charMask(needle))
        assert.equal(masked, plain, 'hay=' + JSON.stringify(hay) + ' needle=' + JSON.stringify(needle))
      }
    }
  })

  it('只传一个掩码时预筛不生效（不会因参数不完整而误杀）', () => {
    for (const hay of haystacks) {
      const hayMask = charMask(hay)
      for (const query of queries) {
        const needle = query.trim().toLowerCase()
        const plain = fuzzyScoreLowered(hay, needle)
        // 只传 hayMask：预筛必须跳过，结果与朴素版相同
        assert.equal(fuzzyScoreLowered(hay, needle, hayMask), plain)
        // 只传 needleMask：同上
        assert.equal(fuzzyScoreLowered(hay, needle, undefined, charMask(needle)), plain)
      }
    }
  })

  it('掩码不会误杀：needle 字符集合是 haystack 子集时结果与朴素版一致', () => {
    // 反向断言——掩码只做必要条件拒绝，命中与否完全由朴素版决定
    for (const hay of haystacks) {
      for (const query of ['a', 'p', 'ab', 'abc']) {
        const needle = query.toLowerCase()
        const plain = fuzzyScoreLowered(hay, needle)
        const masked = fuzzyScoreLowered(hay, needle, charMask(hay), charMask(needle))
        assert.equal(masked === null, plain === null, 'hay=' + JSON.stringify(hay) + ' needle=' + needle)
      }
    }
  })

  it('charMask 只映射 ASCII 字母（CJK/emoji 不进掩码，故只放过不误杀）', () => {
    assert.equal(charMask(''), 0)
    assert.equal(charMask('123-_.'), 0)
    assert.equal(charMask('a'), 1)
    assert.equal(charMask('A'), 1, '大小写映射到同一位')
    assert.equal(charMask('z'), 1 << 25)
    assert.equal(charMask('插件'), 0, '非 ASCII 不进掩码')
    assert.equal(charMask('🚀🎯'), 0)
    // 掩码是并集：a|b = charMask('a') | charMask('b')
    assert.equal(charMask('ab'), charMask('a') | charMask('b'))
  })

  it('长 query（触发大数组分配）与反复调用都不改变结果', () => {
    // A2 最终只落地了掩码预筛（缓冲复用实测更慢，已放弃）——本用例锁定
    // 「无模块级状态 ⇒ 任意调用顺序都不影响结果」这个纯函数性质。
    const long = 'a'.repeat(40)
    assert.equal(fuzzyScoreLowered(long, 'aaaa'), fuzzyScoreLowered(long, 'aaaa', undefined, undefined))
    assert.ok(fuzzyScoreLowered(long, 'aaaa') !== null)
    // 长短 query 交错调用：结果必须与单独调用完全一致（无跨调用状态）
    for (const hay of haystacks) {
      for (const query of queries) {
        const needle = query.trim().toLowerCase()
        assert.equal(
          fuzzyScoreLowered(hay, needle, charMask(hay), charMask(needle)),
          fuzzyScoreLowered(hay, needle),
        )
      }
    }
  })

  it('重入安全：DP 进行中被嵌套调用时外层结果不受污染（无模块级可变状态）', () => {
    // fuzzyScoreLowered 不回调，所以用 Proxy 包一个 String 对象：DP 里读
    // haystack[i] 会走 get trap，在**外层调用尚未返回时**触发一次嵌套调用。
    // 因为最终实现是纯函数（每次新分配），这里断言的是「没有共享状态」这一
    // 性质本身——将来若有人重新引入缓冲复用，本用例会立刻变红。
    const target = new String('plugin-manager')
    let nestedScore = 'not-run'
    let armed = true
    const spy = new Proxy(target, {
      get(obj, prop) {
        if (armed && prop === '3') {
          armed = false
          nestedScore = fuzzyScoreLowered('memory-rag', 'mg')
        }
        return Reflect.get(obj, prop)
      },
    })
    const outerScore = fuzzyScoreLowered(spy, 'plgmgr')
    assert.notEqual(nestedScore, 'not-run', '嵌套调用必须真的发生过（否则本测试没测到重入）')
    assert.equal(nestedScore, fuzzyScoreLowered('memory-rag', 'mg'), '嵌套调用自身结果正确')
    assert.equal(outerScore, fuzzyScoreLowered('plugin-manager', 'plgmgr'), '外层结果未被重入污染')
  })

  it('fuzzyFilter 传掩码后输出与不传掩码逐条一致', () => {
    const items = [
      { name: 'plugin-manager' }, { name: 'memory-rag' }, { name: 'plugin-finder' },
      { name: 'terminal-ui' }, { name: '插件管理器' }, { name: '🚀-rocket' }, { name: '' },
    ]
    for (const query of ['', 'plug', 'plugin', 'pm', 'rag', 'term', '插件', '🚀', 'zzz', 'p']) {
      const hits = fuzzyFilter(items, item => item.name, query)
      if (hits === null) { assert.equal(query.trim().length, 0); continue }
      // 用朴素版重算同一过滤，逐条比较 score/prefix
      const needle = query.trim().toLowerCase()
      const expected = []
      for (const item of items) {
        const lowered = item.name.toLowerCase()
        const score = fuzzyScoreLowered(lowered, needle)
        if (score === null) continue
        expected.push({ name: item.name, score, prefix: lowered.startsWith(needle) })
      }
      expected.sort((a, b) => Number(b.prefix) - Number(a.prefix) || b.score - a.score)
      assert.deepEqual(hits.map(h => ({ name: h.item.name, score: h.score, prefix: h.prefix })), expected, 'query=' + JSON.stringify(query))
    }
  })
})

