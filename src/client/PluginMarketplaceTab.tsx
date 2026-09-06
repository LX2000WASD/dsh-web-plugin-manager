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

import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Button, IconSearchOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { CommandResult, EnvQuestion, MarketplaceItem, MarketplaceResult, MutationResult, ProfileInfo } from '../types.ts'
import { fuzzyScoreLowered } from '../rank.ts'
import type { PluginManagerLocaleKey } from './locales.ts'
import { PM_LINK_CSS, formatStars, outputStyle, shortDate } from './shared.ts'
import { EnvQuestionForm } from './EnvQuestionForm.tsx'
import { PmSelect } from './PmSelect.tsx'

/** Registration-side Remote face provided by the section. */
export interface PluginMarketplaceTabInjected {
  readonly marketplace: (refresh: boolean, profile: string) => Promise<MarketplaceResult>
  readonly profiles: () => Promise<ProfileInfo[]>
  readonly install: (profile: string, spec: string, answers?: Record<string, string>) => Promise<CommandResult>
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
  securityLow: {
    background: 'color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent)',
    color: 'var(--dsw-alias-state-success-primary)',
  },
  securityMedium: {
    background: 'color-mix(in srgb, var(--dsw-alias-state-warning-primary) 12%, transparent)',
    color: 'var(--dsw-alias-state-warning-primary)',
  },
  securityHigh: {
    background: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent)',
    color: 'var(--dsw-alias-state-error-primary)',
  },
  status: { fontSize: '13px', lineHeight: '20px', color: 'var(--dsw-alias-label-tertiary)', margin: 0 },
  error: { fontSize: '13px', lineHeight: '20px', color: 'var(--dsw-alias-state-error-primary)', margin: 0 },
  filterLabel: { fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
  link: {
    color: 'var(--dsw-alias-link, var(--dsw-alias-state-business-primary))',
    fontWeight: 500, textDecoration: 'none', overflowWrap: 'anywhere',
  },
}

/** dsh.so security badge: tone by risk level (no icons — text only). */
function securityBadge(
  t: (key: PluginManagerLocaleKey) => string,
  security: { riskLevel: string; status: string },
): { text: string; style: React.CSSProperties } {
  const risk = security.riskLevel
  if (risk === 'low') return { text: t('securityLow'), style: styles.securityLow }
  if (risk === 'medium') return { text: t('securityMedium'), style: styles.securityMedium }
  if (risk === 'high' || risk === 'critical') return { text: t('securityHigh'), style: styles.securityHigh }
  return { text: t('securityUnknown'), style: styles.tag }
}

/** Props of one marketplace card. Primitive flags + stable handler
 *  identities keep the memo effective: a keystroke reorders the list without
 *  re-rendering the cards, and a busy/output change re-renders only the
 *  touched card instead of the whole rendered window (up to ~3000 cards). */
interface MarketCardProps {
  readonly item: MarketplaceItem
  /** This card's own action is running (button label switches). */
  readonly busy: boolean
  /** All actions blocked (any busy action / env form open elsewhere). */
  readonly disabled: boolean
  /** The env-var form paused for THIS card (null on every other card). */
  readonly envQuestions: readonly EnvQuestion[] | null
  readonly t: (key: PluginManagerLocaleKey) => string
  readonly onInstall: (item: MarketplaceItem) => void
  readonly onUpdate: (item: MarketplaceItem) => void
  readonly onEnvContinue: (item: MarketplaceItem, answers: Record<string, string>) => void
  readonly onEnvCancel: () => void
}

