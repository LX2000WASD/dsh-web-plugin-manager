/**
 * Environment management tab: create/rename/remove custom profiles
 * (official web/headless are read-only), with web/headless templates.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { MutationResult, ProfileInfo } from '../types.ts'
import type { PluginManagerLocaleKey } from './locales.ts'
import { PmSelect } from './PmSelect.tsx'

/** Registration-side Remote face provided by the section. */
export interface PluginEnvironmentsTabInjected {
  readonly profiles: () => Promise<ProfileInfo[]>
  readonly createProfile: (name: string, template: string) => Promise<MutationResult>
  readonly renameProfile: (oldName: string, newName: string) => Promise<MutationResult>
  readonly removeProfile: (name: string) => Promise<MutationResult>
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
export function PluginEnvironmentsTab({ profiles, createProfile, renameProfile, removeProfile, t }: PluginEnvironmentsTabProps): ReactNode {
  const [profileList, setProfileList] = useState<ProfileInfo[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  const [template, setTemplate] = useState('web')
  const [output, setOutput] = useState('')

  const injected = useRef({ profiles, createProfile, renameProfile, removeProfile })

  const refresh = (): void => {
    void injected.current.profiles().then(setProfileList, () => { /* keep last list */ })
  }

  useEffect(() => {
    void injected.current.profiles().then(setProfileList, () => { /* keep last list */ })
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

  return (
    <div style={styles.section}>
      <div style={styles.heading}>
        <h3 style={styles.headingTitle}>{t('envList')}</h3>
        <span style={styles.headingCount}>{profileList.length}</span>
      </div>
      {profileList.length === 0 ? <p style={styles.status}>{t('noProfiles')}</p> : (
        <ul style={styles.cards}>
          {profileList.map((profile) => (
            <li key={profile.name} style={styles.card}>
              <div style={styles.cardRow}>
                <span style={styles.cardTitle} title={profile.name}>{profile.name}</span>
                {profile.isOfficial ? <span style={styles.tag}>{t('officialBadge')}</span> : null}
                {profile.isCurrent ? <span style={{ ...styles.tag, ...styles.tagOn }}>{t('currentBadge')}</span> : null}
                <span style={{ marginLeft: 'auto' }}>
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
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div style={styles.heading}>
        <h3 style={styles.headingTitle}>{t('createEnv')}</h3>
      </div>
      <div style={styles.toolbar}>
        <Input
          type="text"
          value={newName}
          placeholder={t('createPlaceholder')}
          disabled={busy !== null}
          onChange={(event) => setNewName(event.currentTarget.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') void onCreate() }}
          style={{ flex: 1 }}
        />
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
