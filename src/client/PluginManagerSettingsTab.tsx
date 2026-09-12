/**
 * Plugin Manager management tab: install/remove packages and live-mount
 * rows. Viewing/toggling lives in the catalog tab (PluginCatalogTab); this
 * tab only manages installation state.
 */

import React, { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Button, IconChevronDownOutline14, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  AnalyzeIssue, AnalyzeResult, CommandResult, EnvQuestion, MutationResult, PluginManagerSnapshot, ProfileInfo, UpdateCheckResult, UpdateInfo,
} from '../types.ts'
import type { PluginManagerLocaleKey } from './locales.ts'
import { PM_CARD_CSS, PM_LINK_CSS, formatTime, isAbortError, outputStyle, useConfirm, useElapsedSeconds } from './shared.ts'
import { EnvQuestionForm } from './EnvQuestionForm.tsx'
import { PmSelect } from './PmSelect.tsx'

/** Registration-side Remote face provided by the section. Load-path methods
 *  take an optional trailing AbortSignal so a superseded fetch can be
 *  cancelled; mutating commands deliberately cannot be aborted. */
export interface PluginManagerTabInjected {
  readonly profiles: (signal?: AbortSignal) => Promise<ProfileInfo[]>
  readonly list: (profile: string, signal?: AbortSignal) => Promise<PluginManagerSnapshot>
  readonly install: (profile: string, spec: string, answers?: Record<string, string>) => Promise<CommandResult>
  readonly remove: (profile: string, name: string) => Promise<CommandResult>
  readonly removeInsert: (profile: string, rowId: string) => Promise<MutationResult>
  readonly copyPlugins: (from: string, to: string, names: string[]) => Promise<CommandResult>
  readonly checkUpdates: (profile: string) => Promise<UpdateCheckResult>
  readonly update: (profile: string, name: string) => Promise<CommandResult>
  readonly analyze: (profile: string) => Promise<AnalyzeResult>
  readonly fixIssue: (profile: string, action: string, target: string) => Promise<MutationResult>
  readonly fixAll: (profile: string) => Promise<CommandResult>
}

