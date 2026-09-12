/**
 * EnvQuestionForm (C2): shared inline form for install-time environment
 * variables. Used by the marketplace card and the management install bar —
 * no popups, no terminal input (user preference). Empty value = skip.
 */

import { useState, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { EnvQuestion } from '../types.ts'
import { isSensitiveEnvKey } from '../scan.ts'
import type { PluginManagerLocaleKey } from './locales.ts'

/** Locale bind signature (ctx.locale.bind(NS)). */
type T = (key: PluginManagerLocaleKey, params?: Record<string, string | number>) => string

const styles: Record<string, React.CSSProperties> = {
  box: {
    display: 'flex', flexDirection: 'column', gap: '8px',
    marginTop: '8px', padding: '10px 12px',
    // Official tokens only: the previous "fill-base" and bare "border" aliases
    // do not exist in ui-theme, so both declarations were dropped and the form
    // rendered with no background and no border at all.
    background: 'var(--dsw-alias-bg-layer-1)',
    // Neutral borders are 0.5px hairlines per the official styling rules.
    border: '0.5px solid var(--dsw-alias-border-l4)',
    borderRadius: '8px',
  },
  title: { margin: 0, fontSize: '12px', lineHeight: '18px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
  hint: { margin: 0, fontSize: '11px', lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary)' },
  row: { display: 'flex', alignItems: 'center', gap: '8px' },
  label: {
    flex: '0 0 auto', minWidth: '150px', maxWidth: '45%',
    fontSize: '12px', lineHeight: '18px', fontFamily: 'var(--dsw-font-mono)', color: 'var(--dsw-alias-label-secondary)',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  input: {
    flex: '1 1 auto', minWidth: 0,
    fontFamily: 'var(--dsw-font-mono)',
  },
  actions: { display: 'flex', alignItems: 'center', gap: '8px' },
}

/** One env question rendered inline; the caller supplies t (bound locale). */
export function EnvQuestionForm({ questions, busy, t, onContinue, onCancel }: {
  questions: readonly EnvQuestion[]
  busy: boolean
  t: T
  onContinue: (answers: Record<string, string>) => void
  onCancel: () => void
}): ReactNode {
  const [answers, setAnswers] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {}
    for (const q of questions) initial[q.id] = ''
    return initial
  })
  // Per-variable reveal state for the masked inputs.
  const [revealed, setRevealed] = useState<Record<string, boolean>>({})

  const setValue = (key: string, value: string): void => {
    setAnswers(current => ({ ...current, [key]: value }))
  }

  return (
    <div style={styles.box} role="group" aria-label={t('envFormTitle')}>
      <p style={styles.title}>{t('envFormTitle')}</p>
      <p style={styles.hint}>{t('envFormHint')}</p>
      {questions.map(question => {
        // Every scanned variable is credential-shaped (the C2 scanner only
        // reports TOKEN/KEY/SECRET/PASSWORD forms), so the value is masked by
        // default — a shoulder-surfer or a screen recording would otherwise
        // read the secret straight off the form.
        const sensitive = isSensitiveEnvKey(question.id)
        const shown = revealed[question.id] === true
        return (
          <div key={question.id} style={styles.row}>
            <label style={styles.label} title={question.id}>{question.id}</label>
            <input
              type={sensitive && !shown ? 'password' : 'text'}
              style={styles.input}
              value={answers[question.id] ?? ''}
              placeholder={t('envFormValuePlaceholder')}
              aria-label={question.id}
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => setValue(question.id, event.currentTarget.value)}
            />
            {sensitive && (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                aria-label={(shown ? t('envFormHide') : t('envFormShow')) + ' ' + question.id}
                onClick={() => setRevealed(current => ({ ...current, [question.id]: !shown }))}
              >
                {shown ? t('envFormHide') : t('envFormShow')}
              </Button>
            )}
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setValue(question.id, '')}>
              {t('envFormSkip')}
            </Button>
          </div>
        )
      })}
      <div style={styles.actions}>
        <Button size="sm" variant="primary" disabled={busy} onClick={() => onContinue(answers)}>
          {busy ? t('envFormBusy') : t('envFormContinue')}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
          {t('envFormCancel')}
        </Button>
      </div>
    </div>
  )
}
