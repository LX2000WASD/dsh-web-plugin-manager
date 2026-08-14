/**
 * Agent tools for plugin management (plugin_status / plugin_install /
 * plugin_uninstall / plugin_toggle). Registered on ctx.tools when the host
 * provides it (see registerTools). No marketplace features: these operate on
 * the local profile's install state only.
 *
 * Install state has two official shapes:
 *  - bundle plugins (npm package declaring dsh.bundle) live in the profile's
 *    dsh.profile.bundles layer stack and need a web restart to load;
 *  - non-bundle plugins (plain cordis packages) mount as insert rows in the
 *    profile cordis.patch.yml, which config HMR applies live (no restart).
 *
 * Dependencies are injected (PluginToolsHost) to avoid a circular import
 * with index.ts, mirroring the reference console's discovery/tools pattern.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { CommandResult, MutationResult, PluginManagerSnapshot } from './types.ts'

/** Host operations the tools need (implemented by the manager service). */
export interface PluginToolsHost {
  list(profile: string): PluginManagerSnapshot
  setEnabled(profile: string, entryId: string, enabled: boolean): Promise<MutationResult>
  install(profile: string, spec: string): Promise<CommandResult>
  remove(profile: string, name: string): Promise<CommandResult>
  removeInsert(profile: string, rowId: string): Promise<MutationResult>
}

/** Tool dependencies captured for one target profile. */
export interface PluginToolsDeps {
  readonly profile: string
  readonly snapshot: () => PluginManagerSnapshot
  readonly setEnabled: (entryId: string, enabled: boolean) => Promise<MutationResult>
  readonly install: (spec: string) => Promise<CommandResult>
  readonly remove: (name: string) => Promise<CommandResult>
  readonly removeInsert: (rowId: string) => Promise<MutationResult>
}

/** One plugin row in the unified status listing. */
interface PluginStatusRow {
  id: string
  kind: 'bundle' | 'plugin' | 'entry'
  name?: string
  enabled?: boolean
  phase?: string
}

/** Render a list of plugin rows as plain text. */
function renderRows(_args: unknown, value: { profile: string; plugins: PluginStatusRow[] }): ContentBlock[] {
  const lines = value.plugins.map((p) => {
    const name = p.name !== undefined ? ` (${p.name})` : ''
    const state = p.enabled !== undefined ? ` [${p.enabled ? 'enabled' : 'disabled'}]` : ''
    const phase = p.phase !== undefined ? ` ${p.phase}` : ''
    return `- ${p.id} ${p.kind}${name}${state}${phase}`
  })
  const body = lines.length > 0
    ? lines.join('\n')
    : '(no plugins installed)'
  return [{ type: 'text', text: `profile ${value.profile}:\n${body}` }]
}

