import { ArrowLeft } from 'lucide-react'

export type SettingsPage =
  | 'session-defaults'
  | 'appearance'
  | 'decision-scheduling'
  | 'updates'
  | null

interface SettingsNavigationProps {
  updateAvailable?: boolean
  settingsPage: Exclude<SettingsPage, null>
  onBackToApp: () => void
  onOpenSettings: (page: Exclude<SettingsPage, null>) => void
}

export function SettingsNavigation({
  settingsPage,
  updateAvailable,
  onBackToApp,
  onOpenSettings,
}: SettingsNavigationProps): React.JSX.Element {
  return (
    <div className="flex h-full min-h-0 flex-col p-group" data-pact-surface>
      <button
        className="flex min-h-9 w-full items-center gap-group rounded-control px-group py-2 text-left text-body font-medium text-primary hover:bg-surface-raised"
        type="button"
        onClick={onBackToApp}
      >
        <ArrowLeft aria-hidden="true" className="size-4 shrink-0" strokeWidth={1.75} />
        Back to app
      </button>
      <div className="mt-section border-t border-border pt-section">
        <h2 className="text-caption font-medium uppercase tracking-wide text-tertiary">Settings</h2>
        <nav className="mt-group" aria-label="Settings navigation">
          <button
            className="block w-full rounded-control px-group py-2 text-left text-body text-secondary hover:bg-surface-raised data-[active=true]:bg-surface-raised data-[active=true]:font-medium data-[active=true]:text-primary"
            data-active={settingsPage === 'session-defaults'}
            aria-current={settingsPage === 'session-defaults' ? 'page' : undefined}
            type="button"
            onClick={() => onOpenSettings('session-defaults')}
          >
            Default session
          </button>
          <button
            className="mt-1 block w-full rounded-control px-group py-2 text-left text-body text-secondary hover:bg-surface-raised data-[active=true]:bg-surface-raised data-[active=true]:font-medium data-[active=true]:text-primary"
            data-active={settingsPage === 'decision-scheduling'}
            aria-current={settingsPage === 'decision-scheduling' ? 'page' : undefined}
            type="button"
            onClick={() => onOpenSettings('decision-scheduling')}
          >
            Relay
          </button>
          <button
            className="mt-1 block w-full rounded-control px-group py-2 text-left text-body text-secondary hover:bg-surface-raised data-[active=true]:bg-surface-raised data-[active=true]:font-medium data-[active=true]:text-primary"
            data-active={settingsPage === 'appearance'}
            aria-current={settingsPage === 'appearance' ? 'page' : undefined}
            type="button"
            onClick={() => onOpenSettings('appearance')}
          >
            Appearance
          </button>
          <button
            type="button"
            onClick={() => onOpenSettings('updates')}
            className="mt-1 flex w-full items-center justify-between gap-2 rounded-control px-group py-2 text-left text-body text-secondary hover:bg-surface-raised data-[active=true]:bg-surface-raised data-[active=true]:font-medium data-[active=true]:text-primary"
            data-active={settingsPage === 'updates'}
            aria-current={settingsPage === 'updates' ? 'page' : undefined}
          >
            About &amp; updates
            {updateAvailable ? (
              <span className="text-caption font-medium text-focus">New</span>
            ) : null}
          </button>
        </nav>
      </div>
    </div>
  )
}
