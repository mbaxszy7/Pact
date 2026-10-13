// @vitest-environment jsdom

import type { ComponentProps } from 'react'

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { CollaborationTodo, ConversationPage, DesktopBridge } from '@pact/contracts'

import { collaborationFixture, todoFixture } from './collaboration.test-helper'
import { CollaborationTodos, type CollaborationTodoDetail } from './CollaborationTodos'

type Props = ComponentProps<typeof CollaborationTodos>
type ReadResponse = Awaited<ReturnType<DesktopBridge['getConversation']>>
const hosts: HTMLElement[] = []

beforeEach(() => {
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn<() => void>(),
  })
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
  hosts.splice(0).forEach((host) => host.remove())
  window.getSelection()?.removeAllRanges()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it.each(['sidebar-title', 'source-navigation'] as const)(
  'finishes %s positioning only when the actual asynchronous document has increased the scroll range',
  async (entry) => {
    const f = fixture()
    const target = f.items[2]!
    const detail = deferred<CollaborationTodoDetail | undefined>()
    const markdown = deferred<ReadResponse>()
    f.props.onReadDetail.mockReturnValue(detail.promise)
    f.read.mockReturnValue(markdown.promise)
    if (entry === 'source-navigation')
      f.props.reveal = { todoId: target.id, revision: target.revision, navigationId: 'first' }
    const layout = mount(f.props)
    const button = toggle(target)
    if (entry === 'sidebar-title') fireEvent.click(button)
    await waitFor(() => expect(f.props.onReadDetail).toHaveBeenCalledOnce())
    expect(button.getAttribute('aria-expanded')).toBe('true')
    // A browser clamps the first scroll while only the short loading placeholder exists.
    expect(layout.host.scrollTop).toBe(layout.host.scrollHeight - layout.host.clientHeight)
    expect(layout.offset(target)).toBeGreaterThan(0)
    await act(async () => detail.resolve(detailFor(target)))
    await waitFor(() => expect(f.read).toHaveBeenCalledOnce())
    expect(layout.offset(target)).toBeGreaterThan(0)
    await act(async () =>
      markdown.resolve(documentResponse(target, 'The third issue details.', f.props.sessionId)),
    )
    await screen.findByText('The third issue details.')
    expect(layout.offset(target)).toBe(0)
    expect(document.activeElement).toBe(button)
    expect(f.props.onReadDetail).toHaveBeenCalledWith(target)
    expect(f.read).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'collaboration-markdown', document: target.document }),
    )
  },
)

it('positions the same row after closing and reopening it, and leaves a user scroll unchanged on refresh', async () => {
  const f = fixture()
  const target = f.items[2]!
  const layout = mount(f.props)
  fireEvent.click(toggle(target))
  await screen.findByText(`Details for ${target.title}.`)
  expect(layout.offset(target)).toBe(0)
  layout.host.scrollTop = 90
  const calls = layout.scroll.mock.calls.length
  layout.view.rerender(
    <CollaborationTodos
      {...f.props}
      items={f.items.map((item) => Object.assign({}, item))}
      ledgerRevision={2}
    />,
  )
  await waitFor(() => expect(f.props.onReadDetail).toHaveBeenCalledTimes(2))
  expect(layout.host.scrollTop).toBe(90)
  expect(layout.scroll).toHaveBeenCalledTimes(calls)
  fireEvent.click(toggle(target))
  expect(toggle(target).getAttribute('aria-expanded')).toBe('false')
  fireEvent.click(toggle(target))
  await screen.findByText(`Details for ${target.title}.`)
  expect(layout.offset(target)).toBe(0)
})

it('applies each source navigation once even when the same Todo version is clicked again', async () => {
  const f = fixture()
  const target = f.items[2]!
  f.props.reveal = { todoId: target.id, revision: target.revision, navigationId: 'first' }
  const layout = mount(f.props)
  await screen.findByText(`Details for ${target.title}.`)
  expect(layout.offset(target)).toBe(0)
  layout.host.scrollTop = 90
  layout.view.rerender(
    <CollaborationTodos {...f.props} reveal={{ ...f.props.reveal, navigationId: 'second' }} />,
  )
  expect(layout.offset(target)).toBe(0)
  layout.host.scrollTop = 90
  const calls = layout.scroll.mock.calls.length
  layout.view.rerender(
    <CollaborationTodos
      {...f.props}
      items={f.items.map((item) => Object.assign({}, item))}
      reveal={{ ...f.props.reveal, navigationId: 'second' }}
    />,
  )
  await waitFor(() => expect(f.props.onReadDetail).toHaveBeenCalledTimes(2))
  expect(layout.host.scrollTop).toBe(90)
  expect(layout.scroll).toHaveBeenCalledTimes(calls)
})

