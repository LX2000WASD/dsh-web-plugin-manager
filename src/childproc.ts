/**
 * Child-process toolbox: nvm/volta-aware command resolution, PATH-injected
 * child environments, the official `dsh plugin` runner, and the async
 * exec-with-timeout helper every network/subprocess probe uses.
 */

import { execFile, execFileSync } from 'node:child_process'
import { accessSync, constants, existsSync, readdirSync, statSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import type { CommandResult } from './types.ts'

/**
 * Resolve a command to its executable path, preferring an absolute path so
 * the caller can also inject its directory into child PATH.
 *
 * Resolution order (POSIX):
 *   1. the directory of the running node — nvm/volta/fnm layouts put npm,
 *      npx, pnpm and dsh right next to `process.execPath`. This is also the
 *      toolchain the profile's node_modules were installed with, so it is
 *      preferred over a PATH hit: a PATH `npm`/node from a different
 *      (system) version would explode with module/engine mismatches. Under
 *      a normal nvm host this is the same directory PATH would find;
 *   2. plain PATH lookup — covers tools not installed per-node (git, dsh
 *      via a global manager like pnpm/volta);
 *   3. any nvm-installed node version's bin directory ($NVM_DIR) — rescues
 *      hosts started by absolute path (desktop launcher, service, nohup)
 *      where nvm's PATH setup never ran in this process;
 *   4. the bare name — let the child surface the error.
 *
 * The returned `dir` is the directory the command lives in when it was NOT
 * found on PATH (null when PATH resolution succeeded) — prepend it to child
 * PATH so the tool's own children (a dsh shim's `node`, the CLI's `pnpm`)
 * resolve with the same toolchain.
 *
 * Windows keeps the `where` lookup: the npm CLI shims are .cmd/.bat files
 * (dsh, npm, ...) that `execFile`/spawn cannot run by bare name (no PATHEXT
 * lookup) — the full shim path is needed (Node >= 20.12 then executes
 * .cmd/.bat files natively).
 */
export interface ResolvedCommand {
  /** Absolute executable path (or the bare name when nothing resolved). */
  readonly command: string
  /** Directory to prepend to child PATH, or null when already on PATH. */
  readonly dir: string | null
  /** Win32 only: true when command is a cmd/bat shim that spawn must run through a shell. */
  readonly shell?: boolean
}

/** Absolute path of `name` on PATH (POSIX walk; no shell involved). */
export function pathLookup(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir.length === 0) continue
    const candidate = join(dir, name)
    try {
      if (statSync(candidate).isFile()) {
        accessSync(candidate, constants.X_OK)
        return candidate
      }
    } catch { /* not executable here: keep walking */ }
  }
  return undefined
}

/** Resolve a command to an absolute path (see above for the resolution order). */
export function resolveCommand(name: string): ResolvedCommand {
  if (process.platform !== 'win32') {
    const nextToNode = join(dirname(process.execPath), name)
    if (existsSync(nextToNode)) {
      return { command: nextToNode, dir: dirname(process.execPath) }
    }
    const onPath = pathLookup(name)
    if (onPath !== undefined) return { command: onPath, dir: null }
    // Any nvm-installed node version's bin dir (the host node may be a copy
    // outside $NVM_DIR, e.g. launched via an absolute path).
    const nvmRoot = process.env.NVM_DIR ?? join(homedir(), '.nvm')
    try {
      const versions = join(nvmRoot, 'versions', 'node')
      for (const entry of readdirSync(versions, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const bin = join(versions, entry.name, 'bin')
        if (existsSync(join(bin, name))) return { command: join(bin, name), dir: bin }
      }
    } catch { /* no nvm layout */ }
    return { command: name, dir: null }
  }
  try {
    // Console code page 936 (GBK CJK systems) makes `where` emit GBK bytes;
    // decoding them as UTF-8 mangles non-ASCII usernames into a non-existent
    // path. Switch the console to UTF-8 first (same chcp pattern as resolveExec).
    const comspec = process.env.ComSpec ?? process.env.comspec ?? 'cmd.exe'
    const output = execFileSync(comspec, ['/d', '/s', '/c', 'chcp 65001 >nul & where ' + name], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    })
    const hits = output.split(String.fromCharCode(10)).map(line => line.trim()).filter(line => line.length > 0)
    // npm/nvm shims live as BOTH the bare script and the .cmd wrapper: the
    // extensionless file cannot be spawned (ENOENT) — prefer an executable
    // extension, and flag cmd/bat shims so spawns go through a shell.
    const hit = hits.find(h => h.toLowerCase().endsWith('.exe'))
      ?? hits.find(h => h.toLowerCase().endsWith('.cmd'))
      ?? hits.find(h => h.toLowerCase().endsWith('.bat'))
      ?? hits[0]
    if (hit !== undefined) {
      const lower = hit.toLowerCase()
      const shell = lower.endsWith('.cmd') || lower.endsWith('.bat')
      return { command: hit, dir: dirname(hit), ...(shell ? { shell: true } : {}) }
    }
  } catch { /* not on PATH: let the caller surface the error */ }
  return { command: name, dir: null }
}

