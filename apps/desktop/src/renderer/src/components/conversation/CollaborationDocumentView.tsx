import { ChevronLeft, ChevronRight } from 'lucide-react'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react'

import type {
  CollaborationDocument,
  CollaborationMarkdownNode,
  ConversationPage,
} from '@pact/contracts'

import type {
  DocumentSelectionAdapter,
  DocumentSelectionRange,
  MessageTextSelection,
} from './MessageSelectionSurface'

import {
  collaborationDisplayEdits,
  readableCollaborationText,
  type CollaborationDisplayContext,
} from '../../../../shared/collaboration-display-text'
import { MessageMarkdown, type ProjectFileTarget } from './MessageMarkdown'

type Page = Extract<ConversationPage, { scope: 'collaboration-markdown' }>

/** Plain-source cursors can overlap after an aroundOffset read. Keep each character once. */
function clipPlainPage(page: Page, start: number, end: number): Page {
  if (
    page.basis !== 'plain-visible-v1' ||
    start < page.visibleStart ||
    end > page.visibleEnd ||
    end <= start
  )
    throw new Error('Document pages are not contiguous.')
  const span = page.tree.children?.[0]
  const text = span?.children?.[0]?.value
  if (typeof text !== 'string' || text.length !== page.visibleEnd - page.visibleStart)
    throw new Error('The document source range is unavailable.')
  return {
    ...page,
    offset: start,
    visibleStart: start,
    visibleEnd: end,
    previousOffset: start ? Math.max(0, start - 8192) : null,
    nextOffset: end < page.visibleEnd ? end : page.nextOffset,
    tree: {
      type: 'root',
      children: [
        {
          ...span,
          type: 'element',
          properties: {
            ...span?.properties,
            'data-pact-projection-start': start,
            'data-pact-projection-end': end,
          },
          children: [
            { type: 'text', value: text.slice(start - page.visibleStart, end - page.visibleStart) },
          ],
        },
      ],
    },
  }
}

function extendProjectionWindow(pages: Page[], page: Page, direction: 'previous' | 'next'): Page[] {
  const edge = direction === 'previous' ? pages[0] : pages.at(-1)
  if (!edge) return [page]
  if (
    page.document.id !== edge.document.id ||
    page.document.sha256 !== edge.document.sha256 ||
    page.basis !== edge.basis
  )
    throw new Error('The document source changed.')
  if (page.basis === 'plain-visible-v1') {
    page =
      direction === 'previous'
        ? clipPlainPage(page, page.visibleStart, edge.visibleStart)
        : clipPlainPage(page, edge.visibleEnd, page.visibleEnd)
  }
  if (
    direction === 'previous'
      ? page.visibleEnd !== edge.visibleStart || page.nextOffset !== edge.offset
      : page.visibleStart !== edge.visibleEnd || edge.nextOffset !== page.offset
  )
    throw new Error('Document pages are not contiguous.')
  return direction === 'previous' ? [page, ...pages].slice(0, 3) : [...pages, page].slice(-3)
}

type ContinuousOptions = {
  viewport: RefObject<HTMLDivElement | null>
  reveal?: (DocumentSelectionRange & { id: string }) | undefined
  onRevealApplied?: ((id: string) => void) | undefined
}

type DocumentViewProps = Parameters<typeof PagedDocumentView>[0]

export function CollaborationDocumentView({
  continuous,
  ...props
}: DocumentViewProps & { continuous?: ContinuousOptions | undefined }): React.JSX.Element {
  return continuous ? (
    <ContinuousDocumentView {...props} {...continuous} />
  ) : (
    <PagedDocumentView {...props} />
  )
}

type WindowState = { key: string; revision: number; pages: Page[]; error?: string }
type ReadJob = { owner: object; run: () => Promise<void>; reject: (error: Error) => void }

