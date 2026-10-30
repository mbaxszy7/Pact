// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { CollaborationDocument, ConversationPage, DesktopBridge } from '@pact/contracts'

import { markdownProjectionPages } from '../../../../shared/message-anchor-text'
import { CollaborationDocumentView } from './CollaborationDocumentView'
import { focusProjectionRange, selectedTextRange } from './message-selection'

type Page = Extract<ConversationPage, { scope: 'collaboration-markdown' }>
type Request = Parameters<DesktopBridge['getConversation']>[0]

beforeEach(() => {
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => new DOMRect(0, 0, 80, 20),
  })
  Object.defineProperty(Range.prototype, 'getClientRects', {
    configurable: true,
    value: () => [new DOMRect(0, 0, 80, 20)],
  })
})
afterEach(() => {
  cleanup()
  window.getSelection()?.removeAllRanges()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  Reflect.deleteProperty(document, 'caretRangeFromPoint')
})

it.each(['markdown-visible-v2', 'plain-visible-v1'] as const)(
  'keeps second/third segment and cross-segment Comments exact in %s',
  async (basis) => {
    const text = '0123456789'.repeat(2100)
    const fixture = documentFixture(text, basis)
    const onCreateComment = vi.fn<(selection: unknown) => void>()
    const { container } = render(
      <CollaborationDocumentView {...fixture.props} onCreateComment={onCreateComment} />,
    )
    await waitFor(() => expect(projectionSpans(container)).toHaveLength(3))
    expect(fixture.read).toHaveBeenCalledTimes(3)
    expect(container.querySelectorAll('code')).toHaveLength(basis === 'markdown-visible-v2' ? 1 : 0)
    for (const span of projectionSpans(container)) {
      expect(span.childNodes).toHaveLength(1)
      expect(span.firstChild).toBeInstanceOf(Text)
    }
    const host = container.querySelector<HTMLElement>('[data-pact-message-content]')!
    for (const [start, end] of [
      [4100, 4114],
      [8200, 8214],
      [4090, 4104],
    ] as const) {
      expect(focusProjectionRange(host, start, end, { scroll: false, highlight: false })).toBe(true)
      expect(selectedTextRange(host, window.getSelection()!)).toEqual({
        startOffset: start,
        endOffset: end,
        quote: text.slice(start, end),
      })
    }
    fireEvent.keyUp(host)
    fireEvent.click(screen.getByRole('button', { name: 'Comment on selected text' }))
    expect(onCreateComment).toHaveBeenCalledWith({
      messageId: fixture.props.messageId,
      startOffset: 4090,
      endOffset: 4104,
      quote: text.slice(4090, 4104),
      contentHash: fixture.props.source.sha256,
      textBasis: basis,
    })

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await waitFor(() =>
      expect(projectionSpans(container)[0]?.dataset.pactProjectionStart).toBe('12288'),
    )
    expect(projectionSpans(container)).toHaveLength(3)
    expect(host.isConnected).toBe(false)
    expect(
      fixture.read.mock.calls.slice(3).every(([request]) => !('aroundOffset' in request)),
    ).toBe(true)
    const nextHost = container.querySelector<HTMLElement>('[data-pact-message-content]')!
    expect(focusProjectionRange(nextHost, 16400, 16414, { scroll: false })).toBe(true)
    expect(window.getSelection()?.toString()).toBe(text.slice(16400, 16414))
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }))
    await waitFor(() =>
      expect(projectionSpans(container)[0]?.dataset.pactProjectionStart).toBe('0'),
    )
  },
)

it('uses a reverse-navigation offset only for the initial read, then follows returned pages', async () => {
  const fixture = documentFixture('abcdef'.repeat(6000))
  const { container } = render(<CollaborationDocumentView {...fixture.props} aroundOffset={9000} />)
  await waitFor(() =>
    expect(projectionSpans(container)[0]?.dataset.pactProjectionStart).toBe('8192'),
  )
  expect(fixture.read.mock.calls.filter(([request]) => 'aroundOffset' in request)).toHaveLength(1)
  expect(projectionSpans(container)).toHaveLength(3)
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  await waitFor(() =>
    expect(projectionSpans(container)[0]?.dataset.pactProjectionStart).toBe('20480'),
  )
  expect(fixture.read.mock.calls.filter(([request]) => 'aroundOffset' in request)).toHaveLength(1)
})

it('ignores a completed read for an evicted document source', async () => {
  const old = documentFixture('Old document')
  const next = documentFixture('New document')
  let finish!: (value: Awaited<ReturnType<DesktopBridge['getConversation']>>) => void
  const pending = new Promise<Awaited<ReturnType<DesktopBridge['getConversation']>>>((resolve) => {
    finish = resolve
  })
  const read = vi.fn<DesktopBridge['getConversation']>().mockImplementation(async (request) => {
    if (request.scope === 'collaboration-markdown' && request.document.id === old.props.source.id)
      return pending
    return next.read(request)
  })
  vi.stubGlobal('pact', { getConversation: read })
  const view = render(<CollaborationDocumentView {...old.props} />)
  await waitFor(() => expect(read).toHaveBeenCalledTimes(1))
  view.rerender(<CollaborationDocumentView {...next.props} />)
  await screen.findByText('New document')
  await act(async () => finish({ ok: true, value: old.pages[0]! }))
  expect(screen.queryByText('Old document')).toBeNull()
  expect(screen.getByText('New document')).toBeDefined()
})

