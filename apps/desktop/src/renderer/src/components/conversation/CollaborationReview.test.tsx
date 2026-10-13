// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import type { DesktopBridge } from '@pact/contracts'

import { collaborationFixture, reportPage, todoDelta } from './collaboration.test-helper'
import { CollaborationReview } from './CollaborationReview'
import { focusProjectionRange } from './message-selection'

afterEach(() => {
  cleanup()
  window.getSelection()?.removeAllRanges()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it('opens the exact question Todo version without collecting or dispatching answers in the card', async () => {
  const { props, task } = collaborationFixture()
  task.status = 'questions'
  task.result!.outcome = 'needs_user'
  task.result!.todoDeltas = [
    {
      ...todoDelta('delivery-timing-question'),
      kind: 'decision',
      title: 'Choose delivery timing',
      question: {
        id: 'delivery-question',
        revision: 2,
        type: 'choice',
        question: 'When should the message be delivered?',
        reason: 'This determines the running behavior.',
        options: ['Queue', 'Steer'],
        recommended: 0,
        answerResolver: 'codex',
      },
    },
  ]
  const bridge = installRead(task, true, [
    { id: 'delivery-timing-question', revision: 3, title: 'Choose delivery timing' },
  ])
  const onOpenTodo = vi.fn<NonNullable<Parameters<typeof CollaborationReview>[0]['onOpenTodo']>>()
  render(<CollaborationReview {...props} onOpenTodo={onOpenTodo} />)
  fireEvent.click(await screen.findByRole('button', { name: /Plan · v2/u }))
  fireEvent.click(screen.getByRole('button', { name: 'Choose delivery timing' }))
  expect(onOpenTodo).toHaveBeenCalledWith({
    taskId: task.id,
    todoId: 'delivery-timing-question',
    todoRevision: 3,
  })
  expect(screen.queryByRole('radio')).toBeNull()
  expect(screen.queryByRole('textbox')).toBeNull()
  expect(screen.queryByText('When should the message be delivered?')).toBeNull()
  expect(screen.queryByRole('button', { name: /Submit answers/u })).toBeNull()
  expect(bridge.actOnCollaboration).not.toHaveBeenCalled()
})

it('keeps historical updates compact and never duplicates the unique plan or a current Proposal', async () => {
  const { props, task } = collaborationFixture()
  task.result!.todoDeltas = [todoDelta('F1'), todoDelta('F2')]
  installRead(task, false)
  const { container } = render(<CollaborationReview {...props} latestRunId={crypto.randomUUID()} />)
  const header = await screen.findByRole('button', { name: 'Plan · v2 2 updates' })
  expect(header.getAttribute('aria-expanded')).toBe('false')
  expect(screen.queryByRole('list', { name: 'Issue summaries' })).toBeNull()
  expect(screen.queryByText(task.plan!)).toBeNull()
  expect(screen.queryByLabelText('Pact Proposal')).toBeNull()
  fireEvent.click(header)
  expect(screen.getByRole('button', { name: 'Finding F1' })).toBeDefined()
  expect(screen.getByRole('button', { name: 'Finding F2' })).toBeDefined()
  expect(container.querySelectorAll('h3')).toHaveLength(1)
  expect(screen.queryByText('Impact for F1.')).toBeNull()
  fireEvent.click(header)
  expect(screen.queryByText('Finding F1')).toBeNull()
})

it('keeps one current Proposal visible when update summaries are collapsed', async () => {
  const { props, task } = collaborationFixture()
  task.result!.todoDeltas = [todoDelta('F1')]
  installRead(task)
  render(<CollaborationReview {...props} />)
  const header = await screen.findByRole('button', { name: 'Plan · v2 1 update' })
  fireEvent.click(header)
  expect(screen.getByRole('button', { name: 'Finding F1' })).toBeDefined()
  fireEvent.click(header)
  expect(screen.queryByText('Finding F1')).toBeNull()
  expect(screen.getAllByRole('button', { name: 'Review plan · Claude Code' })).toHaveLength(1)
  expect(screen.queryByText(task.plan!)).toBeNull()
  expect(screen.queryByText('Not now')).toBeNull()
})

it.each(['resume', 'failed-action'] as const)(
  'preserves the %s action failure across successful reads and collapsed details',
  async (mode) => {
    const { props, task } = collaborationFixture()
    task.result!.todoDeltas = [todoDelta('F1')]
    if (mode === 'resume') task.status = 'paused'
    const bridge = installRead(task)
    bridge.actOnCollaboration.mockResolvedValue({
      ok: false,
      error: { code: 'CONFLICT', message: 'The action receipt changed.' },
    })
    render(<CollaborationReview {...props} />)
    const button = await screen.findByRole('button', {
      name: mode === 'resume' ? 'Resume collaboration' : 'Review plan · Claude Code',
    })
    fireEvent.click(button)
    await screen.findByRole('alert')
    await waitFor(() => expect(bridge.getConversation).toHaveBeenCalledTimes(2))
    expect(screen.getByRole('alert').textContent).toContain('The action receipt changed.')
    expect(screen.queryByRole('list', { name: 'Issue summaries' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(bridge.getConversation).toHaveBeenCalledTimes(3))
    expect(screen.getByRole('alert').textContent).toContain('The action receipt changed.')
    expect(bridge.actOnCollaboration.mock.calls[0]?.[0].action).toBe(
      mode === 'resume' ? 'resume' : 'continue',
    )
  },
)

it('shows the peer conclusion and exact Todo links while keeping the unique reviewed plan outside chat', async () => {
  const { props, task, planReference } = collaborationFixture()
  task.actor = 'claude'
  props.run.agentId = 'claude'
  task.result = {
    submission: 'plan_review',
    outcome: 'complete',
    reviewedPlan: planReference,
    verdict: 'changes_requested',
    summary: 'Changes requested: cancellation must settle exactly once.',
    todoDeltas: [todoDelta('F1')],
    inputResponses: [],
  }
  const onOpenTodo = vi.fn<NonNullable<Parameters<typeof CollaborationReview>[0]['onOpenTodo']>>()
  installRead(task)
  render(<CollaborationReview {...props} onOpenTodo={onOpenTodo} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Review · v2 1 update' }))
  expect(screen.getByText(task.result.summary)).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: 'Finding F1' }))
  expect(onOpenTodo).toHaveBeenCalledWith({ taskId: task.id, todoId: 'F1', todoRevision: 1 })
  expect(screen.getByRole('button', { name: 'Update plan · Codex' })).toBeDefined()
  expect(screen.queryByText(task.plan!)).toBeNull()
  expect(screen.queryByText('Impact for F1.')).toBeNull()
  expect(screen.queryByText(/reviewedPlan|plan_review|verdict:/u)).toBeNull()
})

it('anchors a conclusion Comment to the immutable report summary rather than the current plan', async () => {
  const { props, task, planReference } = collaborationFixture()
  task.result = {
    submission: 'plan_review',
    outcome: 'complete',
    reviewedPlan: planReference,
    verdict: 'accepted',
    summary: 'Cancellation ownership is settled.',
    todoDeltas: [],
    inputResponses: [],
  }
  installRead(task)
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => new DOMRect(0, 0, 80, 20),
  })
  Object.defineProperty(Range.prototype, 'getClientRects', {
    configurable: true,
    value: () => [new DOMRect(0, 0, 80, 20)],
  })
  const onCreateReportComment = vi.fn<(selection: unknown) => void>()
  const { container } = render(
    <CollaborationReview {...props} onCreateReportComment={onCreateReportComment} />,
  )
  fireEvent.click(await screen.findByRole('button', { name: 'Review · v2' }))
  const summary = container.querySelector<HTMLElement>('[data-pact-report-key="summary"]')!
  const content = summary.querySelector<HTMLElement>('[data-pact-message-content]')!
  expect(focusProjectionRange(content, 0, 12, { scroll: false, highlight: false })).toBe(true)
  fireEvent.keyUp(content)
  fireEvent.click(screen.getByRole('button', { name: 'Comment on selected text' }))
  expect(onCreateReportComment).toHaveBeenCalledWith(
    expect.objectContaining({
      messageId: props.run.userMessageId,
      quote: 'Cancellation',
      startOffset: 0,
      endOffset: 12,
      report: { runId: props.run.id, target: { type: 'summary' } },
    }),
  )
  expect(onCreateReportComment.mock.calls[0]?.[0]).not.toHaveProperty('plan')
})

