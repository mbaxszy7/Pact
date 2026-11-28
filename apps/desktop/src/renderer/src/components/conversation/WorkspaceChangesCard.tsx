import { ChevronDown, FileDiff, RotateCcw } from 'lucide-react'
import { useId, useState } from 'react'

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

const FILE_KIND_BADGE = {
  added: {
    code: 'A',
    label: 'Added',
    className: 'bg-diff-added text-diff-added-foreground',
  },
  modified: {
    code: 'M',
    label: 'Modified',
    className: 'bg-status-info-muted text-status-info-foreground',
  },
  deleted: {
    code: 'D',
    label: 'Deleted',
    className: 'bg-diff-removed text-diff-removed-foreground',
  },
  renamed: {
    code: 'R',
    label: 'Renamed',
    className: 'bg-status-warning-muted text-status-warning-foreground',
  },
} as const satisfies Record<
  WorkspaceFileChange['kind'],
  { code: string; label: string; className: string }
>

function splitFilePath(path: string): { name: string; directory: string } {
  const normalized = path.replace(/\\/gu, '/')
  const lastSlash = normalized.lastIndexOf('/')
  if (lastSlash === -1) return { name: path, directory: '' }
  return {
    name: normalized.slice(lastSlash + 1),
    directory: normalized.slice(0, lastSlash + 1),
  }
}

