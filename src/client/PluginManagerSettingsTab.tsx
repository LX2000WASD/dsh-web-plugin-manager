/**
 * Plugin Manager settings tab: install/remove packages and toggle entries.
 * Renders inside the official Plugins settings section (settings.plugins.tab).
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react'
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

/** Plain, dependency-light table styling via inline styles (no css file needed for v1). */
const styles: Record<string, React.CSSProperties> = {
  section: { display: 'flex', flexDirection: 'column', gap: '16px', padding: '16px 0' },
  row: { display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 0', borderBottom: '1px solid var(--ds-color-border, #ddd)' },
  badge: { padding: '1px 6px', borderRadius: '8px', fontSize: '11px', border: '1px solid currentColor' },
  mono: { fontFamily: 'var(--ds-font-mono, monospace)', fontSize: '12px' },
  output: { maxHeight: '200px', overflow: 'auto', whiteSpace: 'pre-wrap', background: 'var(--ds-color-surface-muted, #f5f5f5)', padding: '8px', borderRadius: '4px', fontFamily: 'var(--ds-font-mono, monospace)', fontSize: '12px' },
}

/** Render the management tab. */
export function PluginManagerSettingsTab({ profiles, list, setEnabled, install, remove, removeInsert, t }: PluginManagerTabProps): ReactNode {
  const [profileList, setProfileList] = useState<ProfileInfo[]>([])
  const [selected, setSelected] = useState<string>('')
  const [state, setState] = useState<ViewState>({ status: 'loading' })
  const [busy, setBusy] = useState<string | null>(null)
  const [spec, setSpec] = useState('')
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
  const entries = useMemo(
    () => (snapshot?.entries ?? []).filter(e => !e.moduleName.startsWith('@deepseek-ai/dsh-') || snapshot!.packages.some(p => p.name === e.moduleName)),
    [snapshot],
  )

  return (
    <div style={styles.section}>
      <div style={styles.row}>
        <label htmlFor="pm-profile">{t('profileLabel')}</label>
        <select
          id="pm-profile"
          value={selected}
          disabled={profileList.length === 0 || busy !== null}
          onChange={(event) => onSelect(event.target.value)}
        >
          {profileList.map((profile) => (
            <option key={profile.name} value={profile.name}>{profile.name}</option>
          ))}
        </select>
        <button type="button" onClick={() => refresh(selected)} disabled={selected.length === 0 || busy !== null}>{t('refresh')}</button>
      </div>

      {state.status === 'error' && <p style={{ color: 'var(--ds-color-danger, #c00)' }}>{t('error')}: {state.message}</p>}
      {state.status === 'loading' && <p aria-busy="true">…</p>}

      {snapshot !== undefined && (
        <>
          <h3>{t('packages')}</h3>
          {snapshot.packages.length === 0 ? <p>{t('noPackages')}</p> : (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {snapshot.packages.map((pkg) => (
                <li key={pkg.name} style={styles.row}>
                  <span style={styles.mono}>{pkg.name}</span>
                  <span style={styles.badge}>{pkg.isBundle ? t('bundleBadge') : t('dependencyBadge')}</span>
                  {pkg.inLayerStack && <span style={{ ...styles.badge, color: '#2a7' }}>✓ {t('enabled')}</span>}
                  {!pkg.inLayerStack && <span style={{ ...styles.badge, color: '#a82' }}>{t('disabled')}</span>}
                  <span style={{ marginLeft: 'auto' }}>
                    <button type="button" disabled={busy !== null} onClick={() => onRemove(pkg.name)}>{t('removeButton')}</button>
                  </span>
                </li>
              ))}
            </ul>
          )}

          <div style={styles.row}>
            <input
              type="text"
              value={spec}
              placeholder={t('installPlaceholder')}
              disabled={busy !== null}
              onChange={(event) => setSpec(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') void onInstall() }}
              style={{ flex: 1 }}
            />
            <button type="button" disabled={busy !== null || spec.trim().length === 0} onClick={() => void onInstall()}>
              {busy === 'install' ? t('installing') : t('installButton')}
            </button>
          </div>

          <h3>{t('insertRows')}</h3>
          {(snapshot.insertRows ?? []).length === 0 ? <p>{t('noInsertRows')}</p> : (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {(snapshot.insertRows ?? []).map((row) => (
                <li key={row.id} style={styles.row}>
                  <span style={styles.mono}>{row.id}</span>
                  <span style={{ ...styles.mono, opacity: 0.7 }}>{row.name}</span>
                  <span style={{ ...styles.badge, color: row.managed ? '#2a7' : '#888' }}>
                    {row.managed ? t('liveBadge') : t('userBadge')}
                  </span>
                  <span style={{ marginLeft: 'auto' }}>
                    {row.managed && (
                      <button type="button" disabled={busy !== null} onClick={() => void onUninstall(row.id)}>
                        {t('uninstallButton')}
                      </button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}

          <h3>{t('entries')}</h3>
          {entries.length === 0 ? <p>—</p> : (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {entries.map((entry) => (
                <li key={entry.entryId} style={styles.row}>
                  <span style={styles.mono}>{entry.entryId}</span>
                  <span style={{ ...styles.mono, opacity: 0.7 }}>{entry.moduleName}</span>
                  <span style={styles.badge}>{t('phase')}: {entry.fiberPhase ?? '—'}</span>
                  <span style={{ marginLeft: 'auto' }}>
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => void onToggle(entry.entryId, !entry.enabled)}
                    >
                      {entry.enabled ? t('disableButton') : t('enableButton')}
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}

          <p style={{ opacity: 0.7, fontSize: '12px' }}>{t('restartHint')}</p>
          {output.length > 0 && (
            <div>
              <h4>{t('commandOutput')}</h4>
              <pre style={styles.output}>{output}</pre>
            </div>
          )}
        </>
      )}
    </div>
  )
}
