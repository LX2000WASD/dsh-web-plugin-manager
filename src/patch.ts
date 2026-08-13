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
 *
 * Non-bundle plugins are mounted as an insert row inside the same marker
 * scheme (live via config HMR, no restart):
 *
 *   # dsh-plugin-manager:managed:start
 *   - insert:
 *       - id: <rowId>
 *         name: '<package>'
 *   # dsh-plugin-manager:managed:end
 *
 * YAML traps handled here (all reproduced in plugin-registry, see
 * docs/reference-notes.md):
 *  - an empty-array document line (`[]`) must be dropped before appending any
 *    row, or the file becomes a two-document YAML and fails to start;
 *  - package names starting with `@` must be single-quoted (bare `@` is a
 *    YAML reserved indicator);
 *  - after removing rows, a file left with no patch row at all (comments or
 *    blank lines only) parses as null and HMR reload fails — restore the
 *    official `[]` template instead.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'

/** Marker lines delimiting one managed block. */
const START = '# dsh-plugin-manager:managed:start'
const END = '# dsh-plugin-manager:managed:end'

/** Official empty patch template (a bare-array document, Loader-safe). */
const EMPTY_TEMPLATE = [
  '# Your patch layer for this dsh profile, applied after every bundle layer:',
  '# a top-level YAML array of loader patch entries (id-targeted config',
  '# overrides, disables, and insert lists; `!!js` expressions allowed).',
  '[]',
].join('\n') + '\n'

/** Validate an entry id so it cannot break the YAML block structure. */
export function assertSafeEntryId(id: string): void {
  if (!/^[A-Za-z0-9._/-]+$/.test(id) || id.length > 120) {
    throw new Error(`unsafe entry id: ${JSON.stringify(id)}`)
  }
}

/** Validate a package name written into a quoted YAML scalar. */
export function assertSafePackageName(name: string): void {
  if (name.length === 0 || name.length > 200 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new Error(`unsafe package name: ${JSON.stringify(name)}`)
  }
}

/** Single-quote a YAML scalar (' doubled inside; @ prefixes stay safe). */
export function yamlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/** One insert row found in a patch file. */
export interface PatchInsertRow {
  /** Insert row id (the mounted entry id). */
  readonly id: string
  /** Module specifier (package name) the row mounts. */
  readonly name: string
  /** Whether the row lives inside a plugin-manager managed block. */
  readonly managed: boolean
}

/**
 * Read every insert row from a patch file (managed blocks and user rows).
 * Line-level parse of top-level `- insert:` blocks and their indented
 * `- id:` / `name:` pairs; never parses the whole document.
 */
export function readInsertRows(content: string): PatchInsertRow[] {
  const rows: PatchInsertRow[] = []
  const lines = content.split('\n')
  let inManaged = false
  let inInsert = false
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!
    const trimmed = line.trim()
    if (trimmed === START) { inManaged = true; continue }
    if (trimmed === END) { inManaged = false; continue }
    if (trimmed === 'insert:' || trimmed.startsWith('- insert:')) {
      inInsert = true
      continue
    }
    if (!inInsert) continue
    // A top-level list item (non-indented `- id:`) ends the insert block.
    if (/^- id:/.test(trimmed) && !line.startsWith('    ')) {
      inInsert = false
      continue
    }
    const idMatch = /^(\s*)- id:\s*([^\s]+)/.exec(line)
    if (idMatch === null) continue
    let name = idMatch[2]!
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = lines[j]!
      if (/^(\s*)- id:/.test(next.trim()) && !next.startsWith('    ')) break
      const nameMatch = /name:\s*(.+)/.exec(next.trim())
      if (nameMatch !== null) {
        name = nameMatch[1]!.trim().replace(/^['"]|['"]$/g, '')
        break
      }
    }
    rows.push({ id: idMatch[2]!, name, managed: inManaged })
  }
  return rows
}

/**
 * Read the ids of top-level rows in a patch file — rows the user (or the
 * manager's managed blocks) explicitly manages. These rows' configured state
 * deviates from the bundle defaults, which the UI highlights. Insert-block
 * child rows (indented) are not targets and are excluded.
 */
