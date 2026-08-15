/**
 * Plugin-install guard rails for agent-driven plugin management.
 *
 * Users often ask the agent directly to install a plugin ("install X for
 * me"). Left to itself the agent runs the raw official CLI
 * (`dsh plugin --profile <name> add <pkg>`) or pnpm against the profile
 * directory — bypassing this manager's quality gate entirely, so a broken
 * plugin (undeclared imports, official packages declared as regular
 * dependencies) lands in the profile and the next boot or round fails.
 *
 * Two layers close that hole:
 *  - a tool guard denies bash/run_code calls that mutate plugin state
 *    through the raw path, with a denial reason pointing at the protected
 *    surface (plugin_* tools, dshpm CLI) — the model reads the reason and
 *    retries through the protected flow;
 *  - a system prompt section states the rule up front, so the model prefers
 *    the protected surface before it ever attempts the raw path.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution, ToolGuard } from '@deepseek-ai/dsh-tools'

/**
 * Shell commands the agent may legitimately run against the dsh CLI without
 * touching plugin state: listing, dumping config, help. Everything else on
 * the plugin subcommand is a mutation.
 */
const DSH_PLUGIN_READ_ONLY = /\b(?:list|ls|status|dump-config|dump|help|-h|--help|--dump-config)\b/

/**
 * Mutating plugin-command patterns: the official CLI's plugin subcommand
 * with a write verb, or pnpm add/remove/rm combined with a dsh profile
 * directory marker anywhere in the command (which bypasses the quality gate
 * exactly like the raw CLI). The marker may sit before or after the verb
 * (pnpm --dir ~/.dsh/profiles/web add foo).
 */
const DSH_PLUGIN_MUTATION =
  /\bdsh\s+plugin\b[\s\S]{0,160}?\b(?:add|install|remove|rm|update|upgrade|uninstall|delete)\b/
const PNPM_MUTATION = /\bpnpm\b[\s\S]{0,80}?\b(?:add|remove|rm)\b/
const PROFILE_DIR_MARKER = /profiles|\\.dsh|DSH_HOME/

/** Denial reason shown to the model in the tool result. */
const DENIAL_REASON =
  'Plugin installation/removal must go through the protected flow: call the plugin_install / plugin_uninstall / '
  + 'plugin_toggle tools, or run the dshpm CLI (dshpm install <pkg> --profile <name>, dshpm remove <name>). '
  + 'Raw dsh plugin add/remove and pnpm add/remove skip the quality gate (undeclared imports, official-package '
  + 'duplicates) and can break the whole profile at runtime.'

/** Command text of one bash/run_code execution, or null for other tools. */
function commandText(exec: ToolExecution): string | null {
  if (exec.name !== 'bash' && exec.name !== 'run_code') return null
  const args = exec.arguments as { command?: unknown; code?: unknown } | undefined
  const text = typeof args?.command === 'string' ? args.command
    : typeof args?.code === 'string' ? args.code
    : undefined
  return text ?? null
}

/**
 * Whether a command mutates plugin state through the unprotected raw path.
 * Read-only dsh plugin verbs (list/status/dump-config/help) are allowed.
 */
function isRawPluginMutation(command: string): boolean {
  if (DSH_PLUGIN_MUTATION.test(command)) {
    if (!DSH_PLUGIN_READ_ONLY.test(command)) return true
  }
  return PNPM_MUTATION.test(command) && PROFILE_DIR_MARKER.test(command)
}

/** One guard instance for the running host (registered once per apply). */
export function createPluginGuard(): ToolGuard {
  return (exec: ToolExecution): string | undefined => {
    const command = commandText(exec)
    if (command === null) return undefined
    if (!isRawPluginMutation(command)) return undefined
    return DENIAL_REASON
  }
}

/**
 * Register the guard on the tools service (same scope the agent's tool
 * calls execute in). Returns the guard disposer.
 */
export function registerPluginGuard(
  ctx: { get(name: string): unknown },
): (() => void) | null {
  const toolsService = ctx.get('tools') as { guard(guard: ToolGuard): () => void } | undefined
  if (toolsService === undefined) return null
  return toolsService.guard(createPluginGuard())
}

/**
 * The system prompt section stating the protected plugin-management
 * surface. Order 300 sits after the tool-guidance band (100-199), so the
 * rule reads as an operational constraint, not tool documentation.
 */
export const PLUGIN_RULE_SECTION = {
  name: 'plugin-manager:install-rule',
  order: 300,
  text: 'To install, remove, or toggle DSH plugins, use the plugin_install / plugin_uninstall / plugin_toggle '
    + 'tools or the dshpm CLI (dshpm install <pkg> --profile <name>, dshpm remove <name>). '
    + 'Never run raw dsh plugin add/remove or pnpm add/remove against a profile: the protected flow runs a quality '
    + 'gate (undeclared imports, official-package duplicates) and rolls back broken installs.',
}

/** Register the prompt section on the systemPrompt service. Returns the section disposer. */
export function registerPluginRulePrompt(
  ctx: { get(name: string): unknown },
): (() => void) | null {
  const systemPrompt = ctx.get('systemPrompt') as
    | { section(section: typeof PLUGIN_RULE_SECTION): () => void } | undefined
  if (systemPrompt === undefined) return null
  return systemPrompt.section(PLUGIN_RULE_SECTION)
}
