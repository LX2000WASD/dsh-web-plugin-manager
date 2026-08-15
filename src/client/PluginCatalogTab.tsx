/**
 * Plugin Catalog tab: the official inventory look (search + card list),
 * shadowing the official read-only tab (same slot id 'all', lower priority)
 * and adding live enable/disable, installed/built-in filtering (built-ins
 * hidden by default), and sorting (default / A-Z / enabled × asc/desc).
 */

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Button, IconChevronDownOutline14, IconSearchOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { MutationResult, PluginManagerSnapshot, ProfileInfo, RuntimeEntry } from '../types.ts'
import type { PluginManagerLocaleKey } from './locales.ts'
import { PmSelect } from './PmSelect.tsx'

/** Registration-side Remote face provided by the section. */
export interface PluginCatalogTabInjected {
  readonly profiles: () => Promise<ProfileInfo[]>
  readonly list: (profile: string) => Promise<PluginManagerSnapshot>
  readonly setEnabled: (profile: string, entryId: string, enabled: boolean) => Promise<MutationResult>
  readonly mount: (profile: string, packageName: string) => Promise<MutationResult>
}

/** Full component props assembled by the Settings slot renderer. */
export type PluginCatalogTabProps =
  PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'settings.pluginManager'>
  & InjectFace<PluginCatalogTabInjected>

/** Which rows the catalog shows. */
export type CatalogFilter = 'installed' | 'builtin' | 'all'

/** Sort key for the catalog. */
export type CatalogSort = 'default' | 'az' | 'enabled'

type ViewState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'ready'; readonly snapshot: PluginManagerSnapshot }