/** Build the four plugin tools for one profile. */
export function createPluginTools(deps: PluginToolsDeps): ReturnType<typeof defineTool>[] {
  const statusRows = (): PluginStatusRow[] => {
    const snap = deps.snapshot()
    const rows: PluginStatusRow[] = []
    // Bundle layers: enabled unless a matching entry is disabled.
    for (const bundle of snap.profile.bundles) {
      const entry = snap.entries.find(e => e.moduleName === bundle)
      rows.push({
        id: bundle,
        kind: 'bundle',
        enabled: entry === undefined ? true : entry.enabled,
        ...(entry !== undefined ? { phase: entry.fiberPhase ?? undefined } : {}),
      })
    }
    // Insert rows: live-mounted non-bundle plugins.
    for (const row of snap.insertRows) {
      rows.push({ id: row.id, kind: 'plugin', name: row.name, enabled: true })
    }
    // Other live entries not covered above (user patch rows).
    for (const entry of snap.entries) {
      if (rows.some(r => r.id === entry.entryId || r.name === entry.moduleName)) continue
      rows.push({
        id: entry.entryId,
        kind: 'entry',
        name: entry.moduleName,
        enabled: entry.enabled,
        phase: entry.fiberPhase ?? undefined,
      })
    }
    return rows
  }

  return [
    defineTool({
      name: 'plugin_status',
      description: 'Show the installed-plugin state of the target dsh profile: bundle layer-stack packages '
        + '(need a web restart to load), live-mounted insert-row plugins (applied via config HMR without a restart), '
        + 'and remaining runtime entries with their enable/disable state. Pass `id` to inspect one plugin or entry.',
      parameters: {
        id: { type: 'string', description: 'Plugin id, package name, or entry id to inspect; omit to list everything.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            profile: { type: 'string', required: true },
            plugins: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string', required: true },
                  kind: { type: 'string', required: true, enum: ['bundle', 'plugin', 'entry'] },
                  name: { type: 'string' },
                  enabled: { type: 'boolean' },
                  phase: { type: 'string' },
                },
              },
            },
          },
        },
        render: renderRows,
      },
      async execute(args) {
        const rows = statusRows()
        const id = (args.id ?? '').trim().toLowerCase()
        const filtered = id === ''
          ? rows
          : rows.filter(p => p.id.toLowerCase() === id || (p.name ?? '').toLowerCase() === id)
        if (id !== '' && filtered.length === 0) {
          throw new Error(`plugin_status: "${args.id}" is not an installed plugin or entry`)
        }
        return { profile: deps.profile, plugins: filtered }
      },
    }),

    defineTool({
      name: 'plugin_install',
      description: 'Install a DSH plugin into the target dsh profile. The package is added via pnpm (the official '
        + '`dsh plugin add` path). A bundle plugin (npm package whose manifest declares dsh.bundle) joins the profile '
        + 'layer stack and loads on the next web restart. A non-bundle plugin (plain cordis package) is additionally '
        + 'written as an insert row into the profile cordis.patch.yml, which config HMR applies live — no restart needed.',
      parameters: {
        source: { type: 'string', required: true, description: 'Install source: npm package name, github:user/repo, tarball URL, or ./local/path.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            installed: { type: 'array', items: { type: 'string' }, required: true },
            message: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.message }],
      },
      async execute(args) {
        const source = args.source.trim()
        if (source === '') throw new Error('plugin_install: source must be a non-empty package name')
        const result = await deps.install(source)
        if (!result.ok) throw new Error(`plugin_install failed: ${result.output.slice(0, 2000)}`)
        const installed = [...(result.installed ?? [])]
        const names = installed.length > 0 ? installed.join(', ') : source
        return {
          ok: true,
          installed,
          message: `plugin_install: ${names} installed into profile ${deps.profile}`
            + (installed.length > 0 ? ' (bundle: restart web to load; non-bundle: mounted live)' : ''),
        }
      },
    }),

    defineTool({
      name: 'plugin_uninstall',
      description: 'Remove an installed DSH plugin from the target dsh profile. A managed insert row (non-bundle '
        + 'plugin) is deleted from the profile cordis.patch.yml and unmounts live (no restart). A bundle plugin is '
        + 'removed from the profile dependencies and layer stack (takes effect on the next web restart). User-owned '
        + 'rows are never touched.',
      parameters: {
        id: { type: 'string', required: true, description: 'Plugin id, insert-row id, or bundle package name to remove.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            message: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.message }],
      },
      async execute(args) {
        const id = args.id.trim()
        if (id === '') throw new Error('plugin_uninstall: id must be a non-empty plugin id')
        // Try the managed insert-row shape first (live removal).
        const insert = await deps.removeInsert(id)
        if (insert.ok) return { ok: true, message: insert.message }
        // Then the bundle shape.
        const result = await deps.remove(id)
        if (result.ok) {
          return { ok: true, message: `plugin_uninstall: removed bundle "${id}" from ${deps.profile} — restart the web app to fully unload it.` }
        }
        throw new Error(`plugin_uninstall: "${id}" is not a managed insert row nor a bundle dependency: ${insert.message} / ${result.output.slice(0, 500)}`)
      },
    }),

    defineTool({
      name: 'plugin_toggle',
      description: 'Enable or disable a runtime plugin entry of the target dsh profile by writing its disabled '
        + 'marker into the profile cordis.patch.yml. Config HMR applies the change live — no restart needed. '
        + 'Target by entry id (Loader row id) or package name; the new state is returned.',
      parameters: {
        entryId: { type: 'string', required: true, description: 'Entry id (Loader row id) or package name to toggle.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            entryId: { type: 'string', required: true },
            enabled: { type: 'boolean', required: true },
            message: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.message }],
      },
      async execute(args) {
        const entryId = args.entryId.trim()
        const snap = deps.snapshot()
        const entry = snap.entries.find(
          e => e.entryId === entryId || e.moduleName === entryId,
        )
        if (entry === undefined) {
          throw new Error(`plugin_toggle: "${entryId}" is not a runtime entry of profile ${deps.profile}`)
        }
        const nextEnabled = !entry.enabled
        const result = await deps.setEnabled(entry.entryId, nextEnabled)
        if (!result.ok) throw new Error(`plugin_toggle failed: ${result.message}`)
        return {
          entryId: entry.entryId,
          enabled: nextEnabled,
          message: `plugin_toggle: ${entry.entryId} ${nextEnabled ? 'enabled' : 'disabled'} (applied live)`,
        }
      },
    }),
  ]
}

/** Register the tools on ctx.tools when available. Returns route disposers. */
export function registerTools(
  ctx: { get(name: string): unknown },
  host: PluginToolsHost,
  profile: string,
): (() => void)[] {
  const toolsService = ctx.get('tools') as { register(def: unknown): () => void } | undefined
  if (toolsService === undefined) return []
  const deps: PluginToolsDeps = {
    profile,
    snapshot: () => host.list(profile),
    setEnabled: (entryId, enabled) => host.setEnabled(profile, entryId, enabled),
    install: (spec) => host.install(profile, spec),
    remove: (name) => host.remove(profile, name),
    removeInsert: (rowId) => host.removeInsert(profile, rowId),
  }
  const definitions = createPluginTools(deps)
  const disposers = definitions.map((definition) => toolsService.register(definition))
  console.log(`[plugin-manager] registered agent tools: ${definitions.map(d => d.name).join(', ')} (profile ${profile})`)
  return disposers
}
