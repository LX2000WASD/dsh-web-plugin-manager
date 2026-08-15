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
import { EnvQuestionForm } from './EnvQuestionForm.tsx'
import { PmSelect } from './PmSelect.tsx'

/** Registration-side Remote face provided by the section. */
export interface PluginManagerTabInjected {
  readonly profiles: () => Promise<ProfileInfo[]>
  readonly list: (profile: string) => Promise<PluginManagerSnapshot>
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
    color: 'var(--dsw-alias-state-business-primary)', textDecoration: 'none', overflowWrap: 'anywhere',
  },
  output: {
    maxHeight: '200px', overflow: 'auto', whiteSpace: 'pre-wrap',
    border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '10px',
    padding: '10px 14px', background: 'var(--dsw-alias-bg-module-platform)',
    fontFamily: 'var(--ds-font-family-code)', fontSize: '12px', lineHeight: '18px',
    color: 'var(--dsw-alias-label-primary)', margin: 0,
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
}

/** Format an ISO timestamp for display (local time). */
function formatTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const pad = (value: number): string => String(value).padStart(2, '0')
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
    + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
}

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
  const [confirmKey, setConfirmKey] = useState<string | null>(null)
  const [fixedKeys, setFixedKeys] = useState<Set<string>>(new Set())

  // Stable identity for the once-only boot effect (see PluginCatalogTab).
  const injected = useRef({ profiles, list, install, remove, removeInsert, copyPlugins, checkUpdates, update, analyze, fixIssue, fixAll })

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

  useEffect(() => {
    void injected.current.profiles().then((items) => {
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
        setState({ status: 'ready', snapshot: undefined as unknown as PluginManagerSnapshot })
      }
    }, (error: unknown) => {
      setState({ status: 'error', message: error instanceof Error ? error.message : String(error) })
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const onSelect = (name: string): void => {
    setSelected(name)
    setUpdates({})
    setAnalysis(null)
    load(name)
  }

  const onAnalyze = async (): Promise<void> => {
    if (selected.length === 0 || analyzing) return
    setAnalyzing(true)
    try {
      const result = await injected.current.analyze(selected)
      setAnalysis(result)
      setFixedKeys(new Set())
      setConfirmKey(null)
    } finally {
      setAnalyzing(false)
    }
  }

  /** A-level fixes run directly; B-level suggestions confirm inline first. */
  const onFix = async (issue: AnalyzeIssue, key?: string): Promise<void> => {
    if (issue.fix === undefined) return
    if (issue.fix.confirm) {
      const id = key ?? issue.fix.label
      if (confirmKey !== id) {
        setConfirmKey(id)
        return
      }
      setConfirmKey(null)
    }
    const fixKey = key ?? 'auto-' + issue.kind
    setFixing(fixKey)
    try {
      const result = await injected.current.fixIssue(selected, issue.fix.action, issue.fix.target)
      setOutput('$ fix ' + issue.kind + ' (' + issue.fix.label + ')\n' + result.message)
      if (result.ok) {
        setFixedKeys(current => new Set(current).add(fixKey))
        void onAnalyze()
      }
    } finally {
      setFixing(null)
    }
  }

  const onFixAll = async (): Promise<void> => {
    setFixing('all')
    try {
      const result = await injected.current.fixAll(selected)
      setOutput('$ fix all\n' + result.output)
      void onAnalyze()
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

  const onInstall = async (): Promise<void> => {
    const trimmed = spec.trim()
    if (selected.length === 0 || trimmed.length === 0) return
    setBusy('install')
    try {
      const result = await install(selected, trimmed)
      if (result.awaiting !== undefined) {
        // C2: paused for env vars — keep the spec, show the inline form.
        setEnvQuestions(result.awaiting.questions)
        setOutput('$ dsh plugin --profile ' + selected + ' add ' + trimmed + '\n' + result.output)
        return
      }
      const mounted = result.installed !== undefined && result.installed.length > 0
        ? '\n✓ ' + t('installMounted')
        : ''
      setOutput('$ dsh plugin --profile ' + selected + ' add ' + trimmed + '\n' + result.output + mounted)
      setEnvQuestions(null)
      setSpec('')
      load(selected)
    } finally {
      setBusy(null)
    }
  }

  /** C2: user submitted the env-var answers — continue the same install. */
  const onEnvContinue = async (answers: Record<string, string>): Promise<void> => {
    const trimmed = spec.trim()
    if (selected.length === 0 || trimmed.length === 0) return
    setBusy('install')
    try {
      const result = await install(selected, trimmed, answers)
      if (result.awaiting !== undefined) {
        setEnvQuestions(result.awaiting.questions)
        setOutput('$ dsh plugin --profile ' + selected + ' add ' + trimmed + '\n' + result.output)
        return
      }
      const mounted = result.installed !== undefined && result.installed.length > 0
        ? '\n✓ ' + t('installMounted')
        : ''
      setOutput('$ dsh plugin --profile ' + selected + ' add ' + trimmed + '\n' + result.output + mounted)
      setEnvQuestions(null)
      setSpec('')
      load(selected)
    } finally {
      setBusy(null)
    }
  }

  const onRemove = async (name: string): Promise<void> => {
    if (!window.confirm(t('confirmRemove'))) return
    setBusy(name)
    try {
      const result = await remove(selected, name)
      setOutput('$ dsh plugin --profile ' + selected + ' remove ' + name + '\n' + result.output)
      load(selected)
    } finally {
      setBusy(null)
    }
  }

  const onUninstall = async (rowId: string): Promise<void> => {
    if (!window.confirm(t('confirmUninstall'))) return
    setBusy(rowId)
    try {
      const result = await removeInsert(selected, rowId)
      setOutput(result.message)
      load(selected)
    } finally {
      setBusy(null)
    }
  }

  const onCheckUpdates = async (): Promise<void> => {
    if (selected.length === 0 || checking) return
    setChecking(true)
    try {
      const result = await injected.current.checkUpdates(selected)
      const byName: Record<string, UpdateInfo> = {}
      for (const item of result.items) byName[item.name] = item
      setUpdates(byName)
      const updatable = result.items.filter(item => item.hasUpdate)
      setOutput('$ check updates --profile ' + selected + '\n'
        + (updatable.length > 0
          ? updatable.map(item => '  ' + item.name + ': ' + (item.currentVersion ?? '?') + ' → ' + (item.latestVersion ?? '?')).join('\n')
          : '  all ' + result.items.length + ' packages up to date')
        + '\n' + result.message)
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
      <style>{`
.pm-card {
  min-width: 0; overflow: hidden;
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px;
  background: var(--dsw-alias-bg-layer-3);
}
.pm-card[data-open='true'] { border-color: var(--dsw-alias-border-l1); }
.pm-card[data-updatable='true'] {
  border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 55%, transparent);
}
.pm-card[data-updatable='true'][data-open='true'] {
  border-color: var(--dsw-alias-state-success-secondary);
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
        <span style={{ marginLeft: 'auto' }} />
        <Button size="sm" variant="ghost" disabled={selected.length === 0 || busy !== null || analyzing} onClick={() => void onAnalyze()}>
          {analyzing ? t('analyzing') : t('healthCheck')}
        </Button>
        <Button size="sm" variant="ghost" disabled={selected.length === 0 || busy !== null || checking} onClick={() => void onCheckUpdates()}>
          {checking ? t('checking') : t('checkUpdates')}
        </Button>
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
                    {autoFixable.map((issue, index) => (
                      <li key={'auto-' + index} style={styles.analysisIssue}>
                        <span style={styles.analysisIssueKind}>{issue.kind}</span>
                        <span style={styles.analysisIssueText}>{issue.message}</span>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy !== null || fixing !== null}
                          onClick={() => void onFix(issue)}
                        >
                          {fixedKeys.has('auto-' + index) ? t('fixDone') : fixing === 'auto-' + index ? t('fixing') : t('fixButton')}
                        </Button>
                      </li>
                    ))}
                  </ul>
                  {suggested.length > 0 && (
                    <p style={styles.status}>{t('fixSuggestedGroup')}</p>
                  )}
                  <ul style={styles.analysisList}>
                    {suggested.map((issue, index) => {
                      const key = 'sug-' + index
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
                    {manual.map((issue, index) => (
                      <li key={'manual-' + index} style={styles.analysisIssue}>
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
                                <a href={pkg.repository} target="_blank" rel="noreferrer" style={styles.link}>
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
                          <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void onRemove(pkg.name)}>
                            {t('removeButton')}
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
                        <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void onUninstall(row.id)}>
                          {t('uninstallButton')}
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
              {outputOpen && <pre style={styles.output}>{output}</pre>}
            </div>
          )}
        </>
      )}
    </div>
  )
}
