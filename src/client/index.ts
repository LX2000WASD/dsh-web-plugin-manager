/**
 * dsh-plugin-manager browser half: registers two settings tabs.
 *  - PluginCatalogTab shadows the official read-only inventory (same slot
 *    id 'all', lower priority) with live enable/disable, filtering, sorting.
 *  - PluginManagerSettingsTab is the install/uninstall management page.
 * Communicates with the host through the /api2/plugin-manager REST surface
 * (same-origin fetch).
 */

import type {} from '@deepseek-ai/dsh-client-locale/client'
// ClientContext is the cordis browser Context. The former
// @deepseek-ai/dsh-client-runtime package that re-exported it was deleted in
// DSH 0.1.2-alpha.1 (refactor(client): migrate consumers and remove Runtime).
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the SlotRegistry service merge (ctx.slots). ui-renderer,
// not the removed runtime package, owns that Context merge since 0.1.2.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {
  AnalyzeResult, BackupDiffResult, BackupFile, CommandResult, KindListView, MarketplaceResult, MutationResult, PluginManagerSnapshot, PresetCompositionGroup, ProfileInfo, StartResult,
  UpdateCheckResult,
} from '../types.ts'
import {
  PluginCatalogTab, type PluginCatalogTabInjected,
} from './PluginCatalogTab.tsx'
import {
  PluginManagerSettingsTab, type PluginManagerTabInjected,
} from './PluginManagerSettingsTab.tsx'
import {
  PluginEnvironmentsTab, type PluginEnvironmentsTabInjected,
} from './PluginEnvironmentsTab.tsx'
import {
  PluginKindsTab, type PluginKindsTabInjected,
} from './PluginKindsTab.tsx'
import {
  PluginMarketplaceTab, type PluginMarketplaceTabInjected,
} from './PluginMarketplaceTab.tsx'
import { en, zh, type PluginManagerLocaleKey } from './locales.ts'

export type { PluginCatalogTabInjected, PluginCatalogTabProps } from './PluginCatalogTab.tsx'
export type { PluginManagerTabInjected, PluginManagerTabProps } from './PluginManagerSettingsTab.tsx'
export type { PluginEnvironmentsTabInjected, PluginEnvironmentsTabProps } from './PluginEnvironmentsTab.tsx'
export type { PluginKindsTabInjected, PluginKindsTabProps } from './PluginKindsTab.tsx'
export type { PluginMarketplaceTabInjected, PluginMarketplaceTabProps } from './PluginMarketplaceTab.tsx'
export type { PluginManagerLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Plugin-manager settings copy. */
    'settings.pluginManager': PluginManagerLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.pluginManager'

/** Services required by the Settings registration. */
export const inject = ['slots', 'locale']

/** Base URL of the host REST surface. */
const BASE = '/api2/plugin-manager'

/** Call one REST op with a JSON body. The optional trailing signal aborts
 *  only the transport: load paths pass one so a superseded fetch dies on
 *  profile switch/unmount, mutating commands never do (they must not be
 *  cancellable). */
async function call<T>(op: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${BASE}/${op}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!response.ok) {
    // Prefer the server's error envelope (e.g. the 429 busy refusal carries
    // a readable "another install/update is still running" message).
    let message = `pluginManager.${op}: HTTP ${response.status}`
    try {
      const body = await response.json() as { error?: { message?: string } }
      if (typeof body.error?.message === 'string' && body.error.message.length > 0) message = body.error.message
    } catch { /* keep the HTTP-only message */ }
    throw new Error(message)
  }
  const envelope = await response.json() as { ok: boolean; value?: T; error?: { code: string; message: string } }
  if (!envelope.ok) {
    throw new Error(`pluginManager.${op} failed: ${envelope.error?.code}: ${envelope.error?.message}`)
  }
  return envelope.value as T
}

