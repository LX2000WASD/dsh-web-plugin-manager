/**
 * updateSpec 构造单测（node --test，跑 dist 产物）：
 *   pnpm add <name>@latest 在 manifest 已声明该包范围时不会真正升级
 *   （输出 "Already up to date"），update 必须显式钉住版本号；
 *   updateSpec 是 updateProtectedInner 的 spec 构造逻辑（src/index.ts）。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { updateSpec } from '../dist/index.js'

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
