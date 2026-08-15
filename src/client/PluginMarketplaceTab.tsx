/**
 * Plugin Marketplace tab (settings.section first-level entry): browse the
 * merged marketplace (static registry index + curated catalog), with
 * server-side installed detection, update availability and install/update
 * actions per card.
 *
 * Rendering is incremental: the first PAGE cards render immediately and the
 * rest appear as the sentinel enters the viewport (IntersectionObserver),
 * with `content-visibility: auto` letting the browser skip off-screen work —
 * a ~3000-entry listing stays responsive without server-side paging.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Button, IconSearchOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { CommandResult, MarketplaceItem, MarketplaceResult, MutationResult, ProfileInfo } from '../types.ts'
import type { PluginManagerLocaleKey } from './locales.ts'
import { PmSelect } from './PmSelect.tsx'

/** Registration-side Remote face provided by the section. */
export interface PluginMarketplaceTabInjected {
  readonly marketplace: (refresh: boolean, profile: string) => Promise<MarketplaceResult>
  readonly profiles: () => Promise<ProfileInfo[]>
  readonly install: (profile: string, spec: string) => Promise<CommandResult>
  readonly update: (profile: string, name: string) => Promise<CommandResult>
  readonly unblock: (repo: string) => Promise<MutationResult>
}

/** Full component props assembled by the Settings section renderer. */
export type PluginMarketplaceTabProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings.pluginManager'>
  & InjectFace<PluginMarketplaceTabInjected>

type ViewState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'ready'; readonly result: MarketplaceResult }

type MarketSort = 'stars' | 'az' | 'updated' | 'created'

/** Cards rendered per incremental batch, and the initial batch size. */
const RENDER_BATCH = 120
/** localStorage key for the column preference. */
const COLS_KEY = 'dshpm-market-cols'

