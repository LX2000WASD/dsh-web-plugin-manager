/**
 * installSession.ts 会话状态机单测（node --test，跑 dist 产物）：
 *   创建/获取/丢弃/TTL 清理 + filterAnswers 白名单校验。
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  createInstallSession, getInstallSession, dropInstallSession,
  filterAnswers, pruneExpiredSessions, sessionCount,
} from '../dist/installSession.js'

const SCANNED = ['OPENAI_API_KEY', 'GITHUB_TOKEN', 'MY_SECRET_PASSWORD']

describe('session lifecycle', () => {
  before(() => { dropInstallSession('spec-a'); dropInstallSession('spec-b') })
  after(() => { dropInstallSession('spec-a'); dropInstallSession('spec-b') })

  it('create → get round-trips the session data', () => {
    createInstallSession('spec-a', '/tmp/repo-a', SCANNED)
    const session = getInstallSession('spec-a')
    assert.equal(session.spec, 'spec-a')
    assert.equal(session.cacheDir, '/tmp/repo-a')
    assert.deepEqual([...session.scanned], SCANNED)
  })
  it('missing session returns undefined', () => {
    assert.equal(getInstallSession('spec-b'), undefined)
  })
  it('re-create overwrites (same spec, latest scan)', () => {
    createInstallSession('spec-a', '/tmp/repo-a2', ['ONLY_ONE'])
    assert.deepEqual([...getInstallSession('spec-a').scanned], ['ONLY_ONE'])
  })
  it('drop removes the session', () => {
    dropInstallSession('spec-a')
    assert.equal(getInstallSession('spec-a'), undefined)
  })
  it('pruneExpiredSessions removes stale sessions', () => {
    createInstallSession('spec-a', '/tmp/a', SCANNED)
    const session = getInstallSession('spec-a')
    // 直接改 createdAt 伪造过期（对象是 live 引用）
    session.createdAt = Date.now() - 20 * 60 * 1000
    pruneExpiredSessions()
    assert.equal(getInstallSession('spec-a'), undefined)
  })
  it('sessionCount reflects live sessions', () => {
    const before = sessionCount()
    createInstallSession('spec-b', '/tmp/b', SCANNED)
    assert.equal(sessionCount(), before + 1)
    dropInstallSession('spec-b')
    assert.equal(sessionCount(), before)
  })
})

describe('filterAnswers (whitelist validation)', () => {
  const session = { spec: 's', cacheDir: '/tmp/s', scanned: SCANNED, createdAt: Date.now() }

  it('injects whitelisted keys', () => {
    const out = filterAnswers(session.scanned, { OPENAI_API_KEY: 'sk-123' })
    assert.deepEqual(out, { OPENAI_API_KEY: 'sk-123' })
  })
  it('empty value = skip (not injected)', () => {
    const out = filterAnswers(session.scanned, { GITHUB_TOKEN: '' })
    assert.deepEqual(out, {})
  })
  it('rejects non-whitelisted keys (PATH/HOME injection)', () => {
    const out = filterAnswers(session.scanned, { PATH: '/evil', HOME: '/evil' })
    assert.deepEqual(out, {})
  })
  it('rejects __ internal keys', () => {
    const out = filterAnswers(session.scanned, { OPENAI_API_KEY: 'k', '__confirm_script__': 'continue' })
    assert.deepEqual(out, { OPENAI_API_KEY: 'k' })
  })
  it('rejects non-string values', () => {
    const out = filterAnswers(session.scanned, { OPENAI_API_KEY: 42 })
    assert.deepEqual(out, {})
  })
  it('undefined answers → {}', () => {
    assert.deepEqual(filterAnswers(session.scanned, undefined), {})
  })
})