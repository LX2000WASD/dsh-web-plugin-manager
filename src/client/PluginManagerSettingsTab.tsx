/**
 * Plugin Manager settings tab: install/remove packages, live-mount rows, and
 * toggle entries. Renders inside the official Plugins settings section
 * (settings.plugins.tab) with official ui-primitives and --dsw-* tokens.
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  Button, IconSearchOutline16, Input,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  CommandResult, MutationResult, PluginManagerSnapshot, ProfileInfo,
} from '../types.ts'
import type { PluginManagerLocaleKey } from './locales.ts'

/** Registration-side Remote face provided by the section. */
export interface PluginManagerTabInjected {
  readonly profiles: () => Promise<ProfileInfo[]>
  readonly list: (profile: string) => Promise<PluginManagerSnapshot>
  readonly setEnabled: (profile: string, entryId: string, enabled: boolean) => Promise<MutationResult>
  readonly install: (profile: string, spec: string) => Promise<CommandResult>
  readonly remove: (profile: string, name: string) => Promise<CommandResult>
  readonly removeInsert: (profile: string, rowId: string) => Promise<MutationResult>
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
  toolbar: { display: 'flex', alignItems: 'center', gap: '10px' },
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
  statusDot: {
    display: 'inline-block', width: '7px', height: '7px', flex: 'none',
    borderRadius: '999px', background: 'var(--dsw-alias-label-tertiary)',
  },
  statusDotActive: { background: 'var(--dsw-alias-state-success-primary)' },
  statusDotFailed: { background: 'var(--dsw-alias-state-error-primary)' },
  statusDotLoading: { background: 'var(--dsw-alias-state-business-primary)' },
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
}

/** Compact a module specifier like the official inventory. */
function moduleShortName(moduleName: string): string {
  const unscoped = moduleName.startsWith('@') ? moduleName.slice(moduleName.indexOf('/') + 1) : moduleName
  return unscoped
    .replace(/^cordis:/, '')
    .replace(/^cordis-plugin-/, '')
    .replace(/^dsh-(?:host-|client-)?/, '')
}