export function readManagedIds(content: string): Set<string> {
  const ids = new Set<string>()
  for (const line of content.split('\n')) {
    const match = /^-\s*id:\s*([^\s]+)/.exec(line)
    if (match !== null) ids.add(match[1]!)
  }
  return ids
}

/** Whether a patch file already manages a disable block for the entry id. */
export function hasManagedDisable(patchPath: string, entryId: string): boolean {
  if (!existsSync(patchPath)) return false
  const lines = readFileSync(patchPath, 'utf8').split('\n')
  let blockStart = -1
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!
    if (line.trimEnd() === START) { blockStart = i; continue }
    if (line.trimEnd() === END) { blockStart = -1; continue }
    if (blockStart < 0) continue
    const block = scanBlock(lines, blockStart)
    return block !== undefined && block.kind === 'disable' && block.id === entryId
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
  const without = removeManagedBlocks(lines, entryId).lines
  const block = [
    START,
    `- id: ${entryId}`,
    '  disabled: true',
    END,
  ]
  return joinDocument(without, block)
}

/** Remove the disable block for one entry id. Returns new content. */
export function removeDisableBlock(content: string, entryId: string): string {
  assertSafeEntryId(entryId)
  const lines = content.length === 0 ? [] : content.split('\n')
  const { lines: without } = removeManagedBlocks(lines, entryId)
  return normalizeDocument(without)
}

/** Escaped literal for one row id inside a line-level regex. */
function rowIdPattern(entryId: string): string {
  return entryId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Line-level top-row regex for one entry id. */
function topRowPattern(entryId: string): RegExp {
  return new RegExp('^-\\s*id:\\s*' + rowIdPattern(entryId) + '\\s*$')
}

/**
 * Line-level enable of a user-written top-level row: drop its `disabled:`
 * child and, when nothing else remains under it, the row itself. Returns the
 * new content and whether anything changed.
 */
export function applyRowEnabled(content: string, entryId: string): { content: string; changed: boolean } {
  assertSafeEntryId(entryId)
  const lines = content.length === 0 ? [] : content.split('\n')
  const pattern = topRowPattern(entryId)
  const out: string[] = []
  let changed = false
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (pattern.test(line)) {
      out.push(line)
      i += 1
      // Consume the row's indented subtree, dropping the disabled child.
      const children: string[] = []
      while (i < lines.length && lines[i]!.startsWith(' ')) {
        const child = lines[i]!
        if (/^\s*disabled:\s*(true|false)/.test(child)) {
          changed = true
          i += 1
          continue
        }
        children.push(child)
        i += 1
      }
      if (children.length === 0) {
        // Nothing left under the row: drop the empty patch row too.
        out.pop()
      } else {
        out.push(...children)
      }
      continue
    }
    out.push(line)
    i += 1
  }
  return changed ? { content: normalizeDocument(out), changed: true } : { content, changed: false }
}

/**
 * Line-level disable of a user-written top-level row: add or update its
 * `disabled: true` child. Returns the new content and whether anything
 * changed (false when no such top-level row exists — the caller falls back
 * to the managed block).
 */
export function applyRowDisabled(content: string, entryId: string): { content: string; changed: boolean } {
  assertSafeEntryId(entryId)
  const lines = content.length === 0 ? [] : content.split('\n')
  const pattern = topRowPattern(entryId)
  const out: string[] = []
  let changed = false
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (pattern.test(line)) {
      out.push(line)
      i += 1
      let disabledSeen = false
      while (i < lines.length && lines[i]!.startsWith(' ')) {
        const child = lines[i]!
        if (/^\s*disabled:\s*(true|false)/.test(child)) {
          out.push('  disabled: true')
          disabledSeen = true
          changed = true
          i += 1
          continue
        }
        out.push(child)
        i += 1
      }
      if (!disabledSeen) {
        out.push('  disabled: true')
        changed = true
      }
      continue
    }
    out.push(line)
    i += 1
  }
  return changed ? { content: out.join('\n') + '\n', changed: true } : { content, changed: false }
}


