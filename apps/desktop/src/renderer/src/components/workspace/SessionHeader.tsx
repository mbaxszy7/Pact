import { Check, FolderClosed, Pencil, SlidersHorizontal, X } from 'lucide-react'
import { useRef, useState } from 'react'

import type { CollaborationSession } from '@pact/contracts'

interface SessionHeaderProps {
  session: CollaborationSession
  projectName?: string | undefined
  saving: boolean
  onSave: (title: string) => Promise<boolean>
  onOpenSettings: () => void
  settingsButtonRef?: React.RefObject<HTMLButtonElement | null> | undefined
}

export function SessionHeader({
  session,
  projectName,
  saving,
  onSave,
  onOpenSettings,
  settingsButtonRef,
}: SessionHeaderProps): React.JSX.Element {
  return (
    <div className="flex h-full min-w-0 items-center justify-between gap-group">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span
          className="grid size-7 shrink-0 place-items-center text-secondary"
          title={projectName ? `Project: ${projectName}` : undefined}
        >
          <FolderClosed aria-hidden="true" className="size-4" strokeWidth={1.75} />
        </span>
        <EditableSessionTitle session={session} saving={saving} onSave={onSave} />
      </div>
      <button
        ref={settingsButtonRef}
        className="inline-flex h-8 shrink-0 items-center gap-2 rounded-control px-2.5 text-caption font-medium text-secondary hover:bg-surface-muted hover:text-primary"
        type="button"
        onClick={onOpenSettings}
      >
        <SlidersHorizontal aria-hidden="true" className="size-4" strokeWidth={1.75} />
        Session settings
      </button>
    </div>
  )
}

function EditableSessionTitle({
  session,
  saving,
  onSave,
}: Pick<SessionHeaderProps, 'session' | 'saving' | 'onSave'>): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(session.title)
  const [error, setError] = useState<string | undefined>()
  const editorRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const beginEditing = (): void => {
    setDraft(session.title)
    setError(undefined)
    setEditing(true)
    window.requestAnimationFrame(() => inputRef.current?.select())
  }
  const cancel = (): void => {
    if (saving) return
    setDraft(session.title)
    setError(undefined)
    setEditing(false)
  }
  const save = async (): Promise<void> => {
    if (saving) return
    const title = draft.trim()
    if (!title) {
      setError('Enter a title.')
      inputRef.current?.focus()
      return
    }
    if (title === session.title) {
      setEditing(false)
      return
    }
    if (await onSave(title)) setEditing(false)
    else setError('Couldn’t save the title. Try again.')
  }

  if (!editing) {
    return (
      <div
        data-titlebar-interactive
        className="group/title flex min-w-0 max-w-full items-center gap-1.5"
      >
        <h1 className="truncate text-body font-medium text-primary">{session.title}</h1>
        <button
          className="grid size-7 shrink-0 place-items-center rounded-control text-tertiary opacity-0 transition-opacity duration-150 hover:bg-surface-muted hover:text-primary focus-visible:opacity-100 group-hover/title:opacity-100 group-focus-within/title:opacity-100"
          type="button"
          aria-label="Rename Session"
          title="Rename Session"
          onClick={beginEditing}
        >
          <Pencil aria-hidden="true" className="size-3.5" strokeWidth={1.75} />
        </button>
      </div>
    )
  }

  return (
    <div
      ref={editorRef}
      data-titlebar-interactive
      className="relative min-w-0 flex-1"
      onBlur={(event) => {
        if (editorRef.current?.contains(event.relatedTarget)) return
        void save()
      }}
    >
      <div className="flex min-w-0 items-center gap-1">
        <input
          ref={inputRef}
          className="h-8 min-w-0 flex-1 rounded-control border border-focus bg-surface-raised px-2.5 text-body font-medium text-primary outline-none ring-2 ring-focus/20"
          aria-label="Session title"
          maxLength={120}
          value={draft}
          disabled={saving}
          onChange={(event) => {
            setDraft(event.target.value)
            setError(undefined)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              void save()
            } else if (event.key === 'Escape') {
              event.preventDefault()
              cancel()
            }
          }}
        />
        <button
          className="grid size-8 shrink-0 place-items-center rounded-control text-secondary hover:bg-surface-muted hover:text-primary disabled:cursor-wait disabled:opacity-50"
          type="button"
          aria-label="Save Session title"
          disabled={saving}
          onClick={() => void save()}
        >
          {saving ? (
            <span className="primary-action-spinner" aria-hidden="true" />
          ) : (
            <Check aria-hidden="true" className="size-4" strokeWidth={1.8} />
          )}
        </button>
        <button
          className="grid size-8 shrink-0 place-items-center rounded-control text-secondary hover:bg-surface-muted hover:text-primary disabled:opacity-50"
          type="button"
          aria-label="Cancel renaming"
          disabled={saving}
          onClick={cancel}
        >
          <X aria-hidden="true" className="size-4" strokeWidth={1.8} />
        </button>
      </div>
      {error ? (
        <p
          className="absolute left-0 top-[calc(100%+0.375rem)] z-20 rounded-control border border-border bg-surface-raised px-2.5 py-1.5 text-caption text-danger shadow-popover"
          role="alert"
        >
          {error}
        </p>
      ) : null}
    </div>
  )
}
