/**
 * Plugin Marketplace tab (settings.section first-level entry): browse
 * GitHub topic:dsh repositories, sort/search, and install via the git
 * source path (clone + quality gate).
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Button, IconSearchOutline16, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { CommandResult, MarketplaceItem, MarketplaceResult } from '../types.ts'
import type { PluginManagerLocaleKey } from './locales.ts'
import { PmSelect } from './PmSelect.tsx'

/** Registration-side Remote face provided by the section. */
export interface PluginMarketplaceTabInjected {
  readonly marketplace: (refresh: boolean) => Promise<MarketplaceResult>
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
  cardRow: {
    boxSizing: 'border-box', display: 'flex', alignItems: 'center', gap: '8px',
    width: '100%', minHeight: '52px', padding: '10px 14px', flexWrap: 'wrap',
  },
  cardTitle: {
    minWidth: 0, overflow: 'hidden', fontSize: '14px', lineHeight: '20px', fontWeight: 600,
    textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  cardDesc: {
    minWidth: 0, overflow: 'hidden', fontSize: '12px', lineHeight: '17px',
    color: 'var(--dsw-alias-label-secondary)', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  meta: {
    fontSize: '11px', lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary)',
    fontVariantNumeric: 'tabular-nums',
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
export function PluginMarketplaceTab({ marketplace, install, t }: PluginMarketplaceTabProps): ReactNode {
  const [state, setState] = useState<ViewState>({ status: 'loading' })
  const [busy, setBusy] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<MarketSort>('stars')
  const [descending, setDescending] = useState(false)
  const [output, setOutput] = useState('')

  const injected = useRef({ marketplace, install })

  const load = (refresh: boolean): void => {
    setState(current => current.status === 'ready' ? current : { status: 'loading' })
    void injected.current.marketplace(refresh).then(
      (result) => setState({ status: 'ready', result }),
      (error: unknown) => setState({ status: 'error', message: error instanceof Error ? error.message : String(error) }),
    )
  }

  useEffect(() => {
    load(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const onInstall = async (item: MarketplaceItem): Promise<void> => {
    setBusy(item.name)
    try {
      const result = await injected.current.install('web', item.url)
      setOutput('$ install ' + item.name + '\n' + result.output)
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
      <div style={styles.toolbar}>
        <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => load(true)}>
          {t('refresh')}
        </Button>
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
      </div>

      {state.status === 'error' && <p style={styles.error} role="alert">{t('error')}: {state.message}</p>}
      {state.status === 'loading' && <p style={styles.status} aria-busy="true">{t('loading')}</p>}

      {state.status === 'ready' && (
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
          <div style={styles.heading}>
            <h3 style={styles.headingTitle}>{t('marketList')}</h3>
            <span style={styles.headingCount}>{rows.length}</span>
            <span style={styles.filterLabel}>
              {state.result.fromCache ? t('marketCached') + (state.result.cachedAt !== undefined ? ' ' + shortDate(state.result.cachedAt) : '') : t('marketFresh')}
            </span>
          </div>
          {rows.length === 0 ? <p style={styles.status}>{t('noMarketItems')}</p> : (
            <ul style={styles.cards}>
              {rows.map((item) => (
                <li key={item.name} style={styles.card}>
                  <div style={styles.cardRow}>
                    <a href={item.url} target="_blank" rel="noreferrer" style={{ ...styles.cardTitle, ...styles.link }} title={item.name}>
                      {item.displayName}
                    </a>
                    <span style={styles.tag}>★ {item.stars}</span>
                    <span style={{ marginLeft: 'auto' }}>
                      <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void onInstall(item)}>
                        {busy === item.name ? t('installing') : t('installButton')}
                      </Button>
                    </span>
                  </div>
                  {item.description !== undefined && item.description.length > 0 && (
                    <div style={{ padding: '0 14px 10px' }}>
                      <span style={styles.cardDesc} title={item.description}>{item.description}</span>
                    </div>
                  )}
                  <div style={{ padding: '0 14px 10px' }}>
                    <span style={styles.meta}>
                      {t('updatedAt')} {shortDate(item.updatedAt)} · {t('createdAt')} {shortDate(item.createdAt)}
                    </span>
                  </div>
                </li>
              ))}
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
