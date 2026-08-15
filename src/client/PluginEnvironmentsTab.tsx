/**
 * Environment management tab: create/rename/remove custom profiles
 * (official web/headless are read-only), with web/headless templates.
 */

import React, { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  BackupDiffResult, BackupFile, CommandResult, MutationResult, ProfileInfo, StartResult,
} from '../types.ts'
import type { PluginManagerLocaleKey } from './locales.ts'
import { PmSelect } from './PmSelect.tsx'

/** Registration-side Remote face provided by the section. */
export interface PluginEnvironmentsTabInjected {
  readonly profiles: () => Promise<ProfileInfo[]>
  readonly copyPlugins: (from: string, to: string, names: string[]) => Promise<CommandResult>
  readonly startProfile: (name: string) => Promise<StartResult>
  readonly stopProfile: (name: string) => Promise<MutationResult>
  readonly createProfile: (name: string, template: string) => Promise<MutationResult>
  readonly renameProfile: (oldName: string, newName: string) => Promise<MutationResult>
  readonly removeProfile: (name: string) => Promise<MutationResult>
  readonly backupExport: (profile: string) => Promise<BackupFile>
  readonly backupDiff: (backup: BackupFile, profile: string) => Promise<BackupDiffResult>
  readonly backupRestore: (backup: BackupFile, profile: string) => Promise<CommandResult>
}

/** Full component props assembled by the Settings slot renderer. */
export type PluginEnvironmentsTabProps =
  PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'settings.pluginManager'>
  & InjectFace<PluginEnvironmentsTabInjected>

