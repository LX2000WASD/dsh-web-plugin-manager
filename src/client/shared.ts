/**
 * Shared client utilities: styles, formatters and hooks that every tab
 * previously copy-pasted (the copies had already started drifting — audit).
 * Pure module, no framework imports beyond react hooks.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

/** Command output `<pre>` style (was duplicated in four tabs). */
export const outputStyle: React.CSSProperties = {
  maxHeight: '200px', overflow: 'auto', whiteSpace: 'pre-wrap',
  border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '10px',
  padding: '10px 14px', background: 'var(--dsw-alias-bg-module-platform)',
  fontFamily: 'var(--ds-font-family-code)', fontSize: '12px', lineHeight: '18px',
  color: 'var(--dsw-alias-label-primary)', margin: 0,
}

/**
 * Base `.pm-card` card CSS shared by the card-list tabs. Tab-specific
 * attribute rules ([data-modified] / [data-updatable]) stay in each tab.
 * The focus-visible selectors are a harmless superset: each tab's unused
 * class simply never matches.
 */
export const PM_CARD_CSS = `
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
.pm-card-title-btn:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary);
  outline-offset: -2px;
}
`

/**
 * Link language aligned with the official 0.1.3 alias-link (hover/focus
 * dotted underline). The color token carries a fallback — the 0.1.2 platform
 * has no --dsw-alias-link yet.
 */
export const PM_LINK_CSS = `
.pm-link {
  color: var(--dsw-alias-link, var(--dsw-alias-state-business-primary));
}
.pm-link:hover, .pm-link:focus-visible {
  text-decoration: underline dotted var(--dsw-alias-link, var(--dsw-alias-state-business-primary));
  text-underline-offset: 3px;
}
`

/** Format an ISO timestamp as a short date. */
export function shortDate(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0')
}

/** Format an ISO timestamp for display (local date + minutes). */
export function formatTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const pad = (value: number): string => String(value).padStart(2, '0')
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
    + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
}

/** Compact star counts: 2500 → 2.5K, 1_200_000 → 1.2M. */
export function formatStars(n: number): string {
  const trimZero = (s: string): string => s.endsWith('.0') ? s.slice(0, -2) : s
  if (n >= 1_000_000) return trimZero((n / 1_000_000).toFixed(1)) + 'M'
  if (n >= 1_000) return trimZero((n / 1_000).toFixed(1)) + 'K'
  return String(n)
}

/**
 * Inline two-step confirm state with an automatic reset. The setter is a
 * drop-in for useState<string | null>: arming a key starts a timer that
 * disarms it, so an armed "delete" never sits waiting for a stray second
 * click indefinitely (and the timer is cleared on unmount).
 */
export function useConfirm(resetMs = 4000): [string | null, (key: string | null) => void] {
  const [confirmKey, setConfirmKey] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const set = useCallback((key: string | null): void => {
    if (timer.current !== undefined) {
      clearTimeout(timer.current)
      timer.current = undefined
    }
    setConfirmKey(key)
    if (key !== null) {
      timer.current = setTimeout(() => {
        timer.current = undefined
        setConfirmKey(null)
      }, resetMs)
    }
  }, [resetMs])
  useEffect(() => () => {
    if (timer.current !== undefined) clearTimeout(timer.current)
  }, [])
  return [confirmKey, set]
}
