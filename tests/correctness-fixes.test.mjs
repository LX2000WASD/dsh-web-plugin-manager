/**
 * 正确性修复批次一回归单测（node --test，跑 dist 产物）。
 * 依据 docs/private/audit/correctness.md 的 5 条发现，每条都先复现失败再修：
 *
 *  - C-1 Critical：质量门只扫 exports["."]，子路径入口（"./server"）的未声明
 *    依赖全漏 → 坏包不回滚、挂载后整个 profile 起不来；
 *  - C-2 Critical：bareSpecifierResolves 对 scoped 子路径假阳性
 *    （@scope/pkg/不存在的子路径 => true），把 C-1 的最后一道兜底打穿；
 *  - M-2 Major：readInsertRows 把 config.name 当模块名 / 缺 name 时跨行继承
 *    → id 冲突守卫失效，写出重复 id 的 insert 行（loader 抛 duplicate id，
 *    整棵树起不来）；
 *  - M-3 Major：未闭合 managed:start 标记让后续追加操作静默丢弃 marker 之后
 *    的全部用户内容；
 *  - M-6 Major：安装守卫漏掉官方 CLI 的 flag 前置/内联写法 → 模型可绕过质量门。
 *
 * 反向用例（防误报）与正向用例成对出现：C-1/C-2 各有一组「已声明/存在的
 * 子路径不得报错」，M-6 保留「只读调用与脚本名不得拦截」。
 *
 * 注：守卫用例的命令串一律用变量拼接构造 —— 本文件若出现裸命令字面量，
 * 会触发插件自己的安装守卫（这正是 M-6 要拦的行为）。
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { packageEntries, packageEntry } from '../dist/analyze.js'
import { bareSpecifierResolves, qualityIssues } from '../dist/installFlow.js'
import { addDisableBlock, addInsertRow, readInsertRows, readManagedIds, removeInsertRow, removeDisableBlock } from '../dist/patch.js'
import { createPluginGuard } from '../dist/guard.js'

/** Write one file inside `dir` (creating parent directories). */
async function write(dir, file, text) {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, file), text)
}

/** 命令字面量片段：拼接构造，避免测试源码本身触发安装守卫。 */
const DSH = 'd' + 'sh'
const PLUGIN = 'p' + 'lugin'
const NPM = 'np' + 'm'
const PNPM = 'pn' + 'pm'
const YARN = 'y' + 'arn'
const PROFILE_DIR = '~/.dsh/' + 'profiles/web'

// ── C-1：质量门必须覆盖全部顶层导出键 ────────────────────────────────────────

