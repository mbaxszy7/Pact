import { AlertTriangle, FileDiff, Maximize2, Minimize2, RotateCcw, X } from 'lucide-react'
import { Component, lazy, Suspense, useEffect, useState, type ReactNode } from 'react'

import {
  WORKSPACE_OPERATION_TIMEOUT_MS,
  WORKSPACE_PREVIEW_BYTES,
  type WorkspaceChangeFilePreview,
} from '@pact/contracts'

import { PlainFileViewer } from './PlainFileViewer'
import { projectFileLanguage } from './project-file-language'

const ProjectCodeViewer = lazy(async () => {
  const module = await import('./ProjectCodeViewer')
  return { default: module.ProjectCodeViewer }
})
const ProjectDiffViewer = lazy(async () => {
  const module = await import('./ProjectCodeViewer')
  return { default: module.ProjectDiffViewer }
})
const RecordedPatchViewer = lazy(async () => {
  const module = await import('./RecordedPatchViewer')
  return { default: module.RecordedPatchViewer }
})

export interface WorkspaceChangesPanelState {
  sessionId: string
  changeSetId: string
  path: string
  revision?: number | undefined
}

interface PreviewReadState {
  key: string
  loading: boolean
  preview?: WorkspaceChangeFilePreview
  patches?: string[]
  error?: { message: string; retryable: boolean }
}

function unavailableMessage(
  reason: Extract<WorkspaceChangeFilePreview, { status: 'unavailable' }>['reason'],
): string {
  const messages = {
    not_recorded: 'The Agent did not provide this complete historical version.',
    not_final: 'This saved change has not been finalized.',
    blob_missing: 'The recorded version is missing from saved storage.',
    blob_corrupt: 'The recorded version failed its integrity check.',
    too_large: 'This recorded version is too large to preview.',
    unsupported_encoding: 'This recorded version is not supported UTF-8 text.',
    temporary_io: 'Pact could not read this saved version. Try again.',
  }
  return messages[reason]
}

// Each side owns one bounded result and deadline. Retrying it cannot discard the other sides.
function useSavedPreview(
  { sessionId, changeSetId, path, revision }: WorkspaceChangesPanelState,
  side: WorkspaceChangeFilePreview['side'],
  enabled = true,
  patchCount = 1,
): PreviewReadState & { retry: () => void } {
  const [attempt, setAttempt] = useState(0)
  const key = JSON.stringify([
    sessionId,
    changeSetId,
    path,
    revision ?? 0,
    side,
    patchCount,
    attempt,
  ])
  const [read, setRead] = useState<Omit<PreviewReadState, 'loading'>>({ key })
  useEffect(() => {
    if (!enabled) return undefined
    let cancelled = false
    const fail = (message: string, retryable: boolean): void => {
      if (!cancelled) setRead({ key, error: { message, retryable } })
    }
    const timeout = window.setTimeout(() => {
      fail('Loading this saved preview took too long. Try again.', true)
      cancelled = true
    }, WORKSPACE_OPERATION_TIMEOUT_MS)
    const load = async (): Promise<void> => {
      let first: WorkspaceChangeFilePreview | undefined
      const patches: string[] = []
      let bytes = 0
      for (let index = 0; index < (side === 'patch' ? patchCount : 1); index += 1) {
        if (cancelled) return
        const patchIndex = side === 'patch' ? index : undefined
        // oxlint-disable-next-line no-await-in-loop -- Immutable patches are read sequentially under one deadline and aggregate byte budget.
        const result = await window.pact.readWorkspaceChangeFile({
          changeSetId,
          path,
          side,
          ...(side === 'patch' ? { patchIndex } : {}),
        })
        if (cancelled) return undefined
        if (!result.ok) {
          fail(
            result.error.message,
            result.error.code === 'TIMEOUT' || result.error.code === 'RUNTIME_UNAVAILABLE',
          )
          return undefined
        }
        const preview = result.value
        const identity = preview.status === 'available' ? preview.file : preview
        if (
          preview.changeSetId !== changeSetId ||
          preview.side !== side ||
          preview.patchIndex !== patchIndex ||
          identity.sessionId !== sessionId ||
          identity.relativePath !== path
        ) {
          fail('This preview does not belong to the requested saved change.', false)
          return undefined
        }
        if (side === 'patch' && preview.patchCount !== patchCount) {
          fail('The saved changes changed while loading. Open this file again.', true)
          return
        }
        first ??= preview
        if (preview.status === 'unavailable') {
          setRead({ key, preview })
          return
        }
        if (side === 'patch') {
          bytes += new TextEncoder().encode(preview.file.content).byteLength
          if (bytes > WORKSPACE_PREVIEW_BYTES) {
            fail('The recorded changes are too large for this preview.', false)
            return
          }
          patches.push(preview.file.content)
        }
      }
      if (first) setRead({ key, preview: first, ...(side === 'patch' ? { patches } : {}) })
    }
    void load()
      .catch(() => fail('Pact could not load this saved preview. Try again.', true))
      .finally(() => window.clearTimeout(timeout))
    return () => {
      cancelled = true
      window.clearTimeout(timeout)
    }
  }, [sessionId, changeSetId, path, side, patchCount, key, enabled])
  return {
    ...(read.key === key ? read : { key }),
    loading: enabled && (read.key !== key || (!read.preview && !read.error)),
    retry: () => setAttempt((value) => value + 1),
  }
}

