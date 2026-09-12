/**
 * 客户端产物启动契约单测（node --test，跑 dist/client.js）。
 *
 * 守护的是 CONTEXT.md 记为「灾难级」的失败模式：客户端 bundle 里出现
 * 平台模块表之外的 require → 浏览器抛 "require(\"x\") missed the module
 * table"，**整个插件页面启动中断**（所有插件 UI 一起消失）。这里用一个
 * 模拟的模块表把 bundle 真正跑起来，越表的 require 会立刻抛错。
 *
 * 顺带核对：slot 注册面、locale 字典 zh/en 键位对齐、五个页签可渲染。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { renderToStaticMarkup } from 'react-dom/server'

const require_ = createRequire(import.meta.url)
const React = require_('react')

/**
 * 官方平台种子表（deepseek-harness packages/client/web/src/platform.ts）。
 * bundle 只允许 require 表内模块；表外一律抛错。这张表随官方版本变，
 * 跟进 DSH 时必须比对（见 CONTEXT.md）。
 */
const PLATFORM = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

/** 以最小桩件启动 bundle，返回其导出。 */
function bootBundle() {
  // 桩：只验证启动契约，不验证 primitives 的视觉实现。
  const primitives = new Proxy({}, { get: () => () => null })
  const table = {
    'react': React,
    'react/jsx-runtime': require_('react/jsx-runtime'),
    'react-dom': {}, 'react-dom/client': {},
    '@deepseek-ai/cordis': { Context: class {} },
    '@deepseek-ai/dsh-client-store': {},
    '@deepseek-ai/dsh-client-ui-slots': {},
    '@deepseek-ai/dsh-client-ui-primitives': primitives,
    '@deepseek-ai/dsh-client-ui-dockkit': {},
  }
  const missed = []
  let exported
  globalThis.window = {
    __ModuleLoader__: {
      load({ id, factory }) {
        exported = factory((spec) => {
          if (!(spec in table)) {
            missed.push(spec)
            throw new Error('missed the module table: ' + spec)
          }
          return table[spec]
        })
        assert.equal(id, 'dsh-web-plugin-manager', 'bundle 必须以自身 id 注册')
      },
    },
  }
  new Function(readFileSync('dist/client.js', 'utf8'))()
  // 越表 require → 浏览器抛 "missed the module table" 并中断整个插件页面。
  assert.deepEqual(missed, [], 'bundle require 了平台模块表之外的模块: ' + missed.join(', '))
  assert.ok(exported !== undefined, 'bundle 未通过 __ModuleLoader__.load 注册')
  // 桩表必须覆盖平台表（少一个都可能是漏网之鱼）。
  assert.deepEqual(PLATFORM.filter(s => !(s in table)), [], '桩表缺平台模块')
  return exported
}

/** 以 mock client ctx 调用 apply()，收集 slot / locale 注册。 */
function applyWithMocks(exported) {
  const slots = []
  const dicts = []
  exported.apply({
    effect(fn) { fn() },
    locale: {
      register(ns, d) { dicts.push({ ns, d }) },
      bind: (ns) => (key, params) => {
        const dict = dicts.find(e => e.ns === ns)?.d.zh ?? {}
        const value = String(dict[key] ?? key)
        return params === undefined
          ? value
          : value.replace(/\{(\w+)\}/g, (_, k) => String(params[k] ?? ''))
      },
    },
    slots: {
      inject(_name, fn) { fn() },
      register(spec, Component) { slots.push({ spec, Component }); return () => {} },
    },
  })
  return { slots, dicts }
}

