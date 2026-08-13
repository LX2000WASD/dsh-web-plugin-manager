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
export function PmSelect({ value, options, onChange, ariaLabel }: {
  value: string
  options: readonly PmSelectOption[]
  onChange: (value: string) => void
  ariaLabel?: string
}): ReactNode {
  const [open, setOpen] = useState(false)
  const selected = options.find(option => option.value === value)
  return (
    <Menu
      open={open}
      anchor={(
        <Button size="sm" variant="outline" aria-label={ariaLabel} onClick={() => setOpen(true)}>
          {selected?.label ?? value}
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
