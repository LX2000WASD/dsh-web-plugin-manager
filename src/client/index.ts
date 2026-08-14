/**
 * dsh-plugin-manager browser half: registers two settings tabs.
 *  - PluginCatalogTab shadows the official read-only inventory (same slot
 *    id 'all', lower priority) with live enable/disable, filtering, sorting.
 *  - PluginManagerSettingsTab is the install/uninstall management page.
 * Communicates with the host through the /api2/plugin-manager REST surface
 * (same-origin fetch).
 */

import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {
  AnalyzeResult, CommandResult, MarketplaceResult, MutationResult, PluginManagerSnapshot, ProfileInfo, StartResult,
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
  PluginMarketplaceTab, type PluginMarketplaceTabInjected,
} from './PluginMarketplaceTab.tsx'
import { en, zh, type PluginManagerLocaleKey } from './locales.ts'

export type { PluginCatalogTabInjected, PluginCatalogTabProps } from './PluginCatalogTab.tsx'
export type { PluginManagerTabInjected, PluginManagerTabProps } from './PluginManagerSettingsTab.tsx'
export type { PluginEnvironmentsTabInjected, PluginEnvironmentsTabProps } from './PluginEnvironmentsTab.tsx'
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

/** Call one REST op with a JSON body. */
async function call<T>(op: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${BASE}/${op}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    throw new Error(`pluginManager.${op}: HTTP ${response.status}`)
  }
  const envelope = await response.json() as { ok: boolean; value?: T; error?: { code: string; message: string } }
  if (!envelope.ok) {
    throw new Error(`pluginManager.${op} failed: ${envelope.error?.code}: ${envelope.error?.message}`)
  }
  return envelope.value as T
}

/** Contribute the catalog (shadowing official) and management tabs. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-web-plugin-manager: dictionaries')

  const t = ctx.locale.bind(NS)
  const catalogInjected = (): PluginCatalogTabInjected => ({
    profiles: () => call<ProfileInfo[]>('listProfiles', {}),
    list: (profile) => call<PluginManagerSnapshot>('list', { profile }),
    setEnabled: (profile, entryId, enabled) => call<MutationResult>('setEnabled', { profile, entryId, enabled }),
  })
  const managerInjected = (): PluginManagerTabInjected => ({
    profiles: () => call<ProfileInfo[]>('listProfiles', {}),
    list: (profile) => call<PluginManagerSnapshot>('list', { profile }),
    install: (profile, spec) => call<CommandResult>('install', { profile, spec }),
    remove: (profile, name) => call<CommandResult>('remove', { profile, name }),
    removeInsert: (profile, rowId) => call<MutationResult>('removeInsert', { profile, rowId }),
    copyPlugins: (from, to, names) => call<CommandResult>('copyPlugins', { from, to, names }),
    checkUpdates: (profile) => call<UpdateCheckResult>('checkUpdates', { profile }),
    update: (profile, name) => call<CommandResult>('update', { profile, name }),
    analyze: (profile) => call<AnalyzeResult>('analyze', { profile }),
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
    profiles: () => call<ProfileInfo[]>('listProfiles', {}),
    copyPlugins: (from, to, names) => call<CommandResult>('copyPlugins', { from, to, names }),
    startProfile: (name) => call<StartResult>('startProfile', { name }),
    stopProfile: (name) => call<MutationResult>('stopProfile', { name }),
    createProfile: (name, template) => call<MutationResult>('createProfile', { name, template }),
    renameProfile: (oldName, newName) => call<MutationResult>('renameProfile', { oldName, newName }),
    removeProfile: (name) => call<MutationResult>('removeProfile', { name }),
  })

  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'environments',
    order: 30,
    label: () => t('envTab'),
    locale: NS,
    inject: environmentsInjected,
  }, PluginEnvironmentsTab))

  // Marketplace: a first-level settings entry (after the official Plugins).
  const marketplaceInjected = (): PluginMarketplaceTabInjected => ({
    marketplace: (refresh) => call<MarketplaceResult>('marketplace', { refresh }),
    install: (profile, spec) => call<CommandResult>('install', { profile, spec }),
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
