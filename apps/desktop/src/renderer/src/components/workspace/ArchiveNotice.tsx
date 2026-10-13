import { Archive, X } from 'lucide-react'

export type ArchivedItem =
  | { kind: 'session'; id: string; title: string; projectId: string }
  | { kind: 'project'; id: string; title: string }

interface ArchiveNoticeProps {
  item: ArchivedItem
  restoring: boolean
  onUndo: () => void
  onDismiss: () => void
}

export function ArchiveNotice({
  item,
  restoring,
  onUndo,
  onDismiss,
}: ArchiveNoticeProps): React.JSX.Element {
  const subject = item.kind === 'session' ? 'Session' : 'Project'
  return (
    <output className="absolute left-1/2 top-[4.25rem] z-[70] flex max-w-[min(30rem,calc(100vw-2rem))] -translate-x-1/2 items-center gap-2 rounded-card border border-border bg-surface-raised p-1.5 pl-group text-caption text-primary shadow-lg">
      <Archive aria-hidden="true" className="size-4 shrink-0 text-secondary" strokeWidth={1.75} />
      <span className="min-w-0 truncate font-medium">{subject} archived</span>
      <button
        className="h-7 shrink-0 rounded-control bg-surface-inverse px-2.5 font-medium text-inverse disabled:cursor-wait disabled:opacity-55"
        type="button"
        disabled={restoring}
        onClick={onUndo}
      >
        {restoring ? 'Restoring…' : 'Undo'}
      </button>
      <button
        className="grid size-7 shrink-0 place-items-center rounded-control text-secondary hover:bg-surface-muted hover:text-primary"
        type="button"
        aria-label="Dismiss archive notice"
        onClick={onDismiss}
      >
        <X aria-hidden="true" className="size-4" strokeWidth={1.75} />
      </button>
    </output>
  )
}