it.each([
  { edge: 'top', y: 131, start: 0, end: 33 },
  { edge: 'bottom', y: 499, start: 45, end: 78 },
])('keeps the exact caret inside the $edge auto-scroll band', async ({ y, start, end }) => {
  const harness = continuousFixture('0123456789'.repeat(100))
  await harness.ready()
  harness.down(start, y)
  harness.move(end, y)
  await harness.frame()
  harness.up()
  fireEvent.click(await screen.findByRole('button', { name: 'Comment on selected text' }))
  expect(harness.comment).toHaveBeenCalledWith(
    expect.objectContaining({
      startOffset: start,
      endOffset: end,
      quote: harness.text.slice(start, end),
    }),
  )
  harness.dispose()
})

it.each([
  { edge: 'top boundary', y: 129, start: 78, caret: 45, expectedStart: 0, expectedEnd: 78 },
  { edge: 'below viewport', y: 510, start: 45, caret: 78, expectedStart: 45, expectedEnd: 1000 },
])(
  'retains resident-edge snapping at the $edge',
  async ({ y, start, caret, expectedStart, expectedEnd }) => {
    const harness = continuousFixture('0123456789'.repeat(100))
    await harness.ready()
    harness.down(start, 300)
    harness.move(caret, y)
    await harness.frame()
    harness.up()
    fireEvent.click(await screen.findByRole('button', { name: 'Comment on selected text' }))
    expect(harness.comment).toHaveBeenCalledWith(
      expect.objectContaining({
        startOffset: expectedStart,
        endOffset: expectedEnd,
        quote: harness.text.slice(expectedStart, expectedEnd),
      }),
    )
    harness.dispose()
  },
)

it.each(['next', 'previous'] as const)(
  'keeps an exact four-page Comment after real %s page eviction',
  async (direction) => {
    const forward = direction === 'next'
    const harness = continuousFixture('0123456789'.repeat(1900), forward ? 0 : 8192)
    await harness.ready()
    const initial = projectionSpans(harness.root)
    const evicted = forward ? initial[0]! : initial.at(-1)!
    const start = forward ? 100 : 16484
    const end = forward ? 16484 : 100
    harness.down(start, 300)
    // Outside the viewport must still cover the resident edge before its page is evicted.
    harness.move(forward ? 12000 : 8300, forward ? 510 : 120)
    await harness.frame()
    await waitFor(() =>
      expect(projectionSpans(harness.root)[0]?.dataset.pactProjectionStart).toBe('4096'),
    )
    expect(evicted.isConnected).toBe(false)
    expect(projectionSpans(harness.root)).toHaveLength(3)
    harness.move(forward ? 16000 : 4200, forward ? 510 : 120)
    await harness.frame()
    await waitFor(() =>
      expect(projectionSpans(harness.root)[0]?.dataset.pactProjectionStart).toBe(
        forward ? '8192' : '0',
      ),
    )
    expect(projectionSpans(harness.root)).toHaveLength(3)
    harness.move(end, 300)
    await harness.frame()
    harness.up()
    fireEvent.click(await screen.findByRole('button', { name: 'Comment on selected text' }))
    expect(harness.comment).toHaveBeenCalledWith(
      expect.objectContaining({
        startOffset: 100,
        endOffset: 16484,
        quote: harness.text.slice(100, 16484),
      }),
    )
    expect(harness.peakReads()).toBe(1)
    expect(
      harness.fixture.read.mock.calls.filter(
        ([request]) => request.scope === 'collaboration-quote',
      ),
    ).toHaveLength(4)
    harness.dispose()
  },
)

const pointer = (target: Element | Document, type: string, y: number) => {
  fireEvent(target, new MouseEvent(type, { bubbles: true, button: 0, clientX: 100, clientY: y }))
}