/** Official --dsw-* token styles (mirrors the other pages). */
const styles: Record<string, React.CSSProperties> = {
  section: {
    display: 'flex', flexDirection: 'column', gap: '14px',
    width: '100%', maxWidth: '760px', color: 'var(--dsw-alias-label-primary)',
  },
  toolbar: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
  heading: { display: 'flex', alignItems: 'baseline', gap: '7px', padding: '0 2px' },
  pageTitle: {
    margin: 0, fontSize: '16px', lineHeight: '24px', fontWeight: 600,
    color: 'var(--dsw-alias-label-primary)',
  },
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
    minWidth: 0, maxWidth: '100%', overflow: 'hidden',
    border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '10px',
    background: 'var(--dsw-alias-bg-layer-3)',
    // Skip off-screen layout/paint until the card approaches the viewport.
    contentVisibility: 'auto',
    containIntrinsicSize: 'auto 132px',
  },
  cardRow: {
    boxSizing: 'border-box', display: 'flex', alignItems: 'center', gap: '8px',
    width: '100%', minHeight: '52px', padding: '10px 14px',
  },
  cardTitle: {
    flex: '1 1 auto', minWidth: 0, overflow: 'hidden', fontSize: '14px', lineHeight: '20px',
    fontWeight: 600, textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  cardAction: { flex: 'none', display: 'inline-flex', alignItems: 'center', gap: '6px' },
  cardDesc: {
    display: 'block', minWidth: 0, overflow: 'hidden', fontSize: '12px', lineHeight: '17px',
    color: 'var(--dsw-alias-label-secondary)', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  meta: {
    fontSize: '11px', lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary)',
    fontVariantNumeric: 'tabular-nums',
  },
  cardMetaRow: {
    display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap',
    // Fixed minimum: rows without any tag still occupy the same height as
    // rows with a tag (uniform card heights).
    minHeight: '28px', padding: '0 14px 8px',
  },
  tagOn: {
    background: 'color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent)',
    color: 'var(--dsw-alias-state-success-primary)',
  },
  tag: {
    display: 'inline-flex', alignItems: 'center', flex: 'none', minHeight: '20px',
    borderRadius: '5px', padding: '1px 6px', background: 'var(--dsw-alias-bg-layer-1)',
    color: 'var(--dsw-alias-label-secondary)', fontSize: '11px', lineHeight: '16px',
    whiteSpace: 'nowrap', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis',
  },
  updateButton: {
    background: 'color-mix(in srgb, var(--dsw-alias-state-warning-primary) 14%, transparent)',
    color: 'var(--dsw-alias-state-warning-primary)',
    borderColor: 'var(--dsw-alias-state-warning-primary)',
  },
  status: { fontSize: '13px', lineHeight: '20px', color: 'var(--dsw-alias-label-tertiary)', margin: 0 },
  error: { fontSize: '13px', lineHeight: '20px', color: 'var(--dsw-alias-state-error-primary)', margin: 0 },
  filterLabel: { fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
  output: {
    maxHeight: '200px', overflow: 'auto', whiteSpace: 'pre-wrap',
    border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '10px',
    padding: '10px 14px', background: 'var(--dsw-alias-bg-module-platform)',
    fontFamily: 'var(--ds-font-family-code)', fontSize: '12px', lineHeight: '18px',
    color: 'var(--dsw-alias-label-primary)', margin: 0,
  },
  link: {
    color: 'var(--dsw-alias-state-business-primary)', textDecoration: 'none', overflowWrap: 'anywhere',
  },
}

/** Format an ISO timestamp as a short date. */
function shortDate(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0')
}

/** Compact star counts: 2500 → 2.5K, 1_200_000 → 1.2M. */
function formatStars(n: number): string {
  const trimZero = (s: string): string => s.endsWith('.0') ? s.slice(0, -2) : s
  if (n >= 1_000_000) return trimZero((n / 1_000_000).toFixed(1)) + 'M'
  if (n >= 1_000) return trimZero((n / 1_000).toFixed(1)) + 'K'
  return String(n)
}

/** Render the marketplace page. */
export function PluginMarketplaceTab({ marketplace, profiles, install, update, unblock, t }: PluginMarketplaceTabProps): ReactNode {
  const [state, setState] = useState<ViewState>({ status: 'loading' })
  const [busy, setBusy] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<MarketSort>('stars')
  const [descending, setDescending] = useState(false)
  const [output, setOutput] = useState('')
  const [profileList, setProfileList] = useState<ProfileInfo[]>([])
  const [targetProfile, setTargetProfile] = useState('web')
  const [cols, setCols] = useState<1 | 2>(() => {
    try { return localStorage.getItem(COLS_KEY) === '1' ? 1 : 2 } catch { return 2 }
  })
  // Incremental rendering: only the first visibleCount cards are mounted.
  const [visibleCount, setVisibleCount] = useState(RENDER_BATCH)
  const sentinelRef = useRef<HTMLDivElement | null>(null)

  const injected = useRef({ marketplace, profiles, install, update, unblock })

  /** Fetch the listing; installed flags are computed server-side per profile. */
  const fetchMarketplace = (refresh: boolean, profile: string): void => {
    setState(current => current.status === 'ready' ? current : { status: 'loading' })
    void injected.current.marketplace(refresh, profile).then(
      (result) => setState({ status: 'ready', result }),
      (error: unknown) => setState({ status: 'error', message: error instanceof Error ? error.message : String(error) }),
    )
  }

  useEffect(() => {
    void injected.current.profiles().then((items) => {
      setProfileList(items)
      const current = items.find(profile => profile.isCurrent === true)
      const target = current !== undefined ? current.name : 'web'
      setTargetProfile(target)
      fetchMarketplace(false, target)
    }, () => {
      fetchMarketplace(false, 'web')
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const onTargetProfileChange = (value: string): void => {
    setTargetProfile(value)
    fetchMarketplace(false, value)
  }

  const onColsToggle = (): void => {
    setCols(current => {
      const next = current === 2 ? 1 : 2
      try { localStorage.setItem(COLS_KEY, String(next)) } catch { /* storage unavailable */ }
      return next
    })
  }

  const runCommand = (item: MarketplaceItem, action: Promise<CommandResult>, label: string): void => {
    setBusy(item.name)
    void action.then((result) => {
      setOutput('$ ' + label + ' ' + item.displayName + '\n' + result.output)
      // Re-fetch so installed/update flags reflect the change.
      fetchMarketplace(false, targetProfile)
    }).finally(() => {
      setBusy(null)
    })
  }

  const onInstall = (item: MarketplaceItem): void => {
    runCommand(item, injected.current.install(targetProfile, item.url), 'install')
  }

  /** Update path: npm-published plugins update through the managed update op
   *  (rewrites the specifier to @latest with quality gate + rollback); git-only
   *  sources re-run the install (re-clone + re-link). */
  const onUpdate = (item: MarketplaceItem): void => {
    const action = item.packageName !== undefined && item.packageName.length > 0
      ? injected.current.update(targetProfile, item.packageName)
      : injected.current.install(targetProfile, item.url)
    runCommand(item, action, 'update')
  }

  /** Unblock one repository (restores it in the listing on the next fetch). */
  const onUnblock = (repo: string): void => {
    setBusy('unblock:' + repo)
    void injected.current.unblock(repo).finally(() => {
      setBusy(null)
      fetchMarketplace(false, targetProfile)
    })
  }

  const items = state.status === 'ready' ? state.result.items : []
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const rows = useMemo(() => {
    const filtered = items.filter(item => normalizedQuery.length === 0
      || item.name.toLocaleLowerCase().includes(normalizedQuery)
      || (item.description ?? '').toLocaleLowerCase().includes(normalizedQuery))
    const sorted = [...filtered]
    if (sort === 'az') {
      sorted.sort((a, b) => a.displayName.localeCompare(b.displayName))
    } else if (sort === 'updated') {
      sorted.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    } else if (sort === 'created') {
      sorted.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    } else {
      // Stars: installed entries first, then star count (server flags).
      sorted.sort((a, b) => (b.installed ? 1 : 0) - (a.installed ? 1 : 0) || b.stars - a.stars)
    }
    if (descending) sorted.reverse()
    return sorted
  }, [items, normalizedQuery, sort, descending])

  // A fresh query/sort resets the incremental window (a new list is not
  // progressively revealed from a stale offset).
  useEffect(() => {
    setVisibleCount(RENDER_BATCH)
  }, [normalizedQuery, sort, descending])

  // Grow the rendered window when the sentinel approaches the viewport.
  useEffect(() => {
    const node = sentinelRef.current
    if (node === null) return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some(entry => entry.isIntersecting)) {
        setVisibleCount(count => Math.min(count + RENDER_BATCH, rows.length))
      }
    }, { rootMargin: '600px' })
    observer.observe(node)
    return () => observer.disconnect()
  }, [rows.length])

  const rendered = rows.slice(0, visibleCount)

  return (
    <div style={styles.section}>
      <div style={styles.heading}>
        <h2 style={styles.pageTitle}>{t('marketList')}</h2>
      </div>
      <div style={styles.toolbar}>
        <span style={styles.filterLabel}>{t('sortLabel')}</span>
        <PmSelect
          ariaLabel={t('sortLabel')}
          value={sort}
          options={[
            { value: 'stars', label: t('sortStars') },
            { value: 'az', label: t('sortAz') },
            { value: 'updated', label: t('sortUpdated') },
            { value: 'created', label: t('sortCreated') },
          ]}
          onChange={(value) => setSort(value as MarketSort)}
        />
        <Button size="sm" variant="ghost" onClick={() => setDescending(current => !current)}>
          {descending ? t('sortDesc') : t('sortAsc')}
        </Button>
        <span style={{ marginLeft: 'auto' }} />
        <Button size="sm" variant="ghost" onClick={onColsToggle}>
          {cols === 2 ? t('colsOne') : t('colsTwo')}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => fetchMarketplace(true, targetProfile)}>
          {t('refresh')}
        </Button>
        <span style={styles.filterLabel}>{t('installTarget')}</span>
        <PmSelect
          ariaLabel={t('installTarget')}
          value={targetProfile}
          options={profileList.map(profile => ({ value: profile.name, label: profile.name }))}
          onChange={onTargetProfileChange}
        />
      </div>

      {state.status === 'error' && <p style={styles.error} role="alert">{t('error')}: {state.message}</p>}
      {state.status === 'loading' && <p style={styles.status} aria-busy="true">{t('loading')}</p>}

      {state.status === 'ready' && (
        <>
          <div style={styles.heading}>
            <h3 style={styles.headingTitle}>{t('marketCount')}</h3>
            <span style={styles.headingCount}>{rows.length}</span>
            <span style={styles.filterLabel}>
              {state.result.fromCache ? t('marketCached') + (state.result.cachedAt !== undefined ? ' ' + shortDate(state.result.cachedAt) : '') : t('marketFresh')}
              {state.result.source !== undefined ? ' · ' + state.result.source : ''}
            </span>
          </div>
          {state.result.dropped !== undefined && state.result.dropped > 0 && (
            <p style={styles.status}>{t('marketDropped', { n: state.result.dropped })}</p>
          )}
          {state.result.blocked !== undefined && state.result.blocked > 0 && (
            <div style={styles.heading}>
              <p style={styles.status}>{t('marketBlocked', { n: state.result.blocked })}</p>
              {(state.result.blockedRepos ?? []).map(repo => (
                <Button
                  key={repo}
                  size="sm"
                  variant="ghost"
                  disabled={busy !== null}
                  onClick={() => onUnblock(repo)}
                  title={repo}
                >
                  {t('unblockButton')} {repo}
                </Button>
              ))}
            </div>
          )}
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
          {rows.length === 0 && (
            <div>
              <p style={styles.status}>{t('noMarketItems')}</p>
              {!state.result.ok && state.result.message.length > 0 && (
                <p style={styles.error} role="alert">{t('marketSourceError')}: {state.result.message}</p>
              )}
            </div>
          )}
          {state.result.ok && state.result.message.includes('unavailable') && (
            <p style={styles.status}>{t('marketSourceNote')}: {state.result.message}</p>
          )}
          {rendered.length > 0 && (
            <ul style={{ ...styles.cards, gridTemplateColumns: cols === 2 ? 'repeat(2, minmax(0, 1fr))' : 'repeat(1, minmax(0, 1fr))' }}>
              {rendered.map((item) => {
                const sourceLabel = item.packageName !== undefined && item.packageName.length > 0 ? t('sourceNpm') : t('sourceGit')
                const kindLabel = item.installedKind === 'skill' ? t('typeSkill')
                  : item.installedKind === 'agent-preset' ? t('typePreset')
                    : t('typePlugin')
                return (
                  <li key={item.name} style={styles.card}>
                    <div style={styles.cardRow}>
                      <a href={item.url} target="_blank" rel="noreferrer" style={{ ...styles.cardTitle, ...styles.link }} title={item.name}>
                        {item.displayName}
                      </a>
                      <span style={styles.cardAction}>
                        {item.installed ? (
                          item.updateAvailable ? (
                            <Button size="sm" variant="outline" style={styles.updateButton} disabled={busy !== null} onClick={() => onUpdate(item)}>
                              {busy === item.name ? t('updating') : t('updateButton')}
                            </Button>
                          ) : (
                            <span style={{ ...styles.tag, ...styles.tagOn }}>
                              {t('marketInstalled')}
                              {item.installedVersion !== undefined ? ' v' + item.installedVersion : ''}
                            </span>
                          )
                        ) : (
                          <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => onInstall(item)}>
                            {busy === item.name ? t('installing') : t('installButton')}
                          </Button>
                        )}
                      </span>
                    </div>
                    {/* Short meta row: compact values that never overflow. */}
                    <div style={styles.cardMetaRow}>
                      <span style={styles.tag} title={String(item.stars)}>★ {formatStars(item.stars)}</span>
                      <span style={styles.tag} title={item.packageName}>{sourceLabel}</span>
                      <span style={styles.tag}>{kindLabel}</span>
                    </div>
                    {/* Tags row: evidence status + real functional topics. */}
                    <div style={styles.cardMetaRow}>
                      {item.status !== undefined && item.status.length > 0 && (
                        <span style={{ ...styles.tag, ...(item.status.includes('✅') ? styles.tagOn : {}) }} title={item.status}>
                          {item.status.includes('✅') ? t('statusVerified')
                            : item.status.includes('archived') ? t('statusArchived')
                              : t('statusPending')}
                        </span>
                      )}
                      {item.topics !== undefined && item.topics.slice(0, 2).map(topic => (
                        <span key={topic} style={styles.tag} title={item.topics!.join(', ')}>{topic}</span>
                      ))}
                      {item.topics !== undefined && item.topics.length > 2 && (
                        <span style={styles.tag} title={item.topics!.join(', ')}>+{item.topics.length - 2}</span>
                      )}
                    </div>
                    <div style={{ minWidth: 0, overflow: 'hidden', padding: '0 14px 10px' }}>
                      {/* No-break space keeps the description line height for
                          cards without a description — uniform card heights. */}
                      <span style={styles.cardDesc} title={item.description ?? ''}>
                        {item.description !== undefined && item.description.length > 0 ? item.description : '\u00A0'}
                      </span>
                    </div>
                    <div style={{ padding: '0 14px 10px' }}>
                      <span style={styles.meta}>
                        {t('updatedAt')} {shortDate(item.updatedAt)}
                        {item.createdAt.length > 0 ? ' · ' + t('createdAt') + ' ' + shortDate(item.createdAt) : ''}
                      </span>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
          {/* Sentinel that grows the rendered window on scroll. */}
          {rows.length > rendered.length && <div ref={sentinelRef} style={{ height: 1 }} />}
          {rows.length > rendered.length && (
            <Button size="sm" variant="ghost" onClick={() => setVisibleCount(count => Math.min(count + RENDER_BATCH, rows.length))}>
              {t('marketMore')} ({rows.length - rendered.length})
            </Button>
          )}
          {output.length > 0 && (
            <div>
              <div style={styles.heading}>
                <h3 style={styles.headingTitle}>{t('commandOutput')}</h3>
              </div>
              <pre style={styles.output}>{output}</pre>
            </div>
          )}
        </>
      )}
    </div>
  )
}
