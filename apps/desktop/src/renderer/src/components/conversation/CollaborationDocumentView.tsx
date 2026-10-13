import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import type {
  CollaborationDocument,
  CollaborationMarkdownNode,
  ConversationPage,
} from '@pact/contracts'

import type { MessageTextSelection } from './MessageSelectionSurface'

import {
  collaborationDisplayEdits,
  readableCollaborationText,
  type CollaborationDisplayContext,
} from '../../../../shared/collaboration-display-text'
import { MessageMarkdown, type ProjectFileTarget } from './MessageMarkdown'

type Page = Extract<ConversationPage, { scope: 'collaboration-markdown' }>

/** One document read, at most three interpreted pages; stale reads never replace a new source. */
export function CollaborationDocumentView({
  sessionId,
  runId,
  source,
  messageId,
  aroundOffset,
  basis,
  onOpenProjectFile,
  onCreateComment,
  onReady,
  displayContext,
}: {
  sessionId: string
  runId: string
  source: CollaborationDocument
  messageId: string
  aroundOffset?: number | undefined
  basis?: 'markdown-visible-v2' | 'plain-visible-v1' | undefined
  onOpenProjectFile: (target: ProjectFileTarget) => void
  onCreateComment?:
    | ((
        selection: MessageTextSelection & {
          contentHash: string
          textBasis: 'markdown-visible-v2' | 'plain-visible-v1'
        },
      ) => void)
    | undefined
  onReady?: (() => (() => void) | undefined) | undefined
  displayContext?: CollaborationDisplayContext | undefined
}): React.JSX.Element {
  const [offset, setOffset] = useState(aroundOffset !== undefined ? -1 : 0)
  const [retry, setRetry] = useState(0)
  const [state, setState] = useState<{ key: string; pages: Page[]; error?: string }>()
  const key = `${sessionId}:${runId}:${source.id}:${source.sha256}:${offset}:${aroundOffset ?? ''}:${basis ?? ''}:${retry}`
  useEffect(() => {
    let current = true
    const read = async () => {
      const pages: Page[] = []
      let next = Math.max(0, offset)
      try {
        for (let i = 0; i < 3; i++) {
          // oxlint-disable-next-line no-await-in-loop -- Next page is fenced by the immutable prior response.
          const response = await window.pact.getConversation({
            scope: 'collaboration-markdown',
            ...(basis ? { basis } : {}),
            sessionId,
            runId,
            document: source,
            offset: next,
            ...(i === 0 && offset === -1 && aroundOffset !== undefined ? { aroundOffset } : {}),
          })
          if (!current) return
          if (!response.ok || response.value.scope !== 'collaboration-markdown')
            throw new Error(response.ok ? 'Document unavailable.' : response.error.message)
          pages.push(response.value)
          if (response.value.nextOffset === null) break
          next = response.value.nextOffset
        }
        if (current) setState({ key, pages })
      } catch (error) {
        if (current)
          setState({
            key,
            pages: [],
            error: error instanceof Error ? error.message : 'Document could not be read.',
          })
      }
    }
    void read()
    return () => {
      current = false
    }
    // Source hash is the immutable identity; object/callback churn must not re-read the document.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  useEffect(
    () => (state?.key === key && state.pages.length ? onReady?.() : undefined),
    [state, key, onReady],
  )
  const tree = useMemo(() => mergeProjectionPages(state?.pages ?? []), [state?.pages])
  const readable = useMemo(() => {
    try {
      return {
        tree: readableCollaborationTree(tree, {
          ...displayContext,
          runId,
          documentId: source.id,
          documentHash: source.sha256,
        }),
      }
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Document could not be displayed.' }
    }
    // Context values are immutable identities; a new wrapper object must not reinterpret the page.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [
    tree,
    runId,
    source.id,
    source.sha256,
    displayContext?.taskId,
    displayContext?.todoId,
    displayContext?.questionId,
  ])
  if (state?.key !== key)
    return (
      <p aria-busy="true" className="text-caption text-secondary">
        Loading…
      </p>
    )
  if (state.error || readable.error)
    return (
      <div role="alert" className="text-caption text-secondary">
        <p>{state.error ?? readable.error}</p>
        <button
          type="button"
          onClick={() => setRetry((value) => value + 1)}
          className="mt-2 underline"
        >
          Try again
        </button>
      </div>
    )
  const previous = state.pages[0]?.previousOffset
  const next = state.pages.at(-1)?.nextOffset
  return (
    <div
      className={state.pages[0]?.basis === 'plain-visible-v1' ? 'whitespace-pre-wrap' : undefined}
    >
      {state.pages[0]?.basis === 'plain-visible-v1' ? (
        <p className="mb-group whitespace-normal text-caption text-secondary">
          Formatting unavailable; full text is shown.
        </p>
      ) : null}
      <MessageMarkdown
        content=""
        tree={readable.tree}
        messageId={messageId}
        onOpenProjectFile={onOpenProjectFile}
        onCreateComment={
          onCreateComment
            ? (selection) =>
                onCreateComment({
                  ...selection,
                  contentHash: source.sha256,
                  textBasis: state.pages[0]!.basis,
                })
            : undefined
        }
      />
      {(previous !== null && previous !== undefined) || (next !== null && next !== undefined) ? (
        <nav
          aria-label="Document pages"
          className="mt-panel flex items-center justify-between gap-group text-caption text-secondary"
        >
          <button
            type="button"
            disabled={previous === null || previous === undefined}
            className="inline-flex min-h-8 items-center gap-1 rounded-control px-2 hover:bg-surface-muted disabled:opacity-40"
            onClick={() =>
              setOffset(
                Math.max(
                  0,
                  (previous ?? 0) - (state.pages[0]?.basis === 'plain-visible-v1' ? 16384 : 2),
                ),
              )
            }
          >
            <ChevronLeft aria-hidden="true" className="size-4" />
            Previous
          </button>
          <button
            type="button"
            disabled={next === null || next === undefined}
            className="inline-flex min-h-8 items-center gap-1 rounded-control px-2 hover:bg-surface-muted disabled:opacity-40"
            onClick={() => setOffset(next ?? offset)}
          >
            Continue
            <ChevronRight aria-hidden="true" className="size-4" />
          </button>
        </nav>
      ) : null}
    </div>
  )
}

/** Consecutive pages from one semantic block render as one block and one selection surface. */
function mergeProjectionPages(pages: Page[]): CollaborationMarkdownNode {
  const merge = (left: CollaborationMarkdownNode[], right: CollaborationMarkdownNode[]): void => {
    for (const node of right) {
      const last = left.at(-1)
      if (
        last &&
        node.type === 'element' &&
        last.type === 'element' &&
        node.tagName === last.tagName &&
        node.properties?.['data-pact-projection-start'] === undefined &&
        node.properties?.['data-pact-node-id'] !== undefined &&
        node.properties['data-pact-node-id'] === last.properties?.['data-pact-node-id']
      ) {
        last.children ??= []
        merge(last.children, node.children ?? [])
      } else left.push(copy(node))
    }
  }
  const children: CollaborationMarkdownNode[] = []
  for (const page of pages) merge(children, page.tree.children ?? [])
  return { type: 'root', children }
}

const copy = (node: CollaborationMarkdownNode): CollaborationMarkdownNode => ({
  ...node,
  properties: node.properties ? { ...node.properties } : undefined,
  children: node.children?.map(copy),
})

/** Display aliases never become counterfeit source selections; unchanged spans keep their exact offsets. */
export function readableCollaborationTree(
  tree: CollaborationMarkdownNode,
  context: CollaborationDisplayContext,
): CollaborationMarkdownNode {
  const fragments: Array<{ start: number; end: number; text: string }> = []
  const collect = (node: CollaborationMarkdownNode): void => {
    if (node.properties?.['data-pact-projection-start'] !== undefined) {
      const start = Number(node.properties['data-pact-projection-start'])
      const end = Number(node.properties['data-pact-projection-end'])
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        !node.children?.every((child) => child.type === 'text' && typeof child.value === 'string')
      )
        throw new Error('The document text source is unavailable.')
      const text = node.children.map((child) => child.value!).join('')
      if (start + text.length !== end || (fragments.length && fragments.at(-1)!.end !== start))
        throw new Error('The document text source is not contiguous.')
      fragments.push({ start, end, text })
      return
    }
    node.children?.forEach(collect)
  }
  collect(tree)
  const base = fragments[0]?.start ?? 0
  const edits = collaborationDisplayEdits(
    fragments.map((fragment) => fragment.text).join(''),
    context,
  ).map((edit) => ({ start: edit.start + base, end: edit.end + base, text: edit.text }))
  let editCursor = 0
  const display = (node: CollaborationMarkdownNode): CollaborationMarkdownNode => {
    const properties = node.properties ? { ...node.properties } : undefined
    for (const name of ['title', 'alt'])
      if (typeof properties?.[name] === 'string')
        properties[name] = readableCollaborationText(properties[name], context)
    if (properties?.['data-pact-projection-start'] !== undefined) {
      const start = Number(properties['data-pact-projection-start'])
      const end = Number(properties['data-pact-projection-end'])
      const original = node.children!.map((child) => child.value!).join('')
      while (edits[editCursor] && edits[editCursor]!.end <= start) editCursor++
      const parts: string[] = []
      let position = start
      for (let index = editCursor; edits[index] && edits[index]!.start < end; index++) {
        const edit = edits[index]!
        parts.push(original.slice(position - start, Math.max(start, edit.start) - start))
        if (edit.start >= start) parts.push(edit.text)
        position = Math.min(end, edit.end)
      }
      parts.push(original.slice(position - start))
      const value = parts.join('')
      if (value !== original) {
        // Alias labels are readable references, not the original characters at these offsets.
        // Whole-Todo Comment remains available; meaningful unchanged text keeps anchored Comment.
        delete properties['data-pact-projection-start']
        delete properties['data-pact-projection-end']
        return { ...node, properties, children: [{ type: 'text', value }] }
      }
    }
    return { ...node, properties, children: node.children?.map(display) }
  }
  return display(tree)
}