it('reopens a historical conclusion for each distinct source navigation request', async () => {
  const { props, task, planReference } = collaborationFixture()
  task.result = {
    submission: 'plan_review',
    outcome: 'complete',
    reviewedPlan: planReference,
    verdict: 'accepted',
    summary: 'Recorded conclusion.',
    todoDeltas: [],
    inputResponses: [],
  }
  const bridge = installRead(task, false)
  const onReportReady = vi.fn<() => undefined>()
  const navigation = {
    ...props,
    latestRunId: crypto.randomUUID(),
    revealReport: { runId: props.run.id, target: { type: 'summary' as const } },
    revealReportRequestId: 'first-request',
    onReportReady,
  }
  const view = render(<CollaborationReview {...navigation} />)
  await screen.findByText('Recorded conclusion.')
  fireEvent.click(screen.getByRole('button', { name: 'Review · v2' }))
  expect(screen.queryByText('Recorded conclusion.')).toBeNull()
  view.rerender(<CollaborationReview {...navigation} revealReportRequestId="second-request" />)
  await screen.findByText('Recorded conclusion.')
  await waitFor(() => expect(onReportReady).toHaveBeenCalledTimes(2))
  expect(bridge.getConversation).toHaveBeenCalledOnce()
  expect(screen.queryByLabelText('Pact Proposal')).toBeNull()
})

