import { BookOpen, Maximize2, Minimize2, RotateCcw, X } from 'lucide-react'
import { Component, lazy, Suspense, type ReactNode } from 'react'

import type { SkillDocument, SkillSelection } from '@pact/contracts'

const CodeViewer = lazy(async () => {
  const module = await import('../project-file/ProjectCodeViewer')
  return { default: module.ProjectCodeViewer }
})

class SkillViewerBoundary extends Component<
  { children: ReactNode; content: string },
  { failed: boolean }
> {
  override state = { failed: false }
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }
  override render(): ReactNode {
    return this.state.failed ? (
      <div className="flex h-full min-h-0 flex-col">
        <output className="shrink-0 border-b border-border p-group text-caption text-secondary">
          Document viewer is unavailable. Showing Markdown source.
        </output>
        <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-panel font-mono text-caption text-primary">
          {this.props.content}
        </pre>
      </div>
    ) : (
      this.props.children
    )
  }
}

export interface SkillDocumentPanelState {
  sessionId: string
  skill: Pick<SkillSelection, 'id' | 'agentId' | 'name'>
  loading: boolean
  document?: SkillDocument | undefined
  error?: string | undefined
}

/** Read-only presentation in the existing Context Panel; App owns requests and replacement. */
export function SkillDocumentPanel({
  state,
  expanded,
  onExpandedChange,
  onClose,
  onRetry,
}: {
  state: SkillDocumentPanelState
  expanded: boolean
  onExpandedChange: (value: boolean) => void
  onClose: () => void
  onRetry: () => void
}): React.JSX.Element {
  const label = state.skill.agentId === 'codex' ? 'Codex' : 'Claude Code'
  const document = state.document
  return (
    <section className="flex h-full min-h-0 flex-col" aria-label="Skill document">
      <header className="flex shrink-0 items-start justify-between gap-group border-b border-border px-panel py-group">
        <div className="flex min-w-0 items-start gap-2.5">
          <BookOpen
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-secondary"
            strokeWidth={1.75}
          />
          <div className="min-w-0">
            <h2 className="break-all text-body font-medium text-primary">{state.skill.name}</h2>
            <p className="mt-0.5 text-caption text-tertiary">
              {label} · {document?.status === 'unavailable' ? 'Skill' : 'SKILL.md'}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 gap-1">
          <button
            type="button"
            className="grid size-8 place-items-center rounded-control text-secondary hover:bg-surface-muted"
            aria-label={expanded ? 'Restore Skill preview' : 'Expand Skill preview'}
            onClick={() => onExpandedChange(!expanded)}
          >
            {expanded ? (
              <Minimize2 aria-hidden="true" className="size-4" />
            ) : (
              <Maximize2 aria-hidden="true" className="size-4" />
            )}
          </button>
          <button
            type="button"
            className="grid size-8 place-items-center rounded-control text-secondary hover:bg-surface-muted"
            aria-label="Close Skill preview"
            onClick={onClose}
          >
            <X aria-hidden="true" className="size-4" />
          </button>
        </div>
      </header>
      {state.loading ? (
        <output className="p-panel text-caption text-secondary">Loading Skill document…</output>
      ) : state.error ? (
        <div role="alert" className="p-panel text-caption text-secondary">
          <p>{state.error}</p>
          <button
            type="button"
            onClick={onRetry}
            className="mt-group inline-flex min-h-8 items-center gap-2 rounded-control border border-border px-3 text-primary"
          >
            <RotateCcw aria-hidden="true" className="size-3.5" />
            Try again
          </button>
        </div>
      ) : document?.status === 'unavailable' ? (
        <div className="space-y-group p-panel text-caption leading-relaxed text-secondary">
          <p>The native runtime has not exposed this Skill’s Markdown source.</p>
          <p>{document.description}</p>
          {document.argumentHint ? <p>Arguments: {document.argumentHint}</p> : null}
        </div>
      ) : document?.status === 'available' ? (
        <div className="min-h-0 flex-1">
          <SkillViewerBoundary
            key={`${document.skillId}:${document.contentHash}`}
            content={document.content}
          >
            <Suspense
              fallback={<p className="p-panel text-caption text-secondary">Opening document…</p>}
            >
              <CodeViewer
                path={`skill-${state.sessionId}-${document.agentId}-${document.skillId}-${document.contentHash}/SKILL.md`}
                content={document.content}
                language="markdown"
              />
            </Suspense>
          </SkillViewerBoundary>
        </div>
      ) : null}
    </section>
  )
}