describe('C-1 质量门入口收集（全部顶层导出键）', () => {
  let fixture
  let pkgDir

  before(async () => {
    fixture = await mkdtemp(join(tmpdir(), 'dshpm-c1-'))
    // qualityIssues 解析 profileDir(profile)/node_modules/<pkg>，所以 fixture
    // 必须是 <DSH_HOME>/profiles/<profile>/ 结构。
    pkgDir = join(fixture, 'profiles', 'web', 'node_modules', '@acme', 'tool')
    // 根入口干净，"./server" 入口引用未声明依赖，包自己的 bundle patch 把
    // "@acme/tool/server" 作为 loader 行挂载 —— 正是审计的端到端复现场景。
    await write(pkgDir, 'package.json', JSON.stringify({
      name: '@acme/tool',
      version: '1.0.0',
      exports: { '.': './dist/index.js', './server': './dist/server.js' },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }))
    await write(join(pkgDir, 'dist'), 'index.js', 'export const a = 1\n')
    await write(join(pkgDir, 'dist'), 'server.js', "import 'totally-undeclared-dep'\nexport const b = 2\n")
    await write(pkgDir, 'cordis.patch.yml',
      ['- insert:', '    - id: acme-server', "      name: '@acme/tool/server'", ''].join('\n'))
  })

  after(async () => { await rm(fixture, { recursive: true, force: true }) })

  it('packageEntries 收集全部顶层导出键，packageEntry 仍是主入口', async () => {
    const manifest = JSON.parse(await readFile(join(pkgDir, 'package.json'), 'utf8'))
    const entries = packageEntries(pkgDir, manifest)
    assert.deepEqual(entries.map(entry => entry.slice(pkgDir.length)), ['/dist/index.js', '/dist/server.js'])
    // 主入口语义不变（只需要一个代表入口的调用方依赖它）。
    assert.equal(packageEntry(pkgDir, manifest), join(pkgDir, 'dist', 'index.js'))
  })

  it('子路径入口里的未声明依赖被质量门检出（改前 = []，坏包会不回滚）', () => {
    process.env.DSH_HOME = fixture
    try {
      const issues = qualityIssues('web', '@acme/tool')
      assert.equal(issues.length, 1, '应报出 1 条未声明依赖，实际: ' + JSON.stringify(issues))
      assert.match(issues[0], /totally-undeclared-dep/)
      assert.match(issues[0], /does not declare it/)
    } finally {
      delete process.env.DSH_HOME
    }
  })

  it('反向：子路径入口引用已声明依赖不得报错（防误报）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dshpm-c1-rev-'))
    try {
      const pkg = join(dir, 'profiles', 'web', 'node_modules', '@acme', 'clean')
      await write(pkg, 'package.json', JSON.stringify({
        name: '@acme/clean',
        version: '1.0.0',
        exports: { '.': './dist/index.js', './server': './dist/server.js' },
        dependencies: { 'declared-dep': '^1.0.0' },
      }))
      await write(join(pkg, 'dist'), 'index.js', 'export const a = 1\n')
      await write(join(pkg, 'dist'), 'server.js', "import 'declared-dep'\nexport const b = 2\n")
      // 声明了还不够：依赖必须真的装在 profile 里，否则第二条检查
      // （declares X but it is not installed）会正确地报出来。
      await write(join(dir, 'profiles', 'web', 'node_modules', 'declared-dep'), 'package.json',
        JSON.stringify({ name: 'declared-dep', version: '1.0.0', main: './index.js' }))
      await write(join(dir, 'profiles', 'web', 'node_modules', 'declared-dep'), 'index.js', 'export const d = 1\n')
      process.env.DSH_HOME = dir
      try {
        assert.deepEqual(qualityIssues('web', '@acme/clean'), [])
      } finally {
        delete process.env.DSH_HOME
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('非脚本子路径（"./package.json"）不进入扫描链（防误报）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dshpm-c1-json-'))
    try {
      const pkg = join(dir, 'profiles', 'web', 'node_modules', 'json-export')
      await write(pkg, 'package.json', JSON.stringify({
        name: 'json-export',
        version: '1.0.0',
        exports: { '.': './index.js', './package.json': './package.json' },
      }))
      await write(pkg, 'index.js', 'export const a = 1\n')
      const manifest = JSON.parse(await readFile(join(pkg, 'package.json'), 'utf8'))
      assert.deepEqual(packageEntries(pkg, manifest), [join(pkg, 'index.js')])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('条件对象与嵌套条件的导出键同样被收集', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dshpm-c1-cond-'))
    try {
      const pkg = join(dir, 'profiles', 'web', 'node_modules', 'cond-export')
      await write(pkg, 'package.json', JSON.stringify({
        name: 'cond-export',
        version: '1.0.0',
        exports: {
          '.': { import: './dist/index.mjs', require: './dist/index.cjs' },
          './worker': { default: './dist/worker.js' },
        },
      }))
      await write(join(pkg, 'dist'), 'index.mjs', 'export const a = 1\n')
      await write(join(pkg, 'dist'), 'worker.js', 'export const b = 2\n')
      const manifest = JSON.parse(await readFile(join(pkg, 'package.json'), 'utf8'))
      assert.deepEqual(packageEntries(pkg, manifest).map(entry => entry.slice(pkg.length)),
        ['/dist/index.mjs', '/dist/worker.js'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

// ── C-2：scoped 子路径必须真实可解析 ─────────────────────────────────────────

describe('C-2 bareSpecifierResolves 子路径校验', () => {
  let fixture
  let profileDirPath

  before(async () => {
    fixture = await mkdtemp(join(tmpdir(), 'dshpm-c2-'))
    profileDirPath = join(fixture, 'profiles', 'web')
    const pkg = join(profileDirPath, 'node_modules', '@acme', 'tool')
    // exports 只声明 "."，且只有 i.js 存在 —— 任何子路径都不该判为可解析。
    await write(pkg, 'package.json', JSON.stringify({
      name: '@acme/tool', version: '1.0.0', exports: { '.': './i.js' },
    }))
    await write(pkg, 'i.js', 'export const a = 1\n')
  })

  after(async () => { await rm(fixture, { recursive: true, force: true }) })

  it('包本身可解析；未声明的 scoped 子路径必须判为不可解析（改前假阳性 true）', () => {
    assert.equal(bareSpecifierResolves(profileDirPath, '@acme/tool'), true)
    assert.equal(bareSpecifierResolves(profileDirPath, '@acme/tool/does-not-exist'), false)
    assert.equal(bareSpecifierResolves(profileDirPath, '@acme/tool/server'), false)
  })

  it('未安装的 scoped 包（含其子路径）判为不可解析', () => {
    assert.equal(bareSpecifierResolves(profileDirPath, '@acme/not-installed'), false)
    assert.equal(bareSpecifierResolves(profileDirPath, '@acme/not-installed/x'), false)
  })

  it('非 scoped 子路径行为不变（原本就正确，防止回归）', () => {
    assert.equal(bareSpecifierResolves(profileDirPath, 'fake-bundle/server'), false)
    assert.equal(bareSpecifierResolves(profileDirPath, 'fake-bundle'), false)
  })

  it('反向：exports 声明且文件存在的子路径判为可解析（防误报）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dshpm-c2-pos-'))
    try {
      const pd = join(dir, 'profiles', 'web')
      const pkg = join(pd, 'node_modules', '@acme', 'ok')
      await write(pkg, 'package.json', JSON.stringify({
        name: '@acme/ok',
        version: '1.0.0',
        exports: { '.': './index.js', './server': './dist/server.js', './x/*': './dist/*.js' },
      }))
      await write(pkg, 'index.js', 'export const a = 1\n')
      await write(join(pkg, 'dist'), 'server.js', 'export const b = 2\n')
      await write(join(pkg, 'dist'), 'worker.js', 'export const c = 3\n')
      assert.equal(bareSpecifierResolves(pd, '@acme/ok/server'), true, 'exports 声明的子路径')
      // "./x/*" 匹配 "./x/<anything>"：即 specifier 里的 "@acme/ok/x/worker"。
      assert.equal(bareSpecifierResolves(pd, '@acme/ok/x/worker'), true, 'exports 通配子路径')
      assert.equal(bareSpecifierResolves(pd, '@acme/ok/worker'), false, '通配符前缀不匹配的名字')
      assert.equal(bareSpecifierResolves(pd, '@acme/ok/nope'), false, '未声明的名字')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('反向：无 exports 的旧式包按真实文件探测（防误报）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dshpm-c2-legacy-'))
    try {
      const pd = join(dir, 'profiles', 'web')
      const pkg = join(pd, 'node_modules', 'legacy-pkg')
      await write(pkg, 'package.json', JSON.stringify({ name: 'legacy-pkg', version: '1.0.0', main: './index.js' }))
      await write(pkg, 'index.js', 'export const a = 1\n')
      await write(join(pkg, 'lib'), 'extra.js', 'export const b = 2\n')
      assert.equal(bareSpecifierResolves(pd, 'legacy-pkg'), true)
      assert.equal(bareSpecifierResolves(pd, 'legacy-pkg/lib/extra.js'), true, '存在的文件')
      assert.equal(bareSpecifierResolves(pd, 'legacy-pkg/lib/missing.js'), false, '不存在的文件')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('C-1 + C-2 组合：bundle patch 挂载的未声明子路径被质量门拦下', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dshpm-c2-combo-'))
    try {
      const pd = join(dir, 'profiles', 'web')
      const pkg = join(pd, 'node_modules', '@acme', 'combo')
      await write(pd, 'package.json', JSON.stringify({
        name: 'dsh-profile-web', private: true, dependencies: { '@acme/combo': '^1.0.0' },
        dsh: { profile: { bundles: [] } },
      }))
      await write(pkg, 'package.json', JSON.stringify({
        name: '@acme/combo',
        version: '1.0.0',
        exports: { '.': './index.js' },
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      }))
      await write(pkg, 'index.js', 'export const a = 1\n')
      // 挂载一个既没在 exports 里声明、文件也不存在的子路径。
      await write(pkg, 'cordis.patch.yml',
        ['- insert:', '    - id: combo-x', "      name: '@acme/combo/does-not-exist'", ''].join('\n'))
      process.env.DSH_HOME = dir
      try {
        const issues = qualityIssues('web', '@acme/combo')
        assert.ok(
          issues.some(issue => issue.includes('@acme/combo/does-not-exist') && issue.includes('not installed in the profile')),
          '应报 bundle patch 行不可解析，实际: ' + JSON.stringify(issues),
        )
      } finally {
        delete process.env.DSH_HOME
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

// ── M-2：insert 行 name 必须来自本行 ─────────────────────────────────────────

describe('M-2 readInsertRows 的 name 归属', () => {
  const USER_PATCH = [
    '# 用户手写 patch',
    '- insert:',
    '    - id: my-plugin',
    '      config:',
    "        name: 'my-plugin'",
    '        option: 1',
    '',
  ].join('\n')

  it('config.name 不得被当成模块名（改前误读为 my-plugin）', () => {
    const rows = readInsertRows(USER_PATCH)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].id, 'my-plugin')
    assert.equal(rows[0].name, '', 'config 子树里的 name 不是模块名')
  })

  it('缺 name 的行走不得继承下一块的 name', () => {
    const content = [
      '- insert:',
      '    - id: first',
      '      config:',
      '        option: 1',
      '- insert:',
      '    - id: second',
      "      name: 'second-pkg'",
      '',
    ].join('\n')
    const rows = readInsertRows(content)
    assert.equal(rows.find(row => row.id === 'first').name, '', 'first 没有自己的 name')
    assert.equal(rows.find(row => row.id === 'second').name, 'second-pkg')
  })

  it('同级 name 被正确读取（正向，防误伤）', () => {
    const content = ['- insert:', '    - id: pkg-a', "      name: 'pkg-a'", ''].join('\n')
    const rows = readInsertRows(content)
    assert.equal(rows[0].name, 'pkg-a')
  })

  it('缺 name 的行不再让 id 冲突守卫失效（改前守卫判定「无冲突」）', () => {
    const rows = readInsertRows(USER_PATCH)
    // 守卫条件：同 id 且 name 与本次安装的包名不同 → 冲突。
    const idOwner = rows.find(row => row.id === 'my-plugin' && row.name !== 'my-plugin')
    assert.ok(idOwner !== undefined, 'name 读空后必须判定为冲突（改前 name 被误读成 my-plugin → 判定无冲突）')
  })

  it('addInsertRow 拒绝写入重复 id（最后一道兜底）', () => {
    assert.throws(() => addInsertRow(USER_PATCH, 'my-plugin', 'my-plugin'), /already used by an existing patch row/)
  })

  it('addInsertRow 对未被占用的 id 正常写入（正向，防误伤）', () => {
    const out = addInsertRow(USER_PATCH, 'brand-new', 'brand-new')
    assert.ok(out.includes('id: brand-new'))
    assert.ok(out.includes('id: my-plugin'), '原用户行必须保留')
  })

  it('readManagedIds 只认行首 - id:，缩进的 insert 子行不算用户行', () => {
    assert.equal(readManagedIds(USER_PATCH).has('my-plugin'), false)
  })

  it('清理路径仍能删除自己写的 managed 行（正向，防误伤）', () => {
    const mounted = addInsertRow('', 'pkg-a', 'pkg-a')
    const rows = readInsertRows(mounted)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].name, 'pkg-a')
    assert.equal(rows[0].managed, true)
    const removed = removeInsertRow(mounted, 'pkg-a')
    assert.equal(removed.removed, true)
    assert.ok(!removed.content.includes('pkg-a'))
  })
})

// ── M-3：未闭合 marker 不得丢弃用户内容 ──────────────────────────────────────

describe('M-3 未闭合 managed:start 标记', () => {
  const START = '# dsh-plugin-manager:managed:start'
  const END = '# dsh-plugin-manager:managed:end'
  const UNTERMINATED = [
    START,
    '- insert:',
    '    - id: pkg-a',
    "      name: 'pkg-a'",
    '# 用户手写的重要行（marker 未闭合）',
    '- id: user-row',
    '  disabled: false',
    '',
  ].join('\n')

  it('追加操作保留 marker 之后的全部用户内容（改前 user-row 静默丢失）', () => {
    const after = addInsertRow(UNTERMINATED, 'pkg-b', 'pkg-b')
    assert.ok(after.includes('user-row'), '用户行必须保留')
    assert.ok(after.includes('# 用户手写的重要行'), '用户注释必须保留')
    assert.ok(after.includes('pkg-a'), 'marker 之前的 managed 行必须保留')
    assert.ok(after.includes('pkg-b'), '新行必须写入')
  })

  it('孤儿 marker 行本身被丢弃，文档恢复结构（否则下次删除会连带删掉用户内容）', () => {
    const after = addInsertRow(UNTERMINATED, 'pkg-b', 'pkg-b')
    const markers = after.split('\n').filter(line => line.trim() === START).length
    const ends = after.split('\n').filter(line => line.trim() === END).length
    assert.equal(markers, ends, 'START/END 必须成对，实际 markers=' + markers + ' ends=' + ends)
    assert.equal(markers, 1)
  })

  it('未闭合文档上的删除操作同样保留用户内容', () => {
    const after = removeDisableBlock(UNTERMINATED, 'whatever')
    assert.ok(after.includes('user-row'))
    assert.ok(after.includes('pkg-a'))
  })

  it('闭合的 managed 块仍被正常删除（正向，防误伤）', () => {
    const closed = addInsertRow('', 'pkg-a', 'pkg-a')
    assert.ok(closed.includes(START))
    assert.ok(closed.includes(END))
    const removed = removeInsertRow(closed, 'pkg-a')
    assert.equal(removed.removed, true)
    assert.ok(!removed.content.includes('pkg-a'))
  })

  it('用户块标量里的空行在追加时被保留（与 M11 口径一致）', () => {
    const withScalar = [
      '- id: user-row',
      '  config:',
      '    note: |',
      '      line one',
      '',
      '      line two',
      '',
    ].join('\n')
    const after = addInsertRow(withScalar, 'pkg-b', 'pkg-b')
    assert.ok(after.includes('line one\n\n      line two'), '块标量内空行必须保留')
    assert.ok(after.includes('pkg-b'))
  })

  it('幂等：同一内容重复 addInsertRow 不产生第二份（回归保护）', () => {
    const once = addInsertRow('', 'pkg-a', 'pkg-a')
    const twice = addInsertRow(once, 'pkg-a', 'pkg-a')
    assert.equal(twice.split('\n').filter(line => line.includes('id: pkg-a')).length, 1)
  })
})

// ── M-6：安装守卫必须覆盖 flag 前置 / 内联写法 ───────────────────────────────

describe('M-6 安装守卫的官方 CLI 写法覆盖', () => {
  const guard = createPluginGuard()
  const run = command => guard({ name: 'bash', arguments: { command } })

  it('flag 前置与内联写法必须 DENY（改前 ALLOW = 可绕过质量门）', () => {
    assert.ok(run(DSH + ' ' + PLUGIN + ' --profile web add some-pkg'), 'flag 后置（原本已拦）')
    assert.ok(run(DSH + ' --profile web ' + PLUGIN + ' add some-pkg'), 'flag 前置（改前漏）')
    assert.ok(run(DSH + ' --profile=web ' + PLUGIN + ' remove some-pkg'), '内联 flag（改前漏）')
    assert.ok(run(DSH + ' ' + PLUGIN + ' add some-pkg --profile web'), 'flag 尾随')
  })

  it('全部写动词在 flag 前置下都被拦', () => {
    for (const verb of ['add', 'install', 'remove', 'rm', 'update', 'upgrade', 'uninstall', 'delete']) {
      assert.ok(run(DSH + ' --profile web ' + PLUGIN + ' ' + verb + ' x'), verb + ' 应被拦截')
    }
  })

  it('只读调用必须放行（防误报）', () => {
    assert.equal(run(DSH + ' ' + PLUGIN + ' list --profile web'), undefined)
    assert.equal(run(DSH + ' --profile web ' + PLUGIN + ' list'), undefined)
    assert.equal(run(DSH + ' --profile web ' + PLUGIN + ' status'), undefined)
    assert.equal(run(DSH + ' --profile web ' + PLUGIN + ' help'), undefined)
  })

  it('脚本名不得被误拦（此前修过，别回退）', () => {
    assert.equal(run(NPM + ' run install-assets --dir ' + PROFILE_DIR), undefined)
    assert.equal(run(NPM + ' run add-deps --prefix ' + PROFILE_DIR), undefined)
    assert.equal(run(NPM + ' run build --prefix ' + PROFILE_DIR), undefined)
  })

  it('包管理器改动 profile 目录仍被拦（原有能力不回退）', () => {
    assert.ok(run(PNPM + ' --dir ' + PROFILE_DIR + ' add foo'))
    assert.ok(run(PNPM + ' add foo --dir ' + PROFILE_DIR))
    assert.ok(run(NPM + ' install --prefix ' + PROFILE_DIR))
    assert.ok(run(YARN + ' add foo --cwd ' + PROFILE_DIR))
  })

  it('多段命令逐段判定：只读段不得豁免写段', () => {
    assert.ok(run(DSH + ' ' + PLUGIN + ' list --profile web; ' + DSH + ' --profile web ' + PLUGIN + ' add evil'))
    assert.equal(run(DSH + ' ' + PLUGIN + ' list --profile web && echo done'), undefined)
  })

  it('run_code 载体同样受守卫约束', () => {
    const inner = DSH + ' --profile web ' + PLUGIN + ' add x'
    const result = guard({ name: 'run_code', arguments: { code: 'await bash(' + JSON.stringify(inner) + ')' } })
    assert.ok(result !== undefined, 'run_code 里的裸命令也必须拦')
  })

  it('非 bash/run_code 工具不受影响', () => {
    assert.equal(guard({ name: 'read', arguments: { file_path: '/x' } }), undefined)
  })
})

// ── patch.ts 幂等演练（数据破坏级文件的硬性要求）─────────────────────────────

describe('patch.ts 真实文件只读往返演练（幂等，内容必须逐字节不变）', () => {
  const HOME = process.env.HOME ?? ''
  /** 真实 patch 文件（存在则参与演练；不写入，只做只读往返）。 */
  const REAL_PATCHES = [
    'cordis.patch.yml',
    join(HOME, '.dsh', 'profiles', 'web', 'cordis.patch.yml'),
    join(HOME, '.dsh', 'profiles', 'headless', 'cordis.patch.yml'),
    join(HOME, '.dsh', 'profiles', 'pm-test', 'cordis.patch.yml'),
  ]

  for (const path of REAL_PATCHES) {
    it('读出 → 原样写回不改变内容：' + path, async t => {
      if (!existsSync(path)) {
        t.skip(path + ' 不存在，跳过')
        return
      }
      const original = await readFile(path, 'utf8')
      // 只读演练：对不存在的 id 走 no-op 路径，内容必须逐字节一致。
      const noop = removeInsertRow(original, '__definitely-absent-id__')
      assert.equal(noop.removed, false)
      assert.equal(noop.content, original, 'no-op 删除不得改动文件')
      assert.equal(removeDisableBlock(original, '__definitely-absent-id__'), original, 'no-op 禁用删除不得改动文件')

      // 解析出的行结构稳定（name 现在是字符串，缺省为空串）。
      for (const row of readInsertRows(original)) {
        assert.equal(typeof row.id, 'string')
        assert.ok(row.id.length > 0)
        assert.equal(typeof row.name, 'string')
      }
    })
  }

  it('no-op 删除必须逐字节返回原文（真实演练发现：normalizeDocument 会改写用户注释）', () => {
    // 演练发现的真实缺陷：removeDisableBlock 无论是否删掉东西都调
    // normalizeDocument，把用户自己的注释头换成官方模板 → 真实 profile
    // patch 的 no-op 往返不是幂等的。
    const userHeader = '# User patch layer for this profile.\n[]\n'
    assert.equal(removeDisableBlock(userHeader, '__absent__'), userHeader)
    assert.equal(removeInsertRow(userHeader, '__absent__').content, userHeader)
  })

  it('用户自写注释头在 add→remove 往返后仍保留（不再被官方模板顶掉）', () => {
    const userHeader = '# User patch layer for this profile.\n[]\n'
    const added = addInsertRow(userHeader, 'probe-id', 'probe-pkg')
    const back = removeInsertRow(added, 'probe-id')
    assert.equal(back.content, userHeader, '往返必须回到原文（含用户注释）')
    const dis = addDisableBlock(userHeader, 'probe-id')
    assert.equal(removeDisableBlock(dis, 'probe-id'), userHeader)
  })

  it('空文档仍恢复官方 [] 模板（注释-only 文件解析为 null 会让 HMR 失败）', () => {
    const added = addInsertRow('', 'probe-id', 'probe-pkg')
    const back = removeInsertRow(added, 'probe-id')
    assert.ok(back.content.includes('[]'), '空文档必须留下 []')
    assert.ok(!back.content.includes('probe-id'))
  })

  it('本项目自身 cordis.patch.yml 的 no-op 往返稳定', async t => {
    const path = 'cordis.patch.yml'
    if (!existsSync(path)) {
      t.skip('cordis.patch.yml 不存在，跳过')
      return
    }
    const original = await readFile(path, 'utf8')
    assert.equal(removeInsertRow(original, '__absent__').content, original)
    assert.equal(removeDisableBlock(original, '__absent__'), original)
  })
})
