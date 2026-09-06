/**
 * Base layer: profile/home paths, manifest & patch-file readers, the global
 * mutation mutex, and host-profile detection. Everything else (childproc,
 * profiles, marketplace, install flow, the service in index.ts) builds on
 * this module; it imports no sibling module.
 */

import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

/** This package's own name (identifies the hosting profile). */
export const OUR_PACKAGE_NAME = (() => {
  try {
    const manifest = JSON.parse(
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'),
    ) as { name?: unknown }
    return typeof manifest.name === 'string' ? manifest.name : 'dsh-web-plugin-manager'
  } catch {
    return 'dsh-web-plugin-manager'
  }
})()

/** Resolve the Harness home directory (DSH_HOME env, then ~/.dsh). */
export function dshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** The safe-profile-name rule (shared by profileDir and hostProfileName). */
export function isSafeProfileName(name: string): boolean {
  // `.` / `..` would escape the profiles root (join(profiles,'..') = dshHome):
  // removeProfile('..') used to delete the whole Harness home.
  return /^[A-Za-z0-9._-]+$/.test(name) && name !== '.' && name !== '..' && name.length <= 120
}

/** Resolve one profile's directory, rejecting traversal. */
export function profileDir(name: string): string {
  if (!isSafeProfileName(name)) {
    throw new Error("unsafe profile name: " + JSON.stringify(name))
  }
  const dir = join(dshHome(), 'profiles', name)
  // Defense in depth: the resolved path must stay under the profiles root
  // (a name like `..` would otherwise resolve to the Harness home itself).
  if (!resolve(dir).startsWith(resolve(join(dshHome(), 'profiles')) + sep)) {
    throw new Error("unsafe profile name: " + JSON.stringify(name))
  }
  return dir
}

/** The profile's package.json manifest, parsed defensively. */
export function readManifest(dir: string): Record<string, unknown> {
  const path = join(dir, 'package.json')
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch (error: unknown) {
    // A corrupt manifest silently reading as "zero deps, zero bundles" hides
    // real state from every listing — surface it at least once per parse.
    console.warn('[plugin-manager] unreadable profile manifest ' + path + ': '
      + (error instanceof Error ? error.message : String(error)))
    return {}
  }
}

/** The profile's cordis.patch.yml path (may not exist yet). */
export function patchPath(dir: string): string {
  return join(dir, 'cordis.patch.yml')
}

/** Read patch file content, or the empty string when absent/unreadable. */
export function readPatch(dir: string): string {
  // Direct read (no existsSync gate): the exists→read gap is a TOCTOU —
  // a concurrently removed file would throw straight into the REST layer.
  try {
    return readFileSync(patchPath(dir), 'utf8')
  } catch {
    return ''
  }
}
/**
 * Global mutation mutex (process-local): profile-changing operations
 * (install / remove / update / toggle / mount / insert-row edits) run
 * strictly serially. Without it, concurrent pnpm calls rewrite the profile
 * manifest from their own snapshots (lost dependencies), concurrent patch
 * edits lose rows, and the quality gate scans node_modules mid-change —
 * all three collapse to no-ops under serialization. The kind-record and
 * blocklist stores already serialize their own files.
 *
 * Process-local only: the dshpm CLI is a separate process (cross-process
 * locking is out of scope — concurrent CLI mutations are rare).
 */
export let mutationQueue: Promise<unknown> = Promise.resolve()
export function enqueueMutation<T>(task: () => Promise<T>): Promise<T> {
  const run = mutationQueue.then(task, task)
  mutationQueue = run.catch(() => { /* a failed mutation must not wedge the queue */ })
  return run
}
/** Turn a package name into a safe insert-row id (scope slash → dash). */
export function slugify(name: string): string {
  return name.replace(/^@/, '').replace(/[^a-z0-9-]/gi, '-').toLowerCase()
}
/** Read the current bundle list of a profile. */
export function readBundles(profile: string): string[] {
  const manifest = readManifest(profileDir(profile))
  const dsh = (manifest['dsh'] ?? {}) as Record<string, unknown>
  const profileManifest = (dsh['profile'] ?? {}) as Record<string, unknown>
  const bundles = Array.isArray(profileManifest['bundles']) ? profileManifest['bundles'] as string[] : []
  return [...bundles]
}

/** Official built-in profiles the environment manager never touches. */
export const OFFICIAL_PROFILES = ['web', 'headless'] as const

/** Whether a profile name is an official built-in. */
export function isOfficialProfile(name: string): boolean {
  return (OFFICIAL_PROFILES as readonly string[]).includes(name)
}

/**
 * The name of the profile hosting this running instance, or null when it
 * cannot be determined safely.
 *
 * Sources, in order:
 *   1. the --profile <name> flag in the launch argv (explicit, official);
 *   2. the subcommand form (dsh web / dsh headless) - searched ONLY past
 *      argv[0..1] (node executable + script path): an nvm/volta install
 *      makes the script a symlink named dsh, so argv[1] is the binary's
 *      own path; scanning the whole argv would take it as the profile name
 *      and crash the boot with an unsafe-profile-name error (issue #1);
 *   3. the plugin's own install location (<profile>/node_modules/
 *      dsh-web-plugin-manager, npm/yarn layouts) as a last resort.
 *
 * Any candidate that is not a safe profile name yields null - the caller
 * (apply) treats null as "no host", never crashing the plugin tree.
 */
export function hostProfileName(): string | null {
  try {
    const argv = process.argv
    const flagIndex = argv.indexOf('--profile')
    if (flagIndex >= 0 && argv[flagIndex + 1] !== undefined) {
      const flagged = argv[flagIndex + 1]!
      return isSafeProfileName(flagged) ? flagged : null
    }
    // dsh web / dsh headless command mode (no --profile flag): only the
    // args after the node executable and the script path are candidates.
    const candidate = argv.slice(2).find(arg => !arg.startsWith('-') && !arg.endsWith('bin.js') && !arg.includes('node'))
    if (candidate !== undefined && isSafeProfileName(candidate)) return candidate
    // Last resort: derive the hosting profile from the install location
    // (npm/yarn keep <profile>/node_modules/<pkg>; pnpm/link installs
    // resolve elsewhere and simply yield null here).
    return locationProfileName()
  } catch {
    return null
  }
}

/**
 * Derive the hosting profile from the plugin's module location: the first
 * ancestor directory whose package.json is named dsh-profile-<basename>
 * (the official and createProfile naming). null when not found (pnpm and
 * link: installs resolve outside the profile tree).
 */
export function locationProfileName(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 10; depth += 1) {
    if (isSafeProfileName(basename(dir))) {
      try {
        const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: unknown }
        if (manifest.name === 'dsh-profile-' + basename(dir)) return basename(dir)
      } catch { /* not a manifest level: keep walking */ }
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  return null
}

/** Whether a profile hosts the running plugin-manager (its dependency). */
export function isHostProfile(name: string): boolean {
  // The profile hosting this running instance — renaming or removing it would
  // break the live process. Other profiles that merely install the plugin
  // (e.g. via copyPlugins) remain manageable.
  return hostProfileName() === name
}