it('ignores an old metadata read after a quick title switch and reveals only the latest requested row', async () => {
  const f = fixture()
  const old = f.items[1]!
  const target = f.items[2]!
  const oldRead = deferred<CollaborationTodoDetail | undefined>()
  const nextRead = deferred<CollaborationTodoDetail | undefined>()
  f.props.onReadDetail.mockImplementation((todo) =>
    todo.id === old.id ? oldRead.promise : nextRead.promise,
  )
  const layout = mount(f.props)
  fireEvent.click(toggle(old))
  fireEvent.click(toggle(target))
  expect(f.props.onReadDetail).toHaveBeenCalledOnce()
  await act(async () => oldRead.resolve(detailFor(old)))
  await waitFor(() => expect(f.props.onReadDetail).toHaveBeenCalledTimes(2))
  expect(f.read).not.toHaveBeenCalled()
  expect(toggle(old).getAttribute('aria-expanded')).toBe('false')
  expect(toggle(target).getAttribute('aria-expanded')).toBe('true')
  await act(async () => nextRead.resolve(detailFor(target)))
  await screen.findByText(`Details for ${target.title}.`)
  expect(screen.queryByText(`Details for ${old.title}.`)).toBeNull()
  expect(layout.offset(target)).toBe(0)
})

it('does not let an old Markdown response or an already-applied source navigation steal a local selection', async () => {
  const f = fixture()
  const old = f.items[1]!
  const target = f.items[2]!
  const oldDocument = deferred<ReadResponse>()
  f.read.mockImplementation(async (request) => {
    if (request.scope !== 'collaboration-markdown') throw new Error(`Unexpected ${request.scope}`)
    return request.document.id === old.document.id
      ? oldDocument.promise
      : documentResponse(target, 'Latest requested details.', f.props.sessionId)
  })
  f.props.reveal = { todoId: old.id, revision: old.revision, navigationId: 'old-source' }
  const layout = mount(f.props)
  await waitFor(() => expect(f.read).toHaveBeenCalledOnce())
  fireEvent.click(toggle(target))
  await screen.findByText('Latest requested details.')
  const calls = layout.scroll.mock.calls.length
  await act(async () =>
    oldDocument.resolve(documentResponse(old, 'Obsolete details.', f.props.sessionId)),
  )
  expect(screen.queryByText('Obsolete details.')).toBeNull()
  expect(layout.offset(target)).toBe(0)
  expect(layout.scroll).toHaveBeenCalledTimes(calls)
  layout.view.rerender(
    <CollaborationTodos {...f.props} items={f.items.map((item) => Object.assign({}, item))} />,
  )
  expect(toggle(target).getAttribute('aria-expanded')).toBe('true')
  expect(toggle(old).getAttribute('aria-expanded')).toBe('false')
})

it('distinguishes the historical recorded status from the current head and navigates its exact document', async () => {
  const f = fixture()
  const current = { ...f.items[0]!, revision: 3, status: 'done' as const }
  const historical = {
    ...current,
    revision: 1,
    status: 'open' as const,
    sourceRunId: crypto.randomUUID(),
    sourceMessageId: crypto.randomUUID(),
    document: { ...current.document, id: crypto.randomUUID(), sha256: 'c'.repeat(64) },
  }
  f.read.mockImplementation(async (request) => {
    if (request.scope !== 'collaboration-markdown') throw new Error(`Unexpected ${request.scope}`)
    if (request.document.id !== historical.document.id) throw new Error('Expected the v1 source')
    return documentResponse(historical, 'The original v1 evidence.', f.props.sessionId)
  })
  f.items[0] = current
  f.props.items = f.items
  f.props.sourceTodo = historical
  f.props.sourceCurrent = { revision: 3, status: 'done' }
  f.props.showDone = true
  f.props.activeCount = 2
  f.props.doneCount = 1
  f.props.reveal = { todoId: historical.id, revision: 1, navigationId: 'history' }
  mount(f.props)
  expect(screen.getByText('Historical version · v1 · Then: Open')).toBeDefined()
  expect(screen.getByText('Current status: Done · v3')).toBeDefined()
  expect(screen.queryByText('Current status unavailable.')).toBeNull()
  await screen.findByText('The original v1 evidence.')
  expect(f.props.onReadDetail).toHaveBeenCalledWith(historical)
  expect(f.read).toHaveBeenCalledWith(
    expect.objectContaining({ runId: historical.sourceRunId, document: historical.document }),
  )
  const sourceRow = row(historical)
  expect(within(sourceRow).queryByRole('button', { name: 'Add your answer' })).toBeNull()
  expect(within(sourceRow).getByRole('button', { name: 'Comment on Todo' })).toBeDefined()
  expect(toggle(current).getAttribute('aria-expanded')).toBe('false')
})

