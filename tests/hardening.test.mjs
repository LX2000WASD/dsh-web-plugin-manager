/**
 * 0.6.1 加固项单测（node --test，跑 dist 产物）：
 *  - packageEntry 统一后 analyzeProfile 认 string-exports 包（此前被静默跳过）；
 *  - scanServices 剥注释，注释掉的 new Service(...) 不再登记为冲突；
 *  - fetchDshSoIndex 缓存优先：新鲜磁盘缓存直接返回，不先打网络。
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { analyzeProfile } from '../dist/analyze.js'
import { fetchDshSoIndex, dshSoIndexAt } from '../dist/registry.js'
import { createPluginGuard } from '../dist/guard.js'

/** Write one file (creating parent directories). */
async function write(dir, name, content) {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, name), content)
}

/** Write one package.json at the given path (creating parents). */
async function writePkg(dir, manifest) {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'package.json'), JSON.stringify(manifest))
}

describe('packageEntry 统一（string exports）', () => {
  let fixture
  let profileDir

  before(async () => {
    fixture = await mkdtemp(join(tmpdir(), 'dshpm-hardening-'))
    profileDir = join(fixture, 'profiles', 'test')
    await writePkg(profileDir, {
      name: 'dsh-profile-test',
      private: true,
      dependencies: { 'string-exports-pkg': '1.0.0', 'ghost-comment-pkg': '1.0.0' },
    })
    // string-exports 形态："exports": "./dist/main.js"（无 main/module），
    // 入口 import 一个未安装包 → 此前 analyze 静默跳过该包，现在必须报 missing-import。
    await writePkg(join(profileDir, 'node_modules', 'string-exports-pkg'), {
      name: 'string-exports-pkg',
      version: '1.0.0',
      exports: './dist/main.js',
    })
    await write(join(profileDir, 'node_modules', 'string-exports-pkg', 'dist'), 'main.js',
      "import { missing } from 'totally-absent-provider'\nexport const x = missing\n")
    // 注释掉的 Service 注册：不剥注释会把 ghost-service 登记为已注册。
    await writePkg(join(profileDir, 'node_modules', 'ghost-comment-pkg'), {
      name: 'ghost-comment-pkg',
      version: '1.0.0',
      main: './index.js',
    })
    await write(join(profileDir, 'node_modules', 'ghost-comment-pkg'), 'index.js',
      "// const s = new Service(ctx, 'ghost-service')\nexport const y = 1\n")
  })

  after(async () => {
    await rm(fixture, { recursive: true, force: true })
  })

  it('string-exports 包的入口被解析并扫描（missing-import 可见）', () => {
    const result = analyzeProfile(profileDir, [], '[]', new Set())
    const pkg = result.packages.find(p => p.name === 'string-exports-pkg')
    assert.ok(pkg !== undefined, 'string-exports-pkg 应在分析列表中')
    assert.deepEqual(pkg.imports, ['totally-absent-provider'])
    const missing = result.issues.filter(issue => issue.kind === 'missing-import')
    assert.ok(missing.some(issue => issue.from === 'string-exports-pkg' && issue.message.includes('totally-absent-provider')),
      'string-exports 包的未声明依赖必须被报告: ' + JSON.stringify(missing))
  })

  it('注释掉的 new Service(...) 不再登记为已注册服务', () => {
    const result = analyzeProfile(profileDir, [], '[]', new Set())
    const pkg = result.packages.find(p => p.name === 'ghost-comment-pkg')
    assert.ok(pkg !== undefined)
    assert.deepEqual(pkg.services, [], '注释中的服务注册不应被扫描到: ' + JSON.stringify(pkg.services))
  })
})

describe('fetchDshSoIndex 缓存优先', () => {
  it('新鲜磁盘缓存直接返回（伪造条目可证明未先打网络）', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'dshpm-dshso-'))
    const previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = fixture
    try {
      // 写一份“新鲜”缓存，条目名是网络永远不可能返回的伪造名：
      // 若实现仍网络优先，伪造条目会被真实响应覆盖（或请求失败走缓存前的路径不同）。
      const cacheDir = join(fixture, 'plugin-manager-cache')
      await mkdir(cacheDir, { recursive: true })
      await writeFile(join(cacheDir, 'dshso-index.json'), JSON.stringify({
        savedAt: new Date().toISOString(),
        entries: [{ name: '__fixture-never-on-network__', verification: { level: 3, label: 'L3' } }],
      }))
      const entries = await fetchDshSoIndex()
      assert.ok(entries !== null, '新鲜缓存应可用')
      assert.equal(entries.length, 1)
      assert.equal(entries[0].name, '__fixture-never-on-network__')
      assert.ok(dshSoIndexAt() > 0, '命中后应留下进程内记忆戳')
      // 第二次调用走进程内 memo（同对象语义）。
      const again = await fetchDshSoIndex()
      assert.equal(again?.[0]?.name, '__fixture-never-on-network__')
    } finally {
      process.env.DSH_HOME = previousHome
      await rm(fixture, { recursive: true, force: true })
    }
  })
})

describe('createPluginGuard — 安装守卫的误报与漏报', () => {
  const guard = createPluginGuard()
  /** Run the guard over one bash command; undefined = allowed. */
  const run = (command) => guard({ name: 'bash', arguments: { command } })

  it('放行 npm run <script>（脚本名不是依赖变更）', () => {
    // 回归：\binstall\b 也会匹配脚本名前缀 install-，于是
    // `npm run install-assets --dir ~/.dsh/profiles/web` 被误判为裸变更。
    assert.equal(run('npm run install-assets --dir ~/.dsh/profiles/web'), undefined)
    assert.equal(run('npm run add-deps --prefix ~/.dsh/profiles/web'), undefined)
    assert.equal(run('npm run build --prefix ~/.dsh/profiles/web'), undefined)
  })

  it('仍然拦截真正改动依赖树的包管理器命令', () => {
    assert.ok(run('pnpm add foo --dir ~/.dsh/profiles/web'))
    assert.ok(run('pnpm --dir ~/.dsh/profiles/web add foo'))
    assert.ok(run('npm install --prefix ~/.dsh/profiles/web'))
    assert.ok(run('npm uninstall x --prefix ~/.dsh/profiles/web'))
    assert.ok(run('pnpm remove bar --dir ~/.dsh/profiles/web'))
  })

  it('仍然拦截官方 dsh plugin 写动词', () => {
    assert.ok(run('dsh plugin --profile web add foo'))
    assert.ok(run('dsh plugin --profile web remove foo'))
    assert.equal(run('dsh plugin --profile web list'), undefined)
  })
})
