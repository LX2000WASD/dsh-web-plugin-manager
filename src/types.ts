/**
 * Shared types for dsh-plugin-manager.
 * Wire-safe JSON shapes crossing the Host/Client Remote boundary.
 */

/** One discovered profile under $DSH_HOME/profiles. */
export interface ProfileInfo {
  /** Directory name under profiles/. */
  readonly name: string
  /** Absolute profile directory path. */
  readonly path: string
  /** Bundles listed in dsh.profile.bundles (ordered layer stack). */
  readonly bundles: readonly string[]
  /** Direct npm dependencies declared in the profile package.json. */
  readonly dependencies: readonly string[]
  /** Whether this profile hosts the running plugin-manager (its dependency). */
  readonly isCurrent: boolean
  /** Whether this is an official built-in profile (web/headless, never managed). */
  readonly isOfficial: boolean
  /** Running instance info (from process scan), when this profile is live. */
  readonly running: { readonly port: number | null; readonly pid: number } | null
}

/** One plugin entry in the composed Loader tree (runtime view). */
export interface RuntimeEntry {
  /** Loader entry id (patch row id). */
  readonly entryId: string
  /** Module specifier (bare package name or relative path). */
  readonly moduleName: string
  /** Whether the entry is currently enabled (not disabled by patch). */
  readonly enabled: boolean
  /** Live fiber phase: pending/loading/active/failed/unloading, null when unobserved. */
  readonly fiberPhase: 'pending' | 'loading' | 'active' | 'failed' | 'unloading' | null
  /** Whether this entry is user-installed (profile dependency or insert row). */
  readonly installed: boolean
  /** Whether the user patch layer explicitly manages this row (deviates from defaults). */
  readonly modified: boolean
  /**
   * Whether this is an installed dependency with NO mount row at all (a
   * manual install through the official CLI or pnpm — the official CLI
   * never writes insert rows). Such a plugin is not loaded and needs a
   * mount action before it can be enabled/disabled.
   */
  readonly unmounted: boolean
}

/** One installable/installed package's management view. */
export interface ManagedPackage {
  /** npm package name or bundle name. */
  readonly name: string
  /** Whether this package declares dsh.bundle (joins the layer stack). */
  readonly isBundle: boolean
  /** Whether this package is listed in dsh.profile.bundles. */
  readonly inLayerStack: boolean

  /** Installed version from the package manifest. */
  readonly version?: string
  /** Install time (node_modules link mtime). */
  readonly installedAt?: string
  /** Upstream repository URL from the package manifest, when declared. */
  readonly repository?: string
  /** The dependency value that installed it (npm range, link:path, git spec). */
  readonly source?: string
}

/** One insert row (non-bundle plugin mount) in the profile patch file. */
export interface InsertRow {
  /** Insert row id (the mounted entry id). */
  readonly id: string
  /** Module specifier (package name) the row mounts. */
  readonly name: string
  /** Whether the row lives inside a plugin-manager managed block. */
  readonly managed: boolean
}

/** Complete snapshot for one profile. */
export interface PluginManagerSnapshot {
  readonly profile: ProfileInfo
  /** Live Loader entries (non-group). */
  readonly entries: readonly RuntimeEntry[]
  /** Installed packages with bundle status. */
  readonly packages: readonly ManagedPackage[]
  /** Insert rows (non-bundle plugin mounts) in the profile patch file. */
  readonly insertRows: readonly InsertRow[]
}

/** Result of an enable/disable mutation. */
export interface MutationResult {
  readonly ok: boolean
  readonly message: string
}

/** One marketplace plugin entry (registry index + curated catalog merged). */
export interface MarketplaceItem {
  /** Repository name (owner/repo). */
  readonly name: string
  /** Display name (repo basename). */
  readonly displayName: string
  readonly description?: string
  /** Star count. */
  readonly stars: number
  /** Last push time. */
  readonly updatedAt: string
  /** Creation time (registry index does not carry it — may be empty). */
  readonly createdAt: string
  /** Repository URL (the git install source). */
  readonly url: string
  /** Catalog status (e.g. ✅ verified, 待测 pending, archived). */
  readonly status?: string
  /** Published npm package name (registry pkg_name or curated catalog). */
  readonly packageName?: string
  /** Category stamp (registry classifier or curated catalog). */
  readonly category?: string
  /** Catalog lifecycle state (active / archived / ...), when known. */
  readonly lifecycle?: string
  /** Real repository topics (eco-generic tags filtered server-side). */
  readonly topics?: readonly string[]
  /** dsh.so independent verification (L1 found … L5 feature-tested). */
  readonly verification?: { readonly level: number; readonly label: string }
  /** dsh.so automated security scan result. */
  readonly security?: { readonly riskLevel: string; readonly status: string }
  /** Latest version from the registry index (repo package.json, CI-fetched). */
  readonly latestVersion?: string
  /** Whether the queried profile has this plugin installed (server-side). */
  readonly installed: boolean
  /** Installed version in the queried profile, when detected. */
  readonly installedVersion?: string
  /** Install kind from the marketplace record (skill/agent-preset/cordis-plugin). */
  readonly installedKind?: string
  /** Whether a newer version than the installed one is available. */
  readonly updateAvailable: boolean
}

/** Marketplace listing result. */
export interface MarketplaceResult {
  readonly ok: boolean
  readonly items: readonly MarketplaceItem[]
  /** When the cached snapshot was fetched (ISO), when served from cache. */
  readonly cachedAt?: string
  readonly fromCache: boolean
  readonly message: string
  /** Data source of the listing: registry | catalog | cache | search. */
  readonly source?: string
  /** How many entries were hidden by the same-package deduplication. */
  readonly dropped?: number
  /** Total entries after deduplication. */
  readonly total?: number
  /** How many repositories are blocked (non-plugin/skill/preset detection). */
  readonly blocked?: number
  /** Blocked repository names (first 20), for the unblock surface. */
  readonly blockedRepos?: readonly string[]
}