/** Full component props assembled by the Settings slot renderer. */
export type PluginManagerTabProps =
  PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'settings.pluginManager'>
  & InjectFace<PluginManagerTabInjected>

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
    width: '100%', minHeight: '52px', padding: '10px 14px',
  },
  cardTitle: {
    minWidth: 0, overflow: 'hidden', fontSize: '14px', lineHeight: '20px', fontWeight: 600,
    textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  cardSub: {
    minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    color: 'var(--dsw-alias-label-tertiary)', fontFamily: 'var(--ds-font-family-code)',
    fontSize: '11px', lineHeight: '17px',
  },
  tag: {
    display: 'inline-flex', alignItems: 'center', flex: 'none', minHeight: '20px',
    borderRadius: '5px', padding: '1px 6px', background: 'var(--dsw-alias-bg-layer-1)',
    color: 'var(--dsw-alias-label-secondary)', fontSize: '11px', lineHeight: '16px',
    whiteSpace: 'nowrap',
  },
  tagOn: {
    background: 'color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent)',
    color: 'var(--dsw-alias-state-success-primary)',
  },
  cardContent: {
    boxSizing: 'border-box', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    gap: '12px', width: '100%', minHeight: '52px', border: 0, padding: '12px 14px',
    background: 'transparent', color: 'inherit', font: 'inherit', textAlign: 'left', cursor: 'pointer',
  },
  cardTrailing: { display: 'inline-flex', flex: 'none', alignItems: 'center', gap: '7px' },
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
  link: {
    color: 'var(--dsw-alias-link, var(--dsw-alias-state-business-primary))',
    fontWeight: 500, textDecoration: 'none', overflowWrap: 'anywhere',
  },
  status: { fontSize: '13px', lineHeight: '20px', color: 'var(--dsw-alias-label-tertiary)', margin: 0 },
  error: { fontSize: '13px', lineHeight: '20px', color: 'var(--dsw-alias-state-error-primary)', margin: 0 },
  select: {
    height: '36px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '8px',
    padding: '0 10px', outline: 'none', background: 'var(--dsw-alias-bg-layer-1)',
    color: 'var(--dsw-alias-label-primary)', font: 'inherit', fontSize: '13px',
  },
  filterLabel: { fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
  foldButton: {
    border: 0, background: 'transparent', padding: 0, cursor: 'pointer',
    color: 'var(--dsw-alias-label-primary)', textAlign: 'left',
  },
  analysisPanel: {
    border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '10px',
    padding: '10px 14px', background: 'var(--dsw-alias-bg-layer-3)',
  },
  analysisList: {
    display: 'flex', flexDirection: 'column', gap: '6px',
    margin: '8px 0 0', padding: 0, listStyle: 'none',
  },
  analysisIssue: {
    display: 'flex', alignItems: 'baseline', gap: '8px', fontSize: '12px', lineHeight: '18px',
  },
  analysisIssueKind: {
    flex: 'none', fontFamily: 'var(--ds-font-family-code)', fontSize: '11px',
    color: 'var(--dsw-alias-state-warn-primary)', whiteSpace: 'nowrap',
  },
  analysisIssueText: { minWidth: 0, color: 'var(--dsw-alias-label-primary)', overflowWrap: 'anywhere' },
} satisfies Record<string, React.CSSProperties>

/** Render the management tab. */
export function PluginManagerSettingsTab({ profiles, list, install, remove, removeInsert, copyPlugins, checkUpdates, update, analyze, fixIssue, fixAll, t }: PluginManagerTabProps): ReactNode {
  const [profileList, setProfileList] = useState<ProfileInfo[]>([])
  const [selected, setSelected] = useState<string>('')
  const [state, setState] = useState<ViewState>({ status: 'loading' })
  const [busy, setBusy] = useState<string | null>(null)
  const [spec, setSpec] = useState('')
  const [output, setOutput] = useState<string>('')
  // C2: the install bar paused waiting for env vars (git-source plugins).
  const [envQuestions, setEnvQuestions] = useState<readonly EnvQuestion[] | null>(null)
  const [updates, setUpdates] = useState<Record<string, UpdateInfo>>({})
  const [checking, setChecking] = useState(false)
  const [analysis, setAnalysis] = useState<AnalyzeResult | null>(null)
  const [analyzing, setAnalyzing] = useState(false)
  // Health-check fix flow: which issue is fixing / awaiting B-level confirm /
  // already fixed in this session (cleared by the next analyze).
  const [fixing, setFixing] = useState<string | null>(null)
  // 行内二次确认（fix/remove/uninstall，键空间互不相交），4 秒无操作自动复位。
  const [confirmKey, setConfirmKey] = useConfirm()
  const [fixedKeys, setFixedKeys] = useState<Set<string>>(new Set())
  // Stable identity for the once-only boot effect (see PluginCatalogTab).
  const injected = useRef({ profiles, list, install, remove, removeInsert, copyPlugins, checkUpdates, update, analyze, fixIssue, fixAll })
  // Live seconds counter while an operation runs (install/update can take
  // tens of seconds — the counter tells "working" from "hung").
  const elapsed = useElapsedSeconds(busy)

  // Request sequence guard: a slow response from an earlier profile must
  // not overwrite the state of the currently selected one (audit M8).
  const loadSeq = useRef(0)
  // Late-response guard for per-profile commands (analyze / checkUpdates /
  // fixes / updates): same race as load, different surface — the response
  // is dropped when the profile it was issued for is no longer selected.
  const selectedRef = useRef(selected)
  useEffect(() => { selectedRef.current = selected }, [selected])
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

  const onSelect = (name: string): void => {
    setSelected(name)
    setUpdates({})
    setAnalysis(null)
    // C2 env form and command output are profile-bound — never leave them
    // dangling across a profile switch (audit M9 / m-1).
    setEnvQuestions(null)
    setOutput('')
    // 确认态（fix/remove/uninstall 共用，键空间互不相交）随 profile 复位。
    setConfirmKey(null)
    load(name)
  }

  const onAnalyze = async (): Promise<void> => {
    if (selected.length === 0 || analyzing) return
    const profile = selected
    setAnalyzing(true)
    try {
      const result = await injected.current.analyze(profile)
      if (selectedRef.current !== profile) return
      setAnalysis(result)
      setFixedKeys(new Set())
      setConfirmKey(null)
    } catch (error: unknown) {
      if (selectedRef.current !== profile) return
      setOutput('$ analyze --profile ' + profile + '\n[error] ' + (error instanceof Error ? error.message : String(error)))
    } finally {
      setAnalyzing(false)
    }
  }

  /** A-level fixes run directly; B-level suggestions confirm inline first. */
  const onFix = async (issue: AnalyzeIssue, key?: string): Promise<void> => {
    if (issue.fix === undefined) return
    // The caller passes the stable content-derived key (see issueKey); the
    // fallback keeps the function usable without one.
    const stableKey = key ?? issueKey('auto', issue)
    if (issue.fix.confirm) {
      const id = stableKey
      if (confirmKey !== id) {
        setConfirmKey(id)
        return
      }
      setConfirmKey(null)
    }
    const fixKey = stableKey
    const profile = selected
    setFixing(fixKey)
    try {
      const result = await injected.current.fixIssue(profile, issue.fix.action, issue.fix.target)
      if (selectedRef.current !== profile) return
      setOutput('$ fix ' + issue.kind + ' (' + issue.fix.label + ')\n' + result.message)
      if (result.ok) {
        setFixedKeys(current => new Set(current).add(fixKey))
        void onAnalyze()
      }
    } catch (error: unknown) {
      if (selectedRef.current !== profile) return
      setOutput('$ fix ' + issue.kind + '\n[error] ' + (error instanceof Error ? error.message : String(error)))
    } finally {
      setFixing(null)
    }
  }

  const onFixAll = async (): Promise<void> => {
    const profile = selected
    setFixing('all')
    try {
      const result = await injected.current.fixAll(profile)
      if (selectedRef.current !== profile) return
      setOutput('$ fix all\n' + result.output)
      void onAnalyze()
    } catch (error: unknown) {
      if (selectedRef.current !== profile) return
      setOutput('$ fix all\n[error] ' + (error instanceof Error ? error.message : String(error)))
    } finally {
      setFixing(null)
    }
  }

  /** Issues grouped by fixability: auto (A) / suggested (B) / manual (C). */
  const autoFixable = useMemo(
    () => (analysis?.issues ?? []).filter(issue => issue.fix !== undefined && !issue.fix.confirm),
    [analysis],
  )
  const suggested = useMemo(
    () => (analysis?.issues ?? []).filter(issue => issue.fix !== undefined && issue.fix.confirm),
    [analysis],
  )
  const manual = useMemo(
    () => (analysis?.issues ?? []).filter(issue => issue.fix === undefined),
    [analysis],
  )
  /**
   * Stable identity of one issue row. Positional keys ('auto-' + index) were
   * wrong twice over: React re-patched the wrong row after a successful fix
   * reordered the list, and the "fixed ✓" marker (keyed the same way) then
   * appeared on an unrelated line. Content-derived keys survive reordering.
   */
  const issueKey = (prefix: string, issue: AnalyzeIssue): string =>
    prefix + ':' + issue.kind + ':' + (issue.from ?? '') + ':' + (issue.to ?? '') + ':' + issue.message

  /** Shared install flow (was duplicated verbatim in onInstall/onEnvContinue
   *  — including the live-mount comment, which had already started to drift). */
  const runInstall = async (answers?: Record<string, string>): Promise<void> => {
    const trimmed = spec.trim()
    if (selected.length === 0 || trimmed.length === 0) return
    setBusy('install')
    try {
      const result = answers === undefined ? await install(selected, trimmed) : await install(selected, trimmed, answers)
      if (result.awaiting !== undefined) {
        // C2: paused for env vars — keep the spec, show the inline form.
        setEnvQuestions(result.awaiting.questions)
        setOutput('$ dsh plugin --profile ' + selected + ' add ' + trimmed + '\n' + result.output)
        return
      }
      // The host reports live: true only when the plugin was actually
      // mounted into the running loader tree. Bundle-layer plugins load at
      // the next start — claiming a live mount for them is a lie.
      const mounted = result.live === true
        ? '\n✓ ' + t('installMounted')
        : ''
      setOutput('$ dsh plugin --profile ' + selected + ' add ' + trimmed + '\n' + result.output + mounted)
      setEnvQuestions(null)
      setSpec('')
      load(selected)
    } catch (error: unknown) {
      setOutput('$ dsh plugin --profile ' + selected + ' add ' + trimmed + '\n[error] ' + (error instanceof Error ? error.message : String(error)))
    } finally {
      setBusy(null)
    }
  }

  const onInstall = (): Promise<void> => runInstall()

  /** C2: user submitted the env-var answers — continue the same install. */
  const onEnvContinue = (answers: Record<string, string>): Promise<void> => runInstall(answers)

  const onRemove = async (name: string): Promise<void> => {
    // 行内二次确认（键前缀与 fix 流程互不相交）：第一次点击只点亮确认态。
    const key = 'remove:' + name
    if (confirmKey !== key) {
      setConfirmKey(key)
      return
    }
    setConfirmKey(null)
    setBusy(name)
    try {
      const result = await remove(selected, name)
      setOutput('$ dsh plugin --profile ' + selected + ' remove ' + name + '\n' + result.output)
      load(selected)
    } catch (error: unknown) {
      setOutput('$ dsh plugin --profile ' + selected + ' remove ' + name + '\n[error] ' + (error instanceof Error ? error.message : String(error)))
    } finally {
      setBusy(null)
    }
  }

  const onUninstall = async (rowId: string): Promise<void> => {
    const key = 'uninstall:' + rowId
    if (confirmKey !== key) {
      setConfirmKey(key)
      return
    }
    setConfirmKey(null)
    setBusy(rowId)
    try {
      const result = await removeInsert(selected, rowId)
      setOutput(result.message)
      load(selected)
    } catch (error: unknown) {
      setOutput('$ removeInsert ' + rowId + '\n[error] ' + (error instanceof Error ? error.message : String(error)))
    } finally {
      setBusy(null)
    }
  }

  const onCheckUpdates = async (): Promise<void> => {
    if (selected.length === 0 || checking) return
    const profile = selected
    setChecking(true)
    try {
      const result = await injected.current.checkUpdates(profile)
      if (selectedRef.current !== profile) return
      const byName: Record<string, UpdateInfo> = {}
      for (const item of result.items) byName[item.name] = item
      setUpdates(byName)
      const updatable = result.items.filter(item => item.hasUpdate)
      setOutput('$ check updates --profile ' + profile + '\n'
        + (updatable.length > 0
          ? updatable.map(item => '  ' + item.name + ': ' + (item.currentVersion ?? '?') + ' → ' + (item.latestVersion ?? '?')).join('\n')
          : '  all ' + result.items.length + ' packages up to date')
        + '\n' + result.message)
    } catch (error: unknown) {
      if (selectedRef.current !== profile) return
      setOutput('$ check updates --profile ' + profile + '\n[error] ' + (error instanceof Error ? error.message : String(error)))
    } finally {
      setChecking(false)
    }
  }

  const onUpdate = async (name: string): Promise<void> => {
    if (selected.length === 0) return
    setBusy('update:' + name)
    try {
      const result = await injected.current.update(selected, name)
      setOutput('$ update ' + name + '\n' + result.output + '\n' + (result.ok ? t('updateRestartHint') : t('updateFailedHint')))
      setUpdates(current => { const next = { ...current }; if (result.ok) delete next[name]; return next })
      load(selected)
    } catch (error: unknown) {
      setOutput('$ update ' + name + '\n[error] ' + (error instanceof Error ? error.message : String(error)))
    } finally {
      setBusy(null)
    }
  }

  const [expandedPkg, setExpandedPkg] = useState<string | null>(null)
  const [outputOpen, setOutputOpen] = useState(true)

  const snapshot = state.status === 'ready' ? state.snapshot : undefined
  const packages = useMemo(() => snapshot?.packages ?? [], [snapshot])
  const insertRows = useMemo(() => snapshot?.insertRows ?? [], [snapshot])

  return (
    <div style={styles.section}>
      <style>{PM_CARD_CSS + `
.pm-card[data-updatable='true'] {
  border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 55%, transparent);
}
.pm-card[data-updatable='true'][data-open='true'] {
  border-color: var(--dsw-alias-state-success-secondary);
}
` + PM_LINK_CSS}</style>
      <div style={styles.toolbar}>
        <span style={styles.filterLabel}>{t('profileLabel')}</span>
        <PmSelect
          ariaLabel={t('profileLabel')}
          disabled={busy !== null || envQuestions !== null}
          value={selected}
          options={profileList.map(profile => ({ value: profile.name, label: profile.name }))}
          onChange={onSelect}
        />
        <Button size="sm" variant="ghost" disabled={selected.length === 0 || busy !== null} onClick={onRefresh}>
          {busy === 'refresh' ? t('refreshing') : t('refresh')}
        </Button>
        <span style={{ marginLeft: 'auto' }} />
        <Button size="sm" variant="ghost" disabled={selected.length === 0 || busy !== null || analyzing} onClick={() => void onAnalyze()}>
          {analyzing ? t('analyzing') : t('healthCheck')}
        </Button>
        <Button size="sm" variant="ghost" disabled={selected.length === 0 || busy !== null || checking} onClick={() => void onCheckUpdates()}>
          {checking ? t('checking') : t('checkUpdates')}
        </Button>
        {elapsed > 0 && <span style={styles.filterLabel}>{elapsed}s</span>}
      </div>

      {state.status === 'error' && <p style={styles.error} role="alert">{t('error')}: {state.message}</p>}
      {state.status === 'loading' && <p style={styles.status} aria-busy="true">{t('loading')}</p>}

      {snapshot !== undefined && (
        <>
          <div style={styles.toolbar}>
            <Input
              type="text"
              value={spec}
              placeholder={t('installPlaceholder')}
              disabled={busy !== null || envQuestions !== null}
              onChange={(event: React.ChangeEvent<HTMLInputElement>) => setSpec(event.currentTarget.value)}
              onKeyDown={(event: React.KeyboardEvent<HTMLInputElement>) => { if (event.key === 'Enter') void onInstall() }}
              style={{ flex: 1 }}
            />
            <Button variant="primary" disabled={busy !== null || envQuestions !== null || spec.trim().length === 0} onClick={() => void onInstall()}>
              {busy === 'install' ? t('installing') : t('installButton')}
            </Button>
          </div>
          {envQuestions !== null && (
            <EnvQuestionForm
              // key per spec: consecutive installs of different packages must
              // not inherit each other's answers (the spec input is frozen
              // while the form is open, so the key is stable within a pause).
              key={spec}
              questions={envQuestions}
              busy={busy === 'install'}
              t={t}
              onContinue={(answers) => void onEnvContinue(answers)}
              onCancel={() => setEnvQuestions(null)}
            />
          )}

          {analysis !== null && (
            <div style={styles.analysisPanel}>
              <div style={styles.heading}>
                <h3 style={styles.headingTitle}>{t('healthCheck')}</h3>
                <span style={styles.headingCount}>
                  {analysis.issues.length === 0 ? t('healthOk') : analysis.issues.length + ' ' + t('healthIssues')}
                </span>
                {autoFixable.length > 0 && (
                  <Button size="sm" variant="outline" disabled={busy !== null || fixing !== null} onClick={() => void onFixAll()}>
                    {fixing === 'all' ? t('fixing') : t('fixAllButton') + '(' + autoFixable.length + ')'}
                  </Button>
                )}
              </div>
              {analysis.issues.length === 0 ? (
                <p style={styles.status}>{t('healthClean')}</p>
              ) : (
                <>
                  {autoFixable.length > 0 && (
                    <p style={styles.status}>{t('fixAutoGroup')}</p>
                  )}
                  <ul style={styles.analysisList}>
                    {autoFixable.map((issue) => {
                      const key = issueKey('auto', issue)
                      return (
                        <li key={key} style={styles.analysisIssue}>
                          <span style={styles.analysisIssueKind}>{issue.kind}</span>
                          <span style={styles.analysisIssueText}>{issue.message}</span>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy !== null || fixing !== null}
                            onClick={() => void onFix(issue, key)}
                          >
                            {fixedKeys.has(key) ? t('fixDone') : fixing === key ? t('fixing') : t('fixButton')}
                          </Button>
                        </li>
                      )
                    })}
                  </ul>
                  {suggested.length > 0 && (
                    <p style={styles.status}>{t('fixSuggestedGroup')}</p>
                  )}
                  <ul style={styles.analysisList}>
                    {suggested.map((issue) => {
                      const key = issueKey('sug', issue)
                      const confirming = confirmKey === key
                      return (
                        <li key={key} style={styles.analysisIssue}>
                          <span style={styles.analysisIssueKind}>{issue.kind}</span>
                          <span style={styles.analysisIssueText}>{issue.message}</span>
                          <Button
                            size="sm"
                            variant={confirming ? 'primary' : 'outline'}
                            disabled={busy !== null || fixing !== null}
                            onClick={() => void onFix(issue, key)}
                          >
                            {fixedKeys.has(key) ? t('fixDone')
                              : fixing === key ? t('fixing')
                                : confirming ? t('fixConfirm')
                                  : t('fixSuggestButton')}
                          </Button>
                        </li>
                      )
                    })}
                  </ul>
                  {manual.length > 0 && (
                    <p style={styles.status}>{t('fixManualGroup')}</p>
                  )}
                  <ul style={styles.analysisList}>
                    {manual.map((issue) => (
                      <li key={issueKey('manual', issue)} style={styles.analysisIssue}>
                        <span style={styles.analysisIssueKind}>{issue.kind}</span>
                        <span style={styles.analysisIssueText}>{issue.message}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {analysis.topoOrder.length > 1 && (
                <div style={{ marginTop: '8px', fontSize: '11px', lineHeight: '17px', color: 'var(--dsw-alias-label-tertiary)' }}>
                  {t('loadOrder')}: {analysis.topoOrder.join(' → ')}
                </div>
              )}
            </div>
          )}

          <div style={styles.heading}>
            <h3 style={styles.headingTitle}>{t('packages')}</h3>
            <span style={styles.headingCount}>{packages.length}</span>
          </div>
          {packages.length === 0 ? <p style={styles.status}>{t('noPackages')}</p> : (
            <ul style={styles.cards}>
              {packages.map((pkg) => {
                const open = expandedPkg === pkg.name
                const info = updates[pkg.name]
                const updatable = info !== undefined && info.hasUpdate
                return (
                  <li key={pkg.name} className="pm-card" data-open={open ? 'true' : undefined} data-updatable={updatable ? 'true' : undefined}>
                    <button
                      className="pm-card-content"
                      style={styles.cardContent}
                      type="button"
                      aria-expanded={open}
                      onClick={() => setExpandedPkg(current => current === pkg.name ? null : pkg.name)}
                    >
                      <span style={styles.cardTitle} title={pkg.name}>{pkg.name}</span>
                      <span style={styles.cardTrailing}>
                        {updatable && (
                          <span style={{ ...styles.tag, ...styles.tagOn }}>{t('updateAvailable')}</span>
                        )}
                        <span style={{ ...styles.tag, ...(pkg.isBundle ? styles.tagOn : {}) }}>
                          {pkg.isBundle ? t('bundleBadge') : t('dependencyBadge')}
                        </span>
                        <IconChevronDownOutline14 size={12} aria-hidden="true" />
                      </span>
                    </button>
                    {open ? (
                      <div style={styles.cardDetails}>
                        <code style={styles.entryValue}>{pkg.name}{pkg.version ? '@' + pkg.version : ''}</code>
                        <dl style={styles.details}>
                          <div style={styles.detailsRow}>
                            <dt>{t('installedAt')}</dt>
                            <dd>{pkg.installedAt !== undefined ? formatTime(pkg.installedAt) : t('unknown')}</dd>
                          </div>
                          <div style={styles.detailsRow}>
                            <dt>{t('repository')}</dt>
                            <dd>
                              {pkg.repository !== undefined ? (
                                <a href={pkg.repository} target="_blank" rel="noreferrer" className="pm-link" style={styles.link}>
                                  {pkg.repository}
                                </a>
                              ) : t('unknown')}
                            </dd>
                          </div>
                          {info !== undefined && (
                            <>
                              {info.currentVersion !== undefined && (
                                <div style={styles.detailsRow}>
                                  <dt>{t('currentVersion')}</dt>
                                  <dd>{info.currentVersion}</dd>
                                </div>
                              )}
                              {info.latestVersion !== undefined && (
                                <div style={styles.detailsRow}>
                                  <dt>{t('latestVersion')}</dt>
                                  <dd>{info.latestVersion}</dd>
                                </div>
                              )}
                              {info.message !== undefined && (
                                <div style={styles.detailsRow}>
                                  <dt>{t('updateMessage')}</dt>
                                  <dd>{info.message}</dd>
                                </div>
                              )}
                            </>
                          )}
                        </dl>
                        <div style={{ marginTop: '10px', display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busy !== null || !updatable}
                            onClick={() => void onUpdate(pkg.name)}
                          >
                            {busy === 'update:' + pkg.name ? t('updating') : t('updateButton')}
                          </Button>
                          <Button
                            size="sm"
                            variant={confirmKey === 'remove:' + pkg.name ? 'primary' : 'ghost'}
                            disabled={busy !== null}
                            title={t('confirmRemove')}
                            onClick={() => void onRemove(pkg.name)}
                          >
                            {confirmKey === 'remove:' + pkg.name ? t('fixConfirm') : t('removeButton')}
                          </Button>
                        </div>
                      </div>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          )}

          <div style={styles.heading}>
            <h3 style={styles.headingTitle}>{t('insertRows')}</h3>
            <span style={styles.headingCount}>{insertRows.length}</span>
          </div>
          {insertRows.length === 0 ? <p style={styles.status}>{t('noInsertRows')}</p> : (
            <ul style={styles.cards}>
              {insertRows.map((row) => (
                <li key={row.id} style={styles.card}>
                  <div style={styles.cardRow}>
                    <span style={styles.cardTitle} title={row.id}>{row.id}</span>
                    <span style={styles.cardSub}>{row.name}</span>
                    <span style={{ ...styles.tag, ...(row.managed ? styles.tagOn : {}) }}>
                      {row.managed ? t('liveBadge') : t('userBadge')}
                    </span>
                    <span style={{ marginLeft: 'auto' }}>
                      {row.managed && (
                        <Button
                          size="sm"
                          variant={confirmKey === 'uninstall:' + row.id ? 'primary' : 'ghost'}
                          disabled={busy !== null}
                          title={t('confirmUninstall')}
                          onClick={() => void onUninstall(row.id)}
                        >
                          {confirmKey === 'uninstall:' + row.id ? t('fixConfirm') : t('uninstallButton')}
                        </Button>
                      )}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {output.length > 0 && (
            <div>
              <div style={styles.heading}>
                <button
                  type="button"
                  style={{ ...styles.headingTitle, ...styles.foldButton }}
                  onClick={() => setOutputOpen(current => !current)}
                >
                  {outputOpen ? '▾ ' : '▸ '}{t('commandOutput')}
                </button>
              </div>
              {outputOpen && <pre style={outputStyle}>{output}</pre>}
            </div>
          )}
        </>
      )}
    </div>
  )
}
