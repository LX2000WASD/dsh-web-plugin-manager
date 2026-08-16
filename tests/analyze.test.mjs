/**
 * analyze.ts official-duplicate 豁免单测（node --test，跑 dist 产物）。
 * fixture：tmp/profiles/{node_modules,test} 双层布局，验证
 * @deepseek-ai/schemastery 作为普通依赖不再误报，而 cordis 等仍被拦截。
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { analyzeProfile, OFFICIAL_DEP_ALLOWED } from '../dist/analyze.js'

let fixture
let profileDir

/** Write one package.json at the given path (creating parents). */
async function writePkg(dir, manifest) {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'package.json'), JSON.stringify(manifest))
}

before(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'dshpm-analyze-test-'))
  // 安装兜底层：profiles/node_modules（dirname(profileDir)/node_modules）
  await writePkg(join(fixture, 'profiles', 'node_modules', '@deepseek-ai', 'schemastery'),
    { name: '@deepseek-ai/schemastery', version: '3.18.1' })
  await writePkg(join(fixture, 'profiles', 'node_modules', '@deepseek-ai', 'cordis'),
    { name: '@deepseek-ai/cordis', version: '4.0.1' })
  // profile 层：test profile，安装了一个插件 p1 与两份官方拷贝
  profileDir = join(fixture, 'profiles', 'test')
  await writePkg(profileDir, { name: 'dsh-profile-test', private: true, dependencies: { p1: '1.0.0' } })
  await writePkg(join(profileDir, 'node_modules', '@deepseek-ai', 'schemastery'),
    { name: '@deepseek-ai/schemastery', version: '3.18.1' })
  await writePkg(join(profileDir, 'node_modules', '@deepseek-ai', 'cordis'),
    { name: '@deepseek-ai/cordis', version: '4.0.1' })
  // p1 声明 schemastery（豁免）与 cordis（peer-only）为普通依赖
  await writePkg(join(profileDir, 'node_modules', 'p1'), {
    name: 'p1',
    version: '1.0.0',
    dependencies: { '@deepseek-ai/schemastery': '^3.18.1', '@deepseek-ai/cordis': '^4.0.1' },
  })
})

after(async () => {
  await rm(fixture, { recursive: true, force: true })
})

describe('official-duplicate 豁免', () => {
  it('schemastery 在豁免名单中', () => {
    assert.ok(OFFICIAL_DEP_ALLOWED.has('@deepseek-ai/schemastery'))
  })

  it('schemastery 作为普通依赖不再报 official-duplicate', () => {
    const result = analyzeProfile(profileDir, [], '[]', new Set())
    const official = result.issues.filter(issue => issue.kind === 'official-duplicate')
    assert.ok(!official.some(issue => issue.to === '@deepseek-ai/schemastery'),
      'schemastery 不应被报为 official-duplicate: ' + JSON.stringify(official))
  })

  it('cordis 作为普通依赖仍报 official-duplicate', () => {
    const result = analyzeProfile(profileDir, [], '[]', new Set())
    const official = result.issues.filter(issue => issue.kind === 'official-duplicate')
    assert.ok(official.some(issue => issue.to === '@deepseek-ai/cordis'),
      'cordis 仍应被报为 official-duplicate: ' + JSON.stringify(official))
  })
})