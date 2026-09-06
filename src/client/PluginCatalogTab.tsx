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
import type { MutationResult, PluginManagerSnapshot, PresetCompositionGroup, ProfileInfo, RuntimeEntry } from '../types.ts'
import { fuzzyScore } from '../rank.ts'
import type { PluginManagerLocaleKey } from './locales.ts'
import { PM_CARD_CSS, isAbortError, useConfirm } from './shared.ts'
import { PmSelect } from './PmSelect.tsx'

/** Registration-side Remote face provided by the section. Load-path methods
 *  take an optional trailing AbortSignal so a superseded fetch can be
 *  cancelled; mutating commands deliberately cannot be aborted. */
export interface PluginCatalogTabInjected {
  readonly profiles: (signal?: AbortSignal) => Promise<ProfileInfo[]>
  readonly list: (profile: string, signal?: AbortSignal) => Promise<PluginManagerSnapshot>
  readonly setEnabled: (profile: string, entryId: string, enabled: boolean) => Promise<MutationResult>
  readonly mount: (profile: string, packageName: string) => Promise<MutationResult>
  /** Agent preset compositions (official 0.1.3 parity); null pre-0.1.3. */
  readonly presetCompositions: () => Promise<PresetCompositionGroup[] | null>
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
  // snapshot stays optional: a profile list with no entries renders the
  // ready-empty state (no `undefined as unknown` casts).
  | { readonly status: 'ready'; readonly snapshot?: PluginManagerSnapshot }

/** Official --dsw-* token styles (mirrors the official inventory tab). */
const styles = {
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
  presetCard: { padding: '10px 14px 12px' },
  presetHead: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
  presetRow: { display: 'flex', alignItems: 'center', gap: '8px', padding: '3px 0', minWidth: 0 },
  presetCondition: {
    fontFamily: 'var(--ds-font-family-code)', fontSize: '10px', lineHeight: '14px',
    color: 'var(--dsw-alias-label-tertiary)',
  },
} satisfies Record<string, React.CSSProperties>

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
export function PluginCatalogTab({ profiles, list, setEnabled, mount, presetCompositions, t }: PluginCatalogTabProps): ReactNode {
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
  // 行内二次确认：停用是危险操作（依赖它的条目可能拖垮 profile），
  // 第一次点击只点亮确认态，再点才执行，4 秒无操作自动复位。
  const [confirmKey, setConfirmKey] = useConfirm()
  // Toggle/mount failures render here (window.alert blocks the main thread
  // and offered no visible trail).
  const [actionError, setActionError] = useState('')
  // Agent preset compositions (official 0.1.3 inventory parity; best-effort).
  const [compositions, setCompositions] = useState<PresetCompositionGroup[] | null>(null)

  // Stable identity for the once-only boot effect: injected faces may be
  // rebuilt by the slot renderer on parent re-renders, and depending on them
  // would re-run the load and grow the list on every interaction.
  const injected = useRef({ profiles, list, setEnabled, mount, presetCompositions })

  useEffect(() => {
    // The boot profiles fetch joins the same abort group so an unmount (or
    // the StrictMode double-invoke) during it stays silent.
    loadAbort.current?.abort()
    const controller = new AbortController()
    loadAbort.current = controller
    void injected.current.profiles(controller.signal).then((items) => {
      setProfileList(items)
      if (items.length > 0) {
        // Default to the profile RUNNING this instance (multiple profiles can
        // host the manager; the running one is the "current environment"),
        // else one hosting the manager, else the first.
        const current = items.find(profile => profile.running !== null)
          ?? items.find(profile => profile.isCurrent === true)
          ?? items[0]!
        setSelected(current.name)
        load(current.name)
      } else {
        setState({ status: 'ready' })
      }
    }, (error: unknown) => {
      if (isAbortError(error)) return
      setState({ status: 'error', message: error instanceof Error ? error.message : String(error) })
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Request sequence guard: a slow response from an earlier profile must not
  // overwrite the state of the currently selected one (audit M8).
  const loadSeq = useRef(0)
  // Abort handle of the in-flight load: a profile switch cancels the stale
  // fetch outright instead of letting it race (and possibly error against)
  // the newer one. Mutating commands never share this controller — they
  // must not be cancellable.
  const loadAbort = useRef<AbortController | null>(null)
  // Unmount must cancel the in-flight load; the guards drop any late
  // response after that, but the request itself should not linger.
  useEffect(() => () => { loadAbort.current?.abort() }, [])
  /** Returns the in-flight request so callers can chain busy handling. */
  const load = (profile: string): Promise<void> => {
    if (profile.length === 0) return Promise.resolve()
    const seq = ++loadSeq.current
    loadAbort.current?.abort()
    const controller = new AbortController()
    loadAbort.current = controller
    // Keep showing the previous snapshot during refreshes so the page does
    // not collapse to the top (only the first load shows the loading state).
    setState(current => current.status === 'ready' ? current : { status: 'loading' })
    // Composition data is host-global (not per-profile) and purely additive:
    // fetched in parallel, never aborted with the listing, failures silent.
    void injected.current.presetCompositions().then(
      (groups) => { if (seq === loadSeq.current) setCompositions(groups) },
      () => { if (seq === loadSeq.current) setCompositions(null) },
    )
    return injected.current.list(profile, controller.signal).then(
      (snapshot) => { if (seq === loadSeq.current) setState({ status: 'ready', snapshot }) },
      (error: unknown) => {
        // An aborted fetch is a cancellation, not a failure: the newer load
        // (or the unmount) owns the UI now.
        if (isAbortError(error)) return
        if (seq === loadSeq.current) setState({ status: 'error', message: error instanceof Error ? error.message : String(error) })
      },
    )
  }

  /** Refresh button: guarded against repeated clicks, with feedback. */
  const onRefresh = (): void => {
    if (selected.length === 0) return
    setBusy('refresh')
    void load(selected).finally(() => setBusy(null))
  }

  const onSelect = (name: string): void => {
    setSelected(name)
    setExpanded(null)
    setConfirmKey(null)
    setActionError('')
    load(name)
  }

  const onToggle = async (entryId: string, enable: boolean): Promise<void> => {
    if (selected.length === 0) return
    if (!enable && confirmKey !== entryId) {
      setConfirmKey(entryId)
      return
    }
    setConfirmKey(null)
    setBusy(entryId)
    setActionError('')
    try {
      const result = await injected.current.setEnabled(selected, entryId, enable)
      // A graceful failure (HTTP 200 + ok:false) must not look like a
      // no-op — the message explains why nothing changed.
      if (!result.ok) setActionError(result.message)
      setExpanded(null)
      load(selected)
    } catch (error: unknown) {
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(null)
    }
  }

  /** Mount an installed-but-unmounted dependency as a managed insert row. */
  const onMount = async (packageName: string): Promise<void> => {
    if (selected.length === 0) return
    setBusy(packageName)
    setActionError('')
    try {
      const result = await injected.current.mount(selected, packageName)
      if (!result.ok) setActionError(result.message)
      setExpanded(null)
      load(selected)
    } catch (error: unknown) {
      setActionError(error instanceof Error ? error.message : String(error))
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
      // 模糊过滤（官方 rankByName 语义）：子序列命中，涵盖并超越旧的
      // 子串匹配——'plgmgr' 也能命中 'plugin-manager'。
      return fuzzyScore(entry.entryId, normalizedQuery) !== null
        || fuzzyScore(entry.moduleName, normalizedQuery) !== null
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

  // Precomputed phase dot styles (was rebuilt per row per render).
  const DOT_ACTIVE = { ...styles.statusDot, ...styles.statusDotActive }
  const DOT_FAILED = { ...styles.statusDot, ...styles.statusDotFailed }
  const DOT_LOADING = { ...styles.statusDot, ...styles.statusDotLoading }
  const dotStyle = (phase: string | null): React.CSSProperties => {
    if (phase === 'active') return DOT_ACTIVE
    if (phase === 'failed') return DOT_FAILED
    if (phase === 'loading' || phase === 'pending') return DOT_LOADING
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
      <style>{PM_CARD_CSS + `
.pm-card[data-modified='true'] {
  border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 55%, transparent);
}
.pm-card[data-modified='true'][data-open='true'] {
  border-color: var(--dsw-alias-state-warn-secondary);
}
`}</style>
      <div style={styles.toolbar}>
        <span style={styles.filterLabel}>{t('profileLabel')}</span>
        <PmSelect
          ariaLabel={t('profileLabel')}
          disabled={busy !== null}
          value={selected}
          options={profileList.map(profile => ({ value: profile.name, label: profile.name }))}
          onChange={onSelect}
        />
        <Button size="sm" variant="ghost" disabled={selected.length === 0 || busy !== null} onClick={onRefresh}>
          {busy === 'refresh' ? t('refreshing') : t('refresh')}
        </Button>
      </div>

      {actionError.length > 0 && <p style={styles.error} role="alert">{t('error')}: {actionError}</p>}
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
                    style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 53px' }}
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
                              variant={entry.enabled ? (confirmKey === entry.entryId ? 'primary' : 'ghost') : 'primary'}
                              disabled={busy !== null}
                              title={entry.enabled ? t('confirmDisable') : undefined}
                              onClick={() => void onToggle(entry.entryId, !entry.enabled)}
                            >
                              {entry.enabled
                                ? (confirmKey === entry.entryId ? t('fixConfirm') : t('disableButton'))
                                : t('enableButton')}
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

          {compositions !== null && compositions.length > 0 && (
            <>
              <div style={styles.heading}>
                <h3 style={styles.headingTitle}>{t('presetGroups')}</h3>
                <span style={styles.headingCount}>{compositions.length}</span>
              </div>
              {compositions.map(group => (
                <div key={group.id} className="pm-card" style={styles.presetCard}>
                  <div style={styles.presetHead}>
                    <strong style={styles.cardTitle} title={group.id}>{group.name ?? group.id}</strong>
                    {group.isDefault && (
                      <span style={{ ...styles.configTag, ...styles.configTagOn }}>{t('presetDefault')}</span>
                    )}
                    {group.broken !== undefined && (
                      <span style={styles.error}>{t('presetBroken')}: {group.broken}</span>
                    )}
                  </div>
                  {group.rows.map((row, index) => (
                    <div key={(row.entryId ?? row.moduleName) + '-' + String(index)} style={styles.presetRow}>
                      <span
                        style={dotStyle(row.fiberPhase)}
                        data-phase={row.fiberPhase ?? 'unobserved'}
                        role="img"
                        aria-label={phaseLabel(row.fiberPhase)}
                        title={phaseLabel(row.fiberPhase)}
                      />
                      <span style={styles.entryValue}>{row.moduleName}</span>
                      {row.condition !== undefined && (
                        <code style={styles.presetCondition} title={row.condition}>!!js</code>
                      )}
                      <span style={styles.configTag}>
                        {row.enabled === 'conditional' ? t('presetConditional')
                          : row.enabled === 'enabled' ? t('enabled') : t('disabled')}
                      </span>
                    </div>
                  ))}
                  {group.rows.length === 0 && group.broken === undefined && (
                    <p style={styles.status}>{t('presetNoRows')}</p>
                  )}
                </div>
              ))}
            </>
          )}
        </>
      )}
    </div>
  )
}
