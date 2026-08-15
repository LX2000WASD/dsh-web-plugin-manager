/**
 * scan.ts 纯函数单测（node --test，跑 dist 产物）：
 *   isSensitiveEnvKey / buildFilteredEnv / scanRequirements（fixture 目录）。
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isSensitiveEnvKey, buildFilteredEnv, scanRequirements } from '../dist/scan.js'

describe('isSensitiveEnvKey', () => {
  it('matches token/key/secret/password/pass/credential', () => {
    assert.equal(isSensitiveEnvKey('GITHUB_TOKEN'), true)
    assert.equal(isSensitiveEnvKey('OPENAI_API_KEY'), true)
    assert.equal(isSensitiveEnvKey('DB_PASSWORD'), true)
    assert.equal(isSensitiveEnvKey('MY_API_SECRET'), true)
    assert.equal(isSensitiveEnvKey('FTP_PASS'), true)
    assert.equal(isSensitiveEnvKey('credentials'), true)
  })
  it('suffix matching is case-insensitive', () => {
    assert.equal(isSensitiveEnvKey('github_token'), true)
    assert.equal(isSensitiveEnvKey('DB_password'), true)
  })
  it('camelCase-prefixed names are NOT filtered (deliberate: the lookbehind that excludes MONKEY also excludes myApiToken; host env keys are SCREAMING_SNAKE/lowercase in practice)', () => {
    assert.equal(isSensitiveEnvKey('GithubToken'), false)
    assert.equal(isSensitiveEnvKey('myApiToken'), false)
  })
  it('does not false-positive on boundary-adjacent words', () => {
    assert.equal(isSensitiveEnvKey('KEYBOARD_LAYOUT'), false)
    assert.equal(isSensitiveEnvKey('MONKEY'), false)
    assert.equal(isSensitiveEnvKey('PASSWORDLESS_MODE'), false)
  })
  it('does not false-positive on ordinary vars', () => {
    assert.equal(isSensitiveEnvKey('PATH'), false)
    assert.equal(isSensitiveEnvKey('HOME'), false)
    assert.equal(isSensitiveEnvKey('NODE_ENV'), false)
  })
})

describe('buildFilteredEnv', () => {
  it('strips sensitive keys, keeps the rest', () => {
    const out = buildFilteredEnv({
      GITHUB_TOKEN: 'ghp_x', OPENAI_API_KEY: 'sk-x', PATH: '/usr/bin',
      NODE_ENV: 'dev', KEYBOARD_LAYOUT: 'us',
    })
    assert.deepEqual(out, { PATH: '/usr/bin', NODE_ENV: 'dev', KEYBOARD_LAYOUT: 'us' })
  })
  it('defaults to process.env', () => {
    const out = buildFilteredEnv()
    assert.equal(out.PATH, process.env.PATH)
    assert.equal(out.NODE_ENV, process.env.NODE_ENV)
  })
})

describe('scanRequirements', () => {
  let fixture
  before(async () => {
    fixture = await mkdtemp(join(tmpdir(), 'dshpm-scan-test-'))
    // 根 README 两个变量 + 子目录 .env.example 一个变量 + 普通配置（应被忽略）
    await writeFile(join(fixture, 'README.md'),
      'Needs OPENAI_API_KEY and GITHUB_TOKEN at install time. PORT=8080 default.\n')
    await mkdir(join(fixture, 'sub'), { recursive: true })
    await writeFile(join(fixture, 'sub', '.env.example'), 'MY_SECRET_PASSWORD=xxx\n')
    // 噪声目录必须被跳过
    await mkdir(join(fixture, 'node_modules', 'pkg'), { recursive: true })
    await writeFile(join(fixture, 'node_modules', 'pkg', 'README.md'), 'NEEDS_LEAKED_TOKEN=1\n')
    await mkdir(join(fixture, '.git'), { recursive: true })
    await writeFile(join(fixture, '.git', 'config'), 'TOKEN=1\n')
  })
  after(async () => {
    await rm(fixture, { recursive: true, force: true })
  })

  it('finds sensitive-shaped vars across 2 levels, dedupes', async () => {
    const vars = await scanRequirements(fixture)
    assert.deepEqual([...vars].sort(), ['GITHUB_TOKEN', 'MY_SECRET_PASSWORD', 'OPENAI_API_KEY'])
  })
  it('excludes ordinary config vars (PORT)', async () => {
    const vars = await scanRequirements(fixture)
    assert.equal(vars.includes('PORT'), false)
  })
  it('skips node_modules and dot dirs', async () => {
    const vars = await scanRequirements(fixture)
    assert.equal(vars.includes('NEEDS_LEAKED_TOKEN'), false)
    assert.equal(vars.includes('TOKEN'), false)
  })
  it('caps the result at 8 vars', async () => {
    const many = await mkdtemp(join(tmpdir(), 'dshpm-scan-many-'))
    const names = Array.from({ length: 12 }, (_, i) => 'VAR' + i + '_API_KEY')
    await writeFile(join(many, 'README.md'), names.join(' ') + '\n')
    const vars = await scanRequirements(many)
    assert.ok(vars.length <= 8)
    await rm(many, { recursive: true, force: true })
  })
  it('returns [] for an empty/missing directory', async () => {
    assert.deepEqual(await scanRequirements(join(fixture, 'does-not-exist')), [])
  })
})
