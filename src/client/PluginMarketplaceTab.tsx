/**
 * Plugin Marketplace tab (settings.section first-level entry): browse
 * GitHub topic:dsh repositories, sort/search, and install via the git
 * source path (clone + quality gate).
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Button, IconSearchOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { CommandResult, MarketplaceItem, MarketplaceResult, PluginManagerSnapshot, ProfileInfo } from '../types.ts'
import type { PluginManagerLocaleKey } from './locales.ts'
import { PmSelect } from './PmSelect.tsx'

/** Registration-side Remote face provided by the section. */
export interface PluginMarketplaceTabInjected {
  readonly marketplace: (refresh: boolean) => Promise<MarketplaceResult>
  readonly profiles: () => Promise<ProfileInfo[]>
  readonly list: (profile: string) => Promise<PluginManagerSnapshot>
  readonly install: (profile: string, spec: string) => Promise<CommandResult>
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
  },
  cardRow: {
    boxSizing: 'border-box', display: 'flex', alignItems: 'center', gap: '8px',
    width: '100%', minHeight: '52px', padding: '10px 14px', flexWrap: 'wrap',
  },
  cardTitle: {
    minWidth: 0, overflow: 'hidden', fontSize: '14px', lineHeight: '20px', fontWeight: 600,
    textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  cardDesc: {
    display: 'block', minWidth: 0, overflow: 'hidden', fontSize: '12px', lineHeight: '17px',
    color: 'var(--dsw-alias-label-secondary)', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  meta: {
    fontSize: '11px', lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary)',
    fontVariantNumeric: 'tabular-nums',
  },
  cardMetaRow: {
    display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap',
    padding: '0 14px 10px',
  },
  tagOn: {
    background: 'color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent)',
    color: 'var(--dsw-alias-state-success-primary)',
  },
  tag: {
    display: 'inline-flex', alignItems: 'center', flex: 'none', minHeight: '20px',
    borderRadius: '5px', padding: '1px 6px', background: 'var(--dsw-alias-bg-layer-1)',
    color: 'var(--dsw-alias-label-secondary)', fontSize: '11px', lineHeight: '16px',
    whiteSpace: 'nowrap',
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

/** Render the marketplace page. */
export function PluginMarketplaceTab({ marketplace, profiles, list, install, t }: PluginMarketplaceTabProps): ReactNode {
  const [state, setState] = useState<ViewState>({ status: 'loading' })
  const [busy, setBusy] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<MarketSort>('stars')
  const [descending, setDescending] = useState(false)
  const [output, setOutput] = useState('')
  const [profileList, setProfileList] = useState<ProfileInfo[]>([])
  const [targetProfile, setTargetProfile] = useState('web')
  // Package names + repository identifiers installed in the target profile.
  const [installedNames, setInstalledNames] = useState<Set<string>>(new Set())
  const [installedRepos, setInstalledRepos] = useState<Set<string>>(new Set())

  const injected = useRef({ marketplace, profiles, list, install })

  /** Refresh which marketplace entries are already installed in the target. */
  const refreshInstalled = (profile: string): void => {
    void injected.current.list(profile).then((snapshot) => {
      const names = new Set<string>()
      const repos = new Set<string>()
      for (const pkg of snapshot.packages) {
        names.add(pkg.name)
        if (pkg.repository !== undefined) {
          const match = /(?:github\.com\/)?([^/]+\/[^/]+?)(?:\.git)?$/.exec(pkg.repository)
          if (match !== null) repos.add(match[1]!.replace(/\.git$/, '').toLocaleLowerCase())
        }
        // Git-cache installs: the dependency value points at the clone dir
        // ($DSH_HOME/plugin-manager-src/github.com-<owner>-<repo>), which
        // carries the upstream identity even when the manifest has no
        // repository field.
        if (pkg.source !== undefined) {
          const cache = /github\.com[-/]([^/\s]+)[-/]([^/\s]+)/.exec(pkg.source)
          if (cache !== null) repos.add((cache[1]! + '/' + cache[2]!).toLocaleLowerCase())
        }
      }
      setInstalledNames(names)
      setInstalledRepos(repos)
    }, () => { /* keep the previous state */ })
  }

  const load = (refresh: boolean): void => {
    setState(current => current.status === 'ready' ? current : { status: 'loading' })
    void injected.current.marketplace(refresh).then(
      (result) => setState({ status: 'ready', result }),
      (error: unknown) => setState({ status: 'error', message: error instanceof Error ? error.message : String(error) }),
    )
  }

  useEffect(() => {
    load(false)
    void injected.current.profiles().then((items) => {
      setProfileList(items)
      const current = items.find(profile => profile.isCurrent === true)
      if (current !== undefined) {
        setTargetProfile(current.name)
        refreshInstalled(current.name)
      }
    }, () => { /* keep web default */ })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const onInstall = async (item: MarketplaceItem): Promise<void> => {
    setBusy(item.name)
    try {
      const result = await injected.current.install(targetProfile, item.url)
      setOutput('$ install ' + item.name + '\n' + result.output)
      refreshInstalled(targetProfile)
    } finally {
      setBusy(null)
    }
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
      sorted.sort((a, b) => b.stars - a.stars)
    }
    if (descending) sorted.reverse()
    return sorted
  }, [items, normalizedQuery, sort, descending])

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
        <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => load(true)}>
          {t('refresh')}
        </Button>
        <span style={styles.filterLabel}>{t('installTarget')}</span>
        <PmSelect
          ariaLabel={t('installTarget')}
          value={targetProfile}
          options={profileList.map(profile => ({ value: profile.name, label: profile.name }))}
          onChange={(value) => {
            setTargetProfile(value)
            refreshInstalled(value)
          }}
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
            </span>
          </div>
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
          {rows.length > 0 && (
            <ul style={styles.cards}>
              {rows.map((item) => {
                const installed = item.packageName !== undefined && item.packageName.length > 0
                  ? installedNames.has(item.packageName)
                  : installedRepos.has(item.name.toLocaleLowerCase())
                return (
                <li key={item.name} style={styles.card}>
                  <div style={styles.cardRow}>
                    <a href={item.url} target="_blank" rel="noreferrer" style={{ ...styles.cardTitle, ...styles.link }} title={item.name}>
                      {item.displayName}
                    </a>
                    <span style={{ marginLeft: 'auto' }}>
                      {installed ? (
                        <span style={{ ...styles.tag, ...styles.tagOn }}>{t('marketInstalled')}</span>
                      ) : (
                        <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void onInstall(item)}>
                          {busy === item.name ? t('installing') : t('installButton')}
                        </Button>
                      )}
                    </span>
                  </div>
                  <div style={styles.cardMetaRow}>
                    <span style={styles.tag}>★ {item.stars}</span>
                    {item.status !== undefined && item.status.length > 0 && (
                      <span style={{ ...styles.tag, ...(item.status.includes('✅') ? styles.tagOn : {}) }} title={item.status}>
                        {item.status.includes('✅') ? t('statusVerified')
                          : item.status.includes('archived') ? t('statusArchived')
                            : t('statusPending')}
                      </span>
                    )}
                    {item.packageName !== undefined && item.packageName.length > 0 && (
                      <span style={styles.tag} title={item.packageName}>npm {item.packageName}</span>
                    )}
                    {item.category !== undefined && item.category.length > 0 && (
                      <span style={styles.tag}>{item.category}</span>
                    )}
                  </div>
                  <div style={{ minWidth: 0, overflow: 'hidden', padding: '0 14px 10px' }}>
                    {/* A space (not empty) keeps the line height identical for
                        cards without a description. */}
                    <span style={styles.cardDesc} title={item.description ?? ''}>
                      {item.description !== undefined && item.description.length > 0 ? item.description : ' '}
                    </span>
                  </div>
                  <div style={{ padding: '0 14px 10px' }}>
                    <span style={styles.meta}>
                      {t('updatedAt')} {shortDate(item.updatedAt)} · {t('createdAt')} {shortDate(item.createdAt)}
                    </span>
                  </div>
                </li>
                )
              })}
            </ul>
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
