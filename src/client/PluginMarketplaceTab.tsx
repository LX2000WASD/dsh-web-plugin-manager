/**
 * Plugin Marketplace tab (settings.section first-level entry): browse the
 * merged marketplace (static registry index + curated catalog), with
 * server-side installed detection, update availability and install/update
 * actions per card.
 *
 * Rendering is incremental: the first PAGE cards render immediately and the
 * rest appear as the sentinel enters the viewport (IntersectionObserver),
 * with content-visibility: auto letting the browser skip off-screen work —
 * a ~13k-entry listing stays responsive without server-side paging.
 *
 * Card layout contract (two-column alignment): a card is a flex column of
 * FIXED-HEIGHT slots — title / tag row 1 / tag row 2 / two-line description /
 * date row — so two cards sharing a grid row are exactly as tall as each
 * other no matter how many tags they carry. The grid stretches its items
 * instead of aligning them at the start. Tags are single-line chips (clipped,
 * never wrapped into a third row); the description is clamped to two lines.
 * The env-var form is the only element allowed to grow a card.
 *
 * Order contract (the toolbar must not lie): 'descending' is the single
 * direction state and it drives BOTH the comparator and the direction button
 * label, so the label always names the direction the list is actually in.
 * Every mode is a stable total order (installed priority → mode key → display
 * name → repository), so equal keys never fall back to the input order.
 * Changing the query, the sort mode, the direction or the category filter
 * resets the incremental window and scrolls the list back to its top.
 */

import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Button, IconSearchOutline16, Input, Tag, type TagTone } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { CommandResult, EnvQuestion, MarketplaceItem, MarketplaceResult, MutationResult, ProfileInfo } from '../types.ts'
import { charMask, fuzzyScoreLowered } from '../rank.ts'
import { categoryCounts, marketTagKey, type MarketTag, type MarketTagTone } from '../tags.ts'
import {
  ALL_CATEGORIES, TAG_SLOTS, buildCategoryOptions, compareTie, defaultDescendingFor, filterByCategory,
  marketToolbarModel, orderCategories, readHostCategories, sortLabelKey, sortRows, tagLabelText,
  tagOverflowCount, tagOverflowTitle, tagsOf, type MarketSort,
} from '../marketView.ts'
import type { PluginManagerLocaleKey } from './locales.ts'
import { PM_LINK_CSS, formatStars, isAbortError, outputStyle, shortDate, useElapsedSeconds } from './shared.ts'
import { EnvQuestionForm } from './EnvQuestionForm.tsx'
import { PmSelect } from './PmSelect.tsx'