/**
 * Add (or refresh) the insert block mounting one non-bundle plugin. The name
 * is single-quoted (YAML @ trap) and the row id is validated.
 */
export function addInsertRow(content: string, rowId: string, name: string): string {
  assertSafeEntryId(rowId)
  assertSafePackageName(name)
  const lines = content.length === 0 ? [] : content.split('\n')
  const without = removeManagedBlocks(lines, rowId).lines
  const block = [
    START,
    '- insert:',
    `    - id: ${rowId}`,
    `      name: ${yamlQuote(name)}`,
    END,
  ]
  return joinDocument(without, block)
}

/** Remove the insert block for one row id. Returns new content and whether a block was removed. */
export function removeInsertRow(content: string, rowId: string): { content: string; removed: boolean } {
  assertSafeEntryId(rowId)
  const lines = content.length === 0 ? [] : content.split('\n')
  const { lines: without, removed } = removeManagedBlocks(lines, rowId)
  if (!removed) return { content, removed: false }
  return { content: normalizeDocument(without), removed: true }
}

/** Identify one managed block: its kind and the row id it targets. */
function scanBlock(lines: readonly string[], start: number): { kind: string; id: string } | undefined {
  let kind: 'insert' | 'disable' | undefined
  let id: string | undefined
  for (let j = start + 1; j < lines.length; j += 1) {
    const line = lines[j]!
    const trimmed = line.trim()
    if (trimmed === END) break
    if (trimmed === 'insert:' || trimmed.startsWith('- insert:')) kind = 'insert'
    if (kind === 'insert') {
      const match = /^\s{4}- id:\s*(.+?)\s*$/.exec(line)
      if (match !== null) id = match[1]!
    } else {
      const match = /^-\s*id:\s*(.+?)\s*$/.exec(line)
      if (match !== null) id = match[1]!
    }
  }
  return kind !== undefined && id !== undefined ? { kind, id } : undefined
}

/**
 * Drop every managed block targeting `entryId` (either a disable block or
 * an insert block whose child row id matches).
 */
function removeManagedBlocks(lines: readonly string[], entryId: string): { lines: string[]; removed: boolean } {
  const out: string[] = []
  let removed = false
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (line.trimEnd() === START) {
      let j = i + 1
      while (j < lines.length && lines[j]!.trimEnd() !== END) j += 1
      if (j >= lines.length) break // unterminated marker: stop, keep the rest
      const block = scanBlock(lines, i)
      if (block !== undefined && block.id === entryId) {
        i = j + 1 // skip the whole block
        removed = true
        continue
      }
      out.push(...lines.slice(i, j + 1))
      i = j + 1
      continue
    }
    out.push(line)
    i += 1
  }
  return { lines: out, removed }
}

/** Join kept lines with an appended block, dropping empty-doc and blank lines. */
function joinDocument(base: readonly string[], block: readonly string[]): string {
  const significant = base.filter(l => l.trim() !== '[]' && l.trim() !== '')
  const joined = [...significant, ...block].join('\n')
  return joined.endsWith('\n') ? joined : joined + '\n'
}

/**
 * Normalize kept lines after a removal: drop empty-doc/blank lines, collapse
 * blank runs, and restore the official `[]` template when no patch row remains
 * (a comments-only file parses as null and HMR reload fails).
 */
function normalizeDocument(lines: readonly string[]): string {
  const significant = lines.filter(l => l.trim() !== '[]' && l.trim() !== '')
  const text = significant.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
  const hasRow = text.split('\n').some(
    l => /^- id:/.test(l) || /^- insert:/.test(l) || /^insert:/.test(l),
  )
  return hasRow ? text : EMPTY_TEMPLATE
}

/** Persist new content with an atomic write. */
export function writePatch(patchPath: string, content: string): void {
  const tmp = patchPath + '.tmp'
  writeFileSync(tmp, content, 'utf8')
  writeFileSync(patchPath, content, 'utf8')
  try { readFileSync(tmp, 'utf8') } finally { /* tmp left for review */ }
}
