/**
 * updateSpec 构造单测（node --test，跑 dist 产物）：
 *   @latest 依赖 pnpm 对 dist-tag 的解析，在 pnpm 11 minimumReleaseAge
 *   （默认 24h 扣留新版本）或镜像 dist-tag 滞后时会解析到旧版或停在现有
 *   范围，update 显式钉住版本号即可绕过；updateSpec 是 updateProtectedInner
 *   的 spec 构造逻辑（src/match.ts）。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { updateSpec } from '../dist/match.js'

describe('updateSpec', () => {
  it('pins the explicit latest version for npm sources', () => {
    assert.equal(updateSpec('^1.2.2', 'dsh-vision-router', '1.4.3'), 'dsh-vision-router@1.4.3')
  })
  it('falls back to @latest when the version cannot be resolved', () => {
    assert.equal(updateSpec('^1.2.2', 'dsh-vision-router', undefined), 'dsh-vision-router@latest')
  })
  it('keeps git-URL sources verbatim', () => {
    assert.equal(updateSpec('github:ysr666/dsh-vision-router', 'dsh-vision-router', '1.4.3'), 'github:ysr666/dsh-vision-router')
  })
})
