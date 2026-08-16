# dsh-web-plugin-manager

[中文](./README.md) | [English](./README.en.md)

[![npm version](https://img.shields.io/npm/v/dsh-web-plugin-manager)](https://www.npmjs.com/package/dsh-web-plugin-manager)
[![License](https://img.shields.io/npm/l/dsh-web-plugin-manager)](LICENSE)

Manage DeepSeek Harness (DSH) plugins from the Web UI: inspect, live enable/disable, install/remove, update checks, health checks (dependency/conflict/compatibility analysis), environment management, and a plugin marketplace. Covers both bundle and non-bundle plugins.

> Install the manager first, then other plugins: it ships a quality gate and health checks (full dependency scan at install time, bundle patch-row validation, install-time rollback; afterwards you can run dependency-graph/conflict/cycle/peer-compatibility analysis). Every later install passes through the gate, which greatly reduces "installed, then the profile fails to boot". A broken plugin is intercepted and rolled back while the profile stays bootable.
>
> If an unverified plugin already prevents the profile from starting: debug with `dsh --profile <name> --patch <empty.yml>` or manually clean the dependency / `cordis.patch.yml` rows, then install the manager to take over.

## Install

```sh
# Option 1 (recommended): from npm (always pin @latest)
dsh plugin --profile <name> add dsh-web-plugin-manager@latest

# Option 2: build from source
cd /path/to/dsh-web-plugin-manager
pnpm install && pnpm run build
dsh plugin --profile <name> add .
```

After restarting the profile, "Settings" gains a "Plugin Manager" tab plus "Skills & Presets" and "Marketplace" top-level entries.

## Update

```sh
# CLI (recommended): upgrade to latest (rewrites the specifier; quality gate + automatic rollback)
dshpm update dsh-web-plugin-manager --profile NAME
# Equivalent (pnpm semantics)
dsh plugin --profile NAME add dsh-web-plugin-manager@latest
```

Self-update from the UI: open "Settings → Plugin Manager", "Check updates" lists every installed package (including the manager itself); click "Update" on a card to upgrade, with automatic rollback to the previous version on failure. Restart the profile afterwards.

Notes:

- `add` without a version does not upgrade: when the profile already declares an old range (e.g. `^0.1.2`), `dsh plugin add` (pnpm add) keeps the existing specifier; `dsh plugin update` (pnpm update) only re-resolves within the declared range. Cross-major upgrades must use `add ...@latest` or `dshpm update`.
- If `@latest` resolves to an old version: check `pnpm config get registry` for a mirror (npmmirror dist-tags lag + pnpm metadata cache); force the official registry with `pnpm add dsh-web-plugin-manager@latest --registry=https://registry.npmjs.org`. Pinning an explicit version (e.g. `@0.3.8`) always works.
- pnpm 11 users: pnpm 11 defaults to `minimumReleaseAge: 1440` (24 h) — releases younger than 24 h are withheld, so "released today, update today" fails or resolves to an older version. Add `minimumReleaseAge: 0` (or a `minimumReleaseAgeExclude` whitelist) to the profile's `pnpm-workspace.yaml`; dsh does not overwrite that file.

## CLI (dshpm)

When a user asks an AI to install a plugin, the AI tends to run a bare `dsh plugin add` / `pnpm add` — bypassing every protection. This package ships the `dshpm` bin (installed with the plugin into the profile's node_modules; also invocable as `node <profile>/node_modules/dsh-web-plugin-manager/dist/cli.js`), and every mutation goes through the same protected path as the Web UI (quality gate + rollback + analysis + insert-row bookkeeping):

```sh
dshpm install <source> [--env KEY=value ...] --profile <name>   # npm name / github:user/repo / git URL / tarball / local path
dshpm remove <name>    --profile <name>   # cleans insert rows + package dependency
dshpm update <name>    --profile <name>   # upgrade to @latest (specifier rewrite, quality gate + rollback)
dshpm mount <name>     --profile <name>   # mount an installed-but-unmounted dependency as an insert row
dshpm uninstall-kind <owner/repo> [--profile <name>]  # uninstall a marketplace-installed skill/preset/cordis plugin
dshpm list             --profile <name>   # bundle layer stack / installed packages / insert rows
dshpm analyze          --profile <name>   # health check; exit code 1 when issues exist
```

When a git-source plugin needs install-time environment variables, the CLI prints the missing variable list and the exact `--env KEY=value` re-run command (non-interactive).

## Features

| Capability | Description |
|---|---|
| Inspect | Merged view of layer stack / dependencies / mount rows / live entries; manually installed unmounted dependencies show "unmounted" with one-click mount |
| Live toggle/unmount | Managed blocks edit the patch, applied directly through the loader; live, persistent across restarts; removing an installed plugin (bundles included) unmounts its live entries and leftover managed blocks in the same step, so the client boot table drops the entry immediately (a refresh never tries to load a deleted bundle script) |
| Install | Official dsh plugin CLI + quality gate + automatic rollback; non-bundle plugins get an insert row and live mount; git sources clone automatically, npm-published repos prefer npm; multi-kind install: skills (SKILL.md → `~/.dsh/skills`, hot-reloaded) and agent presets (agent.cordis.yml → `~/.dsh/.agent-presets`, immediately visible to the official discovery) install directly with records; repos that are neither plugin/skill/preset are refused and added to the marketplace blocklist; git-source installs scan for required env vars (TOKEN/KEY/SECRET shapes) and pause for them — answers are injected only from the scan whitelist (no PATH/HOME injection) and host credentials never reach third-party scripts |
| Update | Update checks (npm dist-tag / git HEAD / installed commit), updates run the quality gate with rollback; includes self-update — update the manager from the Manage tab, failure reinstalls the previous version |
| Health check | Dependency graph / missing imports / cycles / duplicate row ids / same-name registration conflicts (services/tools/sections/routes) / peer versions / duplicate official packages; live diagnostics add pending and failure states; A-level issues fix in one click, B-level suggestions confirm first |
| Environments | Start/stop, copy/transfer plugins, create/rename/remove profiles (official profiles read-only), backup export/import with diff-based protected restore |
| Marketplace | Static index (topic:dsh-plugin, ~3100 entries, multi-source fallback + gzip + disk cache with freshness gating) + curated awesome overlay + dsh.so independent verification/security badges (L1-L5 + risk level); server-side installed detection (package/repository both directions, git sources, directory probes); update detection (index version comparison); same-name deduplication; 24 h cache, timeout budget, proxy support, negative caching |
| Agent tools | plugin_status/search/install/uninstall/toggle + install guard (blocks raw commands and points at the protected surface) + injected prompt section; plugin_search free-text marketplace search (name/topics/description weighting) |

Detailed feature and limitation documentation: [docs/feature-reference.md](docs/feature-reference.md) (shipped with the repo and the npm package).

## Architecture

- Host: `src/index.ts` — `PluginManagerService` (`ctx.pluginManager`) + `/api2/plugin-manager/*` REST routes (with a trust fence: POST+JSON enforced, loopback/whitelist Host check, Origin same-origin — CSRF/DNS-rebinding protection); the install chain installWithSource→installProtected (quality gate + rollback) is fully serialized by a mutation mutex
- Live application: `src/live.ts` — patch changes are applied directly through the loader include entry (`entry.update`, the same channel as the platform's watchUserPatches) before writing the file, bypassing a platform deadlock (a watcher refresh that unloads the timer row HMR depends on causes circular waiting); compensates `applyEntryPatches`' in-place mutation of patch objects (deep clone + baked-value normalization); a plugin-owned patch watcher keeps manual edits live; package removal unmounts every loader row mounting it (remove-by-name, tolerant of baked override fields) so stale client entries never reference deleted bundle scripts
- Analysis engine: `src/analyze.ts` — offline dependency/conflict/compatibility analysis (shares the scanner with the quality gate); runtime diagnostics read `ctx.reflect` active service tables
- Patch editing: `src/patch.ts` — managed marker blocks (`# dsh-plugin-manager:managed:start/end`) append/remove (insert/disable kinds), line-level edits, atomic writes (tmp + rename); handles YAML traps (`@` package quoting, empty-array documents, comments-only files)
- Env scanning: `src/scan.ts` — install-time env requirement scan (2 levels / 40 files / 8 vars cap) + sensitive-key stripping for subprocess env; `src/installSession.ts` session state machine (15 min TTL, answers whitelist validation)
- Agent tools: `src/tools.ts` — dependency-injected to avoid cycles; install guard `src/guard.ts` denies raw `dsh plugin`/npm/yarn/bun/pnpm mutations (read-only verbs pass) and the denial reason points at `plugin_*` tools and `dshpm`; a `systemPrompt.section` states the same rule
- CLI: `src/cli.ts` — reuses the protected chain (ctx may be null: without a host process live application is skipped; file-level behavior identical to the Web UI)
- Client: `src/client/` — registers `settings.plugins.tab` (shadows the official read-only inventory + manager) and `settings.section` (marketplace/kinds); same-origin fetch against the REST surface
- Transport: official webServer routes + same-origin fetch (no Typert Remote)

## Known limitations

- Disabling a depended-on entry can prevent the profile from starting (official fail-loud design); recovery: manually remove the managed block from the profile's `cordis.patch.yml`
- Installing a git bundle requires approving `pnpm allowBuilds` in a terminal (the output echoes the command)
- Random rows (mounts without explicit ids) cannot be toggled here (ids change every mount)
- Git sub-package installs: multi-package repos use the `#路径:<dir>` convention (the subdirectory must stay inside the clone cache)
- The quality gate may reject plugins that omit runtime dependency declarations (conservative policy; whitelisting is possible)
- Official packages must be peerDependencies (a regular dependency installs a second copy and hijacks official loader rows)
- The install guard only intercepts agent tool calls, not manual terminal commands
- Update-check edges: local-directory installs (non-git) report "not checkable"; git-URL sources need the installed commit in the manifest (gitHead); user-owned git workspaces are compared read-only (no fetch) and report "cannot reach the remote" when offline instead of "no update"
- Health checks are static best-effort: same-name conflicts rely on source regex scanning (dynamically composed names are missed); semantic conflicts without a shared name are out of scope
- Manually installed plugins are never auto-mounted: the manager shows "unmounted" with a mount action / `dshpm mount`, without changing profile behavior on its own
- Env filtering covers common sensitive key shapes (TOKEN/KEY/SECRET/PASSWORD/PASS/CREDENTIAL); other host variables still reach the pnpm resolution process of git-source installs (which are link semantics and never execute third-party scripts)
- Marketplace entries come from the awesome directory; some repos may have been deleted or made private
- Marketplace proxy: the host reads `HTTP_PROXY`/`HTTPS_PROXY`; system-proxy/rule-mode accelerators do not apply to Node processes (undici ignores system proxy) — export the proxy as env vars or use TUN/global mode
- The index project (DSH-Plugins-Marketplace) is third-party maintained: index data issues are covered by the curated overlay and the install quality gate; unauthenticated GitHub API rate limits (60/h) only affect star enrichment for catalog-only entries (small; stops on 403/429, listing unaffected)
- nvm users: child processes resolve commands as "running node's directory → PATH → $NVM_DIR" with PATH injection — hosts started outside an nvm-activated shell still work; only when dsh itself is not installed do you need an nvm-activated terminal

## Development

```sh
pnpm run build   # host: tsc (standard decorator transpilation); client: tsdown
pnpm test        # pure-function unit tests (node --test against the dist output)
```

> Lessons learned: the host must be built with tsc (tsdown/rolldown keep native decorator syntax, which Node rejects); the plugin must not export both a default class and named apply — the Loader drops apply. New host source files must be added to tsconfig.host.json's include list.

## Related

- Source & issues: [github.com/LX2000WASD/dsh-web-plugin-manager](https://github.com/LX2000WASD/dsh-web-plugin-manager)
- Marketplace index data: [DSH-Plugins-Marketplace](https://github.com/bradeGithub/DSH-Plugins-Marketplace) (topic:dsh-plugin full index, third-party maintained)
- Curated data: [awesome-dsh-plugins](https://github.com/AdamPlatin123/awesome-dsh-plugins)
- dsh.so verification & security data: [dsh.so](https://www.dsh.so) (independent plugin verification L1–L5 and automated security scans, third-party maintained; overlaid as badges only, never an install source)
- License: MIT