// Lifetime exceeds mounted Plan panels: a closing panel cannot release an unsettled RPC.
const documentReads = { busy: false, desired: undefined as ReadJob | undefined }
async function drainDocumentReads(): Promise<void> {
  if (documentReads.busy) return
  documentReads.busy = true
  try {
    while (documentReads.desired) {
      const next = documentReads.desired
      documentReads.desired = undefined
      try {
        // oxlint-disable-next-line no-await-in-loop -- One physical document RPC slot.
        await next.run()
      } catch (error) {
        next.reject(error instanceof Error ? error : new Error('Document unavailable.'))
      }
    }
  } finally {
    documentReads.busy = false
  }
}
function cancelPendingRead(owner: object): void {
  if (documentReads.desired?.owner !== owner) return
  documentReads.desired.reject(new Error('Document request cancelled.'))
  documentReads.desired = undefined
}

/** The Plan's one physical read slot also verifies logical selections. */
function ContinuousDocumentView({
  sessionId,
  runId,
  source,
  messageId,
  basis,
  aroundOffset,
  viewport,
  reveal,
  onRevealApplied,
  onOpenProjectFile,
  onCreateComment,
  displayContext,
}: DocumentViewProps & ContinuousOptions): React.JSX.Element {
  const sourceKey = `${sessionId}:${runId}:${source.id}:${source.sha256}:${basis ?? ''}`
  const hostRef = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<WindowState>({ key: sourceKey, revision: 0, pages: [] })
  const failedMove = useRef<'previous' | 'next' | number | undefined>(undefined)
  const owner = useRef({
    active: true,
    key: sourceKey,

    state: state,
    revision: 0,
    commit: undefined as
      | { revision: number; resolve: () => void; anchor?: { offset: number; top: number } }
      | undefined,
  })
  const expectedScroll = useRef<number | undefined>(undefined)
  const scrollPosition = useRef(0)
  const scrollViewport = useCallback(
    (top: number): void => {
      const root = viewport.current
      if (!root) return
      root.scrollTop = top
      expectedScroll.current = root.scrollTop
      scrollPosition.current = root.scrollTop
    },
    [viewport],
  )
  useLayoutEffect(() => {
    const current = owner.current
    current.state = state
    const commit = current.commit
    if (commit && state.revision >= commit.revision) {
      const root = viewport.current
      const host = hostRef.current
      if (root && host && commit.anchor && state.revision === commit.revision) {
        const span = [...host.querySelectorAll<HTMLElement>('[data-pact-projection-start]')].find(
          (entry) =>
            Number(entry.dataset.pactProjectionStart) <= commit.anchor!.offset &&
            Number(entry.dataset.pactProjectionEnd) > commit.anchor!.offset,
        )
        if (span)
          scrollViewport(root.scrollTop + span.getBoundingClientRect().top - commit.anchor.top)
      }
      current.commit = undefined
      commit.resolve()
    }
  }, [state, viewport, scrollViewport])
  useEffect(() => {
    const current = owner.current
    current.active = true
    return () => {
      current.active = false
      cancelPendingRead(current)
      current.commit?.resolve()
      current.commit = undefined
    }
  }, [])

  // One replaceable intent. An obsolete RPC retains its physical slot until it settles.
  const schedule = (operation: () => Promise<void>, signal?: AbortSignal): Promise<void> => {
    const current = owner.current
    return new Promise<void>((resolve, reject) => {
      documentReads.desired?.reject(new Error('Document request replaced.'))
      const requestedKey = sourceKey
      const job: ReadJob = {
        owner: current,
        reject,
        run: async () => {
          if (!current.active || current.key !== requestedKey || signal?.aborted)
            throw new Error('Document request cancelled.')
          await operation()
          if (!current.active || current.key !== requestedKey || signal?.aborted)
            throw new Error('Document request cancelled.')
          resolve()
        },
      }
      documentReads.desired = job
      void drainDocumentReads()
    })
  }
  const checkCurrent = (signal?: AbortSignal): void => {
    if (!owner.current.active || owner.current.key !== sourceKey || signal?.aborted)
      throw new Error('Document request cancelled.')
  }
  const readPage = async (offset: number, around?: number, signal?: AbortSignal): Promise<Page> => {
    checkCurrent(signal)
    const reply = await window.pact.getConversation({
      scope: 'collaboration-markdown',
      sessionId,
      runId,
      document: source,
      offset,
      ...(basis ? { basis } : {}),
      ...(around !== undefined ? { aroundOffset: around } : {}),
    })
    checkCurrent(signal)
    if (!reply.ok || reply.value.scope !== 'collaboration-markdown')
      throw new Error(reply.ok ? 'Document unavailable.' : reply.error.message)
    const page = reply.value
    if (
      page.sessionId !== sessionId ||
      page.document.id !== source.id ||
      page.document.sha256 !== source.sha256
    )
      throw new Error('The document source changed.')
    return page
  }
  const commit = async (pages: Page[], preserve: boolean, signal?: AbortSignal): Promise<void> => {
    checkCurrent(signal)
    const current = owner.current
    const root = viewport.current
    const host = hostRef.current
    const rootTop = root?.getBoundingClientRect().top ?? 0
    const retainedStart = pages[0]?.visibleStart ?? 0
    const retainedEnd = pages.at(-1)?.visibleEnd ?? 0
    const span =
      preserve && host
        ? [...host.querySelectorAll<HTMLElement>('[data-pact-projection-start]')].find((entry) => {
            const start = Number(entry.dataset.pactProjectionStart)
            return (
              start >= retainedStart &&
              start < retainedEnd &&
              entry.getBoundingClientRect().bottom >= rootTop
            )
          })
        : undefined
    const anchor = span
      ? { offset: Number(span.dataset.pactProjectionStart), top: span.getBoundingClientRect().top }
      : undefined
    const revision = ++current.revision
    await new Promise<void>((resolve) => {
      current.commit = { revision, resolve, ...(anchor ? { anchor } : {}) }
      setState({ key: sourceKey, revision, pages })
    })
    checkCurrent(signal)
  }
  const loadWindow = async (around?: number, signal?: AbortSignal): Promise<void> => {
    let page = await readPage(0, around, signal)
    const pages = [page]
    for (let index = 1; index < 3 && page.nextOffset !== null; index++) {
      // oxlint-disable-next-line no-await-in-loop -- The prior cursor is authoritative.
      page = await readPage(page.nextOffset, undefined, signal)
      pages.push(page)
    }
    await commit(pages, false, signal)
  }
  const moveViewport: DocumentSelectionAdapter['moveViewport'] = async (target, signal) => {
    try {
      await schedule(async () => {
        if (typeof target === 'number') {
          const pages = owner.current.state.pages
          if (pages.some((page) => page.visibleStart <= target && page.visibleEnd > target)) return
          await loadWindow(target, signal)
          return
        }
        const pages = owner.current.state.pages
        const edge = target === 'previous' ? pages[0] : pages.at(-1)
        const offset = target === 'previous' ? edge?.previousOffset : edge?.nextOffset
        if (offset === null || offset === undefined) return
        const page = await readPage(offset, undefined, signal)
        await commit(extendProjectionWindow(pages, page, target), true, signal)
      }, signal)
      failedMove.current = undefined
    } catch (error) {
      if (!signal.aborted && owner.current.active && owner.current.key === sourceKey) {
        failedMove.current = target
        setState((old) => ({
          ...old,
          error: error instanceof Error ? error.message : 'Document unavailable.',
        }))
      }
      throw error
    }
  }
  const resolveRange: DocumentSelectionAdapter['resolveRange'] = async (range, signal) => {
    let quote = ''
    await schedule(async () => {
      const selectedBasis = owner.current.state.pages[0]?.basis
      if (
        !selectedBasis ||
        range.endOffset <= range.startOffset ||
        range.endOffset - range.startOffset > 20_000
      )
        throw new Error('The selected source range is unavailable.')
      for (let offset = range.startOffset; offset < range.endOffset;) {
        checkCurrent(signal)
        // oxlint-disable-next-line no-await-in-loop -- Verify consecutive quote fragments in the shared read slot.
        const reply = await window.pact.getConversation({
          scope: 'collaboration-quote',
          sessionId,
          runId,
          document: source,
          basis: selectedBasis,
          ...range,
          offset,
        })
        checkCurrent(signal)
        if (!reply.ok || reply.value.scope !== 'collaboration-quote')
          throw new Error(reply.ok ? 'The selection could not be verified.' : reply.error.message)
        const value = reply.value
        if (
          value.document.id !== source.id ||
          value.document.sha256 !== source.sha256 ||
          value.sessionId !== sessionId ||
          value.basis !== selectedBasis ||
          value.offset !== offset ||
          value.startOffset !== range.startOffset ||
          value.endOffset !== range.endOffset ||
          !value.text.length ||
          offset + value.text.length > range.endOffset
        )
          throw new Error('The selection source changed.')
        quote += value.text
        offset += value.text.length
        if (value.nextOffset !== (offset < range.endOffset ? offset : null))
          throw new Error('The selection source is incomplete.')
      }
    }, signal)
    return quote
  }
  useEffect(() => {
    const current = owner.current
    current.key = sourceKey
    failedMove.current = undefined
    cancelPendingRead(current)
    const controller = new AbortController()
    setState({ key: sourceKey, revision: ++current.revision, pages: [] })
    void schedule(() => loadWindow(aroundOffset, controller.signal), controller.signal).catch(
      (error: unknown) => {
        if (controller.signal.aborted || current.key !== sourceKey) return
        setState((old) => ({
          ...old,
          error: error instanceof Error ? error.message : 'Document unavailable.',
        }))
      },
    )
    return () => {
      controller.abort()
    }
    // Immutable source identity owns this lifecycle; navigation is handled by the selection surface.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey])

  const [retry, setRetry] = useState(0)
  useEffect(() => {
    if (!retry) return undefined
    const controller = new AbortController()
    const pending =
      failedMove.current === undefined
        ? schedule(() => loadWindow(aroundOffset, controller.signal), controller.signal)
        : moveViewport(failedMove.current, controller.signal)
    void pending.catch((error: unknown) => {
      if (!controller.signal.aborted) setState((old) => ({ ...old, error: String(error) }))
    })
    return () => controller.abort()
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [retry])
  const movement = useRef(moveViewport)
  useLayoutEffect(() => {
    movement.current = moveViewport
  })
  useEffect(() => {
    const root = viewport.current
    if (!root) return undefined
    const controller = new AbortController()
    let touchY: number | undefined
    let pending = false
    const request = (direction: 'previous' | 'next'): void => {
      if (
        pending ||
        failedMove.current !== undefined ||
        owner.current.state.key !== sourceKey ||
        !owner.current.state.pages.length
      )
        return
      if (
        direction === 'next'
          ? root.scrollHeight - root.scrollTop - root.clientHeight > 160
          : root.scrollTop > 160
      )
        return
      pending = true
      void movement
        .current(direction, controller.signal)
        .catch((error: unknown) => {
          if (!controller.signal.aborted)
            setState((old) => ({
              ...old,
              error: error instanceof Error ? error.message : 'Document unavailable.',
            }))
        })
        .finally(() => {
          pending = false
        })
    }
    const wheel = (event: WheelEvent): void => {
      if (event.deltaY) request(event.deltaY > 0 ? 'next' : 'previous')
    }
    const touchStart = (event: TouchEvent): void => {
      touchY = event.touches[0]?.clientY
    }
    const touchMove = (event: TouchEvent): void => {
      const y = event.touches[0]?.clientY
      if (y !== undefined && touchY !== undefined && y !== touchY)
        request(y < touchY ? 'next' : 'previous')
      touchY = y
    }
    const key = (event: KeyboardEvent): void => {
      if (event.shiftKey || event.defaultPrevented) return
      if (['ArrowDown', 'PageDown', 'End'].includes(event.key)) request('next')
      if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) request('previous')
    }
    scrollPosition.current = root.scrollTop
    const scroll = (): void => {
      const top = root.scrollTop
      const previous = scrollPosition.current
      scrollPosition.current = top
      if (expectedScroll.current === top) {
        expectedScroll.current = undefined
        return
      }
      expectedScroll.current = undefined
      if (top !== previous) request(top > previous ? 'next' : 'previous')
    }
    root.addEventListener('scroll', scroll, { passive: true })
    root.addEventListener('wheel', wheel, { passive: true })
    root.addEventListener('touchstart', touchStart, { passive: true })
    root.addEventListener('touchmove', touchMove, { passive: true })
    root.addEventListener('keydown', key)
    return () => {
      controller.abort()
      root.removeEventListener('scroll', scroll)
      root.removeEventListener('wheel', wheel)
      root.removeEventListener('touchstart', touchStart)
      root.removeEventListener('touchmove', touchMove)
      root.removeEventListener('keydown', key)
    }
  }, [viewport, sourceKey])
  const pages = useMemo(
    () => (state.key === sourceKey ? state.pages : []),
    [state.key, state.pages, sourceKey],
  )
  const tree = useMemo(() => mergeProjectionPages(pages), [pages])
  const readable = useMemo(() => {
    try {
      return {
        tree: readableCollaborationTree(
          tree,
          { ...displayContext, runId, documentId: source.id, documentHash: source.sha256 },
          true,
        ),
      }
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Document unavailable.' }
    }
  }, [tree, displayContext, runId, source.id, source.sha256])
  return (
    <div
      ref={hostRef}
      className={pages[0]?.basis === 'plain-visible-v1' ? 'whitespace-pre-wrap' : undefined}
    >
      {pages[0]?.basis === 'plain-visible-v1' ? (
        <p className="mb-group whitespace-normal text-caption text-secondary">
          Formatting unavailable; full text is shown.
        </p>
      ) : null}
      {!pages.length && !state.error ? (
        <p aria-busy="true" className="text-caption text-secondary">
          Loading…
        </p>
      ) : null}
      {pages.length && readable.tree ? (
        <MessageMarkdown
          content=""
          tree={readable.tree}
          messageId={messageId}
          onOpenProjectFile={onOpenProjectFile}
          documentSelection={{
            sourceKey,
            windowRevision: state.revision,
            viewport,
            reveal,
            onRevealApplied,
            resolveRange,
            moveViewport,
            scrollViewport,
          }}
          onCreateComment={
            onCreateComment
              ? (selection) =>
                  onCreateComment({
                    ...selection,
                    contentHash: source.sha256,
                    textBasis: pages[0]!.basis,
                  })
              : undefined
          }
        />
      ) : null}
      {state.error || readable.error ? (
        <div role="alert" className="mt-group text-caption text-secondary">
          <p>{state.error ?? readable.error}</p>
          <button
            type="button"
            className="mt-2 underline"
            onClick={() => setRetry((value) => value + 1)}
          >
            Try again
          </button>
        </div>
      ) : null}
    </div>
  )
}

/** One document read, at most three interpreted pages; stale reads never replace a new source. */
function PagedDocumentView({
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
  splitAliases = false,
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
        if (splitAliases) {
          properties['data-pact-fragment-start'] = start
          properties['data-pact-fragment-end'] = end
          const children: CollaborationMarkdownNode[] = []
          let cursor = start
          const segment = (from: number, to: number, text: string, alias: boolean): void => {
            if (to <= from) return
            children.push({
              type: 'element',
              tagName: 'span',
              properties: alias
                ? { 'data-pact-source-start': from, 'data-pact-source-end': to }
                : { 'data-pact-projection-start': from, 'data-pact-projection-end': to },
              children: [{ type: 'text', value: text }],
            })
          }
          for (let index = editCursor; edits[index] && edits[index]!.start < end; index++) {
            const edit = edits[index]!
            const from = Math.max(start, edit.start)
            segment(cursor, from, original.slice(cursor - start, from - start), false)
            const to = Math.min(end, edit.end)
            segment(from, to, edit.start >= start ? edit.text : '', true)
            cursor = to
          }
          segment(cursor, end, original.slice(cursor - start), false)
          return { ...node, properties, children }
        }
        return { ...node, properties, children: [{ type: 'text', value }] }
      }
    }
    return { ...node, properties, children: node.children?.map(display) }
  }
  return display(tree)
}
