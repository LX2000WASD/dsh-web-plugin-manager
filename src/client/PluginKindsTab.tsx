/**
 * Skills & Presets tab (settings.section, above the marketplace): manage
 * marketplace-installed skills and agent presets — list records, re-pull
 * github-sourced installs, uninstall. Agent presets are additionally managed
 * by the official settings page (copy/delete/default); this page only owns
 * the re-pull/update flow for what the marketplace installed.
 *
 * No profile concept here: skills/presets live in the global harness roots.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { CommandResult, KindListView, KindRecordView } from '../types.ts'
import type { PluginManagerLocaleKey } from './locales.ts'

/** Registration-side Remote face provided by the section. */
export interface PluginKindsTabInjected {
  readonly kinds: () => Promise<KindListView>
  /** Uninstall a kind install (profile-less: skills/presets only). */
  readonly uninstall: (repo: string) => Promise<CommandResult>
  /** Re-pull a github-sourced kind install (re-clone + copy over). */
  readonly reinstall: (repo: string) => Promise<CommandResult>
}

/** Full component props assembled by the Settings section renderer. */
export type PluginKindsTabProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings.pluginManager'>
  & InjectFace<PluginKindsTabInjected>

/** Official --dsw-* token styles (mirrors the other pages). */
const styles: Record<string, React.CSSProperties> = {
  section: {
    display: 'flex', flexDirection: 'column', gap: '14px',
    width: '100%', maxWidth: '760px', color: 'var(--dsw-alias-label-primary)',
  },
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
  hint: { fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)', margin: 0 },
  card: {
    minWidth: 0, maxWidth: '100%', overflow: 'hidden',
    border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '10px',
    background: 'var(--dsw-alias-bg-layer-3)',
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
  cardMetaRow: {
    display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap',
    minHeight: '28px', padding: '0 14px 10px',
  },
  tag: {
    display: 'inline-flex', alignItems: 'center', flex: 'none', minHeight: '20px',
    borderRadius: '5px', padding: '1px 6px', background: 'var(--dsw-alias-bg-layer-1)',
    color: 'var(--dsw-alias-label-secondary)', fontSize: '11px', lineHeight: '16px',
    whiteSpace: 'nowrap', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis',
  },
  tagOn: {
    background: 'color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent)',
    color: 'var(--dsw-alias-state-success-primary)',
  },
  meta: {
    fontSize: '11px', lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary)',
    fontVariantNumeric: 'tabular-nums',
  },
  status: { fontSize: '13px', lineHeight: '20px', color: 'var(--dsw-alias-label-tertiary)', margin: 0 },
  error: { fontSize: '13px', lineHeight: '20px', color: 'var(--dsw-alias-state-error-primary)', margin: 0 },
  output: {
    maxHeight: '200px', overflow: 'auto', whiteSpace: 'pre-wrap',
    border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '10px',
    padding: '10px 14px', background: 'var(--dsw-alias-bg-module-platform)',
    fontFamily: 'var(--ds-font-family-code)', fontSize: '12px', lineHeight: '18px',
    color: 'var(--dsw-alias-label-primary)', margin: 0,
  },
}

/** Format an ISO timestamp as a short date. */
function shortDate(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0')
}

/** Whether a record key is a github owner/repo (re-pullable) vs a local path. */
function isGithubSource(repo: string): boolean {
  return /^[a-z0-9._-]+\/[a-z0-9._-]+$/i.test(repo) && !repo.includes('\\') && !repo.includes(':') && !repo.includes(' ')
}

