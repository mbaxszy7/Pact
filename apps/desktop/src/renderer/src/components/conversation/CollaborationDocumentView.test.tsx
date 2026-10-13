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
