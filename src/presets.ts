/**
 * Plugin-owned local agent presets: ownership markers, cleanup on uninstall,
 * and archive/restore on disable/re-enable.
 *
 * Presets live in the official user root (<dshHome>/.agent-presets, scanned
 * by the host roster on every read). A preset directory name is the preset
 * id, NOT the plugin that shipped it, so uninstalling a plugin cannot know
 * which directories belong to it without a marker. The ecosystem already
 * writes two marker conventions:
 *   - dsh-agent-rp: .dsh-agent-rp-owner.json = {owner, format: 0, digest}
 *     (strictly validated, digest of the composition files);
 *   - gamelike-plugin-manage: .plugin-manage-owner.json = {format, owners[]}
 *     (no digest; any *.owner.json in the preset dir is read).
 *
 * This module defines the neutral standard marker (.dsh-preset-owner.json =
 * {format: 0, owners: string[], digest}) written by our own preset installer,
 * reads all three shapes for compatibility, and implements two operations:
 *   - cleanup on UNINSTALL: delete only presets whose sole owner is the
 *     removed plugin AND whose files still match the install digest (a user
 *     edit skips deletion). Uses the host agentPresets.remove() when the
 *     running host provides it, direct removal otherwise.
 *   - archive on DISABLE / restore on RE-ENABLE: move the owned preset
 *     directories out of the user root (zero data loss — even edited ones),
 *     and move them back. The roster is a live directory scan, so the
 *     picker reflects the move immediately.
 *
 * Disabling never deletes: the host marks a preset broken only for missing/
 * unparsable compositions, never for a disabled referenced plugin, so there
 * is no safe "clean broken on disable" signal — and a temporary toggle must
 * not destroy user data anyway.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dshHomePath, isUnderRoot, presetsDirPath, renameRetry, rmRetry } from './kinds.ts'

/** Neutral standard ownership marker file name (written by our installer). */
export const OWNER_MARKER = '.dsh-preset-owner.json'

/** Marker schema version. */
export const OWNER_MARKER_FORMAT = 0

/** Directory where disabled plugins' presets are parked (outside the user root). */
export function presetArchiveDir(): string {
  return join(dshHomePath(), 'plugin-manager-cache', 'preset-archive')
}

/** Composition files whose digest records what the plugin shipped. */
const DIGEST_FILES = ['agent.cordis.yml', 'preset.yml'] as const

/**
 * Digest of a preset directory's composition files (filename + NUL + content
 * + NUL each, same scheme as dsh-agent-rp). Returns null when a file is
 * unreadable — treated as "cannot verify" by the modified check.
 */
export function presetDigest(presetDir: string): string | null {
  const hash = createHash('sha256')
  for (const file of DIGEST_FILES) {
    const path = join(presetDir, file)
    if (!existsSync(path)) continue
    try {
      hash.update(file)
      hash.update(String.fromCharCode(0))
      hash.update(readFileSync(path))
      hash.update(String.fromCharCode(0))
    } catch {
      return null
    }
  }
  return hash.digest('hex')
}

/** Coerce a record's owner/owners field into non-empty strings. */
function ownersOfRecord(value: unknown): string[] {
  if (typeof value === 'string') return value.length > 0 ? [value] : []
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string' && item.length > 0)
  }
  return []
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Read every owner a preset directory declares, across the standard marker
 * and the compatible third-party shapes. A corrupt STANDARD marker makes the
 * whole read fail closed (no owners — nothing is deleted); a corrupt
 * third-party marker is skipped individually (their writers are less strict).
 */
export function readPresetOwners(presetDir: string): string[] {
  const owners = new Set<string>()
  const marker = join(presetDir, OWNER_MARKER)
  if (existsSync(marker)) {
    const record = readJson(marker) as { format?: unknown; owner?: unknown; owners?: unknown } | null
    if (record === null || record.format !== OWNER_MARKER_FORMAT) return []
    for (const owner of [...ownersOfRecord(record.owners), ...ownersOfRecord(record.owner)]) owners.add(owner)
  }
  let entries: string[] = []
  try {
    entries = readdirSync(presetDir)
  } catch {
    return []
  }
  for (const file of entries) {
    if (file === OWNER_MARKER || !/owner\.json$/i.test(file)) continue
    const record = readJson(join(presetDir, file)) as { format?: unknown; owner?: unknown; owners?: unknown } | null
    if (record === null) continue
    // dsh-agent-rp style markers carry a format; refuse mismatches instead of
    // guessing at a future schema.
    if (record.format !== undefined && record.format !== OWNER_MARKER_FORMAT) continue
    for (const owner of [...ownersOfRecord(record.owner), ...ownersOfRecord(record.owners)]) owners.add(owner)
  }
  return [...owners]
}

