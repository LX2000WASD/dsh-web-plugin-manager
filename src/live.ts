/**
 * Live patch application through the loader's include entry.
 *
 * The profile patch file stays the source of truth for persistence (every
 * mutation is still written to cordis.patch.yml), but live application goes
 * through the include entry's update() — the same channel the platform's
 * config watcher (watchUserPatches) uses — instead of waiting for the file
 * watcher to pick the change up.
 *
 * Why: a watcher-triggered refresh that unloads a service the HMR service
 * itself depends on deadlocks the platform. The web profile's HMR service
 * injects the timer row; disabling `timer` through the watcher starts a
 * refresh task whose tree update disposes the timer fiber, which unloads
 * HMR (a dependent), and HMR's unload awaits its own disposables — including
 * the very refresh task that is running. The circular wait never settles and
 * every later patch change is silently ignored for the rest of the session.
 * Applying directly (outside the watcher task) lets the unload chain settle
 * cleanly, and the watcher's later refresh of the same content is a no-op.
 *
 * Two platform quirks are compensated here:
 *  - applyEntryPatches mutates the patch objects it is given (override
 *    fields are written into the row objects of earlier insert patches), so
 *    the composed stack is deep-cloned before every update. Removing a
 *    managed disable block additionally scrubs the baked `disabled: true`
 *    from the matching row inside the bundle insert lists — otherwise a
 *    re-enable would keep the row disabled forever (the baked value survives
 *    the block's removal).
 *  - entry.update() can hang when the include's apply queue is already
 *    poisoned by an external deadlock; a timeout converts that into a
 *    "restart to apply" outcome instead of a stuck request.
 */

