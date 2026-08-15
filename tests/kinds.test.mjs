/**
 * kinds.ts 纯函数/目录检测单测（node --test，跑 dist 产物）。
 * 目录级用例用 mkdtemp fixture（检测函数只读文件系统，无网络）。
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  slugDirName, normalizeRepoRef, looksLikeDshPlugin, isUnderRoot,
  findSkillRoots, findPresetRoots, detectRepoType,
} from '../dist/kinds.js'

let fixture

before(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'dshpm-kinds-test-'))

  // 1. agent-preset 仓库（根 agent.cordis.yml）
  await mkdir(join(fixture, 'preset-repo'), { recursive: true })
  await writeFile(join(fixture, 'preset-repo', 'agent.cordis.yml'), '---\n')

  // 2. cordis-plugin 仓库（dsh 字段）
  await mkdir(join(fixture, 'plugin-repo'), { recursive: true })
  await writeFile(join(fixture, 'plugin-repo', 'package.json'), JSON.stringify({ name: 'p', dsh: { client: true } }))

  // 3. cordis-plugin 通过依赖 @deepseek-ai/cordis
  await mkdir(join(fixture, 'plugin-deps-repo'), { recursive: true })
  await writeFile(join(fixture, 'plugin-deps-repo', 'package.json'),
    JSON.stringify({ name: 'q', dependencies: { '@deepseek-ai/cordis': '^4.0.1' } }))

  // 4. 纯 skill 仓库（根 SKILL.md）
  await mkdir(join(fixture, 'skill-repo'), { recursive: true })
  await writeFile(join(fixture, 'skill-repo', 'SKILL.md'), '---\nname: my-skill\n---\nbody\n')

  // 5. skill + 工具链 package.json（非 DSH 插件）→ 仍是 skill
  await mkdir(join(fixture, 'skill-toolchain'), { recursive: true })
  await writeFile(join(fixture, 'skill-toolchain', 'package.json'), JSON.stringify({ name: 'toolchain', scripts: {} }))
  await writeFile(join(fixture, 'skill-toolchain', 'SKILL.md'), '---\nname: tool-skill\n---\nbody\n')

  // 6. 非插件 package.json（聚合页）→ instructions
  await mkdir(join(fixture, 'aggregate-repo'), { recursive: true })
  await writeFile(join(fixture, 'aggregate-repo', 'package.json'), JSON.stringify({ name: 'aggregate' }))

  // 7. 嵌套 skill 集合：子目录含 SKILL.md
  await mkdir(join(fixture, 'skill-set', 'sub-skill'), { recursive: true })
  await writeFile(join(fixture, 'skill-set', 'sub-skill', 'SKILL.md'), '---\nname: sub-skill\n---\nbody\n')

  // 8. 空目录
  await mkdir(join(fixture, 'empty-repo'), { recursive: true })
})

after(async () => {
  await rm(fixture, { recursive: true, force: true })
})

describe('slugDirName', () => {
  it('lowercases and joins separators', () => {
    assert.equal(slugDirName('Hello World!'), 'hello-world')
    assert.equal(slugDirName('  spaced  name  '), 'spaced-name')
  })
  it('falls back to plugin for empty/symbol-only input', () => {
    assert.equal(slugDirName('!!!'), 'plugin')
    assert.equal(slugDirName(''), 'plugin')
  })
})

describe('normalizeRepoRef', () => {
  it('normalizes URL forms to owner/repo', () => {
    assert.equal(normalizeRepoRef('https://github.com/Owner/Repo'), 'owner/repo')
    assert.equal(normalizeRepoRef('https://github.com/owner/repo.git'), 'owner/repo')
    assert.equal(normalizeRepoRef('git+https://github.com/owner/repo'), 'owner/repo')
    assert.equal(normalizeRepoRef('git@github.com:owner/repo.git'), 'owner/repo')
    assert.equal(normalizeRepoRef('github:owner/repo'), 'owner/repo')
    assert.equal(normalizeRepoRef('owner/Repo#ref'), 'owner/repo')
  })
  it('returns null for empty input', () => {
    assert.equal(normalizeRepoRef('   '), null)
  })
})

describe('looksLikeDshPlugin', () => {
  it('true for dsh field', () => {
    assert.equal(looksLikeDshPlugin({ dsh: {} }), true)
  })
  it('true for @deepseek-ai/cordis dependency', () => {
    assert.equal(looksLikeDshPlugin({ dependencies: { '@deepseek-ai/cordis': '^4' } }), true)
  })
  it('true for @deepseek-ai/dsh-* dependency', () => {
    assert.equal(looksLikeDshPlugin({ peerDependencies: { '@deepseek-ai/dsh-tools': '^0.1' } }), true)
  })
  it('false for plain npm projects', () => {
    assert.equal(looksLikeDshPlugin({ name: 'x', scripts: {} }), false)
  })
  it('null for non-object', () => {
    assert.equal(looksLikeDshPlugin(null), null)
    assert.equal(looksLikeDshPlugin(undefined), null)
  })
})

describe('isUnderRoot', () => {
  it('true inside the root', () => {
    assert.equal(isUnderRoot(join(fixture, 'a', 'b'), fixture), true)
  })
  it('false for the root itself (needs a separator boundary)', () => {
    assert.equal(isUnderRoot(fixture, fixture), false)
  })
  it('false for siblings and prefix look-alikes', () => {
    assert.equal(isUnderRoot(join(fixture, '..', 'other'), fixture), false)
    const root2 = fixture + '-x'
    assert.equal(isUnderRoot(root2, fixture), false)
  })
})

describe('findSkillRoots / findPresetRoots', () => {
  it('finds nested skill roots', () => {
    const roots = findSkillRoots(join(fixture, 'skill-set'), 5, 50)
    assert.equal(roots.length, 1)
    assert.equal(roots[0].endsWith('sub-skill'), true)
  })
  it('skips node_modules and dot dirs', async () => {
    await mkdir(join(fixture, 'skill-set', 'node_modules', 'fake'), { recursive: true })
    await writeFile(join(fixture, 'skill-set', 'node_modules', 'fake', 'SKILL.md'), 'x')
    const roots = findSkillRoots(join(fixture, 'skill-set'), 5, 50)
    assert.equal(roots.length, 1)
  })
  it('finds preset roots', () => {
    assert.equal(findPresetRoots(join(fixture, 'preset-repo'), 0, 1).length, 1)
  })
})

describe('detectRepoType (layered)', () => {
  it('root preset → agent-preset', () => {
    assert.equal(detectRepoType(join(fixture, 'preset-repo')), 'agent-preset')
  })
  it('dsh-field plugin → cordis-plugin', () => {
    assert.equal(detectRepoType(join(fixture, 'plugin-repo')), 'cordis-plugin')
  })
  it('cordis dependency plugin → cordis-plugin', () => {
    assert.equal(detectRepoType(join(fixture, 'plugin-deps-repo')), 'cordis-plugin')
  })
  it('pure skill root → skill', () => {
    assert.equal(detectRepoType(join(fixture, 'skill-repo')), 'skill')
  })
  it('tool-chain package.json on a skill repo stays skill', () => {
    assert.equal(detectRepoType(join(fixture, 'skill-toolchain')), 'skill')
  })
  it('non-plugin package.json → instructions (not force-installed)', () => {
    assert.equal(detectRepoType(join(fixture, 'aggregate-repo')), 'instructions')
  })
  it('nested skill collection → skill', () => {
    assert.equal(detectRepoType(join(fixture, 'skill-set')), 'skill')
  })
  it('empty repo → instructions', () => {
    assert.equal(detectRepoType(join(fixture, 'empty-repo')), 'instructions')
  })
})