/** The digest a marker records, standard marker first, else compatible ones. */
function recordedDigest(presetDir: string): string | null {
  const marker = join(presetDir, OWNER_MARKER)
  if (existsSync(marker)) {
    const record = readJson(marker) as { digest?: unknown } | null
    if (record !== null && typeof record.digest === 'string') return record.digest
  }
  let entries: string[] = []
  try {
    entries = readdirSync(presetDir)
  } catch {
    return null
  }
  for (const file of entries) {
    if (!/owner\.json$/i.test(file)) continue
    const record = readJson(join(presetDir, file)) as { digest?: unknown } | null
    if (record !== null && typeof record.digest === 'string') return record.digest
  }
  return null
}

/** Preset directories under a root (directory name = id; dot dirs skipped). */
export function scanPresets(root: string): Array<{ id: string; dir: string }> {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
      .map(entry => ({ id: entry.name, dir: join(root, entry.name) }))
  } catch {
    return []
  }
}

export interface PresetOwnership {
  /** Whether the preset's only owner is the given plugin. */
  readonly owned: boolean
  /** Whether the files no longer match the recorded install digest. */
  readonly modified: boolean
}

/**
 * Ownership verdict for one preset directory. Multi-owner markers (a preset
 * claimed by more than one plugin) are never acted on — one owner's removal
 * must not take the other's data. "Modified" is true when the marker carries
 * a digest and the files differ, and also when the standard marker is
 * corrupt (fail closed); markers without a digest (gamelike shape) report
 * unmodified.
 */
export function presetOwnedBy(presetDir: string, pluginName: string): PresetOwnership {
  const owners = readPresetOwners(presetDir)
  if (owners.length !== 1 || owners[0] !== pluginName) return { owned: false, modified: false }
  const digest = recordedDigest(presetDir)
  if (digest === null) return { owned: true, modified: false }
  const marker = join(presetDir, OWNER_MARKER)
  if (existsSync(marker) && readJson(marker) === null) return { owned: true, modified: true }
  return { owned: true, modified: presetDigest(presetDir) !== digest }
}

/** The host agentPresets service, when the running host provides it. */
export interface AgentPresetService {
  list(): Promise<Array<{ id: string; path: string }>>
  remove(id: string): Promise<unknown>
}

export function agentPresetsOf(ctx: unknown): AgentPresetService | undefined {
  try {
    const service = (ctx as { get?: (name: string) => unknown }).get?.('agentPresets')
    if (
      service === undefined || typeof service !== 'object' ||
      typeof (service as AgentPresetService).list !== 'function' ||
      typeof (service as AgentPresetService).remove !== 'function'
    ) {
      return undefined
    }
    return service as AgentPresetService
  } catch {
    return undefined
  }
}

export interface PresetCleanupResult {
  readonly removed: readonly string[]
  readonly skipped: readonly { id: string; reason: string }[]
}

/**
 * Delete the unmodified presets solely owned by the given plugin under the
 * given root. Prefers the host agentPresets.remove() (it clears a settings
 * default that pointed at the preset and keeps standing sessions intact);
 * falls back to direct removal when the host service is absent (CLI runs).
 * Edited presets (digest mismatch) and multi-owner presets are skipped and
 * reported.
 */
export async function cleanupOwnedPresets(ctx: unknown, root: string, pluginName: string): Promise<PresetCleanupResult> {
  const removed: string[] = []
  const skipped: Array<{ id: string; reason: string }> = []
  const service = agentPresetsOf(ctx)
  for (const { id, dir } of scanPresets(root)) {
    const verdict = presetOwnedBy(dir, pluginName)
    if (!verdict.owned) continue
    if (verdict.modified) {
      skipped.push({ id, reason: 'modified by user (digest mismatch) — kept' })
      continue
    }
    try {
      if (service !== undefined) {
        await service.remove(id)
      } else {
        if (!isUnderRoot(dir, root)) {
          skipped.push({ id, reason: 'outside the preset root — kept' })
          continue
        }
        rmRetry(dir)
      }
      removed.push(id)
    } catch (error) {
      skipped.push({ id, reason: error instanceof Error ? error.message : String(error) })
    }
  }
  return { removed, skipped }
}

export interface PresetArchiveResult {
  readonly archived: readonly string[]
  readonly skipped: readonly { id: string; reason: string }[]
}

/**
 * Move a disabled plugin's owned presets out of the user root (archive).
 * Zero data loss: edited presets are archived too, only the picker loses the
 * entry. The roster re-scans the directory on every read, so the change is
 * visible immediately; no host notification is needed.
 */
export function archiveOwnedPresets(root: string, pluginName: string): PresetArchiveResult {
  const archiveRoot = presetArchiveDir()
  const archived: string[] = []
  const skipped: Array<{ id: string; reason: string }> = []
  for (const { id, dir } of scanPresets(root)) {
    if (!presetOwnedBy(dir, pluginName).owned) continue
    const target = join(archiveRoot, id)
    if (existsSync(target)) {
      skipped.push({ id, reason: 'an archived copy already exists — kept in place' })
      continue
    }
    if (!isUnderRoot(dir, root)) {
      skipped.push({ id, reason: 'outside the preset root — kept' })
      continue
    }
    try {
      mkdirSync(archiveRoot, { recursive: true })
      renameRetry(dir, target)
      archived.push(id)
    } catch (error) {
      skipped.push({ id, reason: error instanceof Error ? error.message : String(error) })
    }
  }
  return { archived, skipped }
}