function continuousFixture(text: string, aroundOffset = 0) {
  const fixture = documentFixture(text)
  const root = document.createElement('div')
  document.body.append(root)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(0, 129, 900, 372),
  )
  Object.defineProperty(root, 'clientHeight', { value: 372 })
  Object.defineProperty(root, 'scrollHeight', { value: 372 })
  // Model a viewport at either scroll boundary; actual projection/window movement remains real.
  Object.defineProperty(root, 'scrollTop', { get: () => 0, set: () => undefined })
  const frames = new Map<number, FrameRequestCallback>()
  let nextFrame = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback)
    return nextFrame
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  let offset = 0
  Object.defineProperty(document, 'caretRangeFromPoint', {
    configurable: true,
    value: () => {
      const span = projectionSpans(root).find(
        (entry) =>
          Number(entry.dataset.pactProjectionStart) <= offset &&
          Number(entry.dataset.pactProjectionEnd) >= offset,
      )
      if (!span?.firstChild) return null
      const range = document.createRange()
      range.setStart(span.firstChild, offset - Number(span.dataset.pactProjectionStart))
      range.collapse(true)
      return range
    },
  })
  let active = 0,
    peak = 0
  vi.stubGlobal('pact', {
    getConversation: async (request: Request) => {
      active++
      peak = Math.max(peak, active)
      try {
        return await fixture.read(request)
      } finally {
        active--
      }
    },
  })
  const comment = vi.fn<(selection: unknown) => void>()
  const view = render(
    <CollaborationDocumentView
      {...fixture.props}
      aroundOffset={aroundOffset}
      continuous={{ viewport: { current: root } }}
      onCreateComment={comment}
    />,
    { container: root },
  )
  return {
    text,
    fixture,
    root,
    comment,
    peakReads: () => peak,
    ready: () =>
      waitFor(() => expect(projectionSpans(root)).toHaveLength(Math.min(3, fixture.pages.length))),
    down: (value: number, y: number) => {
      offset = value
      pointer(screen.getByRole('textbox', { name: 'Plan text' }), 'pointerdown', y)
    },
    move: (value: number, y: number) => {
      offset = value
      pointer(document, 'pointermove', y)
    },
    up: () => pointer(document, 'pointerup', 300),
    frame: async () => {
      await act(async () => {
        const pending = [...frames.values()]
        frames.clear()
        pending.forEach((callback) => callback(0))
      })
    },
    dispose: () => {
      view.unmount()
      root.remove()
      Reflect.deleteProperty(document, 'caretRangeFromPoint')
    },
  }
}

function projectionSpans(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>('[data-pact-projection-start]')]
}

function documentFixture(text: string, basis: Page['basis'] = 'markdown-visible-v2') {
  const sessionId = crypto.randomUUID()
  const runId = crypto.randomUUID()
  const source: CollaborationDocument = {
    id: crypto.randomUUID(),
    sha256: 'a'.repeat(64),
    bytes: text.length,
    chars: text.length,
  }
  const projected =
    basis === 'markdown-visible-v2'
      ? [...markdownProjectionPages(text.length > 4096 ? `\`\`\`txt\n${text}\n\`\`\`` : text)]
      : Array.from({ length: Math.ceil(text.length / 4096) }, (_, ordinal) => {
          const visibleStart = ordinal * 4096
          const visibleText = text.slice(visibleStart, visibleStart + 4096)
          const visibleEnd = visibleStart + visibleText.length
          return {
            ordinal,
            visibleStart,
            visibleEnd,
            visibleText,
            tree: {
              type: 'root' as const,
              children: [
                {
                  type: 'element' as const,
                  tagName: 'span' as const,
                  properties: {
                    'data-pact-node-id': 0,
                    'data-pact-projection-start': visibleStart,
                    'data-pact-projection-end': visibleEnd,
                  },
                  children: [{ type: 'text' as const, value: visibleText }],
                },
              ],
            },
          }
        })
  const pages: Page[] = projected.map((page, index) => ({
    scope: 'collaboration-markdown',
    sessionId,
    document: source,
    basis,
    visibleStart: page.visibleStart,
    visibleEnd: page.visibleEnd,
    tree: page.tree,
    offset: basis === 'plain-visible-v1' ? page.visibleStart : index,
    previousOffset: index
      ? basis === 'plain-visible-v1'
        ? pagesOffset(index - 1)
        : index - 1
      : null,
    nextOffset:
      index + 1 < projected.length
        ? basis === 'plain-visible-v1'
          ? pagesOffset(index + 1)
          : index + 1
        : null,
  }))
  const read = vi.fn<DesktopBridge['getConversation']>(async (request: Request) => {
    if (request.scope === 'collaboration-quote') {
      const end = Math.min(request.endOffset, request.offset + 4096)
      return {
        ok: true,
        value: {
          ...request,
          text: text.slice(request.offset, end),
          nextOffset: end < request.endOffset ? end : null,
        },
      }
    }
    if (request.scope !== 'collaboration-markdown') throw new Error(`Unexpected ${request.scope}`)
    const index =
      request.aroundOffset !== undefined
        ? projected.findIndex((page) => page.visibleEnd > request.aroundOffset!)
        : basis === 'plain-visible-v1'
          ? request.offset / 4096
          : request.offset
    return { ok: true, value: pages[index]! }
  })
  vi.stubGlobal('pact', { getConversation: read })
  return {
    props: {
      sessionId,
      runId,
      source,
      messageId: crypto.randomUUID(),
      onOpenProjectFile: vi.fn<() => void>(),
    },
    read,
    pages,
  }
}

const pagesOffset = (index: number) => index * 4096