it('keeps the active Comment editor focused when late document readiness finishes a title reveal', async () => {
  const f = fixture()
  const target = f.items[2]!
  const markdown = deferred<ReadResponse>()
  f.read.mockReturnValue(markdown.promise)
  const layout = mount(f.props)
  fireEvent.click(toggle(target))
  await waitFor(() => expect(f.read).toHaveBeenCalledOnce())
  fireEvent.click(screen.getByRole('button', { name: 'Comment on Todo' }))
  const editor = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Todo comment' })
  fireEvent.change(editor, { target: { value: 'Preserve this note.' } })
  expect(document.activeElement).toBe(editor)
  layout.host.scrollTop = 80
  const calls = layout.scroll.mock.calls.length
  await act(async () =>
    markdown.resolve(documentResponse(target, 'Late document details.', f.props.sessionId)),
  )
  await screen.findByText('Late document details.')
  expect(document.activeElement).toBe(editor)
  expect(layout.host.scrollTop).toBe(80)
  expect(layout.scroll).toHaveBeenCalledTimes(calls)
  fireEvent.click(toggle(f.items[0]!))
  expect(f.props.onNotice).toHaveBeenCalledWith(
    'Add this Comment to the draft or cancel before opening another Todo.',
  )
  expect(editor.value).toBe('Preserve this note.')
})

it('restores an exact Todo source selection without replacing it with header focus', async () => {
  const f = fixture()
  const target = f.items[2]!
  f.read.mockResolvedValue(documentResponse(target, 'Selected evidence.', f.props.sessionId))
  f.props.reveal = {
    todoId: target.id,
    revision: target.revision,
    navigationId: 'selection',
    selection: {
      contentHash: target.document.sha256,
      textBasis: 'markdown-visible-v2',
      startOffset: 0,
      endOffset: 8,
    },
  }
  mount(f.props)
  await waitFor(() => expect(window.getSelection()?.toString()).toBe('Selected'))
  expect(document.activeElement).not.toBe(toggle(target))
  expect(f.read).toHaveBeenCalledWith(
    expect.objectContaining({ aroundOffset: 0, document: target.document }),
  )
})

