/**
 * git-source install 协议化单测（node --test，跑 dist 产物）：
 * toGitSpec（git URL → pnpm git 协议）与 gitCommitFromLock（从 pnpm-lock
 * 提取 git 依赖当前 commit，供更新回滚）。
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { toGitSpec, gitCommitFromLock } from '../dist/index.js'

describe('toGitSpec', () => {
  it('github https URL → github:owner/repo', () => {
    assert.equal(toGitSpec('https://github.com/Zephyr-vibe/dsh-archived-sessions'),
      'github:Zephyr-vibe/dsh-archived-sessions')
  })
  it('github .git suffix is dropped', () => {
    assert.equal(toGitSpec('https://github.com/owner/repo.git'), 'github:owner/repo')
  })
  it('keeps a #ref fragment', () => {
    assert.equal(toGitSpec('https://github.com/owner/repo', 'main'), 'github:owner/repo#main')
  })
  it('non-github URLs pass through verbatim (pnpm accepts https git URLs)', () => {
    assert.equal(toGitSpec('https://gitlab.com/owner/repo'), 'https://gitlab.com/owner/repo')
    assert.equal(toGitSpec('https://git.example.com/a/b.git', 'v1'), 'https://git.example.com/a/b.git#v1')
  })
  it('no ref → no fragment', () => {
    assert.equal(toGitSpec('https://github.com/owner/repo'), 'github:owner/repo')
    assert.ok(!toGitSpec('https://github.com/owner/repo').includes('#'))
  })
})

describe('gitCommitFromLock', () => {
  let fixture
  let profileDir
  before(async () => {
    fixture = await mkdtemp(join(tmpdir(), 'dshpm-gitsrc-test-'))
    process.env.DSH_HOME = fixture
    profileDir = join(fixture, 'profiles', 'test')
    await mkdir(profileDir, { recursive: true })
    await writeFile(join(profileDir, 'package.json'), JSON.stringify({ name: 'p' }))
    await writeFile(join(profileDir, 'pnpm-lock.yaml'), [
      "lockfileVersion: '9.0'",
      '',
      'importers:',
      '',
      '  .:',
      '    dependencies:',
      '      dsh-archived-sessions:',
      '        specifier: github:Zephyr-vibe/dsh-archived-sessions',
      "        version: https://codeload.github.com/Zephyr-vibe/dsh-archived-sessions/tar.gz/9f3c2a1b0d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a",
      '',
      'packages:',
      '',
      "  dsh-archived-sessions@https://codeload.github.com/Zephyr-vibe/dsh-archived-sessions/tar.gz/9f3c2a1b0d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a:",
      '    resolution: {tarball: https://codeload.github.com/Zephyr-vibe/dsh-archived-sessions/tar.gz/9f3c2a1b0d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a}',
      '    version: 0.1.0',
      '',
      "  '@scope/pkg@https://codeload.github.com/owner/scoped/tar.gz/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa':",
      '    resolution: {tarball: https://codeload.github.com/owner/scoped/tar.gz/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa}',
      '',
      'snapshots:',
      '',
      "  dsh-archived-sessions@https://codeload.github.com/Zephyr-vibe/dsh-archived-sessions/tar.gz/9f3c2a1b0d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a:",
      '    dependencies:',
      "      '@deepseek-ai/schemastery': '3.18.1'",
      '',
    ].join('\n'))
  })
  after(async () => {
    delete process.env.DSH_HOME
    await rm(fixture, { recursive: true, force: true })
  })

  it('extracts the commit from the lockfile packages entry', () => {
    assert.equal(gitCommitFromLock('test', 'dsh-archived-sessions'),
      '9f3c2a1b0d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a')
  })
  it('resolves scoped package names', () => {
    assert.equal(gitCommitFromLock('test', '@scope/pkg'),
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
  })
  it('returns undefined for unknown packages', () => {
    assert.equal(gitCommitFromLock('test', 'no-such-package'), undefined)
  })
  it('returns undefined without a lockfile', () => {
    assert.equal(gitCommitFromLock('no-such-profile', 'x'), undefined)
  })
})