/** Render the skills & presets page. */
export function PluginKindsTab({ kinds, uninstall, reinstall, t }: PluginKindsTabProps): ReactNode {
  const [state, setState] = useState<KindListView | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [output, setOutput] = useState('')

  const injected = useRef({ kinds, uninstall, reinstall })

  const reload = (): void => {
    void injected.current.kinds().then(setState, (err: unknown) => {
      setError(err instanceof Error ? err.message : String(err))
    })
  }

  useEffect(() => {
    reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** Only skill / agent-preset records are managed here (cordis lives in Manage). */
  const records = (state?.records ?? []).filter(record => record.type === 'skill' || record.type === 'agent-preset')

  const onUninstall = (record: KindRecordView): void => {
    if (!window.confirm(t('confirmKindRemove'))) return
    setBusy(record.repo)
    void injected.current.uninstall(record.repo).then((result) => {
      setOutput('$ uninstall ' + record.repo + '\n' + result.output)
      reload()
    }, (error: unknown) => {
      setOutput('$ uninstall ' + record.repo + '\n[error] ' + (error instanceof Error ? error.message : String(error)))
    }).finally(() => setBusy(null))
  }

  const onReinstall = (record: KindRecordView): void => {
    setBusy(record.repo)
    void injected.current.reinstall(record.repo).then((result) => {
      const pausedNote = result.awaiting !== undefined
        ? '\n\n' + t('envFormPausedElsewhere')
        : ''
      setOutput('$ re-pull ' + record.repo + '\n' + result.output + pausedNote)
      reload()
    }, (error: unknown) => {
      setOutput('$ re-pull ' + record.repo + '\n[error] ' + (error instanceof Error ? error.message : String(error)))
    }).finally(() => setBusy(null))
  }

  const kindTag = (type: string): string =>
    type === 'skill' ? t('typeSkill') : type === 'agent-preset' ? t('typeAgent') : type

  return (
    <div style={styles.section}>
      <div style={styles.heading}>
        <h2 style={styles.pageTitle}>{t('kindsTitle')}</h2>
        <span style={styles.headingCount}>{records.length}</span>
        <span style={{ marginLeft: 'auto' }}>
          <Button size="sm" variant="ghost" disabled={busy !== null} onClick={reload}>
            {t('refresh')}
          </Button>
        </span>
      </div>
      <p style={styles.hint}>{t('kindsHint')}</p>

      {error.length > 0 && <p style={styles.error} role="alert">{t('error')}: {error}</p>}

      {state !== null && records.length === 0 && (
        <p style={styles.status}>{t('kindsNone')}</p>
      )}

      {records.map(record => {
        const github = isGithubSource(record.repo)
        const names = record.names !== null && record.names.length > 0 ? record.names : [record.name ?? record.repo]
        return (
          <div key={record.repo} style={styles.card}>
            <div style={styles.cardRow}>
              <span style={styles.cardTitle} title={record.repo}>{record.name ?? record.repo}</span>
              <span style={{ ...styles.tag, ...styles.tagOn }}>{kindTag(record.type)}</span>
              <span style={styles.cardAction}>
                {github && (
                  <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => onReinstall(record)}>
                    {busy === record.repo ? t('installing') : t('reinstallButton')}
                  </Button>
                )}
                <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => onUninstall(record)}>
                  {t('uninstallButton')}
                </Button>
              </span>
            </div>
            <div style={styles.cardMetaRow}>
              <span style={styles.meta}>
                {t('kindsDirLabel')}: {names.join(', ')}
                {' · '}{t('kindsSourceLabel')}: {record.repo}
                {' · '}{t('installedAt')} {shortDate(record.installedAt)}
              </span>
            </div>
          </div>
        )
      })}

      {state !== null && (state.skills.length > 0 || state.presets.length > 0) && (
        <div>
          <div style={styles.heading}>
            <h3 style={styles.headingTitle}>{t('kindsUnmanagedTitle')}</h3>
          </div>
          <p style={styles.status}>
            {state.skills.length > 0 && (
              <span>{t('skillsDirLabel')}: {state.skills.join(', ')}</span>
            )}
            {state.skills.length > 0 && state.presets.length > 0 && <br />}
            {state.presets.length > 0 && (
              <span>{t('presetsDirLabel')}: {state.presets.join(', ')}</span>
            )}
          </p>
        </div>
      )}

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
