/**
 * Controlled editing of a profile's cordis.patch.yml.
 *
 * The manager never rewrites the whole file (that would destroy user
 * comments and hand-written rows). It appends/removes a single marked block
 * per entry id, using line markers that make every edit reversible and
 * reviewable:
 *
 *   # dsh-plugin-manager:managed:start
 *   - id: <entryId>
 *     disabled: true
 *   # dsh-plugin-manager:managed:end
 *
 * The block is a plain id-targeted patch row: it replaces the targeted row's
 * whole config with `disabled: true`, exactly the Loader's disable contract.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'

/** Marker lines delimiting one managed block. */
const START = '# dsh-plugin-manager:managed:start'
const END = '# dsh-plugin-manager:managed:end'

/** Validate an entry id so it cannot break the YAML block structure. */
export function assertSafeEntryId(id: string): void {
  if (!/^[A-Za-z0-9._/-]+$/.test(id) || id.length > 120) {
    throw new Error(`unsafe entry id: ${JSON.stringify(id)}`)
  }
}

/** Whether a patch file already manages the given entry id. */
export function hasManagedDisable(patchPath: string, entryId: string): boolean {
  if (!existsSync(patchPath)) return false
  const lines = readFileSync(patchPath, 'utf8').split('\n')
  let inManaged = false
  for (const line of lines) {
    if (line.trimEnd() === START) { inManaged = true; continue }
    if (line.trimEnd() === END) { inManaged = false; continue }
    if (inManaged) {
      const match = /^\s*-\s*id:\s*(.+?)\s*$/.exec(line)
      if (match !== null && match[1] === entryId) return true
    }
  }
  return false
}

/**
 * Add (or refresh) the disable block for one entry id. Returns the new file
 * content; the caller persists it.
 */
export function addDisableBlock(content: string, entryId: string): string {
  assertSafeEntryId(entryId)
  const lines = content.length === 0 ? [] : content.split('\n')
  // Remove any existing managed block for this id first (refresh in place).
  const without = removeManagedBlocks(lines, entryId)
  const block = [
    START,
    `- id: ${entryId}`,
    '  disabled: true',
    END,
  ]
  // Keep the file's trailing newline convention: join with \n and ensure one.
  const joined = [...without, ...block].join('\n')
  return joined.endsWith('\n') ? joined : joined + '\n'
}

/** Remove the disable block for one entry id. Returns new content. */
export function removeDisableBlock(content: string, entryId: string): string {
  assertSafeEntryId(entryId)
  const lines = content.length === 0 ? [] : content.split('\n')
  const without = removeManagedBlocks(lines, entryId)
  return without.join('\n') + '\n'
}

/** Drop every managed block whose row id equals `entryId`. */
function removeManagedBlocks(lines: readonly string[], entryId: string): string[] {
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (line.trimEnd() === START) {
      // Scan the block body for its row id.
      let j = i + 1
      let blockId: string | undefined
      while (j < lines.length && lines[j]!.trimEnd() !== END) {
        const match = /^\s*-\s*id:\s*(.+?)\s*$/.exec(lines[j]!)
        if (match !== null) blockId = match[1]
        j += 1
      }
      if (j >= lines.length) break // unterminated marker: stop, keep the rest
      if (blockId === entryId) {
        i = j + 1 // skip the whole block
        continue
      }
      out.push(...lines.slice(i, j + 1))
      i = j + 1
      continue
    }
    out.push(line)
    i += 1
  }
  return out
}

/** Persist new content with an atomic write. */
export function writePatch(patchPath: string, content: string): void {
  const tmp = patchPath + '.tmp'
  writeFileSync(tmp, content, 'utf8')
  writeFileSync(patchPath, content, 'utf8')
  try { readFileSync(tmp, 'utf8') } finally { /* tmp left for review */ }
}
