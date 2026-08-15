/**
 * PmSelect: official dropdown (ui-primitives Menu) replacing native selects.
 */

import { useState, type ReactNode } from 'react'
import { Button, IconChevronDownOutline14, Menu } from '@deepseek-ai/dsh-client-ui-primitives'

/** One option of the dropdown. */
export interface PmSelectOption {
  readonly value: string
  readonly label: string
}

/**
 * Render a controlled official-style dropdown.
 * @param props.value - selected option value.
 * @param props.options - selectable options.
 * @param props.onChange - selection callback.
 * @param props.ariaLabel - accessible label for the trigger button.
 */
export function PmSelect({ value, options, onChange, ariaLabel, disabled }: {
  value: string
  options: readonly PmSelectOption[]
  onChange: (value: string) => void
  ariaLabel?: string
  /** Lock the selector while a mutation is running (audit m-4). */
  disabled?: boolean
}): ReactNode {
  const [open, setOpen] = useState(false)
  const selected = options.find(option => option.value === value)
  return (
    <Menu
      open={open && disabled !== true}
      anchor={(
        <Button
          size="sm"
          variant="outline"
          aria-label={ariaLabel}
          title={selected?.label ?? value}
          style={{ maxWidth: 160 }}
          disabled={disabled}
          onClick={() => setOpen(current => !current)}
        >
          <span
            style={{
              display: 'inline-block',
              maxWidth: 120,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              verticalAlign: 'middle',
            }}
          >
            {selected?.label ?? value}
          </span>
          <IconChevronDownOutline14 size={12} aria-hidden="true" />
        </Button>
      )}
      items={options.map(option => ({ id: option.value, label: option.label }))}
      selectedId={value}
      onSelect={(id) => { onChange(id); setOpen(false) }}
      onClose={() => setOpen(false)}
    />
  )
}