it('saves one frozen choice as an answer draft and never starts a Turn or changes the Todo state', async () => {
  const f = fixture()
  const target = f.items[0]!
  target.kind = 'decision'
  target.needsUserAnswer = true
  target.answerResolver = 'codex'
  target.question = {
    id: 'delivery-choice',
    revision: 2,
    type: 'choice',
    question: 'Choose the delivery strategy.',
    reason: 'A running Turn needs one policy.',
    options: ['Queue', 'Steer'],
    recommended: 0,
    answerResolver: 'codex',
  }
  mount(f.props)
  fireEvent.click(toggle(target))
  await screen.findByText(`Details for ${target.title}.`)
  fireEvent.click(screen.getByRole('button', { name: 'Add your answer' }))
  const queue = screen.getByRole('button', { name: /Queue/u })
  fireEvent.click(queue)
  expect(queue.getAttribute('aria-pressed')).toBe('true')
  fireEvent.click(queue)
  expect(queue.getAttribute('aria-pressed')).toBe('false')
  fireEvent.click(screen.getByRole('button', { name: 'Steer' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Todo answer' }), {
    target: { value: 'Use the current running Turn.' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Add to comment' }))
  await waitFor(() =>
    expect(f.props.onAddComment).toHaveBeenCalledWith(
      expect.objectContaining({
        todo: target,
        body: 'Steer\n\nUse the current running Turn.',
        answer: { questionId: 'delivery-choice', questionRevision: 2, optionIndex: 1 },
      }),
    ),
  )
  expect(target.status).toBe('open')
  expect(screen.queryByRole('button', { name: /Send|Submit answers/u })).toBeNull()
  expect(f.dispatch).not.toHaveBeenCalled()
})

function fixture() {
  const { task } = collaborationFixture()
  const items = ['first', 'second', 'third'].map((name) =>
    todoFixture(task, `todo-${name}`, { title: `${name[0]!.toUpperCase()}${name.slice(1)} issue` }),
  )
  const read = vi.fn<DesktopBridge['getConversation']>(async (request) => {
    if (request.scope !== 'collaboration-markdown') throw new Error(`Unexpected ${request.scope}`)
    const todo = items.find((item) => item.document.id === request.document.id)!
    return documentResponse(todo, `Details for ${todo.title}.`, task.sessionId)
  })
  const dispatch = vi.fn<DesktopBridge['actOnCollaboration']>()
  vi.stubGlobal('pact', { getConversation: read, actOnCollaboration: dispatch })
  const props = {
    sessionId: task.sessionId,
    active: true,
    taskId: task.id,
    ledgerRevision: 1,
    items,
    activeCount: 3,
    doneCount: 0,
    showDone: false,
    loading: false,
    hasPrevious: false,
    hasNext: false,
    disabled: false,
    addedDrafts: new Set<string>(),
    onShowDone: vi.fn<Props['onShowDone']>(),
    onPrevious: vi.fn<Props['onPrevious']>(),
    onNext: vi.fn<Props['onNext']>(),
    onRetry: vi.fn<Props['onRetry']>(),
    onReadDetail: vi.fn<Props['onReadDetail']>(async (todo) => detailFor(todo)),
    onAddComment: vi.fn<Props['onAddComment']>().mockResolvedValue(true),
    onEditorChange: vi.fn<Props['onEditorChange']>(),
    onNotice: vi.fn<Props['onNotice']>(),
    onOpenProjectFile: vi.fn<Props['onOpenProjectFile']>(),
    reveal: undefined as Props['reveal'],
    sourceTodo: undefined as Props['sourceTodo'],
    sourceCurrent: undefined as Props['sourceCurrent'],
  }
  return { props, items, read, dispatch }
}

/** jsdom supplies no layout: model the browser's scroll clamping at the native DOM boundary. */
function mount(props: Props) {
  const host = document.createElement('div')
  host.dataset.pactContextScroll = ''
  host.style.paddingTop = '16px'
  document.body.append(host)
  hosts.push(host)
  let scrollTop = 0
  const rows = () => [...host.querySelectorAll<HTMLElement>('li[data-pact-todo-id]')]
  Object.defineProperties(host, {
    clientHeight: { configurable: true, value: 400 },
    scrollHeight: {
      configurable: true,
      get: () =>
        82 +
        rows().reduce((height, element) => height + 150 + (hasDocumentBody(element) ? 700 : 0), 0),
    },
    scrollTop: {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = Math.min(Math.max(0, value), Math.max(0, host.scrollHeight - host.clientHeight))
      },
    },
  })
  const scroll = vi.fn<(options: ScrollToOptions) => void>((options) => {
    host.scrollTop = options.top ?? 0
  })
  Object.defineProperty(host, 'scrollTo', { configurable: true, value: scroll })
  const originalRect = HTMLElement.prototype.getBoundingClientRect.bind(document.documentElement)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    function (this: HTMLElement) {
      if (this === host) return new DOMRect(0, 40, 300, 400)
      if (this.matches('li[data-pact-todo-id]') && host.contains(this)) {
        const before = rows().slice(0, rows().indexOf(this))
        const top =
          40 +
          16 +
          30 +
          before.reduce((height, element) => height + 150 + (hasDocumentBody(element) ? 700 : 0), 0)
        return new DOMRect(0, top - scrollTop, 300, 150 + (hasDocumentBody(this) ? 700 : 0))
      }
      return originalRect()
    },
  )
  const view = render(<CollaborationTodos {...props} />, { container: host })
  return {
    host,
    scroll,
    view,
    offset: (todo: CollaborationTodo) => row(todo).getBoundingClientRect().top - 40 - 16,
  }
}

function hasDocumentBody(element: HTMLElement): boolean {
  return Boolean(element.querySelector('[data-pact-message-content]'))
}

function row(todo: CollaborationTodo): HTMLElement {
  return document.querySelector<HTMLElement>(
    `li[data-pact-todo-id="${todo.id}"][data-pact-todo-revision="${todo.revision}"]`,
  )!
}
function toggle(todo: CollaborationTodo): HTMLButtonElement {
  return row(todo).querySelector<HTMLButtonElement>('[data-pact-todo-toggle]')!
}
function detailFor(todo: CollaborationTodo): CollaborationTodoDetail {
  return { todo, runId: todo.sourceRunId, messageId: todo.sourceMessageId, document: todo.document }
}
function documentResponse(todo: CollaborationTodo, text: string, sessionId: string): ReadResponse {
  const page: Extract<ConversationPage, { scope: 'collaboration-markdown' }> = {
    scope: 'collaboration-markdown',
    sessionId,
    document: todo.document,
    basis: 'markdown-visible-v2',
    visibleStart: 0,
    visibleEnd: text.length,
    offset: 0,
    previousOffset: null,
    nextOffset: null,
    tree: {
      type: 'root',
      children: [
        {
          type: 'element',
          tagName: 'p',
          children: [
            {
              type: 'element',
              tagName: 'span',
              properties: {
                'data-pact-projection-start': 0,
                'data-pact-projection-end': text.length,
              },
              children: [{ type: 'text', value: text }],
            },
          ],
        },
      ],
    },
  }
  return { ok: true, value: page }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
