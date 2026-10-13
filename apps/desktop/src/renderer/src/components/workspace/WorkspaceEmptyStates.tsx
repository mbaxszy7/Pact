import { FolderPlus, MessageSquarePlus, Plus } from 'lucide-react'

import type { Project } from '@pact/contracts'

import type { SettingsPage } from './SettingsNavigation'

interface ProjectEmptyStateProps {
  adding: boolean
  error?: string | undefined
  settingsButtonRef: React.RefObject<HTMLButtonElement | null>
  onAddProject: () => void
  onOpenSettings: (page: Exclude<SettingsPage, null>) => void
  onRetry: () => void
}

export function ProjectEmptyState({
  adding,
  error,
  onAddProject,
  onOpenSettings,
  onRetry,
  settingsButtonRef,
}: ProjectEmptyStateProps): React.JSX.Element {
  return (
    <main className="flex min-h-full items-center justify-center px-section py-spacious">
      <div className="w-full max-w-[32rem] text-center">
        <FolderPlus
          aria-hidden="true"
          className="mx-auto size-10 text-tertiary"
          strokeWidth={1.5}
        />
        <h2 className="mt-section text-title font-medium tracking-[-0.025em]">
          Start with a project
        </h2>
        <p className="mx-auto mt-group max-w-[54ch] text-body leading-relaxed text-secondary">
          Choose a local Git repository or folder. The project reference stays on this device.
        </p>
        {error ? <ErrorNotice message={error} onRetry={onRetry} /> : null}
        <div className="mt-section flex flex-wrap items-center justify-center gap-group">
          <button
            className="primary-action-button"
            type="button"
            disabled={adding}
            data-busy={adding}
            aria-busy={adding}
            onClick={onAddProject}
          >
            {adding ? (
              <span className="primary-action-spinner" aria-hidden="true" />
            ) : (
              <FolderPlus aria-hidden="true" className="size-4" strokeWidth={1.75} />
            )}
            {adding ? 'Adding project' : 'Add project'}
          </button>
          <button
            ref={settingsButtonRef}
            className="h-9 rounded-control px-4 text-body font-medium text-secondary hover:bg-surface-muted hover:text-primary"
            type="button"
            onClick={() => onOpenSettings('session-defaults')}
          >
            Open settings
          </button>
        </div>
      </div>
    </main>
  )
}

export function ProjectReadyState({
  project,
  error,
  onCreate,
  onRetry,
}: {
  project: Project
  error?: string | undefined
  onCreate: () => void
  onRetry: () => void
}): React.JSX.Element {
  return (
    <main className="flex min-h-full items-center justify-center px-section py-spacious">
      <div className="w-full max-w-[30rem] text-center">
        <MessageSquarePlus
          aria-hidden="true"
          className="mx-auto size-9 text-tertiary"
          strokeWidth={1.5}
        />
        <h2 className="mt-section text-title font-medium tracking-[-0.025em]">
          Start a Session in{' '}
          <span className="inline-block rounded-control bg-surface-raised px-2.5 py-1 text-primary">
            {project.name}
          </span>
        </h2>
        <p className="mx-auto mt-group max-w-[48ch] text-body leading-relaxed text-secondary">
          Create a shared workspace for Claude Code, Codex, and you.
        </p>
        {error ? <ErrorNotice message={error} onRetry={onRetry} /> : null}
        <button className="primary-action-button mt-section" type="button" onClick={onCreate}>
          <Plus aria-hidden="true" className="size-4" strokeWidth={1.8} />
          New Session
        </button>
      </div>
    </main>
  )
}

function ErrorNotice({
  message,
  onRetry,
}: {
  message: string
  onRetry: () => void
}): React.JSX.Element {
  return (
    <div
      className="mt-section rounded-control bg-danger-muted px-group py-3 text-left text-caption text-danger"
      role="alert"
    >
      <p>{message}</p>
      <button
        className="mt-2 font-medium underline underline-offset-4"
        type="button"
        onClick={onRetry}
      >
        Try again
      </button>
    </div>
  )
}