/**
 * Canonical spawn form for a resolved command. Win32 .cmd/.bat shims cannot
 * be spawned directly (CreateProcess) and must NOT go through spawn's
 * shell:true either — Node only concatenates args (DEP0190) and the shim's
 * own quoted lines break under cmd /c re-parsing. Instead spawn cmd.exe
 * directly with the quoted batch path and quoted args as ONE command-line
 * argument (the cross-spawn pattern, with windowsVerbatimArguments so Node
 * passes it through untouched).
 */
export function resolveExec(tool: ResolvedCommand, args: readonly string[]): { command: string; args: readonly string[]; verbatim: boolean } {
  if (tool.shell !== true) return { command: tool.command, args, verbatim: false }
  // cmd /s strips only the first and last quote characters, so the batch
  // path alone is quoted and arguments are quoted ONLY when they need it
  // (spaces / cmd specials); bare tokens stay bare (cross-spawn pattern).
  // A chcp 65001 prefix switches the spawned console to UTF-8 first: on CJK
  // systems cmd writes error messages in the legacy code page (GBK), which
  // Node would otherwise misread as UTF-8 mojibake.
  //
  // cmd re-parses the command line even INSIDE quotes: `& | < > ^` are
  // operators and `%` starts variable expansion, so a hostile spec (install
  // source, package name) could inject extra commands (audit M18). Escape
  // them (`^` caret prefix; `%` doubled) on every argument before quoting.
  const escape = (a: string): string => a.replace(/%/g, '%%').replace(/([&|<>^])/g, '^$1')
  const comspec = process.env.ComSpec ?? process.env.comspec ?? 'cmd.exe'
  const quotedArgs = args.length > 0
    ? ' ' + args.map(a => /[\s&|<>^%()]/.test(a) ? '"' + escape(String(a)).replace(/"/g, '""') + '"' : escape(String(a))).join(' ')
    : ''
  return {
    command: comspec,
    args: ['/d', '/s', '/c', 'chcp 65001 >nul & "' + tool.command + '"' + quotedArgs],
    verbatim: true,
  }
}

/** Child env with directories prepended to PATH (null dir → base env). */
export function commandEnv(dir: string | null, base?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (dir === null && process.platform !== 'win32') return base ?? process.env
  const env = { ...(base ?? process.env) }
  const parts: string[] = []
  // Win32: spawned .cmd shims resolve node through PATH, but the host
  // process may run under a different environment than the user's shell
  // (nvm-activated terminal): inject the host node's directory so shims
  // always find node.
  if (process.platform === 'win32') parts.push(dirname(process.execPath))
  if (dir !== null) parts.push(dir)
  // Windows env blocks name the key `Path` (Explorer-started processes) and a
  // plain-object spread keeps that casing — reading only env.PATH would drop
  // System32 etc. and break every spawned .cmd shim (chcp not recognized).
  const path = env.PATH ?? env.Path ?? env.path ?? ''
  delete env.Path
  delete env.path
  env.PATH = [...parts, path].filter(p => p.length > 0).join(delimiter)
  return env
}

/** Run `dsh plugin --profile <name> <verb> <args...>` and collect output. */
export function runDshPlugin(
  profile: string,
  verb: string,
  args: readonly string[],
  cwd: string,
  env?: NodeJS.ProcessEnv,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const tool = resolveCommand('dsh')
    const exec = resolveExec(tool, ['plugin', '--profile', profile, verb, ...args])
    execFile(
      exec.command,
      exec.args,
      { cwd, timeout: 10 * 60 * 1000, maxBuffer: 4 * 1024 * 1024, env: commandEnv(tool.dir, env), ...(exec.verbatim ? { windowsVerbatimArguments: true } : {}) },
      (error, stdout, stderr) => {
        const output = [stdout, stderr].filter(Boolean).join('\n')
        if (error === null) {
          resolve({ ok: true, exitCode: 0, output })
        } else {
          const code = typeof error.code === 'number' ? error.code : null
          if (code === null && (error as NodeJS.ErrnoException).code === 'ENOENT') {
            resolve({
              ok: false,
              exitCode: null,
              output: '[plugin-manager] could not start the dsh CLI (' + error.message + '). '
                + 'Install it if missing (npm i -g dsh), or start this profile from a shell where node/npm/dsh are on PATH '
                + '(nvm: run the profile from an nvm-active terminal, e.g. after `nvm use`).',
            })
          } else {
            resolve({ ok: code === 0, exitCode: code, output })
          }
        }
      },
    )
  })
}
/** Run a command with a timeout, resolving (never throwing) with the output. */
export function execFileTimeout(cmd: string, args: readonly string[], timeoutMs: number): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const tool = resolveCommand(cmd)
    const exec = resolveExec(tool, [...args])
    execFile(
      exec.command,
      exec.args,
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true, env: commandEnv(tool.dir), ...(exec.verbatim ? { windowsVerbatimArguments: true } : {}) },
      (error, stdout, stderr) => {
        const output = [stdout, stderr].filter(Boolean).join('\n')
        if (error === null) resolve({ ok: true, output })
        else resolve({ ok: false, output })
      },
    )
  })
}
