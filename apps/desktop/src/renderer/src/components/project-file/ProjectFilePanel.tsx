import {
  AlertTriangle,
  ChevronLeft,
  FileText,
  Maximize2,
  Minimize2,
  RotateCcw,
  TextWrap,
  X,
} from 'lucide-react'
import { Component, lazy, Suspense, useMemo, useRef, useState, type ReactNode } from 'react'

import type { FileCommentAnchor, ProjectFile } from '@pact/contracts'

import type { ProjectFileTarget } from '../conversation/MessageMarkdown'
import type { FileLocation } from './file-location'

import { NATIVE_PLAIN_LINE_LIMIT, PlainFileViewer } from './PlainFileViewer'
import { projectFileLanguage } from './project-file-language'

const ProjectCodeViewer = lazy(async () => {
  const module = await import('./ProjectCodeViewer')
  return { default: module.ProjectCodeViewer }
})

export type FileCommentSaveOutcome = boolean | string | { conflict: true }

export interface ProjectFilePanelState {
  target: ProjectFileTarget
  file?: ProjectFile | undefined
  loading: boolean
  error?: string | undefined
  requestId?: number | undefined
}

export interface ProjectFileCommentOptions {
  commentId?: string | undefined
  sessionId?: string | undefined
  requestId?: string | undefined
  mode?: 'create' | 'edit' | undefined
}

interface ProjectFilePanelProps {
  state: ProjectFilePanelState
  expanded: boolean
  onClose: () => void
  onBackToSideChat?: (() => void) | undefined
  onExpandedChange: (expanded: boolean) => void
  onRetry: () => void
  onCreateComment: (
    anchor: FileCommentAnchor,
    body: string,
    options?: ProjectFileCommentOptions,
  ) => Promise<FileCommentSaveOutcome>
  commentingDisabled?: boolean | undefined
}

interface PendingFileCommentSubmit {
  requestId: string
  body: string
  mode: 'create' | 'edit'
}

interface FileCommentDraft {
  fileKey: string
  draftId: string
  commentId: string
  persisted: boolean
  pendingSubmit?: PendingFileCommentSubmit | undefined
  anchor: FileCommentAnchor
  quote: string
  body: string
}

const MAX_COMMENT_DRAFTS = 8

function putBoundedCommentDraft(
  drafts: ReadonlyMap<string, FileCommentDraft>,
  fileKey: string,
  draft: FileCommentDraft,
): { next: Map<string, FileCommentDraft>; evictedBlocked: boolean } {
  const next = new Map(drafts)
  if (next.has(fileKey)) {
    next.delete(fileKey)
    next.set(fileKey, draft)
    return { next, evictedBlocked: false }
  }
  while (next.size >= MAX_COMMENT_DRAFTS) {
    let emptyKey: string | undefined
    for (const [key, entry] of next) {
      if (entry.body.trim().length === 0) {
        emptyKey = key
        break
      }
    }
    if (emptyKey === undefined) {
      return { next: new Map(drafts), evictedBlocked: true }
    }
    next.delete(emptyKey)
  }
  next.set(fileKey, draft)
  return { next, evictedBlocked: false }
}

class CodeViewerBoundary extends Component<
  { children: ReactNode; fallback: ReactNode; resetKey: string },
  { failed: boolean; failedKey?: string | undefined }
