import { ChevronDown, FileDiff, RotateCcw } from 'lucide-react'

import type { WorkspaceChangeSet, WorkspaceFileChange } from '@pact/contracts'

export interface WorkspaceChangesList {
  changeSetId: string
  revision?: number | undefined
  files: WorkspaceFileChange[]
  nextPath: string | null
  loading: boolean
  expanded: boolean
  error?: string | undefined
}

export function WorkspaceChangesCard({
  changeSet,
  list,
  undoing,
  disabled,
  onUndo,
  onView,
  onShowFiles,
  onOpenFile,
}: {
  changeSet: WorkspaceChangeSet
  list?: WorkspaceChangesList | undefined
  undoing: boolean
  disabled: boolean
  onUndo: (changeSetId: string) => void
  onView: (changeSetId: string) => void
  onShowFiles: (changeSetId: string) => void
  onOpenFile: (changeSetId: string, path: string) => void
}): React.JSX.Element {
  const unavailable = changeSet.state !== 'ready' || Boolean(changeSet.undoUnavailableReason)
  const reason =
    changeSet.state === 'recording'
      ? 'Background work is still being observed. You can review recorded changes; Undo is unavailable until recording settles.'
      : (changeSet.undoUnavailableReason ??
        (changeSet.state === 'mixed'
          ? 'Concurrent changes were preserved. This round cannot be undone.'
          : changeSet.state === 'recovery_required'
            ? 'File recovery must finish before Undo is available.'
            : undefined))
  const files = list?.files.slice(0, list.expanded ? list.files.length : 3) ?? []
  const remaining = Math.max(0, changeSet.fileCount - files.length)

  return (
    <section
      className="mt-2 w-full min-w-0 rounded-message border border-border bg-surface-raised text-caption"
      aria-label="Changes from this response"
      data-pact-workspace-changes={changeSet.id}
    >
      <p className="px-3 pt-2.5 text-secondary">
        Undo affects only the changes listed in this card.
      </p>
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5">
        <FileDiff
          aria-hidden="true"
          className="size-4 shrink-0 text-secondary"
          strokeWidth={1.75}
        />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-primary">
            Edited {changeSet.fileCount} {changeSet.fileCount === 1 ? 'file' : 'files'}
            {changeSet.state === 'undone' ? (
              <span className="ml-2 font-normal text-tertiary">Undone</span>
            ) : null}
          </p>
          {changeSet.countsAvailable !== false ? (
            <p className="mt-0.5 flex gap-2 font-mono tabular-nums">
              <span className="text-diff-added-foreground">+{changeSet.additions}</span>
              <span className="text-diff-removed-foreground">−{changeSet.deletions}</span>
            </p>
          ) : (
            <p className="mt-0.5 text-secondary">Line counts unavailable</p>
          )}
        </div>
        <button
          className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-control px-2 text-secondary hover:bg-surface-muted hover:text-primary focus-visible:outline-2 focus-visible:outline-focus disabled:cursor-default disabled:opacity-50"
          type="button"
          disabled={unavailable || disabled || undoing}
          title={reason}
          onClick={() => onUndo(changeSet.id)}
        >
          {undoing ? (
            <span className="primary-action-spinner" aria-hidden="true" />
          ) : (
            <RotateCcw aria-hidden="true" className="size-3.5" strokeWidth={1.75} />
          )}
          {undoing ? 'Undoing' : 'Undo'}
        </button>
        <button
          className="h-7 cursor-pointer rounded-control border border-border px-2.5 font-medium text-primary hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-focus disabled:cursor-default disabled:opacity-50"
          type="button"
          disabled={Boolean(list?.loading)}
          onClick={() => onView(changeSet.id)}
        >
          View changes
        </button>
      </header>
      {reason && changeSet.state !== 'undone' ? (
        <p className="line-clamp-2 break-words px-3 pb-2.5 text-secondary" title={reason}>
          {reason}
        </p>
      ) : null}
      {files.length ? (
        <ul className="max-h-64 overflow-auto border-t border-border py-1">
          {files.map((file) => (
            <li key={file.path}>
              <button
                className="flex w-full cursor-pointer items-center gap-3 px-3 py-1.5 text-left hover:bg-surface-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus"
                type="button"
                title={file.previousPath ? `${file.previousPath} → ${file.path}` : file.path}
                onClick={() => onOpenFile(changeSet.id, file.path)}
              >
                <span className="line-clamp-2 min-w-0 flex-1 break-words font-mono text-secondary">
                  {file.path}
                </span>
                {file.additions !== null && file.deletions !== null ? (
                  <span className="flex shrink-0 gap-1.5 font-mono tabular-nums">
                    <span className="text-diff-added-foreground">+{file.additions}</span>
                    <span className="text-diff-removed-foreground">−{file.deletions}</span>
                  </span>
                ) : (
                  <span
                    className="max-w-40 shrink-0 truncate text-tertiary"
                    title={file.reason ?? undefined}
                  >
                    {file.reason ?? file.kind}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {list?.error ? (
        <div
          className="flex items-center gap-2 border-t border-border px-3 py-2 text-secondary"
          role="alert"
        >
          <span className="min-w-0 flex-1">{list.error}</span>
          <button
            className="shrink-0 cursor-pointer rounded-control px-2 py-1 font-medium text-primary hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-focus"
            type="button"
            onClick={() => onShowFiles(changeSet.id)}
          >
            Retry
          </button>
        </div>
      ) : remaining > 0 || list?.loading ? (
        <button
          className="flex min-h-8 w-full cursor-pointer items-center gap-1.5 border-t border-border px-3 py-1.5 text-secondary hover:bg-surface-muted hover:text-primary focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus disabled:cursor-default"
          type="button"
          disabled={Boolean(list?.loading)}
          onClick={() => onShowFiles(changeSet.id)}
        >
          {list?.loading ? (
            <>
              <span className="primary-action-spinner" aria-hidden="true" /> Loading files
            </>
          ) : (
            <>
              Show {remaining} {files.length ? 'more ' : ''}
              {remaining === 1 ? 'file' : 'files'}
              <ChevronDown aria-hidden="true" className="size-3.5" strokeWidth={1.75} />
            </>
          )}
        </button>
      ) : null}
    </section>
  )
}