function readError(read: PreviewReadState): { message: string; retryable: boolean } | undefined {
  if (read.error) return read.error
  return read.preview?.status === 'unavailable'
    ? {
        message: unavailableMessage(read.preview.reason),
        retryable: read.preview.reason === 'temporary_io',
      }
    : undefined
}

class SavedCodeBoundary extends Component<
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

interface WorkspaceChangesPanelProps {
  state: WorkspaceChangesPanelState
  expanded: boolean
  onClose: () => void
  onExpandedChange: (expanded: boolean) => void
}

export function WorkspaceChangesPanel(props: WorkspaceChangesPanelProps): React.JSX.Element {
  return (
    <SavedChangesPanel
      key={JSON.stringify([props.state.sessionId, props.state.changeSetId, props.state.path])}
      {...props}
    />
  )
}

function SavedChangesPanel({
  state,
  expanded,
  onClose,
  onExpandedChange,
}: WorkspaceChangesPanelProps): React.JSX.Element {
  const [mode, setMode] = useState<'diff' | 'after'>('diff')
  const beforeRead = useSavedPreview(state, 'before')
  const afterRead = useSavedPreview(state, 'after')
  const before = beforeRead.preview?.status === 'available' ? beforeRead.preview.file : undefined
  const after = afterRead.preview?.status === 'available' ? afterRead.preview.file : undefined
  const needsPatch = !before || !after
  const patchCount = afterRead.preview?.patchCount ?? beforeRead.preview?.patchCount ?? 0
  const versionsSettled = !beforeRead.loading && !afterRead.loading
  const patchRead = useSavedPreview(state, 'patch', needsPatch && patchCount > 0, patchCount)
  const patchFile = patchRead.preview?.status === 'available' ? patchRead.preview.file : undefined
  const previewFile = mode === 'after' ? after : needsPatch ? patchFile : after
  const selectedRead =
    mode === 'after'
      ? afterRead
      : needsPatch && patchCount > 0
        ? patchRead
        : before
          ? afterRead
          : beforeRead
  const error = readError(selectedRead)
  const previewLoading =
    !previewFile &&
    (mode === 'after' ? afterRead.loading : !versionsSettled || selectedRead.loading)
  const unavailable =
    !previewFile && !error && !previewLoading
      ? 'Complete historical versions and recorded patches are unavailable for this file.'
      : undefined

  const label = state.path.split(/[\\/]/u).at(-1) ?? state.path
  const language = projectFileLanguage(state.path) ?? 'plaintext'
  return (
    <section className="flex h-full min-h-0 flex-col" aria-labelledby="workspace-changes-title">
      <header className="flex shrink-0 items-start justify-between gap-group border-b border-border px-panel py-group">
        <div className="flex min-w-0 items-start gap-2.5">
          <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-control bg-surface-muted text-secondary">
            <FileDiff aria-hidden="true" className="size-4" strokeWidth={1.75} />
          </span>
          <div className="min-w-0">
            <h2
              id="workspace-changes-title"
              className="line-clamp-2 break-words text-body font-medium text-primary"
              title={state.path}
            >
              {label}
            </h2>
            {label !== state.path ? (
              <p
                className="mt-0.5 line-clamp-2 break-words font-mono text-caption text-tertiary"
                title={state.path}
              >
                {state.path}
              </p>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            className="grid size-8 cursor-pointer place-items-center rounded-control text-secondary hover:bg-surface-muted hover:text-primary focus-visible:outline-2 focus-visible:outline-focus"
            type="button"
            aria-label={expanded ? 'Restore changes preview' : 'Expand changes preview'}
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
            className="grid size-8 cursor-pointer place-items-center rounded-control text-secondary hover:bg-surface-muted hover:text-primary focus-visible:outline-2 focus-visible:outline-focus"
            type="button"
            aria-label="Close changes preview"
            title="Close preview"
            onClick={onClose}
          >
            <X aria-hidden="true" className="size-4" strokeWidth={1.75} />
          </button>
        </div>
      </header>
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-panel py-2">
        {(['diff', 'after'] as const).map((option) => (
          <button
            key={option}
            className={`h-7 cursor-pointer rounded-control px-2.5 text-caption font-medium focus-visible:outline-2 focus-visible:outline-focus disabled:cursor-default disabled:opacity-45 ${mode === option ? 'bg-surface-muted text-primary' : 'text-secondary hover:bg-surface-muted hover:text-primary'}`}
            type="button"
            aria-pressed={mode === option}
            disabled={
              option === 'after' &&
              afterRead.preview?.status === 'unavailable' &&
              afterRead.preview.reason !== 'temporary_io'
            }
            title={
              option === 'after' && afterRead.preview?.status === 'unavailable'
                ? unavailableMessage(afterRead.preview.reason)
                : undefined
            }
            onClick={() => setMode(option)}
          >
            {option === 'diff' ? 'Diff' : 'After'}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-1 text-caption text-secondary">
          <span>{needsPatch && mode === 'diff' ? 'Recorded changes' : 'Saved version'}</span>
          {mode === 'diff' &&
          previewFile &&
          (readError(beforeRead)?.retryable || readError(afterRead)?.retryable) ? (
            <button
              type="button"
              aria-label="Retry reading saved versions"
              title="Retry reading saved versions"
              className="grid size-7 cursor-pointer place-items-center rounded-control hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-focus"
              onClick={() => {
                if (readError(beforeRead)?.retryable) beforeRead.retry()
                if (readError(afterRead)?.retryable) afterRead.retry()
              }}
            >
              <RotateCcw aria-hidden="true" className="size-3.5" />
            </button>
          ) : null}
        </div>
      </div>
      {previewLoading ? (
        <div
          className="grid min-h-0 flex-1 place-items-center text-caption text-secondary"
          aria-busy="true"
        >
          Loading saved changes…
        </div>
      ) : error || unavailable ? (
        <div className="flex min-h-0 flex-1 items-center justify-center p-section" role="alert">
          <div className="w-full max-w-72 text-center">
            <AlertTriangle
              aria-hidden="true"
              className="mx-auto size-5 text-status-warning-foreground"
              strokeWidth={1.75}
            />
            <h3 className="mt-group text-body font-medium text-primary">
              Saved preview unavailable
            </h3>
            <p className="mt-1 text-caption leading-relaxed text-secondary">
              {error?.message ?? unavailable}
            </p>
            {error?.retryable ? (
              <button
                className="mt-section inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-control border border-border px-3 text-caption font-medium text-primary hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-focus"
                type="button"
                onClick={selectedRead.retry}
              >
                <RotateCcw aria-hidden="true" className="size-3.5" strokeWidth={1.75} />
                Try again
              </button>
            ) : null}
          </div>
        </div>
      ) : previewFile ? (
        <div className="min-h-0 flex-1 overflow-hidden bg-surface" data-pact-surface>
          <SavedCodeBoundary
            key={`${state.changeSetId}:${state.path}:${mode}`}
            fallback={
              mode === 'after' ? (
                <PlainFileViewer file={previewFile} wrapLines />
              ) : (
                <div className="p-panel text-caption text-secondary" role="alert">
                  Diff could not be displayed. Choose After to read the saved code.
                </div>
              )
            }
          >
            <Suspense
              fallback={
                <div
                  className="grid h-full place-items-center text-caption text-secondary"
                  aria-busy="true"
                >
                  Preparing code view…
                </div>
              }
            >
              {mode === 'diff' && before && after ? (
                <ProjectDiffViewer
                  path={`${state.changeSetId}/${state.path}`}
                  before={before.content}
                  after={after.content}
                  language={language}
                />
              ) : mode === 'diff' && needsPatch ? (
                <RecordedPatchViewer
                  path={state.path}
                  contents={patchRead.patches ?? [previewFile.content]}
                />
              ) : (
                <ProjectCodeViewer
                  path={`${state.changeSetId}/${state.path}`}
                  content={previewFile.content}
                  language={needsPatch && mode === 'diff' ? 'plaintext' : language}
                />
              )}
            </Suspense>
          </SavedCodeBoundary>
        </div>
      ) : null}
    </section>
  )
}
