/**
 * Node 内置模块说明符豁免单测（node --test，跑 dist 产物）。
 * issue #9：质量门对裸内置说明符（crypto/fs/net/...）误报 "imports X but
 * does not declare it"，导致 @xmanrui/dsh-im 这类合法插件无法安装。
 * 修复：scanImports 用 isBuiltin 统一豁免（裸名与 node: 前缀等价），
 * 质量门 / analyzeProfile / 依赖边全部自动不把内置模块当缺失依赖。
 * 回归反例：真实未声明的第三方包必须仍被报出。
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { isBuiltin } from 'node:module'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { scanImports, scanPackageImports } from '../dist/analyze.js'

/** issue #9 报告列出的全部内置模块名（加 events/tls 两个常见兄弟）。 */
const BUILTIN_NAMES = [
  'crypto', 'url', 'stream', 'http2', 'util', 'fs', 'path', 'querystring',
  'zlib', 'http', 'https', 'dns', 'net', 'events', 'tls',
]

let fixture
let pkgDir
let entryPath

before(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'dshpm-builtin-test-'))
  pkgDir = join(fixture, 'pkg')
  await mkdir(pkgDir, { recursive: true })
  entryPath = join(pkgDir, 'index.js')
  // 入口：全部内置引用形态 + 一个真实未声明第三方 + 相对依赖
  const entry = [
    "import crypto from 'crypto'",
    "import { createHash } from 'node:crypto'",
    "import 'fs'",
    "require('path')",
    "import('url')",
    "export { x } from 'stream/promises'",
    "import fsp from 'fs/promises'",
    "import np from 'some-undeclared-pkg'",
    "import './dep.js'",
    '',
  ].join('\n')
  await writeFile(entryPath, entry)
  // 相对依赖：裸内置 + node:-only 模块 + scoped 未声明第三方
  const dep = [
    "import zlib from 'zlib'",
    "import http from 'node:http'",
    "import dns from 'dns'",
    "import 'node:test'",
    "import '@scope/undeclared'",
    '',
  ].join('\n')
  await writeFile(join(pkgDir, 'dep.js'), dep)
})

after(async () => {
  await rm(fixture, { recursive: true, force: true })
})

describe('Node 内置模块说明符豁免（issue #9）', () => {
  it('issue #9 全套裸内置名不再被扫描为导入', async () => {
    const file = join(fixture, 'builtins-only.js')
    const code = BUILTIN_NAMES.map(n => "import x from '" + n + "'").join('\n')
    await writeFile(file, code)
    assert.deepEqual(scanImports(file), [])
  })

  it('node: 前缀、内置子路径与 node:-only 说明符同样豁免', async () => {
    const file = join(fixture, 'prefixed.js')
    const code = [
      "import a from 'node:http'",
      "import b from 'fs/promises'",
      "import c from 'stream/promises'",
      "import 'node:test'",
      '',
    ].join('\n')
    await writeFile(file, code)
    assert.deepEqual(scanImports(file), [])
  })

  it('真实未声明的第三方包仍被报出（门未放宽）', async () => {
    const file = join(fixture, 'third-party.js')
    const code = [
      "import crypto from 'crypto'",
      "import zod from 'zod'",
      "require('lodash')",
      '',
    ].join('\n')
    await writeFile(file, code)
    assert.deepEqual(scanImports(file), ['zod', 'lodash'])
  })

  it('scanPackageImports 全链遍历：内置名被滤除，未声明第三方保留', async () => {
    const imports = await scanPackageImports(pkgDir, entryPath)
    assert.ok(!imports.some(s => isBuiltin(s)),
      '扫描结果不应含任何内置说明符: ' + JSON.stringify(imports))
    assert.ok(!imports.includes('crypto') && !imports.includes('node:crypto'),
      'crypto 的裸名与 node: 名都不应出现: ' + JSON.stringify(imports))
  })

  it('相对依赖链仍被遍历（dep.js 的未声明 @scope 包被捕获）', async () => {
    const imports = await scanPackageImports(pkgDir, entryPath)
    assert.ok(imports.includes('some-undeclared-pkg'),
      '入口的未声明第三方应被捕获: ' + JSON.stringify(imports))
    assert.ok(imports.includes('@scope/undeclared'),
      '相对依赖里的未声明第三方应被捕获: ' + JSON.stringify(imports))
  })

  it('纯内置模块的 fixture 包可通过质量门（issue 建议的回归场景）', async () => {
    // 质量门只关心 scanPackageImports 的输出——空即无未声明导入问题。
    const imports = await scanPackageImports(pkgDir, entryPath)
    const undeclared = imports.filter(s => !isBuiltin(s))
    assert.deepEqual(undeclared.sort(), ['@scope/undeclared', 'some-undeclared-pkg'].sort())
  })
})
