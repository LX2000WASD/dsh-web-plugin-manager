/**
 * rest.ts 信任围栏与请求体读取单测（node --test，跑 dist 产物）。
 * 回归覆盖 issue #11：非 HTTP 载体（桌面壳 app:// 分发 / carrier shim）下
 * 空 Host 请求被 403、无 stream 接口的请求体被 400 的两条断链。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { isTrustedRequest, readJsonBody } from '../dist/rest.js'

describe('isTrustedRequest — web 模式（HTTP 面）', () => {
  it('accepts loopback Host', () => {
    assert.equal(isTrustedRequest({ headers: { host: '127.0.0.1:3080' } }), true)
    assert.equal(isTrustedRequest({ headers: { host: '[::1]:3080' } }), true)
    assert.equal(isTrustedRequest({ headers: { host: 'localhost' } }), true)
  })

  it('accepts loopback Host with a same-origin Origin', () => {
    const req = { headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' } }
    assert.equal(isTrustedRequest(req), true)
  })

  it('refuses a non-loopback Host outside the trusted-host env', () => {
    assert.equal(isTrustedRequest({ headers: { host: 'evil.example' } }), false)
    assert.equal(isTrustedRequest({ headers: { host: '127.0.0.1.evil.example:3080' } }), false)
  })

  it('honors DSH_PLUGIN_MANAGER_TRUSTED_HOSTS', async () => {
    process.env.DSH_PLUGIN_MANAGER_TRUSTED_HOSTS = 'lan.example, 10.0.0.8'
    try {
      assert.equal(isTrustedRequest({ headers: { host: 'lan.example:8080' } }), true)
      assert.equal(isTrustedRequest({ headers: { host: '10.0.0.8' } }), true)
      assert.equal(isTrustedRequest({ headers: { host: 'other.example' } }), false)
    } finally {
      delete process.env.DSH_PLUGIN_MANAGER_TRUSTED_HOSTS
    }
  })

  it('refuses cross-site fetch and foreign Origin', () => {
    const crossSite = { headers: { host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' } }
    assert.equal(isTrustedRequest(crossSite), false)
    const foreign = { headers: { host: '127.0.0.1:3080', origin: 'http://evil.example' } }
    assert.equal(isTrustedRequest(foreign), false)
    const badPort = { headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:9999' } }
    assert.equal(isTrustedRequest(badPort), false)
    assert.equal(isTrustedRequest({ headers: { host: '127.0.0.1:3080', origin: 'null' } }), false)
  })
})

describe('isTrustedRequest — 非 HTTP 载体（issue #11）', () => {
  it('accepts a Host-less request without browser markers (desktop carrier shape)', () => {
    const carrier = {
      headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0 ...' },
    }
    assert.equal(isTrustedRequest(carrier), true)
  })

  it('refuses a Host-less request carrying an Origin', () => {
    assert.equal(isTrustedRequest({ headers: { origin: 'http://evil.example' } }), false)
    assert.equal(isTrustedRequest({ headers: { origin: 'null' } }), false)
  })

  it('refuses a Host-less request labeled cross-site', () => {
    assert.equal(isTrustedRequest({ headers: { 'sec-fetch-site': 'cross-site' } }), false)
  })

  it('keeps accepting trusted-env-free Host-less calls regardless of the env', () => {
    process.env.DSH_PLUGIN_MANAGER_TRUSTED_HOSTS = 'any.example'
    try {
      assert.equal(isTrustedRequest({ headers: { 'sec-fetch-site': 'none' } }), true)
    } finally {
      delete process.env.DSH_PLUGIN_MANAGER_TRUSTED_HOSTS
    }
  })
})

describe('readJsonBody — 请求体读取（issue #11）', () => {
  it('reads node stream bodies (official web server)', async () => {
    const req = new Readable()
    req.push(JSON.stringify({ profile: 'web' }))
    req.push(null)
    assert.deepEqual(await readJsonBody(req), { profile: 'web' })
  })

  it('reads fetch-style text() bodies', async () => {
    const req = { text: async () => JSON.stringify({ profile: 'web', op: 'list' }) }
    assert.deepEqual(await readJsonBody(req), { profile: 'web', op: 'list' })
  })

  it('reads fetch-style json() bodies', async () => {
    const req = { json: async () => ({ profile: 'web' }) }
    assert.deepEqual(await readJsonBody(req), { profile: 'web' })
  })

  it('reads a string body property', async () => {
    const req = { body: JSON.stringify({ profile: 'web' }) }
    assert.deepEqual(await readJsonBody(req), { profile: 'web' })
  })

  it('resolves {} for a bare carrier shim with no body channel', async () => {
    const shim = { method: 'POST', url: '/api2/plugin-manager/marketplace', headers: {} }
    assert.deepEqual(await readJsonBody(shim), {})
    assert.deepEqual(await readJsonBody(undefined), {})
    assert.deepEqual(await readJsonBody(null), {})
  })

  it('rejects oversized stream bodies and malformed JSON', async () => {
    const big = new Readable()
    big.push('x'.repeat(1_000_001))
    big.push(null)
    await assert.rejects(readJsonBody(big), /request body too large/)

    const bad = new Readable()
    bad.push('{not json')
    bad.push(null)
    await assert.rejects(readJsonBody(bad), SyntaxError)
  })
})
