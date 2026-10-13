import { CircleX, Info, TriangleAlert, X } from 'lucide-react'

export type AppToastTone = 'error' | 'warning' | 'info'

export const APP_TOAST_DURATION_MS: Record<AppToastTone, number> = {
  error: 6_000,
  warning: 5_000,
  info: 3_500,
}

const toastAppearance = {
  error: {
    container: 'border-status-danger/40 bg-status-danger-muted text-status-danger-foreground',
    icon: CircleX,
  },
  warning: {
    container: 'border-status-warning/40 bg-status-warning-muted text-status-warning-foreground',
    icon: TriangleAlert,
  },
  info: {
    container: 'border-status-info/40 bg-status-info-muted text-status-info-foreground',
    icon: Info,
  },
} satisfies Record<
  AppToastTone,
  {
    container: string
    icon: typeof Info
  }
>

export function AppToast({
  message,
  tone,
  onDismiss,
}: {
  message: string
  tone: AppToastTone
  onDismiss: () => void
}): React.JSX.Element {
  const appearance = toastAppearance[tone]
  const Icon = appearance.icon

  return (
    <div
      className={`absolute left-1/2 top-[4.25rem] z-[80] flex max-w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 items-center gap-2 rounded-card border px-2 py-1.5 pl-3 text-caption shadow-md ${appearance.container}`}
      role={tone === 'error' ? 'alert' : 'status'}
      aria-live={tone === 'error' ? 'assertive' : 'polite'}
      aria-atomic="true"
      data-pact-toast-tone={tone}
    >
      <Icon aria-hidden="true" className="size-4 shrink-0" strokeWidth={1.75} />
      <span className="min-w-0 flex-1 font-medium leading-snug">{message}</span>
      <button
        className="grid size-7 shrink-0 place-items-center rounded-control text-current opacity-75 hover:bg-surface/40 hover:opacity-100 focus-visible:outline-2 focus-visible:outline-focus"
        type="button"
        aria-label={`Dismiss ${tone} notification`}
        onClick={onDismiss}
      >
        <X aria-hidden="true" className="size-3.5" strokeWidth={1.75} />
      </button>
    </div>
  )
}