/** Render the management tab. */
export function PluginManagerSettingsTab({ profiles, list, setEnabled, install, remove, removeInsert, t }: PluginManagerTabProps): ReactNode {
  const [profileList, setProfileList] = useState<ProfileInfo[]>([])
  const [selected, setSelected] = useState<string>('')
  const [state, setState] = useState<ViewState>({ status: 'loading' })
  const [busy, setBusy] = useState<string | null>(null)
  const [spec, setSpec] = useState('')
  const [query, setQuery] = useState('')
  const [output, setOutput] = useState<string>('')

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
        setSelected(items[0]!.name)
        refresh(items[0]!.name)
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
    refresh(name)
  }

  const onToggle = async (entryId: string, enable: boolean): Promise<void> => {
    if (selected.length === 0) return
    if (!enable && !window.confirm(t('confirmDisable'))) return
    setBusy(entryId)
    try {
      const result = await setEnabled(selected, entryId, enable)
      setOutput(result.message)
      refresh(selected)
    } finally {
      setBusy(null)
    }
  }

  const onInstall = async (): Promise<void> => {
    const trimmed = spec.trim()
    if (selected.length === 0 || trimmed.length === 0) return
    setBusy('install')
    try {
      const result = await install(selected, trimmed)
      const mounted = result.installed !== undefined && result.installed.length > 0
        ? `\n✓ ${t('installMounted')}`
        : ''
      setOutput(`$ dsh plugin --profile ${selected} add ${trimmed}\n${result.output}${mounted}`)
      setSpec('')
      refresh(selected)
    } finally {
      setBusy(null)
    }
  }

  const onRemove = async (name: string): Promise<void> => {
    if (!window.confirm(t('confirmRemove'))) return
    setBusy(name)
    try {
      const result = await remove(selected, name)
      setOutput(`$ dsh plugin --profile ${selected} remove ${name}\n${result.output}`)
      refresh(selected)
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
      refresh(selected)
    } finally {
      setBusy(null)
    }
  }

  const snapshot = state.status === 'ready' ? state.snapshot : undefined
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const entries = useMemo(
    () => (snapshot?.entries ?? []).filter(
      entry => normalizedQuery.length === 0
        || entry.entryId.toLocaleLowerCase().includes(normalizedQuery)
        || entry.moduleName.toLocaleLowerCase().includes(normalizedQuery),
    ),
    [snapshot, normalizedQuery],
  )
  const packages = useMemo(
    () => (snapshot?.packages ?? []).filter(
      pkg => normalizedQuery.length === 0 || pkg.name.toLocaleLowerCase().includes(normalizedQuery),
    ),
    [snapshot, normalizedQuery],
  )
  const insertRows = useMemo(
    () => (snapshot?.insertRows ?? []).filter(
      row => normalizedQuery.length === 0
        || row.id.toLocaleLowerCase().includes(normalizedQuery)
        || row.name.toLocaleLowerCase().includes(normalizedQuery),
    ),
    [snapshot, normalizedQuery],
  )

  const dotStyle = (phase: string | null): React.CSSProperties => {
    if (phase === 'active') return { ...styles.statusDot, ...styles.statusDotActive }
    if (phase === 'failed') return { ...styles.statusDot, ...styles.statusDotFailed }
    if (phase === 'loading' || phase === 'pending') return { ...styles.statusDot, ...styles.statusDotLoading }
    return styles.statusDot
  }

  return (
    <div style={styles.section}>
      <div style={styles.toolbar}>
        <label htmlFor="pm-profile" style={{ ...styles.status, display: 'inline-flex', alignItems: 'center' }}>{t('profileLabel')}</label>
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

          <div style={styles.heading}>
            <h3 style={styles.headingTitle}>{t('packages')}</h3>
            <span style={styles.headingCount}>{packages.length}</span>
          </div>
          {packages.length === 0 ? <p style={styles.status}>{t('noPackages')}</p> : (
            <ul style={styles.cards}>
              {packages.map((pkg) => (
                <li key={pkg.name} style={styles.card}>
                  <div style={styles.cardRow}>
                    <span style={styles.cardTitle} title={pkg.name}>{pkg.name}</span>
                    <span style={{ ...styles.tag, ...(pkg.isBundle ? styles.tagOn : {}) }}>
                      {pkg.isBundle ? t('bundleBadge') : t('dependencyBadge')}
                    </span>
                    <span style={{ marginLeft: 'auto' }}>
                      <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void onRemove(pkg.name)}>
                        {t('removeButton')}
                      </Button>
                    </span>
                  </div>
                </li>
              ))}
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

          <div style={styles.toolbar}>
            <Input
              type="text"
              value={spec}
              placeholder={t('installPlaceholder')}
              disabled={busy !== null}
              onChange={(event) => setSpec(event.currentTarget.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') void onInstall() }}
              style={{ flex: 1 }}
            />
            <Button variant="primary" disabled={busy !== null || spec.trim().length === 0} onClick={() => void onInstall()}>
              {busy === 'install' ? t('installing') : t('installButton')}
            </Button>
          </div>

          <div style={styles.heading}>
            <h3 style={styles.headingTitle}>{t('entries')}</h3>
            <span style={styles.headingCount}>{entries.length}</span>
          </div>
          {entries.length === 0 ? <p style={styles.status}>{t('noEntries')}</p> : (
            <ul style={styles.cards}>
              {entries.map((entry) => {
                const title = moduleShortName(entry.moduleName)
                return (
                  <li key={entry.entryId} style={styles.card} data-plugin-entry={entry.entryId}>
                    <div style={styles.cardRow}>
                      <span
                        style={dotStyle(entry.fiberPhase)}
                        data-phase={entry.fiberPhase ?? 'unobserved'}
                        role="img"
                        aria-label={entry.fiberPhase ?? t('unobserved')}
                        title={entry.fiberPhase ?? t('unobserved')}
                      />
                      <span style={styles.cardTitle} title={entry.moduleName}>{title}</span>
                      <span style={styles.cardSub}>{entry.entryId}</span>
                      <span style={{ ...styles.tag, ...(entry.enabled ? styles.tagOn : {}) }}>
                        {entry.enabled ? t('enabled') : t('disabled')}
                      </span>
                      <span style={{ marginLeft: 'auto' }}>
                        <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void onToggle(entry.entryId, !entry.enabled)}>
                          {entry.enabled ? t('disableButton') : t('enableButton')}
                        </Button>
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