describe('客户端 bundle 启动契约', () => {
  const exported = bootBundle()
  const { slots, dicts } = applyWithMocks(exported)

  it('导出的 inject 面与 NS 符合官方 slot 约定', () => {
    assert.deepEqual(exported.inject, ['slots', 'locale'])
    assert.equal(exported.NS, 'settings.pluginManager')
    assert.equal(typeof exported.apply, 'function')
  })

  it('注册五个页签，slot / id / 顺序符合遮蔽与排序约定', () => {
    const byKey = new Map(slots.map(s => [s.spec.name + '#' + s.spec.id, s.spec]))
    // 目录页遮蔽官方只读清单：同 id 'all'，priority -1（低者渲染）
    assert.equal(byKey.get('settings.plugins.tab#all')?.priority, -1)
    assert.equal(byKey.get('settings.plugins.tab#manager')?.order, 20)
    assert.equal(byKey.get('settings.plugins.tab#environments')?.order, 30)
    assert.equal(byKey.get('settings.section#kinds')?.order, 15)
    assert.equal(byKey.get('settings.section#marketplace')?.order, 20)
    assert.equal(slots.length, 5)
    for (const { spec } of slots) assert.equal(spec.locale, exported.NS)
  })

  it('locale 字典 zh/en 键位完全对齐', () => {
    assert.equal(dicts.length, 1)
    assert.equal(dicts[0].ns, exported.NS)
    const { zh, en } = dicts[0].d
    assert.deepEqual(Object.keys(zh).filter(k => !(k in en)), [], 'en 缺少的键')
    assert.deepEqual(Object.keys(en).filter(k => !(k in zh)), [], 'zh 缺少的键')
    assert.ok(Object.keys(zh).length > 200, '字典规模异常: ' + Object.keys(zh).length)
  })

  it('五个页签都能渲染出 HTML（无运行期错误）', () => {
    // 每个页签的 inject face 用最小桩件：只求 render 不抛。
    const ok = { ok: true, message: '', exitCode: 0, output: '' }
    const profiles = [{
      name: 'p1', path: '/tmp/p1', bundles: ['@deepseek-ai/dsh-base'], dependencies: [],
      isCurrent: true, isOfficial: false, running: null,
    }]
    const snapshot = {
      profile: profiles[0],
      packages: [{ name: 'pkg', version: '1.0.0', source: 'link:', disabled: false, bundles: false, issues: [] }],
      entries: [],
    }
    const faces = {
      'settings.plugins.tab#all': {
        profiles: async () => profiles, list: async () => snapshot,
        setEnabled: async () => ok, mount: async () => ok, presetCompositions: async () => null,
      },
      'settings.plugins.tab#manager': {
        profiles: async () => profiles, list: async () => snapshot, install: async () => ok,
        remove: async () => ok, removeInsert: async () => ok, copyPlugins: async () => ok,
        checkUpdates: async () => ({ ok: true, updates: [] }),
        update: async () => ok,
        analyze: async () => ({ ok: true, packages: [], edges: [], topoOrder: [], issues: [] }),
        fixIssue: async () => ok, fixAll: async () => ok,
      },
      'settings.plugins.tab#environments': {
        profiles: async () => profiles, copyPlugins: async () => ok, startProfile: async () => ok,
        stopProfile: async () => ok, createProfile: async () => ok, renameProfile: async () => ok,
        removeProfile: async () => ok, backupExport: async () => ({ version: 1, profiles: [], kinds: [] }),
        backupDiff: async () => ({ ok: true, missing: [], already: [], missingProfiles: [], unrestorable: [] }),
        backupRestore: async () => ok,
      },
      'settings.section#kinds': {
        kinds: async () => ({ skills: [], presets: [], records: [], blocked: [] }),
        uninstall: async () => ok, reinstall: async () => ok,
      },
      'settings.section#marketplace': {
        marketplace: async () => ({ ok: true, items: [], fromCache: false, message: 'ok', total: 0 }),
        install: async () => ok, update: async () => ok, unblock: async () => ok,
        profiles: async () => profiles,
      },
    }
    for (const { spec, Component } of slots) {
      const face = faces[spec.name + '#' + spec.id]
      assert.ok(face !== undefined, '缺少 ' + spec.name + '#' + spec.id + ' 的注入桩件')
      const props = { ...face, t: (k) => '[' + k + ']', locale: 'zh' }
      const html = renderToStaticMarkup(React.createElement(Component, props))
      assert.ok(html.length > 0, spec.name + '#' + spec.id + ' 渲染为空')
    }
  })
})
