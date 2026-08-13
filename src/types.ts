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

/** One marketplace plugin entry (from the GitHub topic search). */
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
  /** Creation time. */
  readonly createdAt: string
  /** Repository URL (the git install source). */
  readonly url: string
  /** Catalog status (e.g. ✅ verified, 待测 pending). */
  readonly status?: string
}

/** Marketplace listing result. */
export interface MarketplaceResult {
  readonly ok: boolean
  readonly items: readonly MarketplaceItem[]
  /** When the cached snapshot was fetched (ISO), when served from cache. */
  readonly cachedAt?: string
  readonly fromCache: boolean
  readonly message: string
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