export function WorkspaceChangesCard({
  changeSet,
  list,
  undoing,
  disabled,
  activeFilePath,
  undoingPath,
  onUndo,
  onUndoFile,
  onView,
  onShowFiles,
  onOpenFile,
}: {
  changeSet: WorkspaceChangeSet
  list?: WorkspaceChangesList | undefined
  undoing: boolean
  disabled: boolean
  activeFilePath?: string | undefined
  undoingPath?: string | undefined
  onUndo: (changeSetId: string) => void
  onUndoFile?: ((changeSetId: string, path: string) => void | Promise<boolean>) | undefined
  onView: (changeSetId: string) => void
  onShowFiles: (changeSetId: string) => void
  onOpenFile: (changeSetId: string, path: string) => void
}): React.JSX.Element {
  const undoableCount = changeSet.undoableFileCount
  const canAttemptRoundUndoState =
    changeSet.state === 'ready' &&
    !changeSet.undoUnavailableReason &&
    (undoableCount ?? changeSet.fileCount) > 0
  const canAttemptPerFileUndoState =
    (changeSet.state === 'ready' &&
      !changeSet.undoUnavailableReason &&
      (undoableCount ?? changeSet.fileCount) > 0) ||
    (changeSet.state === 'mixed' && (undoableCount ?? 0) > 0)
  const partialUndoable =
    canAttemptRoundUndoState && undoableCount !== undefined && undoableCount < changeSet.fileCount
  const unavailable = !canAttemptRoundUndoState
  const reason = changeSet.undoUnavailableReason
  const shortReason = reason?.startsWith(
    'The Agent did not provide complete original and final file versions.',
  )
    ? 'Original or final file versions are missing.'
    : reason?.split(/(?<=[.!?])\s/u)[0]?.trim()
  const undoTooltipId = useId()
  const [undoTooltipDismissed, setUndoTooltipDismissed] = useState(false)
  const undoDisabled = unavailable || disabled || undoing
  const undoReason = undoing
    ? 'Undo in progress.'
    : changeSet.state === 'undone'
      ? 'Already undone.'
      : changeSet.state === 'recording'
        ? 'Waiting for file changes to finish.'
        : shortReason ||
          (changeSet.state === 'recovery_required'
            ? 'Recover files before Undo.'
            : disabled && canAttemptRoundUndoState
              ? 'Wait for the current operation to finish.'
              : 'Undo is unavailable for these changes.')
  const undoLabel = undoing
    ? 'Undoing'
    : partialUndoable
      ? `Undo (${undoableCount}/${changeSet.fileCount})`
      : 'Undo'
  const undoTitle = partialUndoable
    ? `Undo ${undoableCount} of ${changeSet.fileCount} undoable files in this card`
    : 'Undo all changes listed in this card'
  const files = list?.files.slice(0, list.expanded ? list.files.length : 3) ?? []
  const remaining = Math.max(0, changeSet.fileCount - files.length)

  return (
    <section
      className="pact-silk-surface mt-2 w-full min-w-0 rounded-2xl border border-border bg-surface-muted/70 p-1.5 text-caption"
      aria-label="Changes from this response"
      data-pact-workspace-changes={changeSet.id}
    >
      <header className="flex flex-wrap items-center gap-x-2.5 gap-y-2 px-2.5 py-1.5">
        <span className="grid size-6 shrink-0 place-items-center rounded-lg border border-border bg-surface-raised text-secondary">
          <FileDiff aria-hidden="true" className="size-3.5" strokeWidth={1.75} />
        </span>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2.5 gap-y-0.5">
          <p className="font-medium text-primary">
            Edited {changeSet.fileCount} {changeSet.fileCount === 1 ? 'file' : 'files'}
            {changeSet.state === 'undone' ? (
              <span className="ml-2 inline-flex items-center rounded-pill bg-surface-raised px-2 py-0.5 text-[11px] font-normal text-tertiary">
                Undone
              </span>
            ) : null}
          </p>
          {changeSet.countsAvailable !== false ? (
            <p className="inline-flex items-center gap-1.5 font-mono tabular-nums">
              <span className="text-diff-added-foreground">+{changeSet.additions}</span>
              <span className="text-diff-removed-foreground">−{changeSet.deletions}</span>
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {/* oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- The disabled button needs a focusable tooltip group; enabled interaction belongs to the native button. */}
          <span
            className="group/undo relative inline-flex rounded-lg focus-visible:outline-2 focus-visible:outline-focus"
            tabIndex={undoDisabled ? 0 : undefined}
            role={undoDisabled ? 'group' : undefined}
            aria-label={undoDisabled ? 'Undo unavailable' : undefined}
            aria-describedby={undoDisabled && !undoTooltipDismissed ? undoTooltipId : undefined}
            onMouseEnter={() => setUndoTooltipDismissed(false)}
            onFocus={() => setUndoTooltipDismissed(false)}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && undoDisabled && !undoTooltipDismissed) {
                setUndoTooltipDismissed(true)
                event.stopPropagation()
              }
            }}
          >
            <button
              className="pact-pressable inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-lg border border-border bg-surface-raised px-2.5 font-medium text-primary hover:bg-row-hover focus-visible:outline-2 focus-visible:outline-focus disabled:pointer-events-none disabled:cursor-default disabled:opacity-50"
              type="button"
              disabled={undoDisabled}
              title={!undoDisabled ? undoTitle : undefined}
              onClick={() => onUndo(changeSet.id)}
            >
              {undoing ? (
                <span className="primary-action-spinner" aria-hidden="true" />
              ) : (
                <RotateCcw aria-hidden="true" className="size-3.5" strokeWidth={1.75} />
              )}
              <span className="tabular-nums">{undoLabel}</span>
            </button>
            {undoDisabled && undoReason && !undoTooltipDismissed ? (
              <span
                id={undoTooltipId}
                role="tooltip"
                className="invisible absolute right-0 bottom-full z-30 w-56 max-w-[calc(100vw-2rem)] pb-2 opacity-0 transition-opacity duration-150 group-hover/undo:visible group-hover/undo:opacity-100 group-focus-within/undo:visible group-focus-within/undo:opacity-100 motion-reduce:transition-none"
              >
                <span className="block rounded-lg border border-border bg-surface-raised px-3 py-2 text-left text-caption font-normal leading-relaxed text-primary shadow-popover">
                  {undoReason}
                </span>
              </span>
            ) : null}
          </span>
          <button
            className="pact-pressable h-7 cursor-pointer rounded-lg border border-border bg-surface-raised px-2.5 font-medium text-primary hover:bg-row-hover focus-visible:outline-2 focus-visible:outline-focus disabled:cursor-default disabled:opacity-50"
            type="button"
            disabled={Boolean(list?.loading)}
            onClick={() => onView(changeSet.id)}
          >
            View changes
          </button>
        </div>
      </header>
      {files.length ? (
        <ul className="mt-1 max-h-64 space-y-0.5 overflow-auto px-0.5 pb-0.5">
          {files.map((file) => {
            const badge = FILE_KIND_BADGE[file.kind]
            const { name, directory } = splitFilePath(file.path)
            const isActive = activeFilePath !== undefined && activeFilePath === file.path
            const isUndone =
              Boolean(file.undone) ||
              (changeSet.state === 'undone' && file.undoStrategy !== 'unavailable')
            const isUndoingThisFile = undoingPath === file.path
            const canUndoThisFile =
              Boolean(onUndoFile) &&
              canAttemptPerFileUndoState &&
              !isUndone &&
              file.undoStrategy !== 'unavailable'

            return (
              <li
                key={file.path}
                data-active={isActive ? 'true' : undefined}
                className={`group/file relative flex items-center rounded-xl transition-colors duration-150 ${
                  isActive ? 'bg-accent-soft' : 'hover:bg-row-hover'
                }`}
              >
                {isActive ? (
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute top-2 bottom-2 left-1 w-[3px] rounded-pill bg-focus"
                  />
                ) : null}
                <button
                  className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-xl px-3 py-2 text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus"
                  type="button"
                  title={file.previousPath ? `${file.previousPath} → ${file.path}` : file.path}
                  aria-current={isActive ? 'true' : undefined}
                  onClick={() => onOpenFile(changeSet.id, file.path)}
                >
                  <span
                    className={`inline-grid size-5 shrink-0 place-items-center rounded-md font-mono text-[10px] font-semibold ${badge.className}`}
                    aria-label={badge.label}
                  >
                    {badge.code}
                  </span>
                  <span className="min-w-0 flex-1 truncate">
                    {directory ? (
                      <>
                        <span className="sr-only">{file.path}</span>
                        <span aria-hidden="true">
                          <span
                            className={`font-medium text-primary ${isUndone ? 'line-through opacity-55' : ''}`}
                          >
                            {name}
                          </span>
                          <span className="ml-1.5 font-mono text-[11px] text-tertiary">
                            {directory}
                          </span>
                        </span>
                      </>
                    ) : (
                      <span
                        className={`font-medium text-primary ${isUndone ? 'line-through opacity-55' : ''}`}
                      >
                        {file.path}
                      </span>
                    )}
                  </span>
                  {isUndone ? (
                    <span className="shrink-0 rounded-pill bg-surface-raised px-2 py-0.5 text-[10px] font-medium text-tertiary">
                      Undone
                    </span>
                  ) : null}
                  {file.additions !== null && file.deletions !== null ? (
                    <span className="flex shrink-0 items-center gap-1.5 font-mono text-[11px] tabular-nums">
                      <span className="text-diff-added-foreground">+{file.additions}</span>
                      <span className="text-diff-removed-foreground">−{file.deletions}</span>
                    </span>
                  ) : null}
                </button>
                {canUndoThisFile && onUndoFile ? (
                  <button
                    className={`pact-pressable mr-1.5 inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-lg px-2 text-[11px] font-medium text-secondary transition-opacity duration-150 hover:bg-surface-raised hover:text-primary focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-focus disabled:pointer-events-none disabled:opacity-45 ${
                      isUndoingThisFile
                        ? 'opacity-100'
                        : 'opacity-0 group-focus-within/file:opacity-100 group-hover/file:opacity-100'
                    }`}
                    type="button"
                    disabled={disabled || undoing || isUndoingThisFile}
                    aria-label={`Undo ${file.path}`}
                    title={`Undo ${file.path}`}
                    onClick={() => {
                      void onUndoFile(changeSet.id, file.path)
                    }}
                  >
                    {isUndoingThisFile ? (
                      <span className="primary-action-spinner" aria-hidden="true" />
                    ) : (
                      <RotateCcw aria-hidden="true" className="size-3" strokeWidth={1.75} />
                    )}
                    <span>{isUndoingThisFile ? 'Undoing' : 'Undo'}</span>
                  </button>
                ) : null}
              </li>
            )
          })}
        </ul>
      ) : null}
      {list?.error ? (
        <div
          className="mt-1 flex items-center gap-2 rounded-xl px-3 py-2 text-secondary"
          role="alert"
        >
          <span className="min-w-0 flex-1">{list.error}</span>
          <button
            className="pact-pressable shrink-0 cursor-pointer rounded-lg px-2 py-1 font-medium text-primary hover:bg-row-hover focus-visible:outline-2 focus-visible:outline-focus"
            type="button"
            onClick={() => onShowFiles(changeSet.id)}
          >
            Retry
          </button>
        </div>
      ) : remaining > 0 || list?.loading ? (
        <button
          className="mt-0.5 flex min-h-8 w-full cursor-pointer items-center gap-1.5 rounded-xl px-3 py-1.5 text-secondary transition-colors duration-150 hover:bg-row-hover hover:text-primary focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus disabled:cursor-default"
          type="button"
          disabled={Boolean(list?.loading)}
          onClick={() => onShowFiles(changeSet.id)}
        >
          {list?.loading ? (
            <>
              <span className="primary-action-spinner" aria-hidden="true" /> Loading files…
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