> {
  override state: { failed: boolean; failedKey?: string | undefined } = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  static getDerivedStateFromProps(
    props: { resetKey: string },
    state: { failed: boolean; failedKey?: string | undefined },
  ): { failed: boolean; failedKey?: string | undefined } | null {
    if (state.failed && state.failedKey === undefined) {
      return { failed: true, failedKey: props.resetKey }
    }
    if (state.failed && state.failedKey !== props.resetKey) {
      return { failed: false, failedKey: undefined }
    }
    return null
  }

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

function resolveViewerLanguage(file: ProjectFile | undefined): string | undefined {
  if (!file) return undefined
  return (
    projectFileLanguage(file.relativePath) ??
    (file.lineCount > NATIVE_PLAIN_LINE_LIMIT ? 'plaintext' : undefined)
  )
}

export function ProjectFilePanel({
  state,
  expanded,
  onClose,
  onBackToSideChat,
  onExpandedChange,
  onRetry,
  onCreateComment,
  commentingDisabled = false,
}: ProjectFilePanelProps): React.JSX.Element {
  const [wrapPlain, setWrapPlain] = useState(false)
  const viewerLanguage = resolveViewerLanguage(state.file)
  // Retain the last loaded Monaco file across transient loading transitions so the persistent
  // Monaco editor stays mounted and swaps pooled ITextModels without a blank flash.
  const [retained, setRetained] = useState<
    | {
        file: ProjectFile
        target: ProjectFileTarget
        language: string | undefined
        requestId?: number | undefined
      }
    | undefined
  >(undefined)
  if (
    state.file &&
    (retained?.file !== state.file ||
      retained.target !== state.target ||
      retained.language !== viewerLanguage ||
      retained.requestId !== state.requestId)
  ) {
    setRetained({
      file: state.file,
      target: state.target,
      language: viewerLanguage,
      requestId: state.requestId,
    })
  }

  const activeContent = state.file
    ? {
        file: state.file,
        target: state.target,
        language: viewerLanguage,
        requestId: state.requestId,
      }
    : retained?.language
      ? retained
      : undefined
  const showContent = Boolean(state.file && !state.loading && !state.error)
  const displayPath = state.file?.absolutePath ?? state.target.path
  const fileLabel = state.file?.relativePath ?? state.target.path
  const lineLabel = formatLineLabel(state.file?.lineStart, state.file?.lineEnd)

  return (
    <section className="flex h-full min-h-0 flex-col" aria-labelledby="project-file-title">
      {onBackToSideChat ? (
        <div className="flex h-10 shrink-0 items-center border-b border-border px-3">
          <button
            type="button"
            className="pact-pressable inline-flex h-7 cursor-pointer items-center gap-1 rounded-control px-2 text-caption font-medium text-secondary transition-colors hover:bg-surface-muted hover:text-primary focus-visible:outline-2 focus-visible:outline-focus"
            onClick={onBackToSideChat}
          >
            <ChevronLeft aria-hidden="true" className="size-4" strokeWidth={1.75} />
            Back to side chat
          </button>
        </div>
      ) : null}
      <header className="flex shrink-0 items-start justify-between gap-group border-b border-border px-panel py-group">
        <div className="flex min-w-0 items-start gap-2.5">
          <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg bg-status-info-muted text-status-info-foreground">
            <FileText aria-hidden="true" className="size-4" strokeWidth={1.75} />
          </span>
          <div className="min-w-0">
            <h2 id="project-file-title" className="truncate text-body font-medium text-primary">
              {fileName(fileLabel)}
            </h2>
            <p className="mt-0.5 truncate font-mono text-caption text-tertiary" title={displayPath}>
              {displayPath}
              {lineLabel ? ` · ${lineLabel}` : ''}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {state.file && !state.loading && !state.error && !viewerLanguage ? (
            <button
              className={`pact-pressable grid size-8 cursor-pointer place-items-center rounded-control hover:bg-surface-muted hover:text-primary ${wrapPlain ? 'bg-surface-muted text-primary' : 'text-secondary'}`}
              type="button"
              aria-label={
                wrapPlain
                  ? 'Show line numbers and stop wrapping'
                  : 'Wrap lines and hide line numbers'
              }
              aria-pressed={wrapPlain}
              title={
                wrapPlain
                  ? 'Show line numbers (turns off wrapping)'
                  : 'Wrap lines (hides line numbers)'
              }
              onClick={() => setWrapPlain((current) => !current)}
            >
              <TextWrap aria-hidden="true" className="size-4" strokeWidth={1.75} />
            </button>
          ) : null}
          <button
            className="pact-pressable grid size-8 cursor-pointer place-items-center rounded-control text-secondary hover:bg-surface-muted hover:text-primary"
            type="button"
            aria-label={expanded ? 'Restore file preview' : 'Expand file preview'}
            title={expanded ? 'Restore preview' : 'Expand preview'}
            onClick={() => onExpandedChange(!expanded)}
          >
            {expanded ? (
              <Minimize2 aria-hidden="true" className="size-4" strokeWidth={1.75} />
            ) : (
              <Maximize2 aria-hidden="true" className="size-4" strokeWidth={1.75} />
            )}
          </button>
          <button
            className="pact-pressable grid size-8 cursor-pointer place-items-center rounded-control text-secondary hover:bg-surface-muted hover:text-primary"
            type="button"
            aria-label="Close file preview"
            title="Close preview"
            onClick={onClose}
          >
            <X aria-hidden="true" className="size-4" strokeWidth={1.75} />
          </button>
        </div>
      </header>

      {state.loading && !activeContent ? <FileLoadingState label="Loading file preview" /> : null}
      {state.error && !state.loading ? (
        <div className="flex min-h-0 flex-1 items-center justify-center p-section">
          <div className="w-full max-w-72 text-center" role="alert">
            <span className="mx-auto grid size-10 place-items-center rounded-pill bg-status-warning-muted text-status-warning-foreground">
              <AlertTriangle aria-hidden="true" className="size-5" strokeWidth={1.65} />
            </span>
            <h3 className="mt-group text-body font-medium text-primary">
              File preview unavailable
            </h3>
            <p className="mt-1 text-caption leading-relaxed text-secondary">{state.error}</p>
            <button
              className="pact-pressable mt-section inline-flex h-9 cursor-pointer items-center gap-2 rounded-control border border-border bg-surface-raised px-3 text-caption font-medium text-primary hover:bg-surface-muted"
              type="button"
              onClick={onRetry}
            >
              <RotateCcw aria-hidden="true" className="size-3.5" strokeWidth={1.75} />
              Try again
            </button>
          </div>
        </div>
      ) : null}
      {activeContent ? (
        <div
          className={
            showContent || (state.loading && Boolean(activeContent.language))
              ? 'relative flex min-h-0 flex-1 flex-col overflow-hidden'
              : 'hidden'
          }
          aria-busy={state.loading ? 'true' : undefined}
        >
          <div
            className="relative flex min-h-0 flex-1 flex-col overflow-hidden"
            inert={state.loading && activeContent.target.path !== state.target.path}
            aria-hidden={
              state.loading && activeContent.target.path !== state.target.path ? 'true' : undefined
            }
          >
            <FileContent
              file={activeContent.file}
              target={activeContent.target}
              requestId={activeContent.requestId}
              language={activeContent.language}
              wrapPlain={wrapPlain}
              onCreateComment={onCreateComment}
              commentingDisabled={commentingDisabled || state.loading}
            />
          </div>
          {state.loading && activeContent.target.path !== state.target.path ? (
            <div className="absolute inset-0 z-10 flex bg-surface" aria-busy="true">
              <FileLoadingState label="Loading file preview" />
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}

function FileContent({
  file,
  target,
  requestId,
  language,
  wrapPlain,
  onCreateComment,
  commentingDisabled,
}: {
  file: ProjectFile
  target: ProjectFileTarget
  requestId?: number | undefined
  language: string | undefined
  wrapPlain: boolean
  onCreateComment: (
    anchor: FileCommentAnchor,
    body: string,
    options?: ProjectFileCommentOptions,
  ) => Promise<FileCommentSaveOutcome>
  commentingDisabled: boolean
}): React.JSX.Element {
  const location = useMemo<FileLocation | undefined>(
    () =>
      file.lineStart
        ? {
            lineStart: file.lineStart,
            lineEnd: file.lineEnd,
            startColumn: target.startColumn,
            endColumn: target.endColumn,
          }
        : undefined,
    [file.lineStart, file.lineEnd, target.startColumn, target.endColumn],
  )
  const fileKey = `${file.relativePath}:${file.contentHash}`
  const [draftsByKey, setDraftsByKey] = useState<ReadonlyMap<string, FileCommentDraft>>(
    () => new Map(),
  )
  const [draftLimitNotice, setDraftLimitNotice] = useState<string | undefined>()
  const [pendingReplacement, setPendingReplacement] = useState<
    { fileKey: string; anchor: FileCommentAnchor; quote: string } | undefined
  >()
  const [savingRequest, setSavingRequest] = useState<
    { requestId: string; draftId: string; fileKey: string } | undefined
  >()
  const savingRequestRef = useRef<
    { requestId: string; draftId: string; fileKey: string } | undefined
  >(undefined)
  const selection = draftsByKey.get(fileKey)
  const activePendingReplacement =
    pendingReplacement?.fileKey === fileKey ? pendingReplacement : undefined
  const savingCurrent =
    savingRequest?.fileKey === fileKey && savingRequest.draftId === selection?.draftId

  const clearDraftForKey = (key: string): void => {
    setDraftsByKey((current) => {
      if (!current.has(key)) return current
      const next = new Map(current)
      next.delete(key)
      return next
    })
    setPendingReplacement((current) => (current?.fileKey === key ? undefined : current))
    setDraftLimitNotice(undefined)
  }

  const startCommentDraft = (anchor: FileCommentAnchor, quote: string): void => {
    const existing = draftsByKey.get(fileKey)
    if (existing && existing.body.trim().length > 0) {
      setPendingReplacement({ fileKey, anchor, quote })
      return
    }
    const newDraft: FileCommentDraft = {
      fileKey,
      draftId: crypto.randomUUID(),
      commentId: crypto.randomUUID(),
      persisted: false,
      anchor,
      quote,
      body: '',
    }
    const preview = putBoundedCommentDraft(draftsByKey, fileKey, newDraft)
    if (preview.evictedBlocked) {
      setDraftLimitNotice(
        `You have ${MAX_COMMENT_DRAFTS} unsaved comment drafts. Save or discard one before starting another.`,
      )
      return
    }
    setPendingReplacement(undefined)
    setDraftLimitNotice(undefined)
    setDraftsByKey((current) => {
      const result = putBoundedCommentDraft(current, fileKey, newDraft)
      return result.evictedBlocked ? current : result.next
    })
  }

  const saveSelection = async (): Promise<void> => {
    if (!selection?.body.trim() || commentingDisabled || savingRequestRef.current) return
    const reusedSubmit =
      selection.pendingSubmit && selection.pendingSubmit.body === selection.body
        ? selection.pendingSubmit
        : undefined
    const pendingSubmit: PendingFileCommentSubmit = reusedSubmit ?? {
      requestId: crypto.randomUUID(),
      body: selection.body,
      mode: selection.persisted ? 'edit' : 'create',
    }
    const submitted = {
      ...selection,
      requestId: pendingSubmit.requestId,
      mode: pendingSubmit.mode,
      sessionId: file.sessionId,
    }
    const token = {
      requestId: submitted.requestId,
      draftId: submitted.draftId,
      fileKey: submitted.fileKey,
    }
    savingRequestRef.current = token
    setSavingRequest(token)
    if (!reusedSubmit) {
      setDraftsByKey((current) => {
        const live = current.get(submitted.fileKey)
        if (!live || live.draftId !== submitted.draftId) return current
        const next = new Map(current)
        next.set(submitted.fileKey, { ...live, pendingSubmit })
        return next
      })
    }
    try {
      const saved = await onCreateComment(submitted.anchor, submitted.body, {
        commentId: submitted.commentId,
        sessionId: submitted.sessionId,
        requestId: submitted.requestId,
        mode: submitted.mode,
      })
      if (saved === false) return
      if (typeof saved === 'object' && saved !== null && 'conflict' in saved) {
        setDraftsByKey((current) => {
          const live = current.get(submitted.fileKey)
          if (
            !live ||
            live.draftId !== submitted.draftId ||
            live.commentId !== submitted.commentId
          ) {
            return current
          }
          const next = new Map(current)
          next.set(submitted.fileKey, {
            ...live,
            draftId: crypto.randomUUID(),
            pendingSubmit: undefined,
          })
          return next
        })
        return
      }
      const succeeded = saved === true || (typeof saved === 'string' && saved.length > 0)
      if (!succeeded) return
      const savedCommentId = typeof saved === 'string' ? saved : submitted.commentId
      setDraftsByKey((current) => {
        const live = current.get(submitted.fileKey)
        if (!live || live.draftId !== submitted.draftId || live.commentId !== submitted.commentId) {
          return current
        }
        const next = new Map(current)
        if (live.body === submitted.body) {
          next.delete(submitted.fileKey)
        } else {
          // User kept editing after submit: keep the persisted commentId so the next save edits instead of duplicating.
          next.set(submitted.fileKey, {
            ...live,
            draftId: crypto.randomUUID(),
            commentId: savedCommentId,
            persisted: true,
            pendingSubmit: undefined,
          })
        }
        return next
      })
      setPendingReplacement((current) =>
        current?.fileKey === submitted.fileKey ? undefined : current,
      )
      setDraftLimitNotice(undefined)
    } finally {
      if (savingRequestRef.current?.requestId === submitted.requestId) {
        savingRequestRef.current = undefined
        setSavingRequest(undefined)
      }
    }
  }
  const plainTextFallback = (
    <PlainFileViewer
      key={`${file.relativePath}:${file.contentHash}:${file.lineStart ?? ''}:${file.lineEnd ?? ''}`}
      file={file}
      location={location}
      wrapLines={language ? true : wrapPlain}
    />
  )

  return (
    <div className="relative flex min-h-0 flex-1 overflow-hidden bg-surface" data-pact-surface>
      {language ? (
        <CodeViewerBoundary
          resetKey={`${file.relativePath}:${file.updatedAt}`}
          fallback={plainTextFallback}
        >
          <Suspense fallback={<FileLoadingState label="Loading code view" />}>
            <ProjectCodeViewer
              path={file.relativePath}
              content={file.content}
              contentHash={file.contentHash}
              language={language}
              location={location}
              openRequest={requestId ?? target}
              onCreateComment={
                language === 'plaintext' || commentingDisabled || file.isExternal
                  ? undefined
                  : (range) =>
                      startCommentDraft(
                        {
                          type: 'file',
                          path: file.relativePath.replace(/\\/gu, '/'),
                          contentHash: file.contentHash,
                          startLine: range.startLine,
                          startColumn: range.startColumn,
                          endLine: range.endLine,
                          endColumn: range.endColumn,
                          quote: range.quote,
                        },
                        range.quote,
                      )
              }
            />
          </Suspense>
        </CodeViewerBoundary>
      ) : (
        plainTextFallback
      )}
      {draftLimitNotice && !selection ? (
        <div
          role="alert"
          className="absolute inset-x-3 bottom-3 z-20 flex items-center justify-between gap-2 rounded-xl border border-border bg-surface-raised px-3 py-2.5 text-caption text-status-warning-foreground shadow-popover"
        >
          <span>{draftLimitNotice}</span>
          <button
            type="button"
            aria-label="Dismiss notice"
            className="pact-pressable grid size-6 shrink-0 cursor-pointer place-items-center rounded-control text-secondary hover:bg-surface-muted hover:text-primary"
            onClick={() => setDraftLimitNotice(undefined)}
          >
            <X aria-hidden="true" className="size-3.5" strokeWidth={1.75} />
          </button>
        </div>
      ) : null}
      {selection ? (
        <section className="absolute inset-x-3 bottom-3 z-20 rounded-xl border border-border bg-surface-raised p-3 shadow-popover">
          {draftLimitNotice ? (
            <div
              role="alert"
              className="mb-2 flex items-center justify-between gap-2 rounded-lg border border-border bg-surface-muted px-2.5 py-2 text-caption text-status-warning-foreground"
            >
              <span>{draftLimitNotice}</span>
              <button
                type="button"
                aria-label="Dismiss notice"
                className="pact-pressable grid size-6 shrink-0 cursor-pointer place-items-center rounded-control text-secondary hover:bg-surface-raised hover:text-primary"
                onClick={() => setDraftLimitNotice(undefined)}
              >
                <X aria-hidden="true" className="size-3.5" strokeWidth={1.75} />
              </button>
            </div>
          ) : null}
          {activePendingReplacement ? (
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-surface-muted px-2.5 py-2 text-caption">
              <span className="text-primary">
                Replace your unsaved comment with the new selection?
              </span>
              <div className="flex gap-1.5">
                <button
                  type="button"
                  className="pact-pressable h-7 cursor-pointer rounded-control px-2 text-secondary hover:bg-surface-raised hover:text-primary"
                  onClick={() => setPendingReplacement(undefined)}
                >
                  Keep editing
                </button>
                <button
                  type="button"
                  className="pact-pressable h-7 cursor-pointer rounded-control bg-surface-inverse px-2 font-medium text-inverse"
                  onClick={() => {
                    const replacement = activePendingReplacement
                    setPendingReplacement(undefined)
                    setDraftLimitNotice(undefined)
                    setDraftsByKey((current) => {
                      const result = putBoundedCommentDraft(current, fileKey, {
                        fileKey,
                        draftId: crypto.randomUUID(),
                        commentId: crypto.randomUUID(),
                        persisted: false,
                        anchor: replacement.anchor,
                        quote: replacement.quote,
                        body: '',
                      })
                      return result.evictedBlocked ? current : result.next
                    })
                  }}
                >
                  Discard & replace
                </button>
              </div>
            </div>
          ) : null}
          <p className="line-clamp-2 text-caption text-secondary" title={selection.quote}>
            Comment on “{selection.quote}”
          </p>
          <textarea
            className="mt-2 min-h-16 w-full resize-y rounded-control bg-surface-muted p-2 text-caption text-primary outline-none focus:outline-2 focus:outline-focus"
            value={selection.body}
            disabled={commentingDisabled}
            placeholder="What should the Agent notice?"
            onChange={(event) => {
              const body = event.target.value
              setDraftsByKey((current) => {
                const live = current.get(fileKey)
                if (!live) return current
                const nextPendingSubmit =
                  live.pendingSubmit && live.pendingSubmit.body === body
                    ? live.pendingSubmit
                    : undefined
                const result = putBoundedCommentDraft(current, fileKey, {
                  ...live,
                  body,
                  pendingSubmit: nextPendingSubmit,
                })
                return result.evictedBlocked ? current : result.next
              })
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && !savingCurrent) clearDraftForKey(fileKey)
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                void saveSelection()
              }
            }}
          />
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            <p className="text-caption text-tertiary">Enter to save · Shift+Enter for a new line</p>
            <div className="flex gap-2">
              <button
                className="pact-pressable h-8 cursor-pointer rounded-control px-3 text-caption text-secondary hover:bg-surface-muted"
                type="button"
                disabled={commentingDisabled || savingCurrent}
                onClick={() => clearDraftForKey(fileKey)}
              >
                Cancel
              </button>
              <button
                className="pact-pressable h-8 cursor-pointer rounded-control bg-surface-inverse px-3 text-caption font-medium text-inverse disabled:opacity-40"
                type="button"
                disabled={!selection.body.trim() || commentingDisabled || savingCurrent}
                onClick={() => void saveSelection()}
              >
                {savingCurrent ? 'Saving…' : 'Save comment'}
              </button>
            </div>
          </div>
        </section>
      ) : null}
    </div>
  )
}

function FileLoadingState({ label }: { label: string }): React.JSX.Element {
  return (
    <div className="min-h-0 flex-1 space-y-2 overflow-hidden p-panel" aria-busy="true">
      <p className="sr-only">{label}</p>
      {Array.from({ length: 12 }, (_, index) => (
        <div
          // The uneven widths evoke code without flashing placeholder text.
          key={index}
          className="h-3 animate-pulse rounded-pill bg-surface-muted"
          style={{ width: `${48 + ((index * 17) % 45)}%` }}
        />
      ))}
    </div>
  )
}

function fileName(path: string): string {
  const name = path.split(/[\\/]/u).at(-1)
  return name || path
}

function formatLineLabel(lineStart?: number, lineEnd?: number): string | undefined {
  if (!lineStart) return undefined
  return lineEnd && lineEnd !== lineStart ? `lines ${lineStart}–${lineEnd}` : `line ${lineStart}`
}