/** Official --dsw-* token styles (mirrors the official inventory tab). */
const styles: Record<string, React.CSSProperties> = {
  section: {
    display: 'flex', flexDirection: 'column', gap: '14px',
    width: '100%', maxWidth: '760px', color: 'var(--dsw-alias-label-primary)',
  },
  toolbar: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
  heading: { display: 'flex', alignItems: 'baseline', gap: '7px', padding: '0 2px' },
  headingTitle: { margin: 0, fontSize: '13px', lineHeight: '20px', fontWeight: 600 },
  headingCount: {
    fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)',
    fontVariantNumeric: 'tabular-nums',
  },
  search: {
    display: 'flex', alignItems: 'center', gap: '8px', width: '100%', height: '36px',
    border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '8px',
    padding: '0 12px', boxSizing: 'border-box',
    background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-tertiary)',
  },
  searchInput: {
    flex: 1, minWidth: 0, border: 0, outline: 'none', background: 'transparent',
    color: 'var(--dsw-alias-label-primary)', font: 'inherit', fontSize: '13px',
  },
  cards: {
    display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    alignItems: 'start', gap: '10px', margin: 0, padding: 0, listStyle: 'none',
  },
  // Card look is driven by injected CSS classes (pm-card / pm-card-content):
  // state (open, modified) and focus-visible styling are pure CSS attribute
  // selectors, so no inline style can go stale when a card collapses.
  cardContent: {
    boxSizing: 'border-box', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    gap: '12px', width: '100%', minHeight: '52px', border: 0, padding: '12px 14px',
    background: 'transparent', color: 'inherit', font: 'inherit', textAlign: 'left', cursor: 'pointer',
  },
  cardTitle: {
    minWidth: 0, overflow: 'hidden', fontSize: '14px', lineHeight: '20px', fontWeight: 600,
    textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  cardTrailing: { display: 'inline-flex', flex: 'none', alignItems: 'center', gap: '7px' },
  statusDot: {
    display: 'inline-block', width: '7px', height: '7px', flex: 'none',
    borderRadius: '999px', background: 'var(--dsw-alias-label-tertiary)',
  },
  statusDotActive: { background: 'var(--dsw-alias-state-success-primary)' },
  statusDotFailed: { background: 'var(--dsw-alias-state-error-primary)' },
  statusDotLoading: { background: 'var(--dsw-alias-state-business-primary)' },
  configTag: {
    display: 'inline-flex', alignItems: 'center', minHeight: '20px', borderRadius: '5px',
    padding: '1px 6px', background: 'var(--dsw-alias-bg-layer-1)',
    color: 'var(--dsw-alias-label-secondary)', fontSize: '11px', lineHeight: '16px', whiteSpace: 'nowrap',
  },
  configTagOn: {
    background: 'color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent)',
    color: 'var(--dsw-alias-state-success-primary)',
  },
  chevron: { flex: 'none', color: 'var(--dsw-alias-label-tertiary)', transition: 'transform 140ms var(--ds-ease-in-out)' },
  chevronOpen: { transform: 'rotate(180deg)' },
  cardDetails: {
    borderTop: '1px solid var(--dsw-alias-border-l2)', padding: '10px 14px 12px',
    background: 'var(--dsw-alias-bg-module-platform)',
  },
  entryValue: {
    display: 'block', overflowWrap: 'anywhere', color: 'var(--dsw-alias-label-primary)',
    fontFamily: 'var(--ds-font-family-code)', fontSize: '12px', lineHeight: '18px',
  },
  details: {
    display: 'grid', gridTemplateColumns: '76px minmax(0, 1fr)', gap: '6px 10px',
    margin: '8px 0 0', color: 'var(--dsw-alias-label-tertiary)', fontSize: '11px', lineHeight: '17px',
  },
  detailsRow: { display: 'contents' },
  status: { fontSize: '13px', lineHeight: '20px', color: 'var(--dsw-alias-label-tertiary)', margin: 0 },
  error: { fontSize: '13px', lineHeight: '20px', color: 'var(--dsw-alias-state-error-primary)', margin: 0 },
  select: {
    height: '36px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '8px',
    padding: '0 10px', outline: 'none', background: 'var(--dsw-alias-bg-layer-1)',
    color: 'var(--dsw-alias-label-primary)', font: 'inherit', fontSize: '13px',
  },
  filterRow: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
  filterLabel: { fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
}

/** Compact a module specifier like the official inventory. */
function moduleShortName(moduleName: string): string {
  const unscoped = moduleName.startsWith('@') ? moduleName.slice(moduleName.indexOf('/') + 1) : moduleName
  return unscoped
    .replace(/^cordis:/, '')
    .replace(/^cordis-plugin-/, '')
    .replace(/^dsh-(?:host-|client-)?/, '')
}

/** Author:module display id (@scope/pkg → scope:pkg, else local:name). */
function authorModule(moduleName: string): string {
  if (moduleName.startsWith('@')) {
    const rest = moduleName.slice(1)
    const slash = rest.indexOf('/')
    if (slash > 0) return rest.slice(0, slash) + ':' + rest.slice(slash + 1)
  }
  return 'local:' + moduleName
}

/** Render the catalog (shadows the official read-only inventory). */
export function PluginCatalogTab({ profiles, list, setEnabled, mount, t }: PluginCatalogTabProps): ReactNode {
  const catalogId = useId()
  const [profileList, setProfileList] = useState<ProfileInfo[]>([])
  const [selected, setSelected] = useState<string>('')
  const [state, setState] = useState<ViewState>({ status: 'loading' })
  const [busy, setBusy] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<CatalogFilter>('installed')
  const [sort, setSort] = useState<CatalogSort>('default')
  const [descending, setDescending] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)

  // Stable identity for the once-only boot effect: injected faces may be
  // rebuilt by the slot renderer on parent re-renders, and depending on them
  // would re-run the load and grow the list on every interaction.
  const injected = useRef({ profiles, list, setEnabled, mount })

  useEffect(() => {
    void injected.current.profiles().then((items) => {
      setProfileList(items)
      if (items.length > 0) {
        // Default to the profile hosting this running plugin, else the first.
        const current = items.find(profile => profile.isCurrent === true) ?? items[0]!
        setSelected(current.name)
        load(current.name)
      } else {
        setState({ status: 'ready', snapshot: undefined as unknown as PluginManagerSnapshot })
      }
    }, (error: unknown) => {
      setState({ status: 'error', message: error instanceof Error ? error.message : String(error) })
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const load = (profile: string): void => {
    if (profile.length === 0) return
    // Keep showing the previous snapshot during refreshes so the page does
    // not collapse to the top (only the first load shows the loading state).
    setState(current => current.status === 'ready' ? current : { status: 'loading' })
    void injected.current.list(profile).then(
      (snapshot) => setState({ status: 'ready', snapshot }),
      (error: unknown) => setState({ status: 'error', message: error instanceof Error ? error.message : String(error) }),
    )
  }

  const onSelect = (name: string): void => {
    setSelected(name)
    setExpanded(null)
    load(name)
  }

  const onToggle = async (entryId: string, enable: boolean): Promise<void> => {
    if (selected.length === 0) return
    if (!enable && !window.confirm(t('confirmDisable'))) return
    setBusy(entryId)
    try {
      const result = await injected.current.setEnabled(selected, entryId, enable)
      setExpanded(null)
      load(selected)
    } finally {
      setBusy(null)
    }
  }

  /** Mount an installed-but-unmounted dependency as a managed insert row. */
  const onMount = async (packageName: string): Promise<void> => {
    if (selected.length === 0) return
    setBusy(packageName)
    try {
      const result = await injected.current.mount(selected, packageName)
      setExpanded(null)
      load(selected)
      if (!result.ok) window.alert(result.message)
    } finally {
      setBusy(null)
    }
  }

  const snapshot = state.status === 'ready' ? state.snapshot : undefined
  const normalizedQuery = query.trim().toLocaleLowerCase()

  const rows = useMemo(() => {
    if (snapshot === undefined) return []
    const base = snapshot.entries
    const filtered = base.filter((entry) => {
      if (filter === 'installed' && !entry.installed) return false
      if (filter === 'builtin' && entry.installed) return false
      if (normalizedQuery.length === 0) return true
      return entry.entryId.toLocaleLowerCase().includes(normalizedQuery)
        || entry.moduleName.toLocaleLowerCase().includes(normalizedQuery)
    })
    const sorted = [...filtered]
    // Sort by the displayed short name (what the user sees), tie-break on the
    // full package name so equal short names (e.g. host hmr vs client hmr)
    // keep a deterministic order.
    const byDisplay = (a: RuntimeEntry, b: RuntimeEntry): number =>
      moduleShortName(a.moduleName).localeCompare(moduleShortName(b.moduleName))
        || a.moduleName.localeCompare(b.moduleName)
    if (sort === 'az') {
      sorted.sort(byDisplay)
    } else if (sort === 'enabled') {
      sorted.sort((a, b) => Number(b.enabled) - Number(a.enabled) || byDisplay(a, b))
    }
    if (descending) sorted.reverse()
    return sorted
  }, [snapshot, filter, sort, descending, normalizedQuery])

  useEffect(() => {
    if (expanded !== null && !rows.some(entry => entry.entryId === expanded)) setExpanded(null)
  }, [expanded, rows])

  const dotStyle = (phase: string | null): React.CSSProperties => {
    if (phase === 'active') return { ...styles.statusDot, ...styles.statusDotActive }
    if (phase === 'failed') return { ...styles.statusDot, ...styles.statusDotFailed }
    if (phase === 'loading' || phase === 'pending') return { ...styles.statusDot, ...styles.statusDotLoading }
    return styles.statusDot
  }

  const phaseLabel = (phase: string | null): string => {
    if (phase === null) return t('unobserved')
    if (phase === 'pending') return t('pending')
    if (phase === 'loading') return t('loadingPhase')
    if (phase === 'active') return t('active')
    if (phase === 'failed') return t('failed')
    return t('unloading')
  }

  const cordisLabel = (phase: string | null, tfn: PluginCatalogTabProps['t']): string => {
    if (phase === 'active') return tfn('mounted')
    if (phase === null) return tfn('notMounted')
    if (phase === 'pending') return tfn('pending')
    if (phase === 'loading') return tfn('loadingPhase')
    if (phase === 'failed') return tfn('failed')
    return tfn('unloading')
  }

  return (
    <div style={styles.section}>
      <style>{`
.pm-card {
  min-width: 0; overflow: hidden;
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px;
  background: var(--dsw-alias-bg-layer-3);
}
.pm-card[data-open='true'] { border-color: var(--dsw-alias-border-l1); }
.pm-card[data-modified='true'] {
  border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 55%, transparent);
}
.pm-card[data-modified='true'][data-open='true'] {
  border-color: var(--dsw-alias-state-warn-secondary);
}
.pm-card-content:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary);
  outline-offset: -2px;
}
`}</style>
      <div style={styles.toolbar}>
        <span style={styles.filterLabel}>{t('profileLabel')}</span>
        <PmSelect
          ariaLabel={t('profileLabel')}
          value={selected}
          options={profileList.map(profile => ({ value: profile.name, label: profile.name }))}
          onChange={onSelect}
        />
        <Button size="sm" variant="ghost" disabled={selected.length === 0 || busy !== null} onClick={() => load(selected)}>
          {t('refresh')}
        </Button>
      </div>

      {state.status === 'error' && <p style={styles.error} role="alert">{t('error')}: {state.message}</p>}
      {state.status === 'loading' && <p style={styles.status} aria-busy="true">{t('loading')}</p>}

      {snapshot !== undefined && (
        <>
          <label style={styles.search}>
            <IconSearchOutline16 aria-hidden="true" />
            <input
              type="search"
              style={styles.searchInput}
              value={query}
              placeholder={t('search')}
              aria-label={t('search')}
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
          </label>

          <div style={styles.filterRow}>
            <span style={styles.filterLabel}>{t('filterLabel')}</span>
            <PmSelect
              ariaLabel={t('filterLabel')}
              value={filter}
              options={[
                { value: 'installed', label: t('filterInstalled') },
                { value: 'builtin', label: t('filterBuiltin') },
                { value: 'all', label: t('filterAll') },
              ]}
              onChange={(value) => setFilter(value as CatalogFilter)}
            />
            <span style={styles.filterLabel}>{t('sortLabel')}</span>
            <PmSelect
              ariaLabel={t('sortLabel')}
              value={sort}
              options={[
                { value: 'default', label: t('sortDefault') },
                { value: 'az', label: t('sortAz') },
                { value: 'enabled', label: t('sortEnabled') },
              ]}
              onChange={(value) => setSort(value as CatalogSort)}
            />
            <Button size="sm" variant="ghost" onClick={() => setDescending(current => !current)}>
              {descending ? t('sortDesc') : t('sortAsc')}
            </Button>
          </div>

          <div style={styles.heading}>
            <h3 style={styles.headingTitle}>{t('catalog')}</h3>
            <span style={styles.headingCount} data-plugin-count={rows.length}>{rows.length}</span>
          </div>
          {snapshot.entries.length === 0 ? <p style={styles.status}>{t('noEntries')}</p> : null}
          {snapshot.entries.length > 0 && rows.length === 0
            ? <p style={styles.status}>{t('emptyFilter')}</p>
            : null}
          {rows.length > 0 ? (
            <ul style={styles.cards}>
              {rows.map((entry) => {
                const title = moduleShortName(entry.moduleName)
                const open = expanded === entry.entryId
                const detailId = catalogId + '-details-' + encodeURIComponent(entry.entryId)
                return (
                  <li
                    key={entry.entryId}
                    className="pm-card"
                    data-plugin-entry={entry.entryId}
                    data-open={open ? 'true' : undefined}
                    data-modified={entry.modified && !entry.installed ? 'true' : undefined}
                  >
                    <button
                      className="pm-card-content"
                      style={styles.cardContent}
                      type="button"
                      aria-expanded={open}
                      aria-controls={detailId}
                      onClick={() => setExpanded(current => current === entry.entryId ? null : entry.entryId)}
                    >
                      <strong style={styles.cardTitle} title={entry.moduleName}>{title}</strong>
                      <span style={styles.cardTrailing}>
                        {entry.enabled ? (
                          <span
                            style={dotStyle(entry.fiberPhase)}
                            data-phase={entry.fiberPhase ?? 'unobserved'}
                            role="img"
                            aria-label={phaseLabel(entry.fiberPhase)}
                            title={phaseLabel(entry.fiberPhase)}
                          />
                        ) : null}
                        <span
                          style={{ ...styles.configTag, ...(entry.enabled && !entry.unmounted ? styles.configTagOn : {}) }}
                          data-enabled={entry.enabled ? 'true' : 'false'}
                          data-unmounted={entry.unmounted ? 'true' : undefined}
                        >
                          {entry.unmounted ? t('unmountedTag') : entry.enabled ? t('enabled') : t('disabled')}
                        </span>
                        <span
                          style={open ? { ...styles.chevron, ...styles.chevronOpen } : styles.chevron}
                          role="presentation"
                        >
                          <IconChevronDownOutline14 size={12} aria-hidden="true" />
                        </span>
                      </span>
                    </button>
                    {open ? (
                      <div style={styles.cardDetails} id={detailId}>
                        <code style={styles.entryValue} data-loader-entry>{authorModule(entry.moduleName)}</code>
                        <dl style={styles.details}>
                          <div style={styles.detailsRow}>
                            <dt>{t('configState')}</dt>
                            <dd>{entry.enabled ? t('enabled') : t('disabled')}</dd>
                          </div>
                          <div style={styles.detailsRow}>
                            <dt>{t('cordisState')}</dt>
                            <dd>{entry.unmounted ? t('unmountedHint') : cordisLabel(entry.fiberPhase, t)}</dd>
                          </div>
                        </dl>
                        <div style={{ marginTop: '10px', display: 'flex', justifyContent: 'flex-end' }}>
                          {entry.unmounted ? (
                            <Button
                              size="sm"
                              variant="primary"
                              disabled={busy !== null}
                              onClick={() => void onMount(entry.moduleName)}
                            >
                              {busy === entry.moduleName ? t('mounting') : t('mountButton')}
                            </Button>
                          ) : (
                            <Button
                              size="sm"
                              variant={entry.enabled ? 'ghost' : 'primary'}
                              disabled={busy !== null}
                              onClick={() => void onToggle(entry.entryId, !entry.enabled)}
                            >
                              {entry.enabled ? t('disableButton') : t('enableButton')}
                            </Button>
                          )}
                        </div>
                      </div>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          ) : null}
        </>
      )}
    </div>
  )
}
