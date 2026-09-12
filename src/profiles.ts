/**
 * Profile lifecycle helpers: the running-instance process scan, terminal
 * window launching, port probing, new-profile templates and the in-box
 * bundle guard the protected install flow restores.
 */

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { connect, createServer } from 'node:net'
import { delimiter, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { dshHome, profileDir, readManifest } from './paths.ts'
import { commandEnv, resolveCommand } from './childproc.ts'
import type { CommandResult } from './types.ts'

export interface RunInfo {
  readonly port: number | null
  /** The real instance process (the node process running dsh). */
  readonly pid: number
  /** Launcher processes hosting the instance (terminal cmd/bash windows). */
  readonly launchers: readonly number[]
}

/**
 * Windows process table as "pid<TAB>command line" lines (powershell +
 * CIM). The command line contains the full node/dsh paths and the
 * --profile/--port flags, so the shared parser below works unchanged.
 */
export function windowsProcessLines(): string[] {
  try {
    const script = [
      'Get-CimInstance Win32_Process',
      "| Where-Object { $_.CommandLine -and $_.CommandLine -match 'dsh' }",
      '| ForEach-Object { $_.ProcessId.ToString() + [char]9 + $_.CommandLine }',
    ].join(' ')
    const output = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout: 15_000,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    })
    return output.split(/\r?\n/)
  } catch {
    return []
  }
}

/**
 * POSIX process table as "pid<TAB>command line" lines, read straight from
 * /proc — the Linux fast path for scanRuns (A6).
 *
 * `ps -eo pid=,args=` costs a fork+exec: median 18.0ms on a 590-process box,
 * synchronously blocking the event loop (scanRuns runs on listProfiles/list,
 * i.e. on every page load past the 3s TTL). Reading /proc/<pid>/cmdline
 * directly measures 4.7ms (3.8x) for the same information.
 *
 * `cmdline` is NUL-separated; we join on a single space because the shared
 * parser below treats "the rest of the line" as the command line and its
 * `--profile\s+(\S+)` group ends at the profile name. A NUL inside an argv
 * word would be a path separator here, so joining cannot merge two words
 * that `ps` would have kept apart in a way the parser cares about. A
 * process that exits mid-scan (ENOENT) or that we may not read (EACCES /
 * EPERM) is skipped — `ps` could not see those either.
 *
 * Returns null when /proc is unusable (macOS, BSD, a locked-down container):
 * the caller must fall back to `ps`.
 */
function procProcessLines(): string[] | null {
  let entries: string[]
  try {
    entries = readdirSync('/proc')
  } catch {
    return null
  }
  const lines: string[] = []
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    let cmdline: string
    try {
      cmdline = readFileSync('/proc/' + entry + '/cmdline', 'utf8')
    } catch {
      continue
    }
    // A kernel thread / zombie has an empty cmdline: nothing to parse.
    if (cmdline.length === 0) continue
    lines.push(entry + '\t' + cmdline.split('\0').join(' ').replace(/\s+$/, ''))
  }
  return lines
}

