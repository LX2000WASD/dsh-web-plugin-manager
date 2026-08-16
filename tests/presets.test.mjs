/**
 * presets.ts 单测（node --test，跑 dist 产物）：
 * 归属标记写入/读取（含生态兼容）、digest 修改检测、清理/归档/恢复、
 * 多 profile 检查、路径守卫。DSH_HOME 隔离到 mkdtemp fixture。
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  OWNER_MARKER, presetDigest, readPresetOwners, presetOwnedBy, scanPresets,
  cleanupOwnedPresets, archiveOwnedPresets, restoreArchivedPresets,
  pluginInstalledInOtherProfiles, writeOwnerMarker, presetArchiveDir,
} from '../dist/presets.js'

let home // fake DSH_HOME
let presetRoot // <home>/.agent-presets

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'dshpm-presets-test-'))
  presetRoot = join(home, '.agent-presets')
  process.env.DSH_HOME = home
  await mkdir(presetRoot, { recursive: true })
  await mkdir(join(home, 'profiles'), { recursive: true })
})

after(async () => {
  delete process.env.DSH_HOME
  await rm(home, { recursive: true, force: true })
})

async function makePreset(id, composition = '---\n- name: p\n') {
  const dir = join(presetRoot, id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'agent.cordis.yml'), composition)
  return dir
}

/** Fake host ctx exposing an agentPresets service that mirrors the host's
 * user-root roster semantics (list user dirs; remove = delete dir). */
function hostCtx(removedCalls = []) {
  const service = {
    async list() {
      const out = []
      for (const name of await readdir(presetRoot)) {
        if (name.startsWith('.')) continue
        out.push({ id: name, path: join(presetRoot, name, 'agent.cordis.yml') })
      }
      return out
    },
    async remove(id) {
      removedCalls.push(id)
      await rm(join(presetRoot, id), { recursive: true, force: true })
    },
  }
  return { get: (name) => (name === 'agentPresets' ? service : undefined), removedCalls }
}

describe('writeOwnerMarker', () => {
  it('writes format/owners/digest and the digest matches presetDigest', async () => {
    const dir = await makePreset('marker-a', '---\n- name: p\n')
    writeOwnerMarker(dir, ['@scope/plug'])
    const record = JSON.parse(await readFile(join(dir, OWNER_MARKER), 'utf8'))
    assert.equal(record.format, 0)
    assert.deepEqual(record.owners, ['@scope/plug'])
    assert.equal(record.digest, presetDigest(dir))
  })
  it('never overwrites an existing marker', async () => {
    const dir = await makePreset('marker-b', '---\n- name: p\n')
    await writeFile(join(dir, OWNER_MARKER), JSON.stringify({ format: 0, owners: ['old-owner'], digest: 'x' }))
    writeOwnerMarker(dir, ['new-owner'])
    const record = JSON.parse(await readFile(join(dir, OWNER_MARKER), 'utf8'))
    assert.deepEqual(record.owners, ['old-owner'])
  })
})

describe('readPresetOwners', () => {
  it('reads the standard marker', async () => {
    const dir = await makePreset('read-std', '---\n- name: p\n')
    writeOwnerMarker(dir, ['pkg-a'])
    assert.deepEqual(readPresetOwners(dir), ['pkg-a'])
  })
  it('reads the gamelike shape (.plugin-manage-owner.json, owners array, no format)', async () => {
    const dir = await makePreset('read-gm', '---\n- name: p\n')
    await writeFile(join(dir, '.plugin-manage-owner.json'), JSON.stringify({ format: 0, owners: ['gm-pkg'] }))
    assert.deepEqual(readPresetOwners(dir), ['gm-pkg'])
  })
  it('reads the dsh-agent-rp shape (.dsh-agent-rp-owner.json, owner string + digest)', async () => {
    const dir = await makePreset('read-rp', '---\n- name: p\n')
    await writeFile(join(dir, '.dsh-agent-rp-owner.json'),
      JSON.stringify({ owner: '@dsh-external/dsh-agent-rp', format: 0, digest: 'abc' }))
    assert.deepEqual(readPresetOwners(dir), ['@dsh-external/dsh-agent-rp'])
  })
  it('fails closed on a corrupt standard marker', async () => {
    const dir = await makePreset('read-bad', '---\n- name: p\n')
    await writeFile(join(dir, OWNER_MARKER), '{not json')
    assert.deepEqual(readPresetOwners(dir), [])
  })
  it('skips a compatible marker with a mismatched format', async () => {
    const dir = await makePreset('read-fmt', '---\n- name: p\n')
    await writeFile(join(dir, '.dsh-agent-rp-owner.json'), JSON.stringify({ owner: 'x', format: 99 }))
    assert.deepEqual(readPresetOwners(dir), [])
  })
})