const MarketCard = memo(function MarketCard({ item, busy, disabled, envQuestions, t, onInstall, onUpdate, onEnvContinue, onEnvCancel }: MarketCardProps): ReactNode {
  const sourceLabel = item.packageName !== undefined && item.packageName.length > 0 ? t('sourceNpm') : t('sourceGit')
  // Kind (skill/agent/plugin) is only known for installed items —
  // type detection requires a clone, which the listing cannot
  // afford for ~3000 entries. Uninstalled items show no type tag.
  const kindLabel = item.installed
    ? item.installedKind === 'skill' ? t('typeSkill')
      : item.installedKind === 'agent-preset' ? t('typeAgent')
        : t('typePlugin')
    : null
  // Computed once per card render (each was previously evaluated twice).
  const topicsTitle = item.topics?.join(', ')
  const security = item.security !== undefined && item.security.status !== 'skipped'
    ? securityBadge(t, item.security)
    : null
  return (
    <li style={styles.card}>
      <div style={styles.cardRow}>
        <a href={item.url} target="_blank" rel="noreferrer" className="pm-link" style={{ ...styles.cardTitle, ...styles.link }} title={item.name}>
          {item.displayName}
        </a>
        <span style={styles.cardAction}>
          {item.installed ? (
            item.updateAvailable ? (
              <Button size="sm" variant="outline" style={styles.updateButton} disabled={disabled} onClick={() => onUpdate(item)}>
                {busy ? t('updating') : t('updateButton')}
              </Button>
            ) : (
              <span style={{ ...styles.tag, ...styles.tagOn }}>
                {t('marketInstalled')}
                {item.installedVersion !== undefined ? ' v' + item.installedVersion : ''}
              </span>
            )
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={() => onInstall(item)}
            >
              {busy ? t('installing') : t('installButton')}
            </Button>
          )}
        </span>
      </div>
      {/* Short meta row: compact values that never overflow. */}
      <div style={styles.cardMetaRow}>
        <span style={styles.tag} title={String(item.stars)}>★ {formatStars(item.stars)}</span>
        <span style={styles.tag} title={item.packageName}>{sourceLabel}</span>
        {kindLabel !== null && <span style={styles.tag}>{kindLabel}</span>}
      </div>
      {/* Tags row: adp (awesome) status + so (dsh.so) verification/security + topics. */}
      <div style={styles.cardMetaRow}>
        {item.status !== undefined && item.status.length > 0 && (
          <span style={{ ...styles.tag, ...(item.status.includes('✅') ? styles.tagOn : {}) }} title={item.status}>
            {item.status.includes('✅') ? t('statusVerified')
              : item.status.includes('archived') ? t('statusArchived')
                : t('statusPending')}
          </span>
        )}
        {item.verification !== undefined && (
          <span
            style={{ ...styles.tag, ...(item.verification.level >= 2 ? styles.tagOn : {}) }}
            title={item.verification.label}
          >
            {t('dsoVerified')} L{item.verification.level}
          </span>
        )}
        {security !== null && (
          <span style={{ ...styles.tag, ...security.style }} title={item.security!.status}>
            {security.text}
          </span>
        )}
        {item.topics !== undefined && item.topics.slice(0, 2).map(topic => (
          <span key={topic} style={styles.tag} title={topicsTitle}>{topic}</span>
        ))}
        {item.topics !== undefined && item.topics.length > 2 && (
          <span style={styles.tag} title={topicsTitle}>+{item.topics.length - 2}</span>
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
      {envQuestions !== null && (
        <div style={{ padding: '0 14px 10px' }}>
          <EnvQuestionForm
            questions={envQuestions}
            busy={busy}
            t={t}
            onContinue={(answers) => onEnvContinue(item, answers)}
            onCancel={onEnvCancel}
          />
        </div>
      )}
    </li>
  )
})

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
  // C2: an install paused waiting for env vars, keyed by the card name.
  const [awaiting, setAwaiting] = useState<{ readonly name: string; readonly questions: readonly EnvQuestion[] } | null>(null)
  const [cols, setCols] = useState<1 | 2>(() => {
    try { return localStorage.getItem(COLS_KEY) === '1' ? 1 : 2 } catch { return 2 }
  })
  // Incremental rendering: only the first visibleCount cards are mounted.
  const [visibleCount, setVisibleCount] = useState(RENDER_BATCH)
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  // Refresh-in-flight flag: a full server re-crawl is the heaviest listing
  // operation — the button must not fire it twice concurrently.
  const [refreshing, setRefreshing] = useState(false)

  const injected = useRef({ marketplace, profiles, install, update, unblock })

  // Request sequence guard: a slow response for an earlier profile must not
  // overwrite the listing of the currently selected one (audit M8).
  const fetchSeq = useRef(0)
  /** Fetch the listing; installed flags are computed server-side per profile. */
  const fetchMarketplace = useCallback((refresh: boolean, profile: string): void => {
    const seq = ++fetchSeq.current
    if (refresh) setRefreshing(true)
    setState(current => current.status === 'ready' ? current : { status: 'loading' })
    void injected.current.marketplace(refresh, profile).then(
      (result) => { if (seq === fetchSeq.current) setState({ status: 'ready', result }) },
      (error: unknown) => { if (seq === fetchSeq.current) setState({ status: 'error', message: error instanceof Error ? error.message : String(error) }) },
    ).finally(() => {
      if (refresh) setRefreshing(false)
    })
  }, [])

  // Latest-value ref: memoized card handlers keep stable identities while
  // reading the CURRENTLY selected install target at call time (a stale
  // closure would install into the previous profile after a switch).
  const targetProfileRef = useRef(targetProfile)
  useEffect(() => { targetProfileRef.current = targetProfile }, [targetProfile])

  const runCommand = useCallback((item: MarketplaceItem, action: Promise<CommandResult>, label: string): void => {
    setBusy(item.name)
    void action.then((result) => {
      setOutput('$ ' + label + ' ' + item.displayName + '\n' + result.output)
      if (result.awaiting !== undefined) {
        // C2: paused for env vars — show the inline form, keep the listing.
        setAwaiting({ name: item.name, questions: result.awaiting.questions })
        return
      }
      // Re-fetch so installed/update flags reflect the change.
      fetchMarketplace(false, targetProfileRef.current)
    }, (error: unknown) => {
      // Network failures and non-200 envelopes must not go silent (audit M7).
      setOutput('$ ' + label + ' ' + item.displayName + '\n[error] ' + (error instanceof Error ? error.message : String(error)))
    }).finally(() => {
      setBusy(null)
    })
  }, [fetchMarketplace])

  const onInstall = useCallback((item: MarketplaceItem): void => {
    runCommand(item, injected.current.install(targetProfileRef.current, item.url), 'install')
  }, [runCommand])

  /** C2: user submitted the env-var answers — re-run the install with them. */
  const onEnvContinue = useCallback((item: MarketplaceItem, answers: Record<string, string>): void => {
    runCommand(item, injected.current.install(targetProfileRef.current, item.url, answers), 'install')
  }, [runCommand])

  /** Update path: npm-published plugins update through the managed update op
   *  (rewrites the specifier to @latest with quality gate + rollback); git-only
   *  sources re-run the install (re-clone + re-link). */
  const onUpdate = useCallback((item: MarketplaceItem): void => {
    const action = item.packageName !== undefined && item.packageName.length > 0
      ? injected.current.update(targetProfileRef.current, item.packageName)
      : injected.current.install(targetProfileRef.current, item.url)
    runCommand(item, action, 'update')
  }, [runCommand])

  const onEnvCancel = useCallback((): void => setAwaiting(null), [])

  useEffect(() => {
    void injected.current.profiles().then((items) => {
      setProfileList(items)
      const current = items.find(profile => profile.running !== null)
        ?? items.find(profile => profile.isCurrent === true)
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
    // The C2 env form is bound to the previous profile — never let its
    // answers leak into another environment's install (audit M9).
    setAwaiting(null)
    fetchMarketplace(false, value)
  }

  const onColsToggle = (): void => {
    setCols(current => {
      const next = current === 2 ? 1 : 2
      try { localStorage.setItem(COLS_KEY, String(next)) } catch { /* storage unavailable */ }
      return next
    })
  }

  /** Unblock one repository (restores it in the listing on the next fetch). */
  const onUnblock = (repo: string): void => {
    setBusy('unblock:' + repo)
    void injected.current.unblock(repo).then(() => {
      fetchMarketplace(false, targetProfile)
    }, (error: unknown) => {
      setOutput('$ unblock ' + repo + '\n[error] ' + (error instanceof Error ? error.message : String(error)))
    }).finally(() => {
      setBusy(null)
    })
  }

  const items = state.status === 'ready' ? state.result.items : []
  // 输入保持即时响应：过滤/排序跟随 deferred 值在低优先级渲染中重算
  // （3000+ 条 × O(名称×query) 的对齐打分不阻塞键击）。
  const deferredQuery = useDeferredValue(query)
  const searchQuery = deferredQuery.trim().toLocaleLowerCase()
  // 预构建小写检索索引：只在列表变化时小写化一次（每键击对 ~3000 条
  // × 2 个字段打分，原实现每键击每次调用都重复 toLowerCase 并为描述
  // 兜底新分配全量小写串）。
  const haystacks = useMemo(() => items.map(item => ({
    display: item.displayName.toLowerCase(),
    name: item.name.toLowerCase(),
    description: (item.description ?? '').toLowerCase(),
  })), [items])
  const rows = useMemo(() => {
    if (searchQuery.length === 0) {
      const sorted = [...items]
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
    }
    // 搜索态：相关性优先（对齐分 desc，同分星数 desc）——与官方 slash
    // 菜单的排序契约一致（rankByName：前缀/边界 > 连续命中 > 间隔）。
    // 名称子序列命中为主（已涵盖子串命中），描述子串命中作 1 分兜底，
    // 保证"名字不匹配但描述匹配"的条目仍可被发现。
    const hits: Array<{ item: MarketplaceItem; score: number }> = []
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index]!
      const hay = haystacks[index]!
      const display = fuzzyScoreLowered(hay.display, searchQuery)
      const full = fuzzyScoreLowered(hay.name, searchQuery)
      const best = display !== null && full !== null ? Math.max(display, full) : (display ?? full)
      const score = best ?? (hay.description.includes(searchQuery) ? 1 : null)
      if (score !== null) hits.push({ item, score })
    }
    hits.sort((a, b) => b.score - a.score || b.item.stars - a.item.stars)
    return hits.map(hit => hit.item)
  }, [items, haystacks, searchQuery, sort, descending])

  // A fresh query/sort resets the incremental window (a new list is not
  // progressively revealed from a stale offset).
  useEffect(() => {
    setVisibleCount(RENDER_BATCH)
  }, [searchQuery, sort, descending])

  // Grow the rendered window when the sentinel approaches the viewport.
  // Deps include sentinel presence, not just rows.length: once every row is
  // loaded the sentinel unmounts, and after a query reset it remounts a
  // commit later without rows.length changing again — a rows.length-only
  // dependency would skip that remount and the observer would never
  // re-attach (leaving only the manual "more" button working).
  const hasMore = rows.length > visibleCount
  useEffect(() => {
    const node = sentinelRef.current
    if (!hasMore || node === null) return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some(entry => entry.isIntersecting)) {
        setVisibleCount(count => Math.min(count + RENDER_BATCH, rows.length))
      }
    }, { rootMargin: '600px' })
    observer.observe(node)
    return () => observer.disconnect()
  }, [hasMore, rows.length])

  const rendered = rows.slice(0, visibleCount)

  return (
    <div style={styles.section}>
      {/* 链接语言对齐官方（0.1.3 alias-link）：hover/focus 点状下划线。 */}
      <style>{PM_LINK_CSS}</style>
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
        <Button size="sm" variant="ghost" disabled={busy !== null || refreshing} onClick={() => fetchMarketplace(true, targetProfile)}>
          {refreshing ? t('refreshing') : t('refresh')}
        </Button>
        <span style={styles.filterLabel}>{t('installTarget')}</span>
        <PmSelect
          ariaLabel={t('installTarget')}
          disabled={busy !== null || awaiting !== null}
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
              {rendered.map((item) => (
                <MarketCard
                  key={item.name}
                  item={item}
                  busy={busy === item.name}
                  disabled={busy !== null || (awaiting !== null && awaiting.name === item.name)}
                  envQuestions={awaiting !== null && awaiting.name === item.name ? awaiting.questions : null}
                  t={t}
                  onInstall={onInstall}
                  onUpdate={onUpdate}
                  onEnvContinue={onEnvContinue}
                  onEnvCancel={onEnvCancel}
                />
              ))}
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
              <pre style={outputStyle}>{output}</pre>
            </div>
          )}
        </>
      )}
    </div>
  )
}