import { readFileSync, watch } from 'node:fs'
import { basename, dirname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'

/** One mutation of the live patch stack. */
export type StackOp =
  /** Append a new patch row (managed disable block, insert block). */
  | { kind: 'append'; value: unknown }
  /**
   * Remove the first top-level row equal to value (managed block removal).
   * `id` triggers the baked-disabled scrub (undoes applyEntryPatches's
   * in-place mutation of insert children).
   */
  | { kind: 'remove-first'; id?: string; value: unknown }
  /**
   * Edit the last top-level row with this id in place (user-written rows).
   * The mutate callback returns the replacement, or null to drop the row.
   */
  | { kind: 'replace-last'; id: string; mutate: (row: Record<string, unknown>) => Record<string, unknown> | null }
  /**
   * Remove every top-level row whose insert list mounts the named package
   * (bundle-layer rows and managed insert rows alike). Matches by child
   * `name`, so it survives the in-place override fields applyEntryPatches
   * bakes into rows (disabled/config) that JSON equality would miss.
   */
  | { kind: 'remove-by-name'; name: string }

/** Whether a value is a plain JSON-ish object (not an array). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Deep-clone rows with the baked `disabled: true` stripped from insert
 * children. applyEntryPatches writes override fields into the passed patch
 * objects, so a live-updated insert row differs from its file row — comparing
 * without normalization would misclassify it as a non-profile row and
 * permanently capture a ghost (audit M16).
 */
function normalizeForCompare(rows: unknown[]): unknown[] {
  const clone = structuredClone(rows)
  for (const row of clone) {
    if (isRecord(row) && Array.isArray(row.insert)) {
      for (const child of row.insert) {
        if (isRecord(child) && child.disabled === true) delete child.disabled
      }
    }
  }
  return clone
}

/** Serialize every live stack application (applyLiveOps + watcher recompose). */
let liveApplyTail: Promise<void> = Promise.resolve()
function enqueueLive<T>(task: () => Promise<T>): Promise<T> {
  const run = liveApplyTail.then(task, task)
  liveApplyTail = run.then(() => undefined, () => undefined)
  return run
}

/** The include entry of the live loader tree, or undefined when unavailable. */
function includeEntry(ctx: Context): {
  entry: {
    options: { config?: { patches?: unknown } }
    update(options: { config: Record<string, unknown> }, create?: boolean, force?: boolean): Promise<unknown>
  }
} | undefined {
  const loader = ctx.get('loader') as { entries(): Iterable<{ id: string; options?: unknown }> } | undefined
  if (loader === undefined) return undefined
  for (const candidate of loader.entries()) {
    if (candidate.id !== 'include') continue
    const entry = candidate as unknown as {
      options: { config?: { patches?: unknown } }
      update(options: { config: Record<string, unknown> }, create?: boolean, force?: boolean): Promise<unknown>
    }
    if (typeof entry.update !== 'function' || entry.options === undefined || entry.options.config === undefined) {
      return undefined
    }
    return { entry }
  }
  return undefined
}

/**
 * Remove the baked `disabled: true` that applyEntryPatches wrote into the
 * matching row inside every insert list (its in-place override mutation).
 */
function scrubBakedDisabled(stack: unknown[], id: string): void {
  for (const row of stack) {
    if (!isRecord(row) || !Array.isArray(row.insert)) continue
    for (const child of row.insert) {
      if (isRecord(child) && child.id === id && child.disabled === true) {
        delete child.disabled
      }
    }
  }
}

/** Apply stack ops to the include entry (live config refresh). */
export async function applyLiveOps(
  ctx: Context,
  ops: readonly StackOp[],
  timeoutMs = 5_000,
): Promise<{ ok: boolean; message?: string }> {
  const found = includeEntry(ctx)
  if (found === undefined) {
    return { ok: false, message: 'no live loader include available' }
  }
  const entry = found.entry
  const config = entry.options.config
  if (config === undefined) {
    return { ok: false, message: 'no live patch config' }
  }
  const current = config.patches
  if (!Array.isArray(current)) {
    return { ok: false, message: 'no live patch stack' }
  }
  // Deep clone: applyEntryPatches mutates the patch objects it receives.
  const stack: unknown[] = structuredClone(current)
  for (const op of ops) {
    switch (op.kind) {
      case 'append': {
        stack.push(op.value)
        break
      }
      case 'remove-first': {
        const needle = JSON.stringify(op.value)
        const index = stack.findIndex((row) => JSON.stringify(row) === needle)
        if (index >= 0) stack.splice(index, 1)
        if (op.id !== undefined) scrubBakedDisabled(stack, op.id)
        break
      }
      case 'replace-last': {
        let index = -1
        for (let i = stack.length - 1; i >= 0; i -= 1) {
          const row = stack[i]
          if (isRecord(row) && row.id === op.id) {
            index = i
            break
          }
        }
        if (index < 0) break
        const next = op.mutate(stack[index] as Record<string, unknown>)
        if (next === null) stack.splice(index, 1)
        else stack[index] = next
        break
      }
      case 'remove-by-name': {
        for (let i = stack.length - 1; i >= 0; i -= 1) {
          const row = stack[i]
          if (isRecord(row) && Array.isArray(row.insert)
            && row.insert.some(child => isRecord(child) && child.name === op.name)) {
            stack.splice(i, 1)
          }
        }
        break
      }
    }
  }
  const { patches: _ignored, ...rest } = config as { patches?: unknown } & Record<string, unknown>
  // Serialize against the watcher's recompose: two concurrent update() calls
  // race last-write-wins and one op is lost (audit M16).
  return enqueueLive(async () => {
    const task = entry.update({ config: { ...rest, patches: stack } })
    try {
      await Promise.race([
        task,
        new Promise((_, reject) => setTimeout(() => reject(new Error('live apply timed out')), timeoutMs)),
      ])
      return { ok: true }
    } catch (error: unknown) {
      console.error('[plugin-manager] live apply failed:', error instanceof Error ? error.stack ?? error.message : String(error))
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  })
}

/**
 * Resolve the js-yaml module: the harness ships it in the shared
 * profiles/node_modules fallback directory. Bare imports fail from a
 * plugin's real location, so the absolute file URL is used when the plain
 * import does not resolve.
 */
let yamlModule: { default: { load(content: string): unknown } } | null | undefined
async function loadYaml(): Promise<{ default: { load(content: string): unknown } } | null> {
  if (yamlModule !== undefined) return yamlModule
  try {
    // @ts-expect-error js-yaml is resolved at runtime by the loader
    const mod = await import('js-yaml')
    yamlModule = mod as { default: { load(content: string): unknown } }
    return yamlModule
  } catch {
    try {
      const { homedir } = await import('node:os')
      const { join } = await import('node:path')
      const { pathToFileURL } = await import('node:url')
      const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
      const candidate = join(home, 'profiles', 'node_modules', 'js-yaml', 'index.js')
      const mod = await import(pathToFileURL(candidate).href)
      yamlModule = mod as { default: { load(content: string): unknown } }
      return yamlModule
    } catch {
      yamlModule = null
      return null
    }
  }
}

/** State of the plugin-owned patch watcher (one per process). */
interface PatchWatcherState {
  readonly patchPath: string
  readonly dirPath: string
  /** The non-profile rows of the composed stack (bundle/home/overlay layers). */
  others: unknown[] | undefined
  /** Whether a recompose is currently scheduled. */
  scheduled: boolean
  /** The raw fs.FSWatcher handle, when active. */
  watcher: { close(): void } | undefined
  /** Pending raw timer (never ctx.timeout — the timer service may be gone). */
  timer: ReturnType<typeof setTimeout> | undefined
  /** The context the watcher applies into. */
  ctx: Context
}

let patchWatcher: PatchWatcherState | undefined

/**
 * Start (or keep) the plugin-owned watcher for the running profile's patch
 * file. The platform's own watcher is an effect of the HMR service, which
 * dies when a toggle unloads the timer row (HMR injects it) — and its
 * registerConfig effects are not restored on reactivation. This watcher
 * lives on the plugin's own context and recomposes through the direct
 * include channel, so manual patch edits keep applying live regardless of
 * HMR's lifecycle.
 */
export function ensurePatchWatcher(ctx: Context, patchPath: string): void {
  const dirPath = dirname(patchPath)
  if (patchWatcher !== undefined) {
    if (patchWatcher.patchPath === patchPath && patchWatcher.ctx === ctx) return
    patchWatcher.watcher?.close()
    if (patchWatcher.timer !== undefined) clearTimeout(patchWatcher.timer)
    patchWatcher = undefined
  }
  const state: PatchWatcherState = {
    patchPath,
    dirPath,
    others: undefined,
    scheduled: false,
    watcher: undefined,
    timer: undefined,
    ctx,
  }
  patchWatcher = state
  // Capture the non-profile rows while the stack is pristine (boot state).
  void (async () => {
    const yaml = await loadYaml()
    if (yaml === null || state.others !== undefined) return
    const content = safeRead(patchPath)
    if (content === null) return
    try {
      const rows = yaml.default.load(content)
      const found = includeEntry(ctx)
      const stack = found?.entry.options.config?.patches
      if (Array.isArray(rows) && Array.isArray(stack)) {
        const needle = new Set(normalizeForCompare(rows as unknown[]).map((row) => JSON.stringify(row)))
        state.others = normalizeForCompare(stack as unknown[]).filter((row) => !needle.has(JSON.stringify(row)))
      }
    } catch { /* capture is best-effort; recompose retries with the current file */ }
  })()
  try {
    // Watch the directory (atomic tmp+rename writes replace the file, which
    // would detach a file-level watcher).
    state.watcher = watch(dirPath, (_event, filename) => {
      if (typeof filename !== 'string' || filename !== basename(patchPath)) return
      if (state.scheduled) return
      state.scheduled = true
      state.timer = setTimeout(() => {
        state.scheduled = false
        state.timer = undefined
        void recomposeFromFile(state)
      }, 300)
    })
  } catch {
    state.watcher = undefined
  }
}

/** Read a file, or null when unreadable. */
function safeRead(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/**
 * Re-apply the patch file content through the include entry. Runs on the
 * plugin's own context (never inside the platform's HMR refresh task), so
 * unloading a service HMR depends on cannot deadlock.
 */
async function recomposeFromFile(state: PatchWatcherState): Promise<void> {
  try {
    const yaml = await loadYaml()
    if (yaml === null) return
    const content = safeRead(state.patchPath)
    if (content === null) return
    const rows = yaml.default.load(content)
    if (!Array.isArray(rows)) return
    const found = includeEntry(state.ctx)
    if (found === undefined) return
    const config = found.entry.options.config
    if (config === undefined) return
    const stack = config.patches
    if (!Array.isArray(stack)) return
    // Recompute the non-profile rows on EVERY recompose (normalized against
    // the file): a one-time capture taken after a live toggle had already
    // baked `disabled` into the insert rows and permanently misclassified
    // them as non-profile ghosts (audit M16). Normalization strips the baked
    // field on both sides before the difference.
    const needle = new Set(normalizeForCompare(rows as unknown[]).map((row) => JSON.stringify(row)))
    state.others = normalizeForCompare(stack as unknown[]).filter((row) => !needle.has(JSON.stringify(row)))
    const { patches: _ignored, ...rest } = config as { patches?: unknown } & Record<string, unknown>
    // Deep clone both parts: applyEntryPatches writes override fields into
    // the passed row objects, which would permanently poison the captured
    // non-profile rows (and the fresh parse) for every later recompose.
    const next: unknown[] = [
      ...structuredClone(state.others),
      ...structuredClone(rows as unknown[]),
    ]
    await enqueueLive(async () => {
      await found.entry.update({ config: { ...rest, patches: next } })
    })
  } catch (error: unknown) {
    console.error('[plugin-manager] patch watch recompose failed:', error instanceof Error ? error.message : String(error))
  }
}