/** Registration-side Remote face provided by the section. */
export interface PluginMarketplaceTabInjected {
  readonly marketplace: (refresh: boolean, profile: string, signal?: AbortSignal) => Promise<MarketplaceResult>
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

/** Cards rendered per incremental batch, and the initial batch size. */
const RENDER_BATCH = 120
/** localStorage key for the column preference. */
const COLS_KEY = 'dshpm-market-cols'
/** Stable empty listing (a fresh [] would defeat every memo downstream). */
const EMPTY_ITEMS: readonly MarketplaceItem[] = []
/** Stable empty tag list for the defensive card fallback. */
const NO_TAGS: readonly MarketTag[] = []

/** Page-local CSS: the official Input sizes itself inline-flex and takes no
 *  width through props, so the search field is widened here. */
const MARKET_CSS = `
.pm-market-search { width: 100%; }
`

/** Official --dsw-* token styles (mirrors the other pages). */
const styles = {
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
  // align-items: stretch (NOT start) is what keeps the two columns even: both
  // cards of a row share the row height instead of hugging their own content.
  cards: {
    display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    alignItems: 'stretch', gap: '10px', margin: 0, padding: 0, listStyle: 'none',
  },
  // Flex column of fixed-height slots — the card's height is a constant, not
  // a function of how much metadata an entry happens to carry. Surface follows
  // the official inventory card: no 1px neutral border (styling rule), a
  // 14px radius and the elevation stroke.
  card: {
    display: 'flex', flexDirection: 'column', justifyContent: 'flex-start',
    minWidth: 0, maxWidth: '100%', overflow: 'hidden',
    border: 0, boxShadow: 'var(--dsw-elevation-stroke)', borderRadius: '14px',
    background: 'var(--dsw-alias-bg-layer-3)',
    // Skip off-screen layout/paint until the card approaches the viewport.
    // The intrinsic size matches the real slot sum (52+24+24+42+30) so the
    // scrollbar does not jump while placeholder cards are measured.
    contentVisibility: 'auto',
    containIntrinsicSize: 'auto 172px',
  },
  /** Slot 1: title + action. */
  cardRow: {
    boxSizing: 'border-box', display: 'flex', alignItems: 'center', gap: '8px',
    width: '100%', height: '52px', padding: '0 14px', flex: 'none',
  },
  cardTitle: {
    flex: '1 1 auto', minWidth: 0, overflow: 'hidden', fontSize: '14px', lineHeight: '20px',
    fontWeight: 600, textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  cardAction: { flex: 'none', display: 'inline-flex', alignItems: 'center', gap: '6px' },
  /** Slot 2/3: one line of tag chips. Never wraps — surplus chips are clipped.
   *  align-items: center keeps a chip's own vertical margin out of the slot. */
  tagRow: {
    boxSizing: 'border-box', display: 'flex', alignItems: 'center', gap: '6px',
    flexWrap: 'nowrap', width: '100%', height: '24px', padding: '0 14px',
    overflow: 'hidden', flex: 'none',
  },
  /** Hover target for the official Tag (it takes no title prop). */
  tagWrap: { display: 'inline-flex', alignItems: 'center', minWidth: 0, maxWidth: '100%' },
  /** Slot 4: description clamped to exactly two lines (2 x 17px + 8px gap). */
  descRow: {
    boxSizing: 'border-box', display: 'flex', alignItems: 'flex-start',
    width: '100%', height: '42px', padding: '0 14px 8px', overflow: 'hidden', flex: 'none',
  },
  cardDesc: {
    display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 2,
    maxHeight: '34px', minWidth: 0, overflow: 'hidden', overflowWrap: 'anywhere',
    fontSize: '12px', lineHeight: '17px', color: 'var(--dsw-alias-label-secondary)',
  },
  /** Slot 5: dates on the left, star/source meta pinned right. */
  dateRow: {
    boxSizing: 'border-box', display: 'flex', alignItems: 'center', gap: '8px',
    width: '100%', height: '30px', padding: '0 14px 8px', overflow: 'hidden', flex: 'none',
  },
  dateText: {
    flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  meta: {
    fontSize: '11px', lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary)',
    fontVariantNumeric: 'tabular-nums',
  },
  /** Only the meta chips (stars / source) are still hand-rolled: the official
   *  Tag has no title prop and these two carry the package name on hover. */
  tag: {
    display: 'inline-flex', alignItems: 'center', flex: '0 1 auto', minWidth: 0,
    borderRadius: '999px', padding: '1px 8px', background: 'var(--dsw-alias-bg-module-platform)',
    color: 'var(--dsw-alias-label-secondary)', fontSize: '11px', lineHeight: '16px',
    whiteSpace: 'nowrap', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis',
  },
  status: { fontSize: '13px', lineHeight: '20px', color: 'var(--dsw-alias-label-tertiary)', margin: 0 },
  error: { fontSize: '13px', lineHeight: '20px', color: 'var(--dsw-alias-state-error-primary)', margin: 0 },
  filterLabel: { fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
  link: {
    color: 'var(--dsw-alias-link, var(--dsw-alias-state-business-primary))',
    fontWeight: 500, textDecoration: 'none', overflowWrap: 'anywhere',
  },
} satisfies Record<string, React.CSSProperties>

/**
 * Tone → official Tag palette. The tag model stays framework-free; only this
 * map knows the primitives. Using the shipped Tag is also what removed the
 * hand-written chip CSS (and its misspelled "state-warning-primary" alias,
 * whose whole color-mix declaration the browser dropped).
 */
const tagTones: Record<MarketTagTone, TagTone> = {
  neutral: 'neutral',
  success: 'success',
  warning: 'warning',
  danger: 'danger',
}

/** Props of one marketplace card. Primitive flags, the stable tag array and
 *  stable handler identities keep the memo effective: a keystroke reorders
 *  the list without re-rendering the cards, and a busy/output change
 *  re-renders only the touched card instead of the whole rendered window. */
interface MarketCardProps {
  readonly item: MarketplaceItem
  /** buildMarketTags output of this item; stable per listing (memoized map). */
  readonly tags: readonly MarketTag[]
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

const MarketCard = memo(function MarketCard({ item, tags, busy, disabled, envQuestions, t, onInstall, onUpdate, onEnvContinue, onEnvCancel }: MarketCardProps): ReactNode {
  const sourceLabel = item.packageName !== undefined && item.packageName.length > 0 ? t('sourceNpm') : t('sourceGit')
  const dates = item.updatedAt.length > 0
    ? t('updatedAt') + ' ' + shortDate(item.updatedAt)
      + (item.createdAt.length > 0 ? ' · ' + t('createdAt') + ' ' + shortDate(item.createdAt) : '')
    : item.createdAt.length > 0 ? t('createdAt') + ' ' + shortDate(item.createdAt) : ''
  // Two fixed rows of TAG_SLOTS chips. The tag count is bounded by the shared
  // model (category + type + status + verify + security + 2 topics = 7), so
  // the overflow chip is a safety net, not the normal path.
  const firstRow = tags.slice(0, TAG_SLOTS)
  const secondRow = tags.slice(TAG_SLOTS, TAG_SLOTS * 2)
  const overflow = tagOverflowCount(tags, item.topics, TAG_SLOTS)
  const overflowTitle = tagOverflowTitle(t, tags, TAG_SLOTS)
  const topicsTitle = item.topics?.join(', ')
  return (
    <li style={styles.card}>
      {/* Slot 1: title + action. */}
      <div style={styles.cardRow}>
        <a href={item.url} target="_blank" rel="noreferrer" className="pm-link" style={{ ...styles.cardTitle, ...styles.link }} title={item.name}>
          {item.displayName}
        </a>
        <span style={styles.cardAction}>
          {item.installed ? (
            item.updateAvailable ? (
              <Button size="sm" variant="outline" disabled={disabled} onClick={() => onUpdate(item)}>
                {busy ? t('updating') : t('updateButton')}
              </Button>
            ) : (
              <Tag tone="success">
                {t('marketInstalled') + (item.installedVersion !== undefined ? ' v' + item.installedVersion : '')}
              </Tag>
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
      {/* Slots 2/3: the shared tag model, printed in array order, never
          re-sorted. The official Tag has no title prop, so the hover hint is
          an outer span (its own display:inline-flex keeps the row layout). */}
      <div style={styles.tagRow}>
        {firstRow.map(tag => (
          <span key={marketTagKey(tag)} style={styles.tagWrap} title={tag.title ?? tag.value}>
            <Tag tone={tagTones[tag.tone]}>{tagLabelText(t, tag)}</Tag>
          </span>
        ))}
      </div>
      <div style={styles.tagRow}>
        {secondRow.map(tag => (
          <span key={marketTagKey(tag)} style={styles.tagWrap} title={tag.title ?? tag.value}>
            <Tag tone={tagTones[tag.tone]}>{tagLabelText(t, tag)}</Tag>
          </span>
        ))}
        {overflow > 0 && (
          <span style={styles.tagWrap} title={overflowTitle.length > 0 ? overflowTitle + ' · ' + topicsTitle : topicsTitle}>
            <Tag tone="outline">{'+' + String(overflow)}</Tag>
          </span>
        )}
      </div>
      {/* Slot 4: description, clamped to two lines (never a third). */}
      <div style={styles.descRow}>
        <span style={styles.cardDesc} title={item.description ?? ''}>
          {item.description !== undefined && item.description.length > 0 ? item.description : '\u00A0'}
        </span>
      </div>
      {/* Slot 5: dates left, star/source meta right. */}
      <div style={styles.dateRow}>
        <span style={{ ...styles.meta, ...styles.dateText }} title={dates}>{dates}</span>
        <span style={styles.tagWrap} title={String(item.stars)}>
          <Tag tone="outline">★ {formatStars(item.stars)}</Tag>
        </span>
        <span style={styles.tagWrap} title={item.packageName}>
          <Tag tone="outline">{sourceLabel}</Tag>
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

/**
 * A4：一个「渲染批次」的卡片组。
 *
 * 为什么需要它：`visibleCount` 每 +120 都会让父组件重建**整个已挂载窗口**
 * 的元素（`rows.slice(0, visibleCount)` 产生新数组 → 父层对 13k 个 key 做
 * `createElement` + React 协调）。13k / 120 = 109 批，累计 **1025 ms**，
 * 平均每批 9.4 ms（峰值 21 ms）——每次触底都掉帧。
 *
 * 分组之后：旧批次的 props 全是稳定引用/原始值（`rows` 是 `rows` useMemo
 * 的同一引用、`start`/`end` 是数字），`memo` 直接 bail out，只有新增的那
 * 一批真正建元素。父层每批只建 ~1 个元素而不是 13k 个。
 *
 * DOM 结构契约：组件返回 `React.Fragment`（不产生 DOM 节点），所以
 * `<ul>` 的直接子元素**仍然是 `<li>`**（MarketCard 渲染的），
 * 与 `tests/client-boot.test.mjs` 和布局契约一致。
 */
interface CardChunkProps {
  /** The full sorted row list — SAME reference across visibleCount changes
   *  (it comes from a useMemo), which is what lets old chunks bail out. */
  readonly rows: readonly MarketplaceItem[]
  readonly start: number
  readonly end: number
  readonly tagsByItem: ReadonlyMap<MarketplaceItem, readonly MarketTag[]>
  /** Name of the card whose own action is running (null = none). */
  readonly busyName: string | null
  /** All actions blocked (any busy action / env form open elsewhere). */
  readonly disabled: boolean
  /** Name of the card that owns the open env form (null = none). */
  readonly awaitingName: string | null
  readonly awaitingQuestions: readonly EnvQuestion[] | null
  readonly t: (key: PluginManagerLocaleKey) => string
  readonly onInstall: (item: MarketplaceItem) => void
  readonly onUpdate: (item: MarketplaceItem) => void
  readonly onEnvContinue: (item: MarketplaceItem, answers: Record<string, string>) => void
  readonly onEnvCancel: () => void
}

const CardChunk = memo(function CardChunk({
  rows, start, end, tagsByItem, busyName, disabled, awaitingName, awaitingQuestions, t,
  onInstall, onUpdate, onEnvContinue, onEnvCancel,
}: CardChunkProps): ReactNode {
  const cards: ReactNode[] = []
  for (let index = start; index < end; index += 1) {
    const item = rows[index]
    if (item === undefined) break
    cards.push(
      <MarketCard
        key={item.name}
        item={item}
        tags={tagsByItem.get(item) ?? NO_TAGS}
        busy={busyName === item.name}
        // Matches the documented contract: ANY open env form blocks
        // every action. Letting another card install while a form is
        // awaiting would overwrite awaiting (a single slot), so the
        // first card's questions would vanish mid-answer.
        disabled={disabled}
        envQuestions={awaitingName === item.name ? awaitingQuestions : null}
        t={t}
        onInstall={onInstall}
        onUpdate={onUpdate}
        onEnvContinue={onEnvContinue}
        onEnvCancel={onEnvCancel}
      />,
    )
  }
  // Fragment: keeps <ul>'s direct children as <li> (no wrapper DOM node).
  return <>{cards}</>
})

/** Render the marketplace page. */
export function PluginMarketplaceTab({ marketplace, profiles, install, update, unblock, t }: PluginMarketplaceTabProps): ReactNode {
  const [state, setState] = useState<ViewState>({ status: 'loading' })
  const [busy, setBusy] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<MarketSort>('stars')
  // Direction of the ACTIVE sort mode; starts at the stars default (desc).
  const [descending, setDescending] = useState(defaultDescendingFor('stars'))
  // Category filter; '' = every category.
  const [category, setCategory] = useState<string>(ALL_CATEGORIES)
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
  const listRef = useRef<HTMLUListElement | null>(null)
  // Refresh-in-flight flag: a full server re-crawl is the heaviest listing
  // operation — the button must not fire it twice concurrently.
  const [refreshing, setRefreshing] = useState(false)
  // Live seconds counter while an operation runs (a refresh re-crawl or an
  // install can take tens of seconds — the counter tells "working" from
  // "hung").
  const elapsed = useElapsedSeconds(busy)

  const injected = useRef({ marketplace, profiles, install, update, unblock })

  // Request sequence guard: a slow response for an earlier profile must not
  // overwrite the listing of the currently selected one (audit M8).
  const fetchSeq = useRef(0)
  // Abort handle of the in-flight listing fetch. The marketplace payload is
  // the largest response in the plugin (~7MB at 13k entries) and a full
  // refresh re-crawls the upstream sources, so a profile switch or an unmount
  // must cancel the stale request instead of letting it finish and be dropped.
  const loadAbort = useRef<AbortController | null>(null)
  useEffect(() => () => { loadAbort.current?.abort() }, [])
  /** Fetch the listing; installed flags are computed server-side per profile. */
  const fetchMarketplace = useCallback((refresh: boolean, profile: string): void => {
    const seq = ++fetchSeq.current
    loadAbort.current?.abort()
    const controller = new AbortController()
    loadAbort.current = controller
    if (refresh) setRefreshing(true)
    setState(current => current.status === 'ready' ? current : { status: 'loading' })
    void injected.current.marketplace(refresh, profile, controller.signal).then(
      (result) => { if (seq === fetchSeq.current) setState({ status: 'ready', result }) },
      (error: unknown) => {
        // An aborted fetch is superseded by design — not a visible failure.
        if (isAbortError(error)) return
        if (seq === fetchSeq.current) setState({ status: 'error', message: error instanceof Error ? error.message : String(error) })
      },
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

  /**
   * Switch sort mode. Each mode starts in its natural direction (stars and
   * dates newest-first, A-Z ascending) so the direction button never opens on
   * a direction the user did not ask for; the reset effect below then rewinds
   * the window and scrolls the list back to its top.
   */
  const onSortChange = (value: string): void => {
    const next = value as MarketSort
    setSort(next)
    setDescending(defaultDescendingFor(next))
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

  const items = state.status === 'ready' ? state.result.items : EMPTY_ITEMS
  // 输入保持即时响应：过滤/排序跟随 deferred 值在低优先级渲染中重算
  // （13k+ 条 × O(名称×query) 的对齐打分不阻塞键击）。
  const deferredQuery = useDeferredValue(query)
  const searchQuery = deferredQuery.trim().toLocaleLowerCase()

  // 分类筛选先于检索：它同时决定 haystack 索引、结果集与空态判定。
  const visibleItems = useMemo(() => filterByCategory(items, category), [items, category])

  // 预构建小写检索索引：只在列表变化时小写化一次（每键击对 13k 条 × 2 个
  // 字段打分，原实现每键击每次调用都重复 toLowerCase 并为描述兜底新分配
  // 全量小写串）。
  const haystacks = useMemo(() => visibleItems.map(item => ({
    display: item.displayName.toLowerCase(),
    name: item.name.toLowerCase(),
    description: (item.description ?? '').toLowerCase(),
    // A2 预筛掩码：随小写串一起算一次，每键击用 O(1) 的位与拒绝掉绝大多数
    // 不可能命中的条目（13k 条里"marketplace"只命中 63 条，却要跑完 13k×2
    // 次 DP）。掩码只做拒绝、不参与打分。
    displayMask: charMask(item.displayName.toLowerCase()),
    nameMask: charMask(item.name.toLowerCase()),
  })), [visibleItems])

  // 卡片标签：整表只构建一次，按条目身份缓存——它是卡片的 props，必须保持
  // 引用稳定，否则 memo 每渲染都失效（13k 条时代价极高）。
  const tagsByItem = useMemo(
    () => new Map(items.map(item => [item, tagsOf(item)])),
    [items],
  )

  const rows = useMemo(() => {
    if (searchQuery.length === 0) return sortRows(visibleItems, sort, descending)
    // 搜索态：相关性优先（对齐分 desc）——与官方 slash 菜单的排序契约一致
    // （rankByName：前缀/边界 > 连续命中 > 间隔）。名称子序列命中为主（已
    // 涵盖子串命中），描述子串命中作 1 分兜底，保证"名字不匹配但描述匹配"
    // 的条目仍可被发现。方向按钮只作用于四种排序模式：把相关性反过来会让
    // 最差匹配排在最前；同分用与排序模式同一套 tie-break 保证结果确定。
    const hits: Array<{ item: MarketplaceItem; score: number }> = []
    // A2：needle 掩码每键击算一次（不是每条算一次）。
    const needleMask = charMask(searchQuery)
    for (let index = 0; index < visibleItems.length; index += 1) {
      const item = visibleItems[index]!
      const hay = haystacks[index]!
      const display = fuzzyScoreLowered(hay.display, searchQuery, hay.displayMask, needleMask)
      const full = fuzzyScoreLowered(hay.name, searchQuery, hay.nameMask, needleMask)
      const best = display !== null && full !== null ? Math.max(display, full) : (display ?? full)
      const score = best ?? (hay.description.includes(searchQuery) ? 1 : null)
      if (score !== null) hits.push({ item, score })
    }
    hits.sort((a, b) => b.score - a.score || compareTie(a.item, b.item))
    return hits.map(hit => hit.item)
  }, [visibleItems, haystacks, searchQuery, sort, descending])

  /**
   * Category options: the host aggregate when the payload carries one, else
   * the client aggregation of the same listing (same shared implementation,
   * so the two paths cannot disagree). 'other' is pinned last by
   * orderCategories; unknown upstream ids stay as-is (raw label).
   */
  const categories = useMemo(() => {
    const host = state.status === 'ready' ? readHostCategories(state.result) : undefined
    return orderCategories(host ?? categoryCounts(items))
  }, [state, items])

  const categoryOptions = useMemo(
    () => buildCategoryOptions(t, categories, items.length),
    [categories, items.length, t],
  )

  // A selected category that vanished from a refreshed listing would filter
  // everything out with no way back — fall back to "all".
  useEffect(() => {
    if (category !== ALL_CATEGORIES && !categories.some(entry => entry.id === category)) setCategory(ALL_CATEGORIES)
  }, [categories, category])

  /**
   * A fresh query / sort / direction / category is a DIFFERENT list: reset the
   * incremental window (a new list must not be revealed from a stale offset)
   * and scroll back to its top. Column count is a pure layout preference and
   * deliberately does not participate. The first run is the mount — the reader
   * is already at the top, so nothing scrolls.
   */
  const skipFirstReset = useRef(true)
  useEffect(() => {
    setVisibleCount(RENDER_BATCH)
    if (skipFirstReset.current) {
      skipFirstReset.current = false
      return
    }
    const node = listRef.current
    if (node !== null && typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'start' })
  }, [searchQuery, sort, descending, category])

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

  // A4：把已挂载窗口切成固定大小的批次。批次边界只依赖 visibleCount 与
  // RENDER_BATCH，所以"增长"只追加一个新 chunk，旧的 chunk 因 props 未变
  // 而整体 bail out——父层不再重建整个窗口。
  const chunkStarts = useMemo(() => {
    const starts: number[] = []
    for (let start = 0; start < visibleCount && start < rows.length; start += RENDER_BATCH) starts.push(start)
    return starts
  }, [visibleCount, rows.length])
  // 已挂载的卡片数（"还有 N 条"的计数与 sentinel 判据都用它）。
  const renderedCount = Math.min(visibleCount, rows.length)
  const filtering = category !== ALL_CATEGORIES
  // Toolbar labels come from the same model the comparator is built from, so
  // the direction button cannot name a direction the list is not in.
  const toolbar = marketToolbarModel(sort, descending, category)
  const sortOptions = useMemo(
    () => toolbar.sortOptions.map(mode => ({ value: mode, label: t(sortLabelKey(mode)) })),
    [toolbar.sortOptions, t],
  )

  return (
    <div style={styles.section}>
      {/* 链接语言对齐官方（0.1.3 alias-link）：hover/focus 点状下划线。
          官方 Input 是 inline-flex，宽度只能由 className 给（style 会落到
          内层 input 上）。 */}
      <style>{PM_LINK_CSS}{MARKET_CSS}</style>
      <div style={styles.heading}>
        <h2 style={styles.pageTitle}>{t('marketList')}</h2>
      </div>
      <div style={styles.toolbar}>
        <span style={styles.filterLabel}>{t('sortLabel')}</span>
        <PmSelect
          ariaLabel={t('sortLabel')}
          value={toolbar.sort}
          options={sortOptions}
          onChange={onSortChange}
        />
        {/* Label and comparator share the one descending state — the button can
            never name a direction the list is not in. */}
        <Button size="sm" variant="ghost" onClick={() => setDescending(current => !current)}>
          {t(toolbar.directionLabelKey)}
        </Button>
        <span style={styles.filterLabel}>{t(toolbar.categoryLabelKey)}</span>
        <PmSelect
          ariaLabel={t(toolbar.categoryLabelKey)}
          value={toolbar.category}
          options={categoryOptions}
          onChange={setCategory}
        />
        <span style={{ marginLeft: 'auto' }} />
        <Button size="sm" variant="ghost" onClick={onColsToggle}>
          {cols === 2 ? t('colsOne') : t('colsTwo')}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy !== null || refreshing} onClick={() => fetchMarketplace(true, targetProfile)}>
          {refreshing ? t('refreshing') : t('refresh')}
        </Button>
        {elapsed > 0 && <span style={styles.filterLabel}>{elapsed}s</span>}
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
            <span style={styles.headingCount}>
              {filtering ? String(rows.length) + ' / ' + String(items.length) : rows.length}
            </span>
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
          {/* Official Input: 0.5px hairline + :focus-within border-color, the
              focus affordance the hand-rolled box never had. Its className
              lands on the wrapper span (style would land on the inner input). */}
          <Input
            className="pm-market-search"
            type="search"
            icon={<IconSearchOutline16 aria-hidden="true" />}
            value={query}
            placeholder={t('search')}
            aria-label={t('search')}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
          {rows.length === 0 && (
            <div>
              <p style={styles.status}>{filtering ? t('marketEmptyCategory') : t('noMarketItems')}</p>
              {!state.result.ok && state.result.message.length > 0 && (
                <p style={styles.error} role="alert">{t('marketSourceError')}: {state.result.message}</p>
              )}
            </div>
          )}
          {state.result.ok && state.result.message.includes('unavailable') && (
            <p style={styles.status}>{t('marketSourceNote')}: {state.result.message}</p>
          )}
          {renderedCount > 0 && (
            <ul ref={listRef} style={{ ...styles.cards, gridTemplateColumns: cols === 2 ? 'repeat(2, minmax(0, 1fr))' : 'repeat(1, minmax(0, 1fr))' }}>
              {chunkStarts.map((start) => (
                <CardChunk
                  key={start}
                  rows={rows}
                  start={start}
                  end={Math.min(start + RENDER_BATCH, renderedCount)}
                  tagsByItem={tagsByItem}
                  busyName={busy}
                  disabled={busy !== null || awaiting !== null}
                  awaitingName={awaiting !== null ? awaiting.name : null}
                  awaitingQuestions={awaiting !== null ? awaiting.questions : null}
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
          {rows.length > renderedCount && <div ref={sentinelRef} style={{ height: 1 }} />}
          {rows.length > renderedCount && (
            <Button size="sm" variant="ghost" onClick={() => setVisibleCount(count => Math.min(count + RENDER_BATCH, rows.length))}>
              {t('marketMore')} ({rows.length - renderedCount})
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