/** One kind-install record as surfaced to the Manage tab. */
export interface KindRecordView {
  /** Normalized repository key (owner/repo). */
  readonly repo: string
  /** Install kind: skill | agent-preset | cordis-plugin | instructions. */
  readonly type: string
  /** Display name (single install). */
  readonly name: string | null
  /** All installed names. */
  readonly names: string[] | null
  /** Install location. */
  readonly location: string | null
  /** Installed version, when the kind carries one. */
  readonly version: string | null
  /** ISO install time. */
  readonly installedAt: string
}

/** Kind-install overview for the Manage tab. */
export interface KindListView {
  readonly records: readonly KindRecordView[]
  /** Directory names under <dshHome>/skills. */
  readonly skills: readonly string[]
  /** Directory names under <dshHome>/.agent-presets. */
  readonly presets: readonly string[]
}

/** One profile's install manifest inside a backup file. */
export interface BackupProfile {
  readonly name: string
  /** Bundle layer stack. */
  readonly bundles: readonly string[]
  /** Dependencies: name → install source (npm range / git URL / link path). */
  readonly dependencies: Record<string, string>
}

/** Backup file: install manifests + marketplace kind records (reinstallable list). */
export interface BackupFile {
  readonly app: string
  readonly appVersion?: string
  readonly exportedAt: string
  readonly profiles: readonly BackupProfile[]
  /** Marketplace-installed skills/presets (global, not profile-scoped). */
  readonly kinds: readonly KindRecordView[]
}

/** One restorable entry in a backup diff. */
export interface BackupDiffEntry {
  readonly profile: string
  readonly name: string
  readonly source: string
  /** kind: skill | agent-preset | cordis-plugin. */
  readonly kind: string
}

/** Diff between a backup and the current installation state. */
export interface BackupDiffResult {
  readonly ok: boolean
  /** Entries to reinstall. */
  readonly missing: readonly BackupDiffEntry[]
  /** Entries already present (skipped). */
  readonly already: readonly string[]
  /** Profiles in the backup that do not exist locally (create them first). */
  readonly missingProfiles: readonly string[]
  /** Entries that cannot be restored (local-path sources no longer present). */
  readonly unrestorable: readonly string[]
}

/** Result of launching a profile instance. */
export interface StartResult {
  readonly ok: boolean
  /** Allocated port, when the instance started. */
  readonly port?: number
  /** Browser URL of the started instance. */
  readonly url?: string
  readonly message: string
}

/** Result of an install/remove subprocess run. */
export interface CommandResult {
  readonly ok: boolean
  readonly exitCode: number | null
  readonly output: string
  /** Real package names resolved from the profile manifest after install. */
  readonly installed?: readonly string[]
}

/** One package's update-check result. */
export interface UpdateInfo {
  /** Package name. */
  readonly name: string
  /** Whether a newer version is available. */
  readonly hasUpdate: boolean
  /** Installed version from the package manifest, when known. */
  readonly currentVersion?: string
  /** Latest available version (npm dist-tag latest / git remote ref). */
  readonly latestVersion?: string
  /** Install source kind: npm | git | local | unknown. */
  readonly source: string
  /** Human-readable note (why it cannot be checked, what was compared…). */
  readonly message?: string
}

/** Batch update-check result. */
export interface UpdateCheckResult {
  readonly ok: boolean
  readonly items: readonly UpdateInfo[]
  readonly message: string
}

/** One package participating in the dependency analysis. */
export interface AnalyzePackage {
  readonly name: string
  /** Whether the package declares dsh.bundle (joins the layer stack). */
  readonly isBundle: boolean
  /** Installed version. */
  readonly version?: string
  /** Bare specifiers its entry imports (relative/node: excluded). */
  readonly imports: readonly string[]
  /** Services the entry source registers (best-effort scan). */
  readonly services: readonly string[]
  /** Services the entry injects (best-effort scan of inject declarations). */
  readonly injects: readonly string[]
  /** Tool names the entry registers (best-effort scan of tools.register). */
  readonly tools: readonly string[]
  /** Prompt-section names the entry registers (best-effort scan of systemPrompt.section). */
  readonly sections: readonly string[]
  /** Web route paths the entry registers (best-effort scan of webServer.register). */
  readonly routes: readonly string[]
  /** Row id that mounts this package, when known. */
  readonly rowId?: string
  /** Whether the package's row is disabled in the patch. */
  readonly disabled: boolean
}

/** One dependency edge (from → provider). */
export interface AnalyzeEdge {
  readonly from: string
  readonly to: string
  /** The import specifier that created the edge. */
  readonly specifier: string
}

/** One analysis finding. */
export interface AnalyzeIssue {
  readonly kind:
    | 'missing-import'
    | 'disabled-dependency'
    | 'circular-dependency'
    | 'duplicate-row-id'
    | 'peer-mismatch'
    | 'service-conflict'
    | 'tool-conflict'
    | 'section-conflict'
    | 'route-conflict'
    | 'official-duplicate'
    | 'pending-dependency'
    | 'load-failure'
  readonly message: string
  readonly from?: string
  readonly to?: string
  /** Cycle members for circular-dependency issues. */
  readonly cycle?: readonly string[]
}

/** Full analysis result for one profile. */
export interface AnalyzeResult {
  readonly ok: boolean
  readonly packages: readonly AnalyzePackage[]
  readonly edges: readonly AnalyzeEdge[]
  /** Topological order of the package dependency graph (load order hint). */
  readonly topoOrder: readonly string[]
  readonly issues: readonly AnalyzeIssue[]
}
