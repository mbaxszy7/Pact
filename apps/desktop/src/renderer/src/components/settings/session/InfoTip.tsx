import { Info } from 'lucide-react'
import { useId } from 'react'

export function InfoTip({
  label,
  children,
}: {
  label: string
  children: string
}): React.JSX.Element {
  const tooltipId = useId()
  return (
    <span className="group relative inline-flex shrink-0 align-middle">
      <button
        className="grid size-5 place-items-center rounded-control text-tertiary hover:bg-surface-muted hover:text-primary"
        type="button"
        aria-label={`About ${label}`}
        aria-describedby={tooltipId}
      >
        <Info aria-hidden="true" className="size-4" strokeWidth={1.75} />
      </button>
      <span
        id={tooltipId}
        className="pointer-events-none invisible absolute bottom-[calc(100%+0.5rem)] left-1/2 z-30 w-72 max-w-[calc(100vw-2rem)] -translate-x-1/2 translate-y-1 rounded-control border border-border bg-surface-raised px-3 py-2 text-left text-caption font-normal leading-relaxed text-primary opacity-0 shadow-popover transition-[opacity,transform,visibility] duration-150 group-hover:visible group-hover:translate-y-0 group-hover:opacity-100 group-focus-within:visible group-focus-within:translate-y-0 group-focus-within:opacity-100"
        role="tooltip"
      >
        {children}
      </span>
    </span>
  )
}
