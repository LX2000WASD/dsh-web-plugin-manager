/**
 * dsh-plugin-manager browser half: registers the Manage tab inside the
 * official Plugins settings section (settings.plugins.tab).
 * Communicates with the host through the /api2/plugin-manager REST surface
 * (same-origin fetch).
 */

import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {
  CommandResult, MutationResult, PluginManagerSnapshot, ProfileInfo,
} from '../types.ts'
import {
  PluginManagerSettingsTab, type PluginManagerTabInjected,
} from './PluginManagerSettingsTab.tsx'
import { en, zh, type PluginManagerLocaleKey } from './locales.ts'

export type { PluginManagerTabInjected, PluginManagerTabProps } from './PluginManagerSettingsTab.tsx'
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

/** Contribute the Manage tab to the Plugins settings section. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-plugin-manager: dictionaries')

  const t = ctx.locale.bind(NS)
  const injected = (): PluginManagerTabInjected => ({
    profiles: () => call<ProfileInfo[]>('listProfiles', {}),
    list: (profile) => call<PluginManagerSnapshot>('list', { profile }),
    setEnabled: (profile, entryId, enabled) => call<MutationResult>('setEnabled', { profile, entryId, enabled }),
    install: (profile, spec) => call<CommandResult>('install', { profile, spec }),
    remove: (profile, name) => call<CommandResult>('remove', { profile, name }),
    removeInsert: (profile, rowId) => call<MutationResult>('removeInsert', { profile, rowId }),
  })

  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'manager',
    order: 20,
    label: () => t('tab'),
    locale: NS,
    inject: injected,
  }, PluginManagerSettingsTab))
}