export function scanRuns(): Map<string, RunInfo> {
  // Collect every match per profile, then resolve the primary process: the
  // real node process when present (a .cmd/.bat shim or bash wrapper is only
  // its launcher — killing the wrapper alone would orphan the instance),
  // preferring the entry carrying a --port, as before.
  const byProfile = new Map<string, Array<{ port: number | null; pid: number; node: boolean }>>()
  try {
    // Linux/WSL: /proc direct read (A6, 18.0ms -> 4.7ms). Everywhere else
    // (macOS, BSD, Windows) keep the previous path — a missing /proc must
    // degrade to `ps`, never throw.
    const output = process.platform === 'win32'
      ? windowsProcessLines()
      : (procProcessLines() ?? execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' }).split('\n'))
    for (const line of output) {
      let match = /^\s*(\d+)\s+(.*\bdsh\b.*--profile\s+(\S+))/.exec(line)
      let profile: string | undefined
      let pid: number | undefined
      if (match !== null) {
        pid = Number(match[1]!)
        profile = match[3]!
      } else {
        // `dsh web`/`dsh headless` command mode (no --profile flag).
        match = /^\s*(\d+)\s+.*\bbin\.js\s+(\S+)/.exec(line)
        if (match !== null) {
          pid = Number(match[1]!)
          profile = match[2]!
        }
      }
      if (profile === undefined || pid === undefined) continue
      // Parse --port from the whole line (the --profile group ends at the name).
      const portMatch = /--port\s+(\d+)/.exec(line)
      const port = portMatch === null ? null : Number(portMatch[1]!)
      // A line naming node or a .js script is the real instance; a bare shim
      // (dsh.cmd / bash wrapper) is only its launcher.
      const node = /\bnode(?:\.exe)?\b|\b[\w-]+\.js\b/.test(line)
      const list = byProfile.get(profile)
      if (list === undefined) byProfile.set(profile, [{ port, pid, node }])
      else list.push({ port, pid, node })
    }
  } catch {
    /* ps/powershell unavailable: no runs reported */
  }
  const out = new Map<string, RunInfo>()
  for (const [name, matches] of byProfile) {
    const withPort = matches.filter(match => match.port !== null)
    // The primary is a real node process — prefer the one explicitly started
    // with --port (the plugin's own spawns) over a port-less default instance
    // (`dsh web`): stopping the wrong one would take down a profile the user
    // may not have started from this page.
    const node = matches.find(match => match.node && match.port !== null)
      ?? matches.find(match => match.node)
    const primary = node ?? withPort[0] ?? matches[0]!
    const port = primary.port ?? (withPort[0]?.port ?? null)
    out.set(name, {
      port,
      pid: primary.pid,
      // A launcher is only ever a shim/wrapper process (cmd/bash), never
      // another real node instance — killing that would stop a second,
      // independently running instance of the same profile.
      launchers: matches
        .filter(match => match.pid !== primary.pid && !match.node)
        .map(match => match.pid),
    })
  }
  return out
}

/**
 * scanRuns 结果的短 TTL 缓存。一次页面加载会连续触发 listProfiles + list
 * （每次都 spawn 一个 `ps` 全表扫描；Windows 上是 powershell CIM 查询，
 * 可达数秒）——运行状态变化频率低，3s 内共享一份扫描对读路径不可感知。
 * start/stop 的轮询判定必须看到即时变化，保持走 scanRuns() 实时扫描。
 */
export const SCAN_RUNS_TTL_MS = 3_000
export let scanRunsCache: { at: number; value: Map<string, RunInfo> } | null = null
export function scanRunsCached(): Map<string, RunInfo> {
  if (scanRunsCache !== null && Date.now() - scanRunsCache.at < SCAN_RUNS_TTL_MS) {
    return scanRunsCache.value
  }
  const value = scanRuns()
  scanRunsCache = { at: Date.now(), value }
  return value
}

/**
 * Cheap liveness probe: signal 0 throws ESRCH only when the pid is gone.
 * EPERM still means the process exists (owned by someone else).
 */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
/** Result of trying to open a terminal window. */
export interface TerminalOpen {
  readonly opened: boolean
  readonly terminal?: string
  readonly command?: string
}

/**
 * Prepend the tool directories the host relies on (the resolved dsh dir when
 * it was found outside PATH, plus the running node's dir) to PATH inside a
 * POSIX terminal command. Mirrors the Windows shim-dir injection: without
 * it, a terminal's bash may not have nvm loaded and `dsh`/node fail with
 * "command not found" — the instance never starts.
 */
export function commandWithPath(command: string): string {
  const dirs: string[] = []
  const tool = resolveCommand('dsh')
  if (tool.dir !== null) dirs.push(tool.dir)
  const nodeDir = dirname(process.execPath)
  if (nodeDir !== tool.dir) dirs.push(nodeDir)
  const seen = new Set<string>()
  const unique = dirs.filter(dir => (seen.has(dir) ? false : (seen.add(dir), true)))
  if (unique.length === 0) return command
  return 'export PATH=' + JSON.stringify(unique.join(delimiter) + delimiter + '$PATH') + '; ' + command
}

/**
 * Open a visible terminal window running `command`. The instance then lives
 * and dies with that terminal session — the window keeps the instance in
 * plain sight so the user never forgets a process is running. Linux probes
 * common emulators; macOS uses Terminal.app via osascript; Windows opens a
 * cmd window. Returns opened=false when nothing is available.
 */
export async function openInTerminal(command: string): Promise<TerminalOpen> {
  if (process.platform === 'darwin') {
    const final = commandWithPath(command)
    spawn('osascript', ['-e', 'tell application "Terminal" to do script "' + final.replace(/"/g, '\\"') + '"'], { stdio: 'ignore' }).unref()
    return { opened: true, terminal: 'Terminal.app', command: final }
  }
  if (process.platform === 'win32') {
    // A visible cmd window runs the command (`cmd /k` keeps it open).
    // Two compatibility fixes for the "a cmd window suddenly appears"
    // reports: windowsHide suppresses the intermediate `start` launcher
    // window (only the real window shows), and the dsh shim directory is
    // prepended to PATH so `dsh` resolves inside the new window even when
    // it is not on the user's PATH (otherwise the window opens with
    // "'dsh' is not recognized" and the instance never starts).
    const dshShim = resolveCommand('dsh')
    const env = { ...process.env }
    if (dshShim.command !== 'dsh' && dshShim.command !== 'dsh.cmd') {
      // Same Path/PATH casing tolerance as commandEnv (Explorer-started hosts).
      const path = env.PATH ?? env.Path ?? env.path ?? ''
      delete env.Path
      delete env.path
      env.PATH = dirname(dshShim.command) + (path.length > 0 ? delimiter + path : '')
    }
    spawn('cmd', ['/c', 'start', '', 'cmd', '/k', command], { stdio: 'ignore', windowsHide: true, env }).unref()
    return { opened: true, terminal: 'cmd', command }
  }
  // The user's explicit choice, then the system default terminal selector
  // (x-terminal-emulator / update-alternatives), then common emulators.
  const envTerminal = process.env.TERMINAL?.trim()
  const candidates = [
    ...(envTerminal !== undefined && envTerminal.length > 0 ? [envTerminal.split(/\s+/)[0]!] : []),
    'x-terminal-emulator', 'gnome-terminal', 'konsole', 'xterm', 'kitty', 'alacritty', 'wezterm',
  ]
  const final = commandWithPath(command)
  for (const bin of candidates) {
    if (!hasBinary(bin)) continue
    const argv = terminalArgs(bin, final)
    try {
      spawn(bin, argv, { stdio: 'ignore', windowsHide: true }).unref()
      return { opened: true, terminal: bin, command: final }
    } catch {
      /* try the next emulator */
    }
  }
  return { opened: false }
}

/** Whether a binary exists on PATH (where on Windows, which elsewhere). */
export function hasBinary(bin: string): boolean {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [bin], { stdio: 'ignore', windowsHide: true })
    return true
  } catch {
    return false
  }
}

/** Terminal-emulator specific argv for running one command and keeping the window. */
export function terminalArgs(bin: string, command: string): string[] {
  const body = ['bash', '-c', command + '; echo; read -p "Press Enter to close..."']
  switch (bin) {
    case 'gnome-terminal': return ['--', ...body]
    case 'wezterm': return ['start', '--', ...body]
    case 'konsole':
    case 'x-terminal-emulator':
    case 'xterm':
    case 'alacritty': return ['-e', ...body]
    default: return body
  }
}
/** Find the first free port from `start` upward. */
export async function findFreePort(start: number): Promise<number> {
  for (let port = start; port < start + 200; port += 1) {
    const free = await new Promise<boolean>((resolve) => {
      const server = createServer()
      server.once('error', () => resolve(false))
      server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
    })
    if (free) return port
  }
  throw new Error('no free port found')
}

/** Whether a TCP port accepts connections. */
export function probePort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1')
    const done = (ok: boolean): void => {
      socket.destroy()
      resolve(ok)
    }
    // A silently dropped SYN (firewall) would otherwise leave the promise
    // unsettled forever and hang the start-readiness loop.
    socket.setTimeout(1_000, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}
/** Official empty patch template for new profiles. */
export const PATCH_TEMPLATE = [
  "# Your patch layer for this dsh profile, applied after every bundle layer:",
  "# a top-level YAML array of loader patch entries (id-targeted config",
  "# overrides, disables, and insert lists; `!!js` expressions allowed).",
  '[]',
].join('\n') + '\n'

/** Hoisted-linker workspace for new profiles (mirrors the official template). */
export const PNPM_WORKSPACE_TEMPLATE = [
  'packages:',
  '  - .',
  '',
  'nodeLinker: hoisted',
  'autoInstallPeers: false',
  '',
].join('\n')

/** Installation-owned (in-box) bundles: never dependencies, always layers. */
export const IN_BOX_BUNDLES = [
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-headless',
] as const

/**
 * `dsh plugin` reconciles bundles from installed dependencies and drops
 * in-box bundles (base/web-app/headless are installation-owned, not
 * dependencies). Re-insert only those in-box bundles that existed before.
 */
export function restoreInBoxBundles(profile: string, before: readonly string[]): void {
  const dir = profileDir(profile)
  const path = join(dir, 'package.json')
  const manifest = readManifest(dir) as {
    dependencies?: Record<string, string>
    dsh?: { profile?: { bundles?: string[] } }
  }
  const current = manifest.dsh?.profile?.bundles ?? []
  const missing = before.filter(
    (bundle) => (IN_BOX_BUNDLES as readonly string[]).includes(bundle) && !current.includes(bundle),
  )
  if (missing.length === 0) return
  const next = [...current]
  for (const bundle of missing) {
    // Insert after the previous bundle's position to keep the prior order.
    const beforeIndex = before.indexOf(bundle)
    const anchor = before[beforeIndex - 1]
    const at = anchor === undefined ? 0 : next.indexOf(anchor) + 1
    next.splice(at, 0, bundle)
  }
  manifest.dsh = manifest.dsh ?? {}
  manifest.dsh.profile = manifest.dsh.profile ?? {}
  manifest.dsh.profile.bundles = next
  writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n')
}
