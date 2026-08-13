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
}

/** One installable/installed package's management view. */
export interface ManagedPackage {
  /** npm package name or bundle name. */
  readonly name: string
  /** Whether this package declares dsh.bundle (joins the layer stack). */
  readonly isBundle: boolean
  /** Whether this package is listed in dsh.profile.bundles. */
  readonly inLayerStack: boolean
  /** Disabled-by-manager patch ids affecting rows this package owns, if any. */
  readonly managedDisabledIds: readonly string[]
}

/** Complete snapshot for one profile. */
export interface PluginManagerSnapshot {
  readonly profile: ProfileInfo
  /** Live Loader entries (non-group). */
  readonly entries: readonly RuntimeEntry[]
  /** Installed packages with bundle status. */
  readonly packages: readonly ManagedPackage[]
}

/** Result of an enable/disable mutation. */
export interface MutationResult {
  readonly ok: boolean
  readonly message: string
}

/** Result of an install/remove subprocess run. */
export interface CommandResult {
  readonly ok: boolean
  readonly exitCode: number | null
  readonly output: string
}