/**
 * Long operations (install/update/remove/backupRestore/uninstallKind/
 * copyPlugins) return { jobId } and keep running server-side — the REST
 * request no longer hangs for a 10-minute pnpm lifecycle (timeouts would
 * detach the client while the mutation keeps going). Poll `job` until the
 * job settles, then return its CommandResult so every tab's calling code
 * stays unchanged (busy/spinner state simply spans the whole poll).
 */
const JOB_POLL_MS = 1500
/** Interval used for the fast start of the poll schedule (A10). */
const JOB_POLL_FAST_MS = 250
/**
 * Sleep before the next poll, given how long this poll loop has already
 * waited (A10). 250ms for the first JOB_POLL_MS of waiting, then the
 * original 1.5s cadence.
 *
 * Why this shape: JOB_POLL_MS is an exact multiple of JOB_POLL_FAST_MS, so
 * the new poll times (0, 250, 500, …, 1500, 3000, 4500, …) are a SUPERSET of
 * the old ones (0, 1500, 3000, …). The perceived latency is therefore never
 * worse than the flat 1.5s loop for ANY settle time, and up to 1.25s better
 * for the common case (a refused spec, a cached no-op, a sub-second pnpm
 * run). Exponential backoff would not have this property: a job settling
 * just after the fast window would wait a full 1.5s from an off-grid poll.
 *
 * Cost: at most JOB_POLL_MS / JOB_POLL_FAST_MS = 6 extra POSTs per job, all
 * against the local host (the `job` op is a Map lookup + JSON envelope).
 */
function jobPollDelayMs(waitedMs: number): number {
  return waitedMs < JOB_POLL_MS ? JOB_POLL_FAST_MS : JOB_POLL_MS
}

async function pollJob<T>(jobId: string): Promise<T> {
  // Poll BEFORE the first sleep: an op that settles instantly (a refused
  // spec, a cached no-op) used to pay a flat 1.5s of dead time. Mutating
  // jobs are deliberately NOT cancellable, so this loop keeps polling to
  // its end even if the tab unmounts — dropping the result would leave the
  // user with a mutation that ran and no report of it.
  let waited = 0
  for (;;) {
    const status = await call<{ done: boolean; result?: T; error?: string; missing?: boolean }>('job', { id: jobId })
    if (!status.done) {
      const delay = jobPollDelayMs(waited)
      waited += delay
      await new Promise(resolve => setTimeout(resolve, delay))
      continue
    }
    if (status.missing === true) throw new Error('job result expired (server restarted?) — reload and check the profile state')
    if (status.error !== undefined) throw new Error(status.error)
    return status.result as T
  }
}

async function callJob<T>(op: string, body: Record<string, unknown>): Promise<T> {
  const accepted = await call<{ jobId: string }>(op, body)
  return pollJob<T>(accepted.jobId)
}

