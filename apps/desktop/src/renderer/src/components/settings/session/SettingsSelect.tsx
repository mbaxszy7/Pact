import type { SelectHTMLAttributes } from 'react'

import { ChevronDown } from 'lucide-react'

type SettingsSelectProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, 'className'>

export function SettingsSelect({
  children,
  disabled,
  ...props
}: SettingsSelectProps): React.JSX.Element {
  return (
    <span className="relative mt-2 block">
      <select
        {...props}
        disabled={disabled}
        className="h-10 w-full appearance-none rounded-control border border-border bg-surface-raised py-0 pl-3 pr-10 text-body text-primary disabled:cursor-not-allowed disabled:opacity-55"
      >
        {children}
      </select>
      <ChevronDown
        aria-hidden="true"
        className={`pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-secondary ${disabled ? 'opacity-45' : ''}`}
        strokeWidth={1.75}
      />
    </span>
  )
}
