/**
 * patch.ts managed-block 单测（node --test，跑 dist 产物）。
 * 回归覆盖 issue #2 的 Bug B（scanBlock 不识别禁用块 → removeDisableBlock
 * 静默失效）与 Bug C 依赖的块语义（managed 禁用块不是用户行）。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { addDisableBlock, removeDisableBlock, readInsertRows, readManagedIds } from '../dist/patch.js'

describe('managed disable blocks (issue #2 Bug B/C)', () => {
  it('addDisableBlock writes a recognizable disable block', () => {
    const out = addDisableBlock('', 'my-plugin')
    assert.ok(out.includes('- id: my-plugin'))
    assert.ok(out.includes('disabled: true'))
    // The block must be removable: scanBlock must tag it as a disable block.
    // (An emptied patch normalizes back to the default template — assert by
    // absence of the managed markers and the id.)
    const after = removeDisableBlock(out, 'my-plugin')
    assert.ok(!after.includes('my-plugin'))
    assert.ok(!after.includes('managed:start'))
  })

  it('removeDisableBlock removes only the targeted id', () => {
    let content = addDisableBlock('', 'alpha')
    content = addDisableBlock(content, 'beta')
    const after = removeDisableBlock(content, 'alpha')
    assert.ok(after.includes('beta'))
    assert.ok(!after.includes('alpha'))
    const final = removeDisableBlock(after, 'beta')
    assert.ok(!final.includes('beta'))
    assert.ok(!final.includes('managed:start'))
  })

  it('disable-block id is NOT reported as an insert row', () => {
    const content = addDisableBlock('', 'my-plugin')
    const rows = readInsertRows(content)
    assert.equal(rows.some(row => row.id === 'my-plugin'), false)
  })

  it('readManagedIds includes the managed disable id (that is the Bug C premise)', () => {
    const content = addDisableBlock('', 'my-plugin')
    assert.equal(readManagedIds(content).has('my-plugin'), true)
  })

  it('insert blocks are unaffected by removeDisableBlock', () => {
    // A patch with both an insert block and a disable block for DIFFERENT ids.
    const withInsert = '\n# --- plugin-manager-managed start ---\ninsert:\n  - id: live-a\n    name: pkg-a\n# --- plugin-manager-managed end ---'
    const content = addDisableBlock(withInsert, 'dead-b')
    const after = removeDisableBlock(content, 'dead-b')
    assert.ok(after.includes('live-a'))
    assert.ok(after.includes('pkg-a'))
    assert.ok(!after.includes('dead-b'))
  })

  it('removeDisableBlock on a clean patch is a no-op', () => {
    const patch = '- id: user-row\n  disabled: true\n'
    assert.equal(removeDisableBlock(patch, 'user-row'), patch)
  })

  it('normalizeDocument preserves blank lines inside user block scalars (audit M11)', () => {
    const patch = [
      '# dsh-plugin-manager:managed:start',
      '- id: dead',
      '  disabled: true',
      '# dsh-plugin-manager:managed:end',
      '',
      '- id: user-row',
      '  config:',
      '    note: |',
      '      line one',
      '',
      '      line two',
      '',
    ].join('\n')
    const after = removeDisableBlock(patch, 'dead')
    // The block scalar's inner blank line must survive the removal.
    assert.ok(after.includes('line one\n\n      line two'))
    assert.ok(after.includes('user-row'))
    assert.ok(!after.includes('dead'))
  })
})