export interface PresetRestoreResult {
  readonly restored: readonly string[]
  readonly skipped: readonly { id: string; reason: string }[]
}

/**
 * Move a re-enabled plugin's archived presets back into the user root. A
 * same-id preset that appeared meanwhile wins; the archived copy stays put
 * and is reported.
 */
export function restoreArchivedPresets(root: string, pluginName: string): PresetRestoreResult {
  const archiveRoot = presetArchiveDir()
  const restored: string[] = []
  const skipped: Array<{ id: string; reason: string }> = []
  for (const { id, dir } of scanPresets(archiveRoot)) {
    if (!presetOwnedBy(dir, pluginName).owned) continue
    const target = join(root, id)
    if (existsSync(target)) {
      skipped.push({ id, reason: 'a same-id preset already exists — archived copy kept at ' + dir })
      continue
    }
    try {
      renameRetry(dir, target)
      restored.push(id)
    } catch (error) {
      skipped.push({ id, reason: error instanceof Error ? error.message : String(error) })
    }
  }
  return { restored, skipped }
}

/**
 * Whether the plugin is still installed in another profile. Presets are
 * global, so uninstalling or disabling a plugin in one profile must not
 * remove presets a second profile still uses. Install records always land in
 * the profile manifest dependencies, so the dependency check is the
 * authoritative "still around somewhere" signal.
 */
export function pluginInstalledInOtherProfiles(profile: string, pluginName: string): boolean {
  const profilesRoot = join(dshHomePath(), 'profiles')
  let names: string[] = []
  try {
    names = readdirSync(profilesRoot)
  } catch {
    return false
  }
  for (const name of names) {
    if (name === profile || name.startsWith('.')) continue
    try {
      const manifest = readJson(join(profilesRoot, name, 'package.json')) as { dependencies?: Record<string, unknown> } | null
      if (manifest !== null && manifest.dependencies !== undefined && pluginName in manifest.dependencies) {
        return true
      }
    } catch {
      // An unreadable profile must not block cleanup; treat it as absent.
    }
  }
  return false
}

/**
 * Write the neutral ownership marker into an installed preset directory.
 * Never overwrites an existing marker (a plugin or another tool may already
 * claim the directory). The digest records what was just installed, so a
 * later user edit skips deletion.
 */
export function writeOwnerMarker(presetDir: string, owners: readonly string[]): void {
  const marker = join(presetDir, OWNER_MARKER)
  if (existsSync(marker)) return
  const digest = presetDigest(presetDir)
  const record: Record<string, unknown> = {
    format: OWNER_MARKER_FORMAT,
    owners: [...new Set(owners.filter(owner => owner.length > 0))],
  }
  if (digest !== null) record.digest = digest
  writeFileSync(marker, JSON.stringify(record, undefined, 2) + String.fromCharCode(10), 'utf8')
}

/** Human-readable summary of a cleanup result (for command output). */
export function formatCleanupResult(pluginName: string, result: PresetCleanupResult): string {
  const parts: string[] = []
  if (result.removed.length > 0) parts.push('removed ' + result.removed.length + ' preset(s): ' + result.removed.join(', '))
  for (const skip of result.skipped) parts.push('kept ' + skip.id + ' (' + skip.reason + ')')
  return parts.length > 0
    ? '[plugin-manager] preset cleanup for ' + pluginName + ': ' + parts.join('; ')
    : '[plugin-manager] preset cleanup for ' + pluginName + ': no owned presets found'
}

/** Human-readable summary of an archive result. */
export function formatArchiveResult(pluginName: string, result: PresetArchiveResult): string {
  const parts: string[] = []
  if (result.archived.length > 0) parts.push('moved ' + result.archived.join(', ') + ' out of the preset picker')
  for (const skip of result.skipped) parts.push('kept ' + skip.id + ' (' + skip.reason + ')')
  return parts.length > 0
    ? '[plugin-manager] preset archive for ' + pluginName + ': ' + parts.join('; ')
    : ''
}

/** Human-readable summary of a restore result. */
export function formatRestoreResult(pluginName: string, result: PresetRestoreResult): string {
  const parts: string[] = []
  if (result.restored.length > 0) parts.push('restored ' + result.restored.join(', ') + ' to the preset picker')
  for (const skip of result.skipped) parts.push('kept archived ' + skip.id + ' (' + skip.reason + ')')
  return parts.length > 0
    ? '[plugin-manager] preset restore for ' + pluginName + ': ' + parts.join('; ')
    : ''
}