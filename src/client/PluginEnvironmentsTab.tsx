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
import { PM_CARD_CSS, outputStyle, useConfirm, useElapsedSeconds } from './shared.ts'
import { PmSelect } from './PmSelect.tsx'

/** Registration-side Remote face provided by the section. Only the initial
 *  profiles load takes an optional trailing AbortSignal (mount-time
 *  cancellation); the action-triggered calls stay uncancellable. */
export interface PluginEnvironmentsTabInjected {
  readonly profiles: (signal?: AbortSignal) => Promise<ProfileInfo[]>
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

/** Minimal structural gate for an imported backup file (audit: any JSON was
 *  previously cast blindly and failed deep inside the host). */
function isBackupFile(value: unknown): value is BackupFile {
  if (value === null || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return Array.isArray(v.profiles) && Array.isArray(v.kinds)
}

/** Full component props assembled by the Settings slot renderer. */
export type PluginEnvironmentsTabProps =
  PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'settings.pluginManager'>
  & InjectFace<PluginEnvironmentsTabInjected>

/** Official --dsw-* token styles (mirrors the other tabs). */
const styles = {
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
} satisfies Record<string, React.CSSProperties>

/** Render the environment management tab. */
export function PluginEnvironmentsTab({ profiles, copyPlugins, startProfile, stopProfile, createProfile, renameProfile, removeProfile, backupExport, backupDiff, backupRestore, t }: PluginEnvironmentsTabProps): ReactNode {
  const [profileList, setProfileList] = useState<ProfileInfo[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  // Live seconds counter while a (potentially long) backup/restore runs.
  const elapsed = useElapsedSeconds(busy)
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
  // 行内二次确认（删除环境/备份恢复，键空间：环境名 + 'restore:' 前缀），
  // 4 秒无操作自动复位——点亮态不会无限期等第二次点击。
  const [confirmKey, setConfirmKey] = useConfirm()
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  // Rename flow: inline input instead of window.prompt (blocks the main
  // thread, no styling, no validation surface).
  const [renameTarget, setRenameTarget] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')

  const injected = useRef({ profiles, copyPlugins, startProfile, stopProfile, createProfile, renameProfile, removeProfile, backupExport, backupDiff, backupRestore })

  const refresh = (): void => {
    void injected.current.profiles().then(setProfileList, () => { /* keep last list */ })
  }

  // Abort handle for the mount-time initial profiles load only: the
  // action-triggered refreshes (create/rename/remove feedback) are part of
  // a command and must not be cancellable.
  const loadAbort = useRef<AbortController | null>(null)
  // Unmount must cancel the in-flight initial load.
  useEffect(() => () => { loadAbort.current?.abort() }, [])

  useEffect(() => {
    loadAbort.current?.abort()
    const controller = new AbortController()
    loadAbort.current = controller
    void injected.current.profiles(controller.signal).then((items) => {
      setProfileList(items)
      // Backup/restore defaults to the profile RUNNING this instance.
      const running = items.find(profile => profile.running !== null)
      if (running !== undefined) setBackupProfile(running.name)
    }, () => { /* keep last list; aborted loads land here too */ })
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
    } catch (error: unknown) {
      setOutput('[error] ' + (error instanceof Error ? error.message : String(error)))
    } finally {
      setBusy(null)
    }
  }

  const onRenameStart = (oldName: string): void => {
    setRenameTarget(oldName)
    setRenameValue(oldName)
  }

  const onRenameConfirm = async (): Promise<void> => {
    const oldName = renameTarget
    const newProfileName = renameValue.trim()
    if (oldName === null || newProfileName.length === 0 || newProfileName === oldName) return
    setRenameTarget(null)
    setBusy('rename-' + oldName)
    try {
      const result = await injected.current.renameProfile(oldName, newProfileName)
      setOutput(result.message)
      if (result.ok) refresh()
    } catch (error: unknown) {
      setOutput('[error] ' + (error instanceof Error ? error.message : String(error)))
    } finally {
      setBusy(null)
    }
  }

  const onRemove = async (name: string): Promise<void> => {
    // 行内二次确认：删除整个环境目录不可逆，第一次点击只点亮确认态。
    if (confirmKey !== name) {
      setConfirmKey(name)
      return
    }
    setConfirmKey(null)
    setBusy('remove-' + name)
    try {
      const result = await injected.current.removeProfile(name)
      setOutput(result.message)
      if (result.ok) refresh()
    } catch (error: unknown) {
      setOutput('[error] ' + (error instanceof Error ? error.message : String(error)))
    } finally {
      setBusy(null)
    }
  }

  const onStart = async (name: string): Promise<void> => {
    setBusy('start-' + name)
    try {
      const result = await injected.current.startProfile(name)
      setOutput(result.message)
      if (result.ok && result.url !== undefined) {
        // window.open after an await has left the user-gesture context and is
        // commonly swallowed by popup blockers — fall back to the URL in the
        // output area instead of failing silently.
        if (window.open(result.url, '_blank') === null) {
          setOutput(result.message + '\n' + result.url)
        }
      }
    } catch (error: unknown) {
      setOutput('[error] ' + (error instanceof Error ? error.message : String(error)))
    } finally {
      setBusy(null)
    }
  }

  const onStop = async (name: string): Promise<void> => {
    setBusy('stop-' + name)
    try {
      const result = await injected.current.stopProfile(name)
      setOutput(result.message)
    } catch (error: unknown) {
      setOutput('[error] ' + (error instanceof Error ? error.message : String(error)))
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
    } catch (error: unknown) {
      setOutput('[error] ' + (error instanceof Error ? error.message : String(error)))
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
      anchor.download = 'dsh-backup-' + (backupProfile.length > 0 ? backupProfile : 'all') + '-' + (backup.exportedAt ?? '').slice(0, 10) + '.json'
      anchor.click()
      URL.revokeObjectURL(url)
      setOutput('$ export backup (' + backup.profiles.length + ' profile(s), ' + backup.kinds.length + ' kind record(s))')
    } catch (error: unknown) {
      setOutput('[error] ' + (error instanceof Error ? error.message : String(error)))
    } finally {
      setBusy(null)
    }
  }

  /** Read an imported backup file and diff it against the current state. */
  const onBackupFile = async (file: File | null): Promise<void> => {
    if (file === null) return
    setBusy('backup-import')
    try {
      // Minimal shape gate: an arbitrary JSON file used to be cast blindly
      // and only failed deep inside the host with an opaque error.
      const parsed: unknown = JSON.parse(await file.text())
      if (!isBackupFile(parsed)) {
        setOutput('$ import failed: ' + file.name + ' is not a plugin-manager backup (missing profiles/kinds lists)')
        return
      }
      setBackupData(parsed)
      const diff = await injected.current.backupDiff(parsed, backupProfile)
      setDiffResult(diff)
      setOutput('$ import ' + file.name + ' — diff computed ('
        + diff.missing.length + ' missing, ' + diff.already.length + ' already, '
        + diff.missingProfiles.length + ' missing profiles, ' + diff.unrestorable.length + ' unrestorable)')
    } catch (error: unknown) {
      setOutput('$ import failed: ' + (error instanceof Error ? error.message : String(error)))
    } finally {
      setBusy(null)
    }
  }

  /**
   * Switch the restore target: the imported backup re-diffs against the new
   * target. Without this, the visible missing list still describes the old
   * target while the restore button would write into the newly selected one
   * — the diff summary and the actual behavior must never diverge.
   */
  const onBackupTargetChange = (name: string): void => {
    setBackupProfile(name)
    setConfirmKey(null)
    const backup = backupData
    if (backup === null) return
    setBusy('backup-diff')
    injected.current.backupDiff(backup, name).then((diff) => {
      setDiffResult(diff)
      setOutput('$ diff against ' + (name.length > 0 ? name : 'all') + ' — ('
        + diff.missing.length + ' missing, ' + diff.already.length + ' already, '
        + diff.missingProfiles.length + ' missing profiles, ' + diff.unrestorable.length + ' unrestorable)')
    }, (error: unknown) => {
      setDiffResult(null)
      setOutput('[error] ' + (error instanceof Error ? error.message : String(error)))
    }).finally(() => setBusy(null))
  }

  /** Restore every missing entry from the imported backup. */
  const onBackupRestore = async (): Promise<void> => {
    if (backupData === null) return
    // 行内二次确认：恢复会向目标环境批量重装缺失项（与删除环境同一确认
    // 模式；键前缀 ':' 与环境名空间不相交——环境名不含冒号）。
    const key = 'restore:' + backupProfile
    if (confirmKey !== key) {
      setConfirmKey(key)
      return
    }
    setConfirmKey(null)
    setBusy('backup-restore')
    try {
      const result = await injected.current.backupRestore(backupData, backupProfile)
      setOutput('$ restore\n' + result.output)
      // Re-diff so the restored state is visible.
      const diff = await injected.current.backupDiff(backupData, backupProfile)
      setDiffResult(diff)
    } catch (error: unknown) {
      setOutput('[error] ' + (error instanceof Error ? error.message : String(error)))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div style={styles.section}>
      <style>{PM_CARD_CSS}</style>
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
                        renameTarget === profile.name ? (
                          <>
                            <Input
                              type="text"
                              value={renameValue}
                              placeholder={t('renamePrompt')}
                              disabled={busy !== null}
                              autoFocus
                              onChange={(event: React.ChangeEvent<HTMLInputElement>) => setRenameValue(event.currentTarget.value)}
                              onKeyDown={(event: React.KeyboardEvent<HTMLInputElement>) => { if (event.key === 'Enter') void onRenameConfirm() }}
                              style={{ width: '180px' }}
                            />
                            <Button
                              size="sm"
                              variant="primary"
                              disabled={busy !== null || renameValue.trim().length === 0 || renameValue.trim() === profile.name}
                              onClick={() => void onRenameConfirm()}
                            >
                              {t('renameConfirm')}
                            </Button>
                            <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => setRenameTarget(null)}>
                              {t('envFormCancel')}
                            </Button>
                          </>
                        ) : (
                          <>
                            <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => onRenameStart(profile.name)}>
                              {t('renameButton')}
                            </Button>
                            <Button
                              size="sm"
                              variant={confirmKey === profile.name ? 'primary' : 'ghost'}
                              disabled={busy !== null}
                              title={t('confirmRemoveProfile') + ' ' + profile.name + '?'}
                              onClick={() => void onRemove(profile.name)}
                            >
                              {confirmKey === profile.name ? t('fixConfirm') : t('removeButton')}
                            </Button>
                          </>
                        )
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
            onChange={onBackupTargetChange}
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
          {elapsed > 0 && <span style={styles.filterLabel}>{elapsed}s</span>}
          {diffResult !== null && (
            <>
              {diffResult.missing.length > 0 && (
                <Button
                  variant="primary"
                  disabled={busy !== null}
                  title={t('confirmRestore')}
                  onClick={() => void onBackupRestore()}
                >
                  {confirmKey === 'restore:' + backupProfile ? t('fixConfirm') : (busy === 'backup-restore' ? t('restoring') : t('backupRestoreButton'))}
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
          <pre style={outputStyle}>{output}</pre>
        </div>
      )}
    </div>
  )
}
