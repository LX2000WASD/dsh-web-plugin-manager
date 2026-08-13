/**
 * Plugin Catalog tab: the official inventory look (search + card list),
 * shadowing the official read-only tab (same slot id 'all', lower priority)
 * and adding live enable/disable, installed/built-in filtering (built-ins
 * hidden by default), and sorting (default / A-Z / enabled × asc/desc).
 */

import { useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import {
  Button, IconChevronDownOutline14, IconSearchOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { MutationResult, PluginManagerSnapshot, ProfileInfo, RuntimeEntry } from '../types.ts'
import type { PluginManagerLocaleKey } from './locales.ts'

/** Registration-side Remote face provided by the section. */
export interface PluginCatalogTabInjected {
  readonly profiles: () => Promise<ProfileInfo[]>
  readonly list: (profile: string) => Promise<PluginManagerSnapshot>
  readonly setEnabled: (profile: string, entryId: string, enabled: boolean) => Promise<MutationResult>
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
  card: {
    minWidth: 0, overflow: 'hidden',
    border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '10px',
    background: 'var(--dsw-alias-bg-layer-3)',
  },
  cardOpen: { borderColor: 'var(--dsw-alias-border-l1)', boxShadow: 'var(--dsw-shadow-lv1)' },
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

/** Whether an entry is user-installed (a profile dependency or insert row). */
function isInstalled(entry: RuntimeEntry, snapshot: PluginManagerSnapshot): boolean {
  const packageNames = new Set(snapshot.packages.map(pkg => pkg.name))
  const insertNames = new Set(snapshot.insertRows.map(row => row.name))
  const insertIds = new Set(snapshot.insertRows.map(row => row.id))
  return packageNames.has(entry.moduleName)
    || insertNames.has(entry.moduleName)
    || insertIds.has(entry.entryId)
}

/** Render the catalog (shadows the official read-only inventory). */
export function PluginCatalogTab({ profiles, list, setEnabled, t }: PluginCatalogTabProps): ReactNode {
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

  const refresh = (profile: string): void => {
    if (profile.length === 0) return
    setState({ status: 'loading' })
    void list(profile).then(
      (snapshot) => setState({ status: 'ready', snapshot }),
      (error: unknown) => setState({ status: 'error', message: error instanceof Error ? error.message : String(error) }),
    )
  }

  useEffect(() => {
    void profiles().then((items) => {
      setProfileList(items)
      if (items.length > 0) {
        // Default to the profile hosting this running plugin, else the first.
        const current = items.find(profile => profile.isCurrent === true) ?? items[0]!
        setSelected(current.name)
        refresh(current.name)
      } else {
        setState({ status: 'ready', snapshot: undefined as unknown as PluginManagerSnapshot })
      }
    }, (error: unknown) => {
      setState({ status: 'error', message: error instanceof Error ? error.message : String(error) })
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profiles])

  const onSelect = (name: string): void => {
    setSelected(name)
    setExpanded(null)
    refresh(name)
  }

  const onToggle = async (entryId: string, enable: boolean): Promise<void> => {
    if (selected.length === 0) return
    if (!enable && !window.confirm(t('confirmDisable'))) return
    setBusy(entryId)
    try {
      const result = await setEnabled(selected, entryId, enable)
      setExpanded(null)
      refresh(selected)
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
      if (filter === 'installed' && !isInstalled(entry, snapshot)) return false
      if (filter === 'builtin' && isInstalled(entry, snapshot)) return false
      if (normalizedQuery.length === 0) return true
      return entry.entryId.toLocaleLowerCase().includes(normalizedQuery)
        || entry.moduleName.toLocaleLowerCase().includes(normalizedQuery)
    })
    const sorted = [...filtered]
    if (sort === 'az') {
      sorted.sort((a, b) => a.moduleName.localeCompare(b.moduleName))
    } else if (sort === 'enabled') {
      sorted.sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.moduleName.localeCompare(b.moduleName))
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

  return (
    <div style={styles.section}>
      <div style={styles.toolbar}>
        <label htmlFor="pm-profile" style={{ ...styles.filterLabel, display: 'inline-flex', alignItems: 'center' }}>{t('profileLabel')}</label>
        <select
          id="pm-profile"
          style={styles.select}
          value={selected}
          disabled={profileList.length === 0 || busy !== null}
          onChange={(event) => onSelect(event.target.value)}
        >
          {profileList.map((profile) => (
            <option key={profile.name} value={profile.name}>{profile.name}</option>
          ))}
        </select>
        <Button size="sm" variant="ghost" disabled={selected.length === 0 || busy !== null} onClick={() => refresh(selected)}>
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
            <select
              style={styles.select}
              value={filter}
              onChange={(event) => setFilter(event.currentTarget.value as CatalogFilter)}
            >
              <option value="installed">{t('filterInstalled')}</option>
              <option value="builtin">{t('filterBuiltin')}</option>
              <option value="all">{t('filterAll')}</option>
            </select>
            <span style={styles.filterLabel}>{t('sortLabel')}</span>
            <select
              style={styles.select}
              value={sort}
              onChange={(event) => setSort(event.currentTarget.value as CatalogSort)}
            >
              <option value="default">{t('sortDefault')}</option>
              <option value="az">{t('sortAz')}</option>
              <option value="enabled">{t('sortEnabled')}</option>
            </select>
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
                const installed = isInstalled(entry, snapshot)
                const open = expanded === entry.entryId
                const detailId = catalogId + '-details-' + encodeURIComponent(entry.entryId)
                return (
                  <li
                    key={entry.entryId}
                    style={open ? { ...styles.card, ...styles.cardOpen } : styles.card}
                    data-plugin-entry={entry.entryId}
                    data-open={open ? 'true' : undefined}
                  >
                    <button
                      style={styles.cardContent}
                      type="button"
                      aria-expanded={open}
                      aria-controls={detailId}
                      onClick={() => setExpanded(current => current === entry.entryId ? null : entry.entryId)}
                    >
                      <strong style={styles.cardTitle} title={entry.moduleName}>{title}</strong>
                      <span style={styles.cardTrailing}>
                        {installed ? <span style={{ ...styles.configTag, ...styles.configTagOn }}>{t('installedBadge')}</span> : null}
                        {entry.enabled ? (
                          <span
                            style={dotStyle(entry.fiberPhase)}
                            data-phase={entry.fiberPhase ?? 'unobserved'}
                            role="img"
                            aria-label={phaseLabel(entry.fiberPhase)}
                            title={phaseLabel(entry.fiberPhase)}
                          />
                        ) : null}
                        <span style={{ ...styles.configTag, ...(entry.enabled ? styles.configTagOn : {}) }} data-enabled={entry.enabled ? 'true' : 'false'}>
                          {entry.enabled ? t('enabled') : t('disabled')}
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
                        <code style={styles.entryValue} data-loader-entry>{entry.entryId}</code>
                        <dl style={styles.details}>
                          <div>
                            <dt>{t('module')}</dt>
                            <dd>{entry.moduleName}</dd>
                          </div>
                          <div>
                            <dt>{t('phase')}</dt>
                            <dd>{phaseLabel(entry.fiberPhase)}</dd>
                          </div>
                        </dl>
                        <div style={{ marginTop: '10px', display: 'flex', justifyContent: 'flex-end' }}>
                          <Button
                            size="sm"
                            variant={entry.enabled ? 'ghost' : 'primary'}
                            disabled={busy !== null}
                            onClick={() => void onToggle(entry.entryId, !entry.enabled)}
                          >
                            {entry.enabled ? t('disableButton') : t('enableButton')}
                          </Button>
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