/** Official --dsw-* token styles (mirrors the other tabs). */
const styles: Record<string, React.CSSProperties> = {
  section: {
    display: 'flex', flexDirection: 'column', gap: '14px',
    width: '100%', maxWidth: '760px', color: 'var(--dsw-alias-label-primary)',
  },
  toolbar: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
  formCol: { display: 'flex', flexDirection: 'column', gap: '8px' },
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
    width: '100%', minHeight: '52px', padding: '10px 14px', flexWrap: 'wrap',
  },
  cardTitle: {
    minWidth: 0, overflow: 'hidden', fontSize: '14px', lineHeight: '20px', fontWeight: 600,
    textOverflow: 'ellipsis', whiteSpace: 'nowrap',
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
  status: { fontSize: '13px', lineHeight: '20px', color: 'var(--dsw-alias-label-tertiary)', margin: 0 },
  cardHeader: {
    boxSizing: 'border-box', display: 'flex', alignItems: 'center', gap: '8px',
    width: '100%', minHeight: '52px', padding: '0 10px 0 0',
  },
  titleButton: {
    boxSizing: 'border-box', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    gap: '12px', flex: 1, minWidth: 0, minHeight: '52px', border: 0, padding: '12px 14px',
    background: 'transparent', color: 'inherit', font: 'inherit', textAlign: 'left', cursor: 'pointer',
  },
  cardTrailing: { display: 'inline-flex', flex: 'none', alignItems: 'center', gap: '7px', minWidth: 0 },
  cardDetails: {
    borderTop: '1px solid var(--dsw-alias-border-l2)', padding: '10px 14px 12px',
    background: 'var(--dsw-alias-bg-module-platform)',
  },
  detailsActions: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
  error: { fontSize: '13px', lineHeight: '20px', color: 'var(--dsw-alias-state-error-primary)', margin: 0 },
  filterLabel: { fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
  output: {
    maxHeight: '200px', overflow: 'auto', whiteSpace: 'pre-wrap',
    border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '10px',
    padding: '10px 14px', background: 'var(--dsw-alias-bg-module-platform)',
    fontFamily: 'var(--ds-font-family-code)', fontSize: '12px', lineHeight: '18px',
    color: 'var(--dsw-alias-label-primary)', margin: 0,
  },
}

/** Render the environment management tab. */
export function PluginEnvironmentsTab({ profiles, copyPlugins, startProfile, stopProfile, createProfile, renameProfile, removeProfile, backupExport, backupDiff, backupRestore, t }: PluginEnvironmentsTabProps): ReactNode {
  const [profileList, setProfileList] = useState<ProfileInfo[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  const [template, setTemplate] = useState('web')
  const [output, setOutput] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  // Plugin transfer state: package names, source, target.
  const [transferNames, setTransferNames] = useState('')
  const [transferFrom, setTransferFrom] = useState('')
  const [transferTo, setTransferTo] = useState('')
  // Backup/restore state: target profile ('' = all), imported backup + diff.
  const [backupProfile, setBackupProfile] = useState('')
  const [backupData, setBackupData] = useState<BackupFile | null>(null)
  const [diffResult, setDiffResult] = useState<BackupDiffResult | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const injected = useRef({ profiles, copyPlugins, startProfile, stopProfile, createProfile, renameProfile, removeProfile, backupExport, backupDiff, backupRestore })

  const refresh = (): void => {
    void injected.current.profiles().then(setProfileList, () => { /* keep last list */ })
  }

  useEffect(() => {
    void injected.current.profiles().then((items) => {
      setProfileList(items)
      // Backup/restore defaults to the profile RUNNING this instance.
      const running = items.find(profile => profile.running !== null)
      if (running !== undefined) setBackupProfile(running.name)
    }, () => { /* keep last list */ })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const onCreate = async (): Promise<void> => {
    const name = newName.trim()
    if (name.length === 0) return
    setBusy('create')
    try {
      const result = await injected.current.createProfile(name, template)
      setOutput(result.message)
      if (result.ok) { setNewName(''); refresh() }
    } finally {
      setBusy(null)
    }
  }

  const onRename = async (oldName: string): Promise<void> => {
    const newProfileName = window.prompt(t('renamePrompt'), oldName)
    if (newProfileName === null || newProfileName.trim().length === 0 || newProfileName.trim() === oldName) return
    setBusy('rename-' + oldName)
    try {
      const result = await injected.current.renameProfile(oldName, newProfileName.trim())
      setOutput(result.message)
      if (result.ok) refresh()
    } finally {
      setBusy(null)
    }
  }

  const onRemove = async (name: string): Promise<void> => {
    if (!window.confirm(t('confirmRemoveProfile') + ' ' + name + '?')) return
    setBusy('remove-' + name)
    try {
      const result = await injected.current.removeProfile(name)
      setOutput(result.message)
      if (result.ok) refresh()
    } finally {
      setBusy(null)
    }
  }

  const onStart = async (name: string): Promise<void> => {
    setBusy('start-' + name)
    try {
      const result = await injected.current.startProfile(name)
      setOutput(result.message)
      if (result.ok && result.url !== undefined) window.open(result.url, '_blank')
    } finally {
      setBusy(null)
    }
  }

  const onStop = async (name: string): Promise<void> => {
    setBusy('stop-' + name)
    try {
      const result = await injected.current.stopProfile(name)
      setOutput(result.message)
    } finally {
      setBusy(null)
    }
  }

  const onTransfer = async (): Promise<void> => {
    const names = transferNames.split(/[,\s]+/).map(name => name.trim()).filter(name => name.length > 0)
    if (names.length === 0 || transferFrom.length === 0 || transferTo.length === 0) return
    setBusy('transfer')
    try {
      const result = await injected.current.copyPlugins(transferFrom, transferTo, names)
      setOutput('$ copy ' + names.join(', ') + ' ' + transferFrom + ' -> ' + transferTo + '\n' + result.output)
      setTransferNames('')
    } finally {
      setBusy(null)
    }
  }

  /** Export the selected environment (or all) as a downloadable JSON backup. */
  const onBackupExport = async (): Promise<void> => {
    setBusy('backup-export')
    try {
      const backup = await injected.current.backupExport(backupProfile)
      const blob = new Blob([JSON.stringify(backup, undefined, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = 'dsh-backup-' + (backupProfile.length > 0 ? backupProfile : 'all') + '-' + backup.exportedAt.slice(0, 10) + '.json'
      anchor.click()
      URL.revokeObjectURL(url)
      setOutput('$ export backup (' + backup.profiles.length + ' profile(s), ' + backup.kinds.length + ' kind record(s))')
    } finally {
      setBusy(null)
    }
  }

  /** Read an imported backup file and diff it against the current state. */
  const onBackupFile = async (file: File | null): Promise<void> => {
    if (file === null) return
    try {
      const backup = JSON.parse(await file.text()) as BackupFile
      setBackupData(backup)
      const diff = await injected.current.backupDiff(backup, backupProfile)
      setDiffResult(diff)
      setOutput('$ import ' + file.name + ' — diff computed ('
        + diff.missing.length + ' missing, ' + diff.already.length + ' already, '
        + diff.missingProfiles.length + ' missing profiles, ' + diff.unrestorable.length + ' unrestorable)')
    } catch (error: unknown) {
      setOutput('$ import failed: ' + (error instanceof Error ? error.message : String(error)))
    }
  }

  /** Restore every missing entry from the imported backup. */
  const onBackupRestore = async (): Promise<void> => {
    if (backupData === null) return
    setBusy('backup-restore')
    try {
      const result = await injected.current.backupRestore(backupData, backupProfile)
      setOutput('$ restore\n' + result.output)
      // Re-diff so the restored state is visible.
      const diff = await injected.current.backupDiff(backupData, backupProfile)
      setDiffResult(diff)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div style={styles.section}>
      <style>{`
.pm-card {
  min-width: 0; overflow: hidden;
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px;
  background: var(--dsw-alias-bg-layer-3);
}
.pm-card[data-open='true'] { border-color: var(--dsw-alias-border-l1); }
.pm-card-title-btn:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary);
  outline-offset: -2px;
}
`}</style>
      <div style={styles.heading}>
        <h3 style={styles.headingTitle}>{t('envList')}</h3>
        <span style={styles.headingCount}>{profileList.length}</span>
      </div>
      {profileList.length === 0 ? <p style={styles.status}>{t('noProfiles')}</p> : (
        <ul style={styles.cards}>
          {profileList.map((profile) => {
            const open = expanded === profile.name
            const running = profile.running !== null
            const canStart = !running && profile.bundles.includes('@deepseek-ai/dsh-web-app')
            return (
              <li key={profile.name} className="pm-card" data-open={open ? 'true' : undefined}>
                <div style={styles.cardHeader}>
                  <button
                    className="pm-card-title-btn"
                    style={styles.titleButton}
                    type="button"
                    aria-expanded={open}
                    onClick={() => setExpanded(current => current === profile.name ? null : profile.name)}
                  >
                    <span style={styles.cardTitle} title={profile.name}>{profile.name}</span>
                    <span style={styles.cardTrailing}>
                      {profile.isOfficial ? <span style={styles.tag}>{t('officialBadge')}</span> : null}
                      {profile.isCurrent ? <span style={{ ...styles.tag, ...styles.tagOn }}>{t('currentBadge')}</span> : null}
                      {running ? (
                        <span style={{ ...styles.tag, ...styles.tagOn }}>
                          {t('runningBadge')}{profile.running!.port !== null ? ' :' + profile.running!.port : ''}
                        </span>
                      ) : null}
                    </span>
                  </button>
                  {canStart && (
                    <span style={{ flex: 'none' }}>
                      <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void onStart(profile.name)}>
                        {busy === 'start-' + profile.name ? t('starting') : t('startButton')}
                      </Button>
                    </span>
                  )}
                  {running && !profile.isCurrent && (
                    <span style={{ flex: 'none' }}>
                      <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void onStop(profile.name)}>
                        {busy === 'stop-' + profile.name ? t('stopping') : t('stopButton')}
                      </Button>
                    </span>
                  )}
                </div>
                {open && (
                  <div style={styles.cardDetails}>
                    <div style={styles.detailsActions}>
                      {!profile.isOfficial && !profile.isCurrent && (
                        <>
                          <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void onRename(profile.name)}>
                            {t('renameButton')}
                          </Button>
                          <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void onRemove(profile.name)}>
                            {t('removeButton')}
                          </Button>
                        </>
                      )}
                      {profile.isOfficial && <span style={styles.filterLabel}>{t('officialReadonly')}</span>}
                      {profile.isCurrent && <span style={styles.filterLabel}>{t('currentRunningHint')}</span>}
                      {running && !profile.isCurrent && <span style={styles.filterLabel}>{t('terminalRunningHint')}</span>}
                    </div>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}

      <div style={styles.heading}>
        <h3 style={styles.headingTitle}>{t('createEnv')}</h3>
      </div>
      <div style={styles.formCol}>
        <Input
          type="text"
          value={newName}
          placeholder={t('createPlaceholder')}
          disabled={busy !== null}
          onChange={(event: React.ChangeEvent<HTMLInputElement>) => setNewName(event.currentTarget.value)}
          onKeyDown={(event: React.KeyboardEvent<HTMLInputElement>) => { if (event.key === 'Enter') void onCreate() }}
          style={{ width: '100%' }}
        />
        <div style={styles.toolbar}>
          <PmSelect
            ariaLabel={t('templateLabel')}
            value={template}
            options={[
              { value: 'web', label: t('templateWeb') },
              { value: 'headless', label: t('templateHeadless') },
            ]}
            onChange={setTemplate}
          />
          <Button variant="primary" disabled={busy !== null || newName.trim().length === 0} onClick={() => void onCreate()}>
            {busy === 'create' ? t('creating') : t('createButton')}
          </Button>
        </div>
      </div>

      <div style={styles.heading}>
        <h3 style={styles.headingTitle}>{t('transferTitle')}</h3>
      </div>
      <div style={styles.formCol}>
        <Input
          type="text"
          value={transferNames}
          placeholder={t('transferPlaceholder')}
          disabled={busy !== null}
          onChange={(event: React.ChangeEvent<HTMLInputElement>) => setTransferNames(event.currentTarget.value)}
          onKeyDown={(event: React.KeyboardEvent<HTMLInputElement>) => { if (event.key === 'Enter') void onTransfer() }}
          style={{ width: '100%' }}
        />
        <div style={styles.toolbar}>
          <PmSelect
            ariaLabel={t('transferFrom')}
            value={transferFrom}
            options={profileList.map(profile => ({ value: profile.name, label: profile.name }))}
            onChange={setTransferFrom}
          />
          <span style={styles.filterLabel}>{t('transferArrow')}</span>
          <PmSelect
            ariaLabel={t('transferTo')}
            value={transferTo}
            options={profileList.map(profile => ({ value: profile.name, label: profile.name }))}
            onChange={setTransferTo}
          />
          <Button variant="primary" disabled={busy !== null || transferNames.trim().length === 0 || transferFrom.length === 0 || transferTo.length === 0 || transferFrom === transferTo} onClick={() => void onTransfer()}>
            {busy === 'transfer' ? t('transferring') : t('transferButton')}
          </Button>
        </div>
      </div>

      <div style={styles.heading}>
        <h3 style={styles.headingTitle}>{t('backupTitle')}</h3>
      </div>
      <div style={styles.formCol}>
        <div style={styles.toolbar}>
          <span style={styles.filterLabel}>{t('backupTargetLabel')}</span>
          <PmSelect
            ariaLabel={t('backupTargetLabel')}
            value={backupProfile}
            options={[
              { value: '', label: t('backupAll') },
              ...profileList.map(profile => ({ value: profile.name, label: profile.name })),
            ]}
            onChange={setBackupProfile}
          />
          <span style={{ marginLeft: 'auto' }} />
          <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void onBackupExport()}>
            {busy === 'backup-export' ? t('exporting') : t('backupExportButton')}
          </Button>
          <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => fileInputRef.current?.click()}>
            {t('backupImportButton')}
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json,.json"
            style={{ display: 'none' }}
            onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
              const file = event.currentTarget.files?.[0] ?? null
              void onBackupFile(file)
              event.currentTarget.value = ''
            }}
          />
          {diffResult !== null && (
            <>
              {diffResult.missing.length > 0 && (
                <Button variant="primary" disabled={busy !== null} onClick={() => void onBackupRestore()}>
                  {busy === 'backup-restore' ? t('restoring') : t('backupRestoreButton')}
                </Button>
              )}
              <span style={styles.filterLabel}>
                {t('backupDiffSummary', {
                  missing: diffResult.missing.length,
                  already: diffResult.already.length,
                })}
              </span>
            </>
          )}
        </div>
        {diffResult !== null && (
          <div>
            {diffResult.missingProfiles.length > 0 && (
              <p style={styles.status}>{t('backupMissingProfiles')}: {diffResult.missingProfiles.join(', ')}</p>
            )}
            {diffResult.unrestorable.length > 0 && (
              <p style={styles.status}>{t('backupUnrestorable')}:</p>
            )}
            {diffResult.unrestorable.map(item => <p key={item} style={styles.status}>- {item}</p>)}
            {diffResult.missing.length === 0 && diffResult.missingProfiles.length === 0 && (
              <p style={styles.status}>{t('backupUpToDate')}</p>
            )}
          </div>
        )}
      </div>

      {output.length > 0 && (
        <div>
          <div style={styles.heading}>
            <h3 style={styles.headingTitle}>{t('commandOutput')}</h3>
          </div>
          <pre style={styles.output}>{output}</pre>
        </div>
      )}
    </div>
  )
}
