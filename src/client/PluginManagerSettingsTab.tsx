/**
 * Plugin Manager management tab: install/remove packages and live-mount
 * rows. Viewing/toggling lives in the catalog tab (PluginCatalogTab); this
 * tab only manages installation state.
 */

import React, { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Button, IconChevronDownOutline14, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  CommandResult, MutationResult, PluginManagerSnapshot, ProfileInfo,
} from '../types.ts'
import type { PluginManagerLocaleKey } from './locales.ts'
import { PmSelect } from './PmSelect.tsx'

/** Registration-side Remote face provided by the section. */
export interface PluginManagerTabInjected {
  readonly profiles: () => Promise<ProfileInfo[]>
  readonly list: (profile: string) => Promise<PluginManagerSnapshot>
  readonly install: (profile: string, spec: string) => Promise<CommandResult>
  readonly remove: (profile: string, name: string) => Promise<CommandResult>
  readonly removeInsert: (profile: string, rowId: string) => Promise<MutationResult>
  readonly copyPlugins: (from: string, to: string, names: string[]) => Promise<CommandResult>
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
export function PluginManagerSettingsTab({ profiles, list, install, remove, removeInsert, copyPlugins, t }: PluginManagerTabProps): ReactNode {
  const [profileList, setProfileList] = useState<ProfileInfo[]>([])
  const [selected, setSelected] = useState<string>('')
  const [state, setState] = useState<ViewState>({ status: 'loading' })
  const [busy, setBusy] = useState<string | null>(null)
  const [spec, setSpec] = useState('')
  const [output, setOutput] = useState<string>('')

  // Stable identity for the once-only boot effect (see PluginCatalogTab).
  const injected = useRef({ profiles, list, install, remove, removeInsert, copyPlugins })

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
        // Default to the profile hosting this running plugin, else the first.
        const current = items.find(profile => profile.isCurrent === true) ?? items[0]!
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
    load(name)
  }

  const onInstall = async (): Promise<void> => {
    const trimmed = spec.trim()
    if (selected.length === 0 || trimmed.length === 0) return
    setBusy('install')
    try {
      const result = await install(selected, trimmed)
      const mounted = result.installed !== undefined && result.installed.length > 0
        ? '\n✓ ' + t('installMounted')
        : ''
      setOutput('$ dsh plugin --profile ' + selected + ' add ' + trimmed + '\n' + result.output + mounted)
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
              disabled={busy !== null}
              onChange={(event: React.ChangeEvent<HTMLInputElement>) => setSpec(event.currentTarget.value)}
              onKeyDown={(event: React.KeyboardEvent<HTMLInputElement>) => { if (event.key === 'Enter') void onInstall() }}
              style={{ flex: 1 }}
            />
            <Button variant="primary" disabled={busy !== null || spec.trim().length === 0} onClick={() => void onInstall()}>
              {busy === 'install' ? t('installing') : t('installButton')}
            </Button>
          </div>

          <div style={styles.heading}>
            <h3 style={styles.headingTitle}>{t('packages')}</h3>
            <span style={styles.headingCount}>{packages.length}</span>
          </div>
          {packages.length === 0 ? <p style={styles.status}>{t('noPackages')}</p> : (
            <ul style={styles.cards}>
              {packages.map((pkg) => {
                const open = expandedPkg === pkg.name
                return (
                  <li key={pkg.name} className="pm-card" data-open={open ? 'true' : undefined}>
                    <button
                      className="pm-card-content"
                      style={styles.cardContent}
                      type="button"
                      aria-expanded={open}
                      onClick={() => setExpandedPkg(current => current === pkg.name ? null : pkg.name)}
                    >
                      <span style={styles.cardTitle} title={pkg.name}>{pkg.name}</span>
                      <span style={styles.cardTrailing}>
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
                            <dt>{t('updatedAt')}</dt>
                            <dd>{t('unknown')}</dd>
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
                        </dl>
                        <div style={{ marginTop: '10px', display: 'flex', justifyContent: 'flex-end' }}>
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

          <div style={styles.toolbar}>
            <Input
              type="text"
              value={spec}
              placeholder={t('installPlaceholder')}
              disabled={busy !== null}
              onChange={(event: React.ChangeEvent<HTMLInputElement>) => setSpec(event.currentTarget.value)}
              onKeyDown={(event: React.KeyboardEvent<HTMLInputElement>) => { if (event.key === 'Enter') void onInstall() }}
              style={{ flex: 1 }}
            />
            <Button variant="primary" disabled={busy !== null || spec.trim().length === 0} onClick={() => void onInstall()}>
              {busy === 'install' ? t('installing') : t('installButton')}
            </Button>
          </div>


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