it('reports a document-backed historical conclusion ready only after its projected text exists', async () => {
  const { props, task, planReference } = collaborationFixture()
  task.result = {
    submission: 'plan_review',
    outcome: 'complete',
    reviewedPlan: planReference,
    verdict: 'accepted',
    summary: '',
    todoDeltas: [],
    inputResponses: [],
  }
  const source = { id: crypto.randomUUID(), sha256: 'c'.repeat(64), bytes: 100, chars: 100 }
  let finishDocument!: (response: Awaited<ReturnType<DesktopBridge['getConversation']>>) => void
  const documentRead = new Promise<Awaited<ReturnType<DesktopBridge['getConversation']>>>(
    (resolve) => {
      finishDocument = resolve
    },
  )
  const bridge = installRead(task, false)
  bridge.getConversation.mockImplementation(async (request) => {
    if (request.scope === 'collaboration-markdown') return documentRead
    if (request.scope !== 'collaboration') throw new Error(`Unexpected ${request.scope}`)
    return {
      ok: true,
      value: reportPage(task, {
        actionable: false,
        documents: [{ key: 'summary', source }],
      }),
    }
  })
  const onReportReady = vi.fn<(host: HTMLElement) => undefined>()
  render(
    <CollaborationReview
      {...props}
      latestRunId={crypto.randomUUID()}
      revealReport={{ runId: props.run.id, target: { type: 'summary' } }}
      revealReportRequestId="document-request"
      onReportReady={onReportReady}
    />,
  )
  await waitFor(() => expect(bridge.getConversation).toHaveBeenCalledTimes(2))
  expect(onReportReady).not.toHaveBeenCalled()
  const text = 'Archived document conclusion.'
  await act(async () =>
    finishDocument({
      ok: true,
      value: {
        scope: 'collaboration-markdown',
        sessionId: task.sessionId,
        document: source,
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
      },
    }),
  )
  await screen.findByText(text)
  await waitFor(() => expect(onReportReady).toHaveBeenCalledOnce())
  expect(
    onReportReady.mock.calls[0]?.[0].querySelector('[data-pact-message-content]')?.textContent,
  ).toContain(text)
})

function installRead(
  task: ReturnType<typeof collaborationFixture>['task'],
  actionable = true,
  summaries = task.result?.todoDeltas.map((delta) => ({
    id: delta.todoId,
    revision: delta.expectedRevision + 1,
    title: delta.title!,
  })) ?? [],
) {
  const bridge = {
    getConversation: vi.fn<DesktopBridge['getConversation']>().mockResolvedValue({
      ok: true,
      value: reportPage(task, { actionable, todoSummaries: summaries }),
    }),
    actOnCollaboration: vi.fn<DesktopBridge['actOnCollaboration']>(),
  }
  vi.stubGlobal('pact', bridge)
  return bridge
}