describe('presetOwnedBy', () => {
  it('owned when sole owner matches and digest matches', async () => {
    const dir = await makePreset('owned-yes', '---\n- name: p\n')
    writeOwnerMarker(dir, ['pkg-x'])
    const verdict = presetOwnedBy(dir, 'pkg-x')
    assert.equal(verdict.owned, true)
    assert.equal(verdict.modified, false)
  })
  it('modified when the composition was edited after install', async () => {
    const dir = await makePreset('owned-edit', '---\n- name: p\n')
    writeOwnerMarker(dir, ['pkg-x'])
    await writeFile(join(dir, 'agent.cordis.yml'), '---\n- name: edited\n')
    const verdict = presetOwnedBy(dir, 'pkg-x')
    assert.equal(verdict.owned, true)
    assert.equal(verdict.modified, true)
  })
  it('not owned with multiple owners (never act on shared presets)', async () => {
    const dir = await makePreset('owned-multi', '---\n- name: p\n')
    await writeFile(join(dir, '.plugin-manage-owner.json'),
      JSON.stringify({ format: 0, owners: ['pkg-x', 'pkg-y'] }))
    assert.equal(presetOwnedBy(dir, 'pkg-x').owned, false)
    assert.equal(presetOwnedBy(dir, 'pkg-y').owned, false)
  })
  it('not owned for a different plugin', async () => {
    const dir = await makePreset('owned-other', '---\n- name: p\n')
    writeOwnerMarker(dir, ['pkg-x'])
    assert.equal(presetOwnedBy(dir, 'pkg-z').owned, false)
  })
  it('unmodified when the marker has no digest (gamelike shape)', async () => {
    const dir = await makePreset('owned-nodigest', '---\n- name: p\n')
    await writeFile(join(dir, '.plugin-manage-owner.json'), JSON.stringify({ format: 0, owners: ['pkg-x'] }))
    await writeFile(join(dir, 'agent.cordis.yml'), '---\n- name: edited\n')
    const verdict = presetOwnedBy(dir, 'pkg-x')
    assert.equal(verdict.owned, true)
    assert.equal(verdict.modified, false)
  })
  it('not owned without any marker (user-authored preset)', async () => {
    const dir = await makePreset('owned-none', '---\n- name: p\n')
    assert.equal(presetOwnedBy(dir, 'pkg-x').owned, false)
  })
})

describe('scanPresets', () => {
  it('lists directories only, skipping dot dirs', async () => {
    await makePreset('scan-a', '---\n- name: p\n')
    await mkdir(join(presetRoot, '.hidden'), { recursive: true })
    await writeFile(join(presetRoot, 'file.yml'), 'x')
    const ids = scanPresets(presetRoot).map(entry => entry.id)
    assert.ok(ids.includes('scan-a'))
    assert.ok(!ids.includes('.hidden'))
    assert.ok(!ids.includes('file.yml'))
  })
})

describe('cleanupOwnedPresets (no host ctx — direct removal)', () => {
  let root2
  before(async () => {
    root2 = join(home, 'presets-clean')
    await mkdir(root2, { recursive: true })
  })
  it('deletes unmodified owned presets, keeps edited / unmarked / multi-owner ones', async () => {
    const clean = join(root2, 'clean-ok')
    await mkdir(clean, { recursive: true })
    await writeFile(join(clean, 'agent.cordis.yml'), '---\n- name: p\n')
    writeOwnerMarker(clean, ['pkg-x'])
    const edited = join(root2, 'clean-edit')
    await mkdir(edited, { recursive: true })
    await writeFile(join(edited, 'agent.cordis.yml'), '---\n- name: p\n')
    writeOwnerMarker(edited, ['pkg-x'])
    await writeFile(join(edited, 'agent.cordis.yml'), '---\n- name: user-edit\n')
    const unmarked = join(root2, 'clean-user')
    await mkdir(unmarked, { recursive: true })
    await writeFile(join(unmarked, 'agent.cordis.yml'), '---\n- name: p\n')
    const multi = join(root2, 'clean-multi')
    await mkdir(multi, { recursive: true })
    await writeFile(join(multi, 'agent.cordis.yml'), '---\n- name: p\n')
    await writeFile(join(multi, '.plugin-manage-owner.json'),
      JSON.stringify({ format: 0, owners: ['pkg-x', 'pkg-y'] }))

    const result = await cleanupOwnedPresets(null, root2, 'pkg-x')
    assert.deepEqual(result.removed, ['clean-ok'])
    const skipped = result.skipped.map(entry => entry.id)
    assert.ok(skipped.includes('clean-edit')) // edited → kept + reported
    // unmarked (user-authored) and multi-owner presets are not owned by
    // pkg-x at all: not removed, not even reported
    assert.ok(!skipped.includes('clean-user'))
    assert.ok(!skipped.includes('clean-multi'))
    // directories that must survive:
    for (const id of ['clean-edit', 'clean-user', 'clean-multi']) {
      await readdir(join(root2, id)) // throws if removed
    }
  })
  it('reports no owned presets when none match', async () => {
    const result = await cleanupOwnedPresets(null, root2, 'pkg-absent')
    assert.deepEqual(result.removed, [])
    assert.deepEqual(result.skipped, [])
  })
})