/** Contribute the catalog (shadowing official) and management tabs. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-web-plugin-manager: dictionaries')

  const t = ctx.locale.bind(NS)
  const catalogInjected = (): PluginCatalogTabInjected => ({
    profiles: (signal) => call<ProfileInfo[]>('listProfiles', {}, signal),
    list: (profile, signal) => call<PluginManagerSnapshot>('list', { profile }, signal),
    setEnabled: (profile, entryId, enabled) => call<MutationResult>('setEnabled', { profile, entryId, enabled }),
    mount: (profile, packageName) => call<MutationResult>('mount', { profile, packageName }),
    presetCompositions: () => call<PresetCompositionGroup[] | null>('presetCompositions', {}),
  })
  const managerInjected = (): PluginManagerTabInjected => ({
    profiles: (signal) => call<ProfileInfo[]>('listProfiles', {}, signal),
    list: (profile, signal) => call<PluginManagerSnapshot>('list', { profile }, signal),
    install: (profile, spec, answers) => callJob<CommandResult>('install', { profile, spec, answers }),
    remove: (profile, name) => callJob<CommandResult>('remove', { profile, name }),
    removeInsert: (profile, rowId) => call<MutationResult>('removeInsert', { profile, rowId }),
    copyPlugins: (from, to, names) => callJob<CommandResult>('copyPlugins', { from, to, names }),
    checkUpdates: (profile) => callJob<UpdateCheckResult>('checkUpdates', { profile }),
    update: (profile, name) => callJob<CommandResult>('update', { profile, name }),
    analyze: (profile) => call<AnalyzeResult>('analyze', { profile }),
    fixIssue: (profile, action, target) => call<MutationResult>('fixIssue', { profile, action, target }),
    fixAll: (profile) => call<CommandResult>('fixAll', { profile }),
  })

  // Shadow the official read-only inventory: same slot id 'all', lower
  // priority wins per the slots shadowing contract (lowest renders).
  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'all',
    order: 10,
    priority: -1,
    label: () => t('catalogTab'),
    locale: NS,
    inject: catalogInjected,
  }, PluginCatalogTab))

  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'manager',
    order: 20,
    label: () => t('tab'),
    locale: NS,
    inject: managerInjected,
  }, PluginManagerSettingsTab))

  const environmentsInjected = (): PluginEnvironmentsTabInjected => ({
    profiles: (signal) => call<ProfileInfo[]>('listProfiles', {}, signal),
    copyPlugins: (from, to, names) => callJob<CommandResult>('copyPlugins', { from, to, names }),
    startProfile: (name) => call<StartResult>('startProfile', { name }),
    stopProfile: (name) => call<MutationResult>('stopProfile', { name }),
    createProfile: (name, template) => call<MutationResult>('createProfile', { name, template }),
    renameProfile: (oldName, newName) => call<MutationResult>('renameProfile', { oldName, newName }),
    removeProfile: (name) => call<MutationResult>('removeProfile', { name }),
    backupExport: (profile) => call<BackupFile>('backupExport', { profile }),
    backupDiff: (backup, profile) => call<BackupDiffResult>('backupDiff', { profile, backup }),
    backupRestore: (backup, profile) => callJob<CommandResult>('backupRestore', { profile, backup }),
  })

  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'environments',
    order: 30,
    label: () => t('envTab'),
    locale: NS,
    inject: environmentsInjected,
  }, PluginEnvironmentsTab))

  // Skills & Presets: a first-level settings entry above the marketplace.
  // Profile-less: skills/presets live in the global harness roots. Re-pull
  // and uninstall call the host install/uninstallKind ops with an empty
  // profile — the skill/preset branches never touch profile state.
  const kindsInjected = (): PluginKindsTabInjected => ({
    kinds: (signal) => call<KindListView>('listKinds', {}, signal),
    uninstall: (repo) => callJob<CommandResult>('uninstallKind', { profile: '', repo }),
    reinstall: (repo) => callJob<CommandResult>('install', { profile: '', spec: 'https://github.com/' + repo, answers: undefined }),
  })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'kinds',
    order: 15,
    label: () => t('kindsTab'),
    locale: NS,
    inject: kindsInjected,
  }, PluginKindsTab))

  // Marketplace: a first-level settings entry (after the official Plugins).
  const marketplaceInjected = (): PluginMarketplaceTabInjected => ({
    marketplace: (refresh, profile, signal) => call<MarketplaceResult>('marketplace', { refresh, profile }, signal),
    install: (profile, spec, answers) => callJob<CommandResult>('install', { profile, spec, answers }),
    update: (profile, name) => callJob<CommandResult>('update', { profile, name }),
    unblock: (repo) => call<MutationResult>('unblockRepo', { repo }),
    profiles: () => call<ProfileInfo[]>('listProfiles', {}),
  })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'marketplace',
    order: 20,
    label: () => t('marketTab'),
    locale: NS,
    inject: marketplaceInjected,
  }, PluginMarketplaceTab))
}
