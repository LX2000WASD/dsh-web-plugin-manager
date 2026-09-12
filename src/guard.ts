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
 * Mutating plugin-command patterns, evaluated PER SHELL SEGMENT (see
 * isRawPluginMutation): the official CLI's plugin subcommand whose first
 * non-flag token is a write verb, or pnpm add/remove/rm combined with a dsh
 * profile directory marker inside the same segment. The marker may sit
 * before or after the verb (pnpm --dir <profile-dir> add foo).
 *
 * The dsh plugin verb is positional: the subcommand takes only flags
 * (--profile X) before the verb, so a read-only call (list/status/help) is
 * simply a verb that is not in the mutation set. There is no whole-command
 * read-only exemption — an echo or comment mentioning "plugin list" in the
 * same script can never exempt a real mutation.
 */
// Write verbs of the official CLI's plugin subcommand.
const PLUGIN_WRITE_VERBS = new Set(['add', 'install', 'remove', 'rm', 'update', 'upgrade', 'uninstall', 'delete'])

/**
 * Positional words of one command segment, with global flag tokens removed.
 * Both official spellings are handled: `--profile web` (space-separated
 * value) and `--profile=web` (inline).
 *
 * M-6: matching the subcommand ADJACENTLY only caught the order where flags
 * follow it. The launcher parses global flags anywhere in argv, so the
 * flag-first and inline orders are the same mutation and used to be allowed
 * through — a one-token change bypassed the quality gate entirely.
 *
 * A token is consumed as a flag value only when it is not itself the
 * subcommand, so the flag-first order cannot lose its subcommand to the
 * value slot.
 */
function positionalWords(segment: string): string[] {
  // Command-word tokens: shell punctuation (quotes, parens, backticks, `=`,
  // commas) separates tokens exactly like whitespace does, so a command
  // embedded in a quoted string or wrapped in a run_code expression is still
  // recognized as the same mutation.
  const tokens = segment.match(/[A-Za-z0-9_@.\/~-]+/g) ?? []
  const out: string[] = []
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!
    if (token.startsWith('-')) {
      // `--flag=value` carries its value inline — nothing to skip.
      if (token.includes('=')) continue
      // `--flag value`: consume the next token as the value unless it is the
      // subcommand itself (or another flag).
      const next = tokens[i + 1]
      if (next !== undefined && !next.startsWith('-') && next !== 'plugin') i += 1
      continue
    }
    out.push(token)
  }
  return out
}

/**
 * Whether one segment mutates plugin state through the official CLI, in ANY
 * flag order: a `dsh` word immediately followed by the `plugin`
 * subcommand, then a write verb among the remaining positional words.
 */
function isDshPluginMutation(segment: string): boolean {
  const words = positionalWords(segment)
  for (let i = 0; i < words.length - 1; i += 1) {
    if (!isDshWord(words[i]!) || words[i + 1] !== 'plugin') continue
    for (let j = i + 2; j < words.length; j += 1) {
      if (PLUGIN_WRITE_VERBS.has(words[j]!)) return true
    }
    return false
  }
  return false
}

/**
 * Whether one positional word names the CLI executable: the bare name or any
 * path ending in it (`/usr/local/bin/dsh`). A longer word that merely ends in
 * the name (`x-dsh`) does not match. Erring toward detection is deliberate:
 * a false positive only makes the model retry through the protected surface,
 * a false negative lets a mutation skip the quality gate.
 */
function isDshWord(word: string): boolean {
  return word.split('/').pop() === 'dsh'
}
// Any package-manager add/remove/rm hitting a profile dir — pnpm, npm,
// yarn, bun, and their --dir/-C variants (audit: the old guard only
// covered pnpm).
//
// The trailing `(?![\w-])` matters: `\binstall\b` alone also matched the
// `install-` PREFIX of a script name, so `npm run install-assets --dir
// ~/.dsh/profiles/web` was denied as a raw mutation even though `npm run`
// never touches the dependency tree. The lookahead makes the verb a whole
// word, so `install-assets` and `add-deps` no longer trip the guard.
const PM_MUTATION = /\b(?:pnpm|npm|yarn|bun)\b[\s\S]{0,80}?\b(?:add|remove|rm|uninstall|install)(?![\w-])/
const PROFILE_DIR_MARKER = /profiles|\\.dsh|DSH_HOME/

/** Denial reason shown to the model in the tool result. */
const DENIAL_REASON =
  'Plugin installation/removal must go through the protected flow: call the plugin_install / plugin_uninstall / '
  + 'plugin_toggle tools, or run the dshpm CLI (dshpm install <pkg> --profile <name>, dshpm remove <name>, '
  + 'dshpm update <name>). Raw dsh plugin add/remove and pnpm add/remove skip the quality gate (undeclared '
  + 'imports, official-package duplicates) and can break the whole profile at runtime.'

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
 * Each shell segment (commands separated by ; newline & or |) is judged on
 * its own: a read-only dsh plugin call in one segment must not exempt a
 * mutating call in another, and a profile-dir mention in one segment must
 * not implicate a plain pnpm command in another.
 */
function isRawPluginMutation(command: string): boolean {
  for (const segment of command.split(/[;\n&|]+/)) {
    if (isDshPluginMutation(segment)) return true
    if (PM_MUTATION.test(segment) && PROFILE_DIR_MARKER.test(segment)) return true
  }
  return false
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
 * surface. Order 300 sits in the gap between the official bands PERSONA (0)
 * and PLAN_POLICY (500) — an operational constraint ahead of policy text.
 * (An earlier comment cited a "tool-guidance band 100-199"; the official
 * SECTION_ORDERS table has no such band.)
 */
export const PLUGIN_RULE_SECTION = {
  name: 'plugin-manager:install-rule',
  order: 300,
  text: 'To install, remove, update, or toggle DSH plugins, use the plugin_install / plugin_uninstall / '
    + 'plugin_toggle tools or the dshpm CLI (dshpm install <pkg> --profile <name>, dshpm remove <name>, '
    + 'dshpm update <name>). Never run raw dsh plugin add/remove or pnpm add/remove against a profile: the '
    + 'protected flow runs a quality gate (undeclared imports, official-package duplicates) and rolls back '
    + 'broken installs.',
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