describe('cleanupOwnedPresets (host ctx — host service removal)', () => {
  let root3
  before(async () => {
    root3 = join(home, 'presets-host')
    await mkdir(root3, { recursive: true })
  })
  it('removes through the service and reports', async () => {
    const dir = join(root3, 'clean-host')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'agent.cordis.yml'), '---\n- name: p\n')
    writeOwnerMarker(dir, ['pkg-h'])
    const service = {
      async list() {
        return [{ id: 'clean-host', path: join(dir, 'agent.cordis.yml') }]
      },
      async remove(id) {
        await rm(join(root3, id), { recursive: true, force: true })
      },
    }
    const removedCalls = []
    const ctx = { get: (name) => (name === 'agentPresets' ? service : undefined) }
    const result = await cleanupOwnedPresets(ctx, root3, 'pkg-h')
    assert.deepEqual(result.removed, ['clean-host'])
  })
})

describe('archive / restore', () => {
  it('archives owned presets on disable (edited ones included) and leaves unmarked alone', async () => {
    const a = await makePreset('arch-a', '---\n- name: p\n')
    writeOwnerMarker(a, ['pkg-arch'])
    const b = await makePreset('arch-b', '---\n- name: p\n')
    writeOwnerMarker(b, ['pkg-arch'])
    await writeFile(join(b, 'agent.cordis.yml'), '---\n- name: user-edit\n')
    await makePreset('arch-user', '---\n- name: p\n')

    const result = archiveOwnedPresets(presetRoot, 'pkg-arch')
    assert.deepEqual([...result.archived].sort(), ['arch-a', 'arch-b'])
    // moved out of the user root, present under the archive dir
    const archiveRoot = presetArchiveDir()
    assert.ok((await readdir(join(archiveRoot, 'arch-a'))).includes('agent.cordis.yml'))
    await readdir(join(presetRoot, 'arch-user')) // untouched
  })
  it('restores archived presets on re-enable and keeps a conflicting new preset', async () => {
    const archiveRoot = presetArchiveDir()
    await mkdir(join(archiveRoot, 'restore-me'), { recursive: true })
    await writeFile(join(archiveRoot, 'restore-me', 'agent.cordis.yml'), '---\n- name: p\n')
    writeOwnerMarker(join(archiveRoot, 'restore-me'), ['pkg-restore'])
    // a same-id preset appeared meanwhile
    await makePreset('restore-me', '---\n- name: p\n')

    const result = restoreArchivedPresets(presetRoot, 'pkg-restore')
    assert.deepEqual(result.restored, [])
    assert.equal(result.skipped.length, 1)
    // the fresh preset wins; the archive copy stays
    assert.ok((await readdir(join(archiveRoot, 'restore-me'))).includes('agent.cordis.yml'))

    // clean conflict away, restore now succeeds
    await rm(join(presetRoot, 'restore-me'), { recursive: true, force: true })
    const again = restoreArchivedPresets(presetRoot, 'pkg-restore')
    assert.deepEqual(again.restored, ['restore-me'])
  })
  it('idempotent: nothing to archive after archiving', async () => {
    const result = archiveOwnedPresets(presetRoot, 'pkg-arch')
    assert.deepEqual(result.archived, [])
  })
})

describe('pluginInstalledInOtherProfiles', () => {
  it('true when another profile manifest still depends on the plugin', async () => {
    await mkdir(join(home, 'profiles', 'other'), { recursive: true })
    await writeFile(join(home, 'profiles', 'other', 'package.json'),
      JSON.stringify({ dependencies: { 'pkg-multi': '^1.0.0' } }))
    assert.equal(pluginInstalledInOtherProfiles('web', 'pkg-multi'), true)
    assert.equal(pluginInstalledInOtherProfiles('web', 'pkg-single'), false)
  })
})

describe('presetDigest', () => {
  it('is stable and changes when the composition changes', async () => {
    const dir = await makePreset('digest-x', '---\n- name: p\n')
    const first = presetDigest(dir)
    const second = presetDigest(dir)
    assert.equal(first, second)
    await writeFile(join(dir, 'agent.cordis.yml'), '---\n- name: q\n')
    assert.notEqual(presetDigest(dir), first)
  })
})
