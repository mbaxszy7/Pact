// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import type { DesktopBridge } from '@pact/contracts'

import { collaborationFixture, reportPage, markdownPage } from './collaboration.test-helper'
import { CollaborationReview } from './CollaborationReview'
import { focusProjectionRange } from './message-selection'

afterEach(() => {
  cleanup()
  window.getSelection()?.removeAllRanges()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it('anchors a conclusion Comment to the immutable report summary rather than the current plan', async () => {
  const { props, task, planReference } = collaborationFixture()
  task.stage = 'plan_review'
  props.run.collaboration!.stage = 'plan_review'
  task.review = {
    runId: props.run.id,
    actor: 'claude',
    stage: 'plan_review',
    verdict: 'accepted',
    inputSequence: 0,
    planReference,
    document: planReference.document,
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
  await screen.findByText('Cancellation ownership is settled.')
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
  task.stage = 'plan_review'
  props.run.collaboration!.stage = 'plan_review'
  task.review = {
    runId: props.run.id,
    actor: 'claude',
    stage: 'plan_review',
    verdict: 'accepted',
    inputSequence: 0,
    planReference,
    document: planReference.document,
  }
  const bridge = installRead(task, false, 'Recorded conclusion.')
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
  view.rerender(<CollaborationReview {...navigation} revealReportRequestId="second-request" />)
  await screen.findByText('Recorded conclusion.')
  await waitFor(() => expect(onReportReady).toHaveBeenCalledTimes(2))
  expect(
    bridge.getConversation.mock.calls.filter(([request]) => request.scope === 'collaboration'),
  ).toHaveLength(1)
  expect(screen.queryByLabelText('Pact Proposal')).toBeNull()
})

it('reports a document-backed historical conclusion ready only after its projected text exists', async () => {
  const { props, task, planReference } = collaborationFixture()
  task.stage = 'plan_review'
  props.run.collaboration!.stage = 'plan_review'
  task.review = {
    runId: props.run.id,
    actor: 'claude',
    stage: 'plan_review',
    verdict: 'accepted',
    inputSequence: 0,
    planReference,
    document: planReference.document,
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
        documents: [{ key: 'report', source }],
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
  text = 'Cancellation ownership is settled.',
) {
  const bridge = {
    getConversation: vi
      .fn<DesktopBridge['getConversation']>()
      .mockImplementation(async (request) => ({
        ok: true,
        value:
          request.scope === 'collaboration-markdown'
            ? markdownPage(task, text)
            : reportPage(task, { actionable }),
      })),
    actOnCollaboration: vi.fn<DesktopBridge['actOnCollaboration']>(),
  }
  vi.stubGlobal('pact', bridge)
  return bridge
}

it('opens Session settings instead of offering an ineffective Continue at the plan review limit', async () => {
  const { props, task } = collaborationFixture()
  task.discussionRounds = props.session.settings.maxDiscussionRounds
  task.planInputSequence = task.inputSequence
  task.pauseReason = 'limit'
  task.notice = 'The Session discussion limit has been reached.'
  const bridge = installRead(task)
  bridge.getConversation.mockResolvedValue({
    ok: true,
    value: reportPage(task, { nextStep: 'Review the current plan with Claude Code' }),
  })
  const onOpenSessionSettings = vi.fn<() => void>()
  render(<CollaborationReview {...props} onOpenSessionSettings={onOpenSessionSettings} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Session settings' }))
  expect(onOpenSessionSettings).toHaveBeenCalledOnce()
  expect(screen.queryByRole('button', { name: 'Continue collaboration' })).toBeNull()
  expect(bridge.actOnCollaboration).not.toHaveBeenCalled()
  expect(task.discussionRounds).toBe(props.session.settings.maxDiscussionRounds)
})

it('omits the generic restart reminder only for known settled work', async () => {
  const { props, task } = collaborationFixture()
  const notice = 'Application restarted. Check the original execution, then continue collaboration.'
  task.pauseReason = 'restart'
  task.notice = notice
  installRead(task)
  const view = render(<CollaborationReview {...props} />)
  await screen.findByRole('button', { name: 'Continue collaboration' })
  expect(screen.queryByText(notice)).toBeNull()
  view.rerender(
    <CollaborationReview {...props} run={{ ...props.run, nativeEffectsState: 'unknown' }} />,
  )
  expect(screen.getByText(notice).textContent).toBe(notice)
})

it('requires explicit Continue after updated Session limits and refreshes the same Run projection', async () => {
  const { props, task } = collaborationFixture()
  task.planInputSequence = task.inputSequence
  task.discussionRounds = props.session.settings.maxDiscussionRounds
  task.pauseReason = 'limit'
  task.notice = 'The Session discussion limit has been reached.'
  const bridge = installRead(task)
  bridge.getConversation.mockResolvedValue({
    ok: true,
    value: reportPage(task, { nextStep: 'Review the current plan with Claude Code' }),
  })
  bridge.actOnCollaboration.mockResolvedValue({
    ok: false,
    error: { code: 'CONFLICT', message: 'A current action receipt is required.' },
  })
  const onOpenSessionSettings = vi.fn<() => void>()
  const view = render(
    <CollaborationReview {...props} onOpenSessionSettings={onOpenSessionSettings} />,
  )
  await screen.findByRole('button', { name: 'Session settings' })
  view.rerender(
    <CollaborationReview
      {...props}
      session={{
        ...props.session,
        settingsRevision: props.session.settingsRevision + 1,
        settings: { ...props.session.settings, maxDiscussionRounds: task.discussionRounds + 1 },
      }}
      onOpenSessionSettings={onOpenSessionSettings}
    />,
  )
  const resume = await screen.findByRole('button', { name: 'Continue collaboration' })
  expect(bridge.getConversation).toHaveBeenCalledTimes(2)
  expect(bridge.actOnCollaboration).not.toHaveBeenCalled()
  expect(screen.queryByText(/limit.*reached/i)).toBeNull()
  fireEvent.click(resume)
  await waitFor(() =>
    expect(bridge.actOnCollaboration).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ taskId: task.id, revision: task.revision, action: 'resume' }),
    ),
  )
  expect(task.discussionRounds).toBe(props.session.settings.maxDiscussionRounds)
})

it('opens the exact current plan without duplicating it in chat or offering historical actions', async () => {
  const { props, task } = collaborationFixture()
  const bridge = installRead(task)
  bridge.getConversation.mockResolvedValue({
    ok: true,
    value: reportPage(task, { planSource: { runId: task.runId, messageId: task.taskMessageId } }),
  })
  const onOpenPlan = vi.fn<NonNullable<Parameters<typeof CollaborationReview>[0]['onOpenPlan']>>()
  const view = render(<CollaborationReview {...props} onOpenPlan={onOpenPlan} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Open plan' }))
  expect(onOpenPlan).toHaveBeenCalledWith({
    runId: task.runId,
    messageId: task.taskMessageId,
    version: 2,
  })
  expect(screen.getAllByRole('button', { name: 'Continue collaboration' })).toHaveLength(1)
  view.rerender(
    <CollaborationReview {...props} latestRunId={crypto.randomUUID()} onOpenPlan={onOpenPlan} />,
  )
  expect(screen.queryByLabelText('Pact Proposal')).toBeNull()
  expect(bridge.actOnCollaboration).not.toHaveBeenCalled()
})

it('keeps failed action receipts visible after successful refresh and sends the revision once', async () => {
  const { props, task } = collaborationFixture()
  const bridge = installRead(task)
  bridge.actOnCollaboration.mockResolvedValue({
    ok: false,
    error: { code: 'CONFLICT', message: 'The action receipt changed.' },
  })
  render(<CollaborationReview {...props} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Continue collaboration' }))
  await screen.findByRole('alert')
  await waitFor(() => expect(bridge.getConversation).toHaveBeenCalledTimes(2))
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
  await waitFor(() => expect(bridge.getConversation).toHaveBeenCalledTimes(3))
  expect(screen.getByRole('alert').textContent).toContain('The action receipt changed.')
  expect(bridge.actOnCollaboration).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ taskId: task.id, revision: task.revision, action: 'resume' }),
  )
})

it('omits Pause while preserving the authorized next action and revision receipt', async () => {
  const { props, task } = collaborationFixture()
  const bridge = installRead(task)
  bridge.getConversation.mockResolvedValue({
    ok: true,
    value: reportPage(task, { availableActions: ['resume', 'pause'] }),
  })
  bridge.actOnCollaboration.mockResolvedValue({
    ok: false,
    error: { code: 'CONFLICT', message: 'Revision changed' },
  })
  render(<CollaborationReview {...props} />)
  const resume = await screen.findByRole('button', { name: 'Continue collaboration' })
  expect(screen.queryByRole('button', { name: /Pause collaboration/i })).toBeNull()
  fireEvent.click(resume)
  await waitFor(() =>
    expect(bridge.actOnCollaboration).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ taskId: task.id, revision: task.revision, action: 'resume' }),
    ),
  )
})
