import { AlertTriangle, FileText, Maximize2, Minimize2, RotateCcw, TextWrap, X } from 'lucide-react'
import { Component, lazy, Suspense, useMemo, useState, type ReactNode } from 'react'

import type { FileCommentAnchor, ProjectFile } from '@pact/contracts'

import type { ProjectFileTarget } from '../conversation/MessageMarkdown'
import type { FileLocation } from './file-location'

import { NATIVE_PLAIN_LINE_LIMIT, PlainFileViewer } from './PlainFileViewer'
import { projectFileLanguage } from './project-file-language'

const ProjectCodeViewer = lazy(async () => {
  const module = await import('./ProjectCodeViewer')
  return { default: module.ProjectCodeViewer }
})

export interface ProjectFilePanelState {
  target: ProjectFileTarget
  file?: ProjectFile | undefined
  loading: boolean
  error?: string | undefined
}

interface ProjectFilePanelProps {
  state: ProjectFilePanelState
  expanded: boolean
  onClose: () => void
  onExpandedChange: (expanded: boolean) => void
  onRetry: () => void
  onCreateComment: (anchor: FileCommentAnchor, body: string) => Promise<boolean>
  commentingDisabled?: boolean | undefined
}

class CodeViewerBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

export function ProjectFilePanel({
  state,
  expanded,
  onClose,
  onExpandedChange,
  onRetry,
  onCreateComment,
  commentingDisabled = false,
}: ProjectFilePanelProps): React.JSX.Element {
  const [wrapPlain, setWrapPlain] = useState(false)
  const viewerLanguage = state.file
    ? (projectFileLanguage(state.file.relativePath) ??
      (state.file.lineCount > NATIVE_PLAIN_LINE_LIMIT ? 'plaintext' : undefined))
    : undefined
  const displayPath = state.file?.absolutePath ?? state.target.path
  const fileLabel = state.file?.relativePath ?? state.target.path
  const lineLabel = formatLineLabel(state.file?.lineStart, state.file?.lineEnd)

  return (
    <section className="flex h-full min-h-0 flex-col" aria-labelledby="project-file-title">
      <header className="flex shrink-0 items-start justify-between gap-group border-b border-border px-panel py-group">
        <div className="flex min-w-0 items-start gap-2.5">
          <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-control bg-status-info-muted text-status-info-foreground">
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
              className={`grid size-8 place-items-center rounded-control hover:bg-surface-muted hover:text-primary ${wrapPlain ? 'bg-surface-muted text-primary' : 'text-secondary'}`}
              type="button"
              aria-label={
                wrapPlain
                  ? 'Show line numbers and stop wrapping'
                  : 'Wrap lines and hide line numbers'
              }
              aria-pressed={wrapPlain}
              title={wrapPlain ? 'Show line numbers' : 'Wrap lines'}
              onClick={() => setWrapPlain((current) => !current)}
            >
              <TextWrap aria-hidden="true" className="size-4" strokeWidth={1.75} />
            </button>
          ) : null}
          <button
            className="grid size-8 place-items-center rounded-control text-secondary hover:bg-surface-muted hover:text-primary"
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
            className="grid size-8 place-items-center rounded-control text-secondary hover:bg-surface-muted hover:text-primary"
            type="button"
            aria-label="Close file preview"
            title="Close preview"
            onClick={onClose}
          >
            <X aria-hidden="true" className="size-4" strokeWidth={1.75} />
          </button>
        </div>
      </header>

      {state.loading ? (
        <FileLoadingState label="Loading file preview" />
      ) : state.error ? (
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
              className="mt-section inline-flex h-9 items-center gap-2 rounded-control border border-border bg-surface-raised px-3 text-caption font-medium text-primary hover:bg-surface-muted"
              type="button"
              onClick={onRetry}
            >
              <RotateCcw aria-hidden="true" className="size-3.5" strokeWidth={1.75} />
              Try again
            </button>
          </div>
        </div>
      ) : state.file ? (
        <FileContent
          key={`${state.file.relativePath}:${state.file.contentHash}:${state.file.lineStart ?? ''}:${state.file.lineEnd ?? ''}:${state.target.startColumn ?? ''}:${state.target.endColumn ?? ''}`}
          file={state.file}
          target={state.target}
          language={viewerLanguage}
          wrapPlain={wrapPlain}
          onCreateComment={onCreateComment}
          commentingDisabled={commentingDisabled}
        />
      ) : null}
    </section>
  )
}

function FileContent({
  file,
  target,
  language,
  wrapPlain,
  onCreateComment,
  commentingDisabled,
}: {
  file: ProjectFile
  target: ProjectFileTarget
  language: string | undefined
  wrapPlain: boolean
  onCreateComment: (anchor: FileCommentAnchor, body: string) => Promise<boolean>
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
  const [selection, setSelection] = useState<
    { anchor: FileCommentAnchor; quote: string; body: string } | undefined
  >()
  const saveSelection = async (): Promise<void> => {
    if (!selection?.body.trim() || commentingDisabled) return
    if (await onCreateComment(selection.anchor, selection.body)) setSelection(undefined)
  }
  const plainTextFallback = (
    <PlainFileViewer file={file} location={location} wrapLines={language ? true : wrapPlain} />
  )

  return (
    <div className="relative flex min-h-0 flex-1 overflow-hidden bg-surface" data-pact-surface>
      {language ? (
        <CodeViewerBoundary
          key={`${file.relativePath}:${file.updatedAt}`}
          fallback={plainTextFallback}
        >
          <Suspense fallback={<FileLoadingState label="Preparing code view" />}>
            <ProjectCodeViewer
              path={file.relativePath}
              content={file.content}
              language={language}
              location={location}
              onCreateComment={
                language === 'plaintext' || commentingDisabled || file.isExternal
                  ? undefined
                  : (range) =>
                      setSelection({
                        anchor: {
                          type: 'file',
                          path: file.relativePath.replace(/\\/gu, '/'),
                          contentHash: file.contentHash,
                          startLine: range.startLine,
                          startColumn: range.startColumn,
                          endLine: range.endLine,
                          endColumn: range.endColumn,
                          quote: range.quote,
                        },
                        quote: range.quote,
                        body: '',
                      })
              }
            />
          </Suspense>
        </CodeViewerBoundary>
      ) : (
        plainTextFallback
      )}
      {selection ? (
        <section className="absolute inset-x-3 bottom-3 rounded-card border border-border bg-surface-raised p-3 shadow-lg">
          <p className="text-caption text-secondary">Comment on “{selection.quote}”</p>
          <textarea
            className="mt-2 min-h-16 w-full resize-y rounded-control bg-surface-muted p-2 text-caption text-primary outline-none focus:outline-2 focus:outline-focus"
            value={selection.body}
            disabled={commentingDisabled}
            placeholder="What should the Agent notice?"
            onChange={(event) => setSelection({ ...selection, body: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setSelection(undefined)
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
                className="h-8 rounded-control px-3 text-caption text-secondary hover:bg-surface-muted"
                type="button"
                disabled={commentingDisabled}
                onClick={() => setSelection(undefined)}
              >
                Cancel
              </button>
              <button
                className="h-8 rounded-control bg-surface-inverse px-3 text-caption font-medium text-inverse disabled:opacity-40"
                type="button"
                disabled={!selection.body.trim() || commentingDisabled}
                onClick={() => void saveSelection()}
              >
                Save Comment
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
