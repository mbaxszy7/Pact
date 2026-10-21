import type { Virtualizer } from '@tanstack/react-virtual'
import type { ComponentProps } from 'react'

// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
// oxlint-disable-next-line eslint/no-restricted-imports -- jsdom lacks browser SubtleCrypto; this test-only provider verifies the real source hash.
import { webcrypto } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { AgentRun, ConversationPage, DesktopBridge, WorkspaceChangeSet } from '@pact/contracts'

import { collaborationTaskSchema } from '@pact/contracts'

import { collaborationFixture, reportPage, markdownPage } from './collaboration.test-helper'
import { composerBridgeFixture } from './composer.test-helper'
import { windowFromPage } from './conversation-window'
import { ConversationView } from './ConversationView'
import { focusProjectionRange } from './message-selection'

const virtualState = vi.hoisted(() => ({
  interactive: false,
  instance: undefined as Virtualizer<Element, Element> | undefined,
}))

vi.mock('@tanstack/react-virtual', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-virtual')>()
  return {
    ...actual,
    useVirtualizer: (options: Parameters<typeof actual.useVirtualizer>[0]) => {
      const instance = actual.useVirtualizer({
        ...options,
        initialRect: { width: 900, height: 600 },
        observeElementRect: (_instance, callback) => {
          callback({ width: 900, height: 600 })
          return () => undefined
        },
        observeElementOffset: (owner, callback) => {
          if (virtualState.interactive && owner.scrollElement) {
            const element = owner.scrollElement
            const observe = () => callback(element.scrollTop, true)
            callback(element.scrollTop, false)
            element.addEventListener('scroll', observe)
            return () => element.removeEventListener('scroll', observe)
          }
          callback(0, false)
          return () => undefined
        },
        measureElement: () => (virtualState.interactive ? 100 : 180),
        scrollToFn: (offset, { adjustments }, owner) => {
          if (!owner.scrollElement) return
          owner.scrollElement.scrollTop = offset + (adjustments ?? 0)
          if (virtualState.interactive) {
            const element = owner.scrollElement
            queueMicrotask(() => element.dispatchEvent(new Event('scroll')))
          }
        },
      })
      virtualState.instance = instance
      return instance
    },
  }
})

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'hidePopover', {
    configurable: true,
    value: vi.fn<() => void>(),
  })
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  vi.stubGlobal('matchMedia', () => ({
    matches: true,
    addEventListener: vi.fn<() => void>(),
    removeEventListener: vi.fn<() => void>(),
  }))
  virtualState.interactive = false
  virtualState.instance = undefined
  Object.defineProperty(crypto, 'subtle', { configurable: true, value: webcrypto.subtle })
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn<() => void>(),
  })
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: vi.fn<() => DOMRect>(() => new DOMRect(0, 0, 80, 20)),
  })
  Object.defineProperty(Range.prototype, 'getClientRects', {
    configurable: true,
    value: () => [new DOMRect(0, 0, 80, 20)],
  })
  vi.stubGlobal('pact', composerBridgeFixture())
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    window.setTimeout(() => callback(0), 0),
  )
  vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it('defers a completed Steer fold while reading history and resumes when scrolling back to latest', async () => {
  const { props, run } = recordingFixture()
  delete run.workspaceChanges
  run.status = 'running'
  run.outputSnapshots = {
    count: 2,
    lastInputMessageId: crypto.randomUUID(),
    lastInputSequence: 1,
    settled: false,
  }
  props.snapshot!.messages.push({
    id: crypto.randomUUID(),
    sessionId: props.session.id,
    runId: run.id,
    replyToMessageId: run.userMessageId,
    role: 'assistant',
    agentId: 'codex',
    content: 'Canonical response.',
    contentRevision: 0,
    state: 'complete',
    sequence: 2,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    outputSnapshot: {
      ordinal: 1,
      frozen: false,
      canonical: true,
      order: { sequence: 2, rank: 1, id: run.id },
    },
  })
  props.history.window!.preserveRunId = run.id
  props.history.collapseEarlierResponses = vi
    .fn<NonNullable<typeof props.history.collapseEarlierResponses>>()
    .mockResolvedValue(undefined)
  const mounted = render(<ConversationView {...props} />)
  const transcript = screen.getByRole('region', { name: 'Conversation messages' })
  Object.defineProperties(transcript, {
    scrollHeight: { configurable: true, value: 1200 },
    clientHeight: { configurable: true, value: 400 },
  })
  fireEvent.wheel(transcript, { deltaY: -100 })
  transcript.scrollTop = 300
  fireEvent.scroll(transcript)
  run.status = 'completed'
  run.nativeEffectsState = 'settled'
  run.outputSnapshots = { ...run.outputSnapshots, settled: true }
  props.snapshot = { ...props.snapshot!, runs: [{ ...run }] }
  mounted.rerender(<ConversationView {...props} />)
  expect(props.history.collapseEarlierResponses).not.toHaveBeenCalled()
  fireEvent.keyDown(transcript, { key: 'End' })
  transcript.scrollTop = 800
  fireEvent.scroll(transcript)
  await waitFor(() => expect(props.history.collapseEarlierResponses).toHaveBeenCalledWith(run.id))
  expect(props.history.protectReading).toHaveBeenLastCalledWith(undefined)
})

it('keeps the completion fold guard closed while a historical Message selection is active', () => {
  const { props } = recordingFixture()
  let guard: (() => boolean) | undefined
  props.history.setSnapshotFoldGuard = (value) => {
    guard = value
  }
  const mounted = render(<ConversationView {...props} />)
  expect(guard?.()).toBe(true)
  const host = mounted.container.querySelector<HTMLElement>('[data-pact-message-content]')!
  expect(focusProjectionRange(host, 0, 4, { scroll: false, highlight: false })).toBe(true)
  expect(guard?.()).toBe(false)
  window.getSelection()?.removeAllRanges()
  expect(guard?.()).toBe(true)
})

it.each(['no-output', 'structured-only', 'changes-only', 'answered-changes'] as const)(
  'shows exactly one collaboration recovery/action entry for a settled %s Run',
  async (mode) => {
    const { props, run } = recordingFixture()
    const user = props.snapshot!.messages[0]!
    const task = collaborationTaskSchema.parse({
      protocol: 'native-workflow-v1',
      owner: 'codex',
      automation: 'paused',
      inputSequence: 0,
      handledInputSequence: 0,
      id: crypto.randomUUID(),
      sessionId: props.session.id,
      runId: run.id,
      taskMessageId: user.id,
      kind: 'build',
      revision: 1,

      reviewer: 'claude',
      task: 'Implement cancellation.',
      stage: 'implement',
      actor: 'codex',
      status: mode === 'no-output' ? 'failed' : 'waiting',
      planVersion: 0,
      discussionRounds: 0,

      reviewCycles: 0,
      repairAttempts: 0,

      ...(mode === 'no-output' ? { notice: 'Failed before output.' } : {}),
    })
    run.collaboration = { taskId: task.id, kind: 'build', stage: 'implement' }
    run.nativeEffectsState = 'settled'
    run.status = mode === 'no-output' ? 'failed' : 'completed'
    user.runId = run.id
    if (!['changes-only', 'answered-changes'].includes(mode)) delete run.workspaceChanges
    else if (run.workspaceChanges) {
      run.workspaceChanges.state = 'ready'
      run.workspaceChanges.finalizedAt = run.updatedAt
    }
    props.snapshot!.nativeContexts = []
    props.history.window!.latestRun = run
    if (mode === 'structured-only' || mode === 'answered-changes')
      props.snapshot!.messages.push({
        id: crypto.randomUUID(),
        sessionId: props.session.id,
        role: 'assistant',
        agentId: 'codex',
        runId: run.id,
        replyToMessageId: user.id,
        content: mode === 'answered-changes' ? 'Implementation complete.' : '',
        contentRevision: 0,
        state: 'complete',
        sequence: 1,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
      })
    const bridge = {
      ...composerBridgeFixture(),
      getConversation: vi.fn<DesktopBridge['getConversation']>().mockResolvedValue({
        ok: true,
        value: {
          scope: 'collaboration',
          sessionId: props.session.id,
          view: {
            task,
            availableActions: [mode === 'no-output' ? 'retry' : 'resume'],
            actionable: true,
            accepted: mode !== 'no-output',
            reportAvailable: mode !== 'no-output',
          },
        },
      }),
    }
    vi.stubGlobal('pact', bridge)
    render(<ConversationView {...props} />)
    await waitFor(() =>
      expect(screen.getAllByRole('region', { name: 'Pact collaboration result' })).toHaveLength(1),
    )
    expect(
      screen.getAllByRole('button', {
        name: mode === 'no-output' ? 'Retry · Codex' : 'Continue collaboration',
      }),
    ).toHaveLength(1)
  },
)

it.each(['answer', 'standalone', 'historical-source'] as const)(
  'keeps the %s plan in the right context pane and out of its chat card',
  async (mode) => {
    const { props, run } = recordingFixture()
    run.nativeEffectsState = 'settled'
    delete run.workspaceChanges
    const user = props.snapshot!.messages[0]!
    user.runId = run.id
    const task = collaborationTaskSchema.parse({
      protocol: 'native-workflow-v1',
      owner: 'codex',
      automation: 'paused',
      inputSequence: 0,
      handledInputSequence: 0,
      id: crypto.randomUUID(),
      sessionId: props.session.id,
      runId: run.id,
      taskMessageId: user.id,
      kind: 'plan',
      revision: 1,

      reviewer: 'claude',
      task: 'Inspect ownership',
      stage: 'plan',
      actor: 'codex',
      status: 'waiting',
      planVersion: 1,

      planReference: {
        version: 1,
        sourceRunId: run.id,
        sourceMessageId: user.id,
        document: { id: crypto.randomUUID(), sha256: 'a'.repeat(64), bytes: 25, chars: 25 },
      },
      discussionRounds: 0,

      reviewCycles: 0,
      repairAttempts: 0,
    })
    run.collaboration = { taskId: task.id, kind: 'plan', stage: 'plan' }
    props.snapshot!.nativeContexts = []
    if (mode === 'answer')
      props.snapshot!.messages.push({
        id: crypto.randomUUID(),
        sessionId: props.session.id,
        role: 'assistant',
        agentId: 'codex',
        runId: run.id,
        replyToMessageId: user.id,
        content: 'Source answer.',
        contentRevision: 0,
        state: 'complete',
        sequence: 1,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
      })
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
      new DOMRect(0, 0, 900, 600),
    )
    const host = document.createElement('aside')
    document.body.append(host)
    props.planPanelHost = host
    props.onPlanAvailable =
      vi.fn<NonNullable<ComponentProps<typeof ConversationView>['onPlanAvailable']>>()
    props.onClosePlan = vi.fn<() => void>()
    props.onPlanPanelExpandedChange = vi.fn<(expanded: boolean) => void>()
    if (mode === 'historical-source')
      props.messageNavigation = {
        navigationId: crypto.randomUUID(),
        messageId: user.id,
        plan: { runId: run.id, version: 1 },
        startOffset: 0,
        endOffset: 5,
      }
    vi.stubGlobal('pact', {
      ...composerBridgeFixture(),
      getConversation: vi
        .fn<DesktopBridge['getConversation']>()
        .mockImplementation(async (request) => {
          if (request.scope === 'collaboration-markdown')
            return { ok: true, value: markdownPage(task, 'Exact frozen plan version') }
          if (request.scope === 'collaboration-quote')
            return {
              ok: true,
              value: {
                ...request,
                text: 'Exact frozen plan version'.slice(request.offset, request.endOffset),
                nextOffset: null,
              },
            }
          if (request.scope !== 'collaboration') throw new Error(`Unexpected ${request.scope}`)
          return {
            ok: true,
            value: {
              scope: 'collaboration',
              sessionId: props.session.id,
              view: {
                task,
                availableActions: [],
                actionable: request.projection !== 'plan',
                accepted: true,
                reportAvailable: true,
                ...(request.projection === 'current' || request.projection === 'plan'
                  ? { planSource: { runId: run.id, messageId: user.id } }
                  : {}),
              },
            },
          }
        }),
    })
    const { container, rerender, unmount } = render(<ConversationView {...props} />)
    await waitFor(() => expect(host.textContent).toContain('Exact frozen plan version'))
    expect(container.textContent).not.toContain('Exact frozen plan version')
    expect(host.querySelectorAll('[data-pact-plan-run-id]')).toHaveLength(1)
    expect(container.querySelectorAll('[data-pact-plan-run-id]')).toHaveLength(0)
    expect(screen.queryByRole('button', { name: 'Not now' })).toBeNull()
    await waitFor(() =>
      expect(window.getSelection()?.toString()).toBe(mode === 'historical-source' ? 'Exact' : ''),
    )
    const text = host.querySelector('[data-pact-projection-start]')!.firstChild!
    const range = document.createRange()
    range.setStart(text, 0)
    range.setEnd(text, 5)
    act(() => {
      window.getSelection()!.removeAllRanges()
      window.getSelection()!.addRange(range)
    })
    rerender(<ConversationView {...props} composer="A new draft" />)
    expect(host.querySelector('[data-pact-projection-start]')!.firstChild).toBe(text)
    expect(window.getSelection()?.toString()).toBe('Exact')
    fireEvent.click(screen.getByRole('button', { name: 'Expand plan panel' }))
    expect(props.onPlanPanelExpandedChange).toHaveBeenLastCalledWith(true)
    rerender(<ConversationView {...props} planPanelExpanded />)
    expect(host.querySelector('[data-pact-projection-start]')!.firstChild).toBe(text)
    const planContent = host.querySelector<HTMLElement>('[data-pact-plan-run-id]')!
    expect(focusProjectionRange(planContent, 0, 5, { scroll: false, highlight: false })).toBe(true)
    // jsdom has no browser caret movement; move to the selected word boundary.
    Object.defineProperty(window.getSelection()!, 'modify', {
      configurable: true,
      value: () => window.getSelection()!.collapse(text, 5),
    })
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Plan text' }), {
      key: 'ArrowRight',
      shiftKey: true,
      ctrlKey: true,
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Comment on selected text' }))
    const editor = await screen.findByRole('textbox', { name: 'Comment' })
    expect(host.contains(editor)).toBe(true)
    fireEvent.change(editor, { target: { value: 'Keep this plan detail.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Restore plan panel' }))
    expect(props.onPlanPanelExpandedChange).toHaveBeenLastCalledWith(false)
    rerender(<ConversationView {...props} planPanelExpanded={false} />)
    expect(host.querySelector('[data-pact-projection-start]')!.firstChild).toBe(text)
    const restoredEditor = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Comment' })
    expect(container.contains(restoredEditor)).toBe(true)
    expect(restoredEditor.value).toBe('Keep this plan detail.')
    fireEvent.click(screen.getByRole('button', { name: 'Expand plan panel' }))
    rerender(<ConversationView {...props} planPanelExpanded />)
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Comment' }).value).toBe(
      'Keep this plan detail.',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Add to comment' }))
    await waitFor(() =>
      expect(props.onSaveCommentDraft).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: 'create',
          body: 'Keep this plan detail.',
          anchor: expect.objectContaining({
            quote: 'Exact',
            plan: { runId: run.id, version: 1 },
          }),
        }),
      ),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Close context panel' }))
    expect(props.onClosePlan).toHaveBeenCalledOnce()
    unmount()
    host.remove()
    window.getSelection()?.removeAllRanges()
  },
)

it('finishes historical report navigation after the source page is ready and preserves it across draft edits', async () => {
  window.getSelection()?.removeAllRanges()
  const { props, run } = recordingFixture()
  const { task } = collaborationFixture()
  task.sessionId = props.session.id
  task.runId = run.id
  task.taskMessageId = run.userMessageId
  task.actor = 'claude'
  task.stage = 'plan_review'
  task.review = {
    runId: run.id,
    actor: 'claude',
    stage: 'plan_review',
    verdict: 'accepted',
    inputSequence: 0,
    planReference: task.planReference,
    document: task.planReference?.document ?? task.reviewScopeRef!,
  }
  run.agentId = 'claude'
  run.nativeEffectsState = 'settled'
  run.collaboration = { taskId: task.id, kind: task.kind, stage: task.stage }
  delete run.workspaceChanges
  props.snapshot!.messages[0]!.runId = run.id
  props.snapshot!.nativeContexts = []
  props.history.window!.latestRun = { ...run, id: crypto.randomUUID() }
  props.history.window!.sourceMessageId = run.userMessageId
  props.history.loadingPage = true
  props.messageNavigation = {
    navigationId: 'historical-report-source',
    messageId: run.userMessageId,
    report: { runId: run.id, target: { type: 'summary' } },
    startOffset: 4,
    endOffset: 21,
  }
  const read = vi.fn<DesktopBridge['getConversation']>(async (request) => {
    if (request.scope === 'collaboration-markdown')
      return {
        ok: true,
        value: markdownPage(task, 'The historical review conclusion is preserved.'),
      }
    if (request.scope !== 'collaboration') throw new Error(`Unexpected ${request.scope}`)
    return { ok: true, value: reportPage(task, { actionable: false }) }
  })
  vi.stubGlobal('pact', { ...composerBridgeFixture(), getConversation: read })
  const view = render(<ConversationView {...props} />)
  await screen.findByText('The historical review conclusion is preserved.')
  const summary = view.container.querySelector<HTMLElement>('[data-pact-report-key="summary"]')!
  expect(summary.dataset.pactReportRunId).toBe(run.id)
  expect(window.getSelection()?.toString()).toBe('')
  const sourceBefore = summary.querySelector('[data-pact-projection-start]')!.firstChild!
  const position = vi.spyOn(virtualState.instance!, 'scrollToOffset')
  view.rerender(<ConversationView {...props} history={{ ...props.history, loadingPage: false }} />)
  await waitFor(() => expect(window.getSelection()?.toString()).toBe('historical review'))
  const selected = window.getSelection()!.getRangeAt(0)
  expect(selected.startContainer).toBe(sourceBefore)
  expect(selected.startOffset).toBe(4)
  expect(selected.endOffset).toBe(21)
  expect(position).toHaveBeenCalledOnce()
  expect(screen.getByText('The historical review conclusion is preserved.')).toBeDefined()
  view.rerender(
    <ConversationView
      {...props}
      composer="A separate current draft"
      history={{ ...props.history, loadingPage: false }}
    />,
  )
  expect(screen.getByText('The historical review conclusion is preserved.')).toBeDefined()
  expect(position).toHaveBeenCalledOnce()
  window.getSelection()?.removeAllRanges()
})

it('cancels a superseded report reveal frame and applies only the latest navigation through prop churn', async () => {
  window.getSelection()?.removeAllRanges()
  const frames = new Map<number, FrameRequestCallback>()
  let frameId = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = ++frameId
    frames.set(id, callback)
    return id
  })
  const cancel = vi.fn<(id: number) => void>((id) => {
    frames.delete(id)
  })
  vi.stubGlobal('cancelAnimationFrame', cancel)
  const { props, run } = recordingFixture()
  const { task } = collaborationFixture()
  task.sessionId = props.session.id
  task.runId = run.id
  task.taskMessageId = run.userMessageId
  task.actor = 'claude'
  task.stage = 'plan_review'
  task.review = {
    runId: run.id,
    actor: 'claude',
    stage: 'plan_review',
    verdict: 'accepted',
    inputSequence: 0,
    planReference: task.planReference,
    document: task.planReference?.document ?? task.reviewScopeRef!,
  }
  run.agentId = 'claude'
  run.nativeEffectsState = 'settled'
  run.collaboration = { taskId: task.id, kind: task.kind, stage: task.stage }
  delete run.workspaceChanges
  props.snapshot!.messages[0]!.runId = run.id
  props.snapshot!.nativeContexts = []
  props.history.window!.latestRun = { ...run, id: crypto.randomUUID() }
  props.history.window!.sourceMessageId = run.userMessageId
  props.history.loadingPage = true
  props.messageNavigation = {
    navigationId: 'first-report-source',
    messageId: run.userMessageId,
    report: { runId: run.id, target: { type: 'summary' } },
    startOffset: 4,
    endOffset: 21,
  }
  vi.stubGlobal('pact', {
    ...composerBridgeFixture(),
    getConversation: vi
      .fn<DesktopBridge['getConversation']>()
      .mockImplementation(async (request) => ({
        ok: true,
        value:
          request.scope === 'collaboration-markdown'
            ? markdownPage(task, 'The historical review conclusion is preserved.')
            : reportPage(task, { actionable: false }),
      })),
  })
  const view = render(<ConversationView {...props} />)
  await screen.findByText('The historical review conclusion is preserved.')
  const position = vi.spyOn(virtualState.instance!, 'scrollToOffset')
  const readyHistory = { ...props.history, loadingPage: false }
  view.rerender(<ConversationView {...props} history={readyHistory} />)
  expect(frames.size).toBeGreaterThan(0)
  expect(window.getSelection()?.toString()).toBe('')
  const latestNavigation = {
    ...props.messageNavigation,
    navigationId: 'latest-report-source',
    startOffset: 22,
    endOffset: 32,
  }
  view.rerender(
    <ConversationView {...props} history={readyHistory} messageNavigation={latestNavigation} />,
  )
  expect(cancel).toHaveBeenCalled()
  view.rerender(
    <ConversationView
      {...props}
      history={readyHistory}
      messageNavigation={latestNavigation}
      composer="A separate draft during navigation"
    />,
  )
  await screen.findByText('The historical review conclusion is preserved.')
  await act(async () => {
    const readyFrames = [...frames]
    for (const [id, callback] of readyFrames) {
      frames.delete(id)
      callback(0)
    }
  })
  expect(window.getSelection()?.toString()).toBe('conclusion')
  const selected = window.getSelection()!.getRangeAt(0)
  expect(selected.startOffset).toBe(22)
  expect(selected.endOffset).toBe(32)
  expect(position).toHaveBeenCalledOnce()
  view.rerender(
    <ConversationView
      {...props}
      history={readyHistory}
      messageNavigation={latestNavigation}
      composer="A separate draft after navigation"
    />,
  )
  await act(async () => {
    const readyFrames = [...frames]
    for (const [id, callback] of readyFrames) {
      frames.delete(id)
      callback(0)
    }
  })
  expect(position).toHaveBeenCalledOnce()
  window.getSelection()?.removeAllRanges()
})

it('keeps a previously accepted code review waiting when a newer input is Received', async () => {
  const { props, run } = recordingFixture()
  const { task } = collaborationFixture()
  task.sessionId = props.session.id
  task.runId = run.id
  task.taskMessageId = run.userMessageId
  task.kind = 'review'
  task.stage = 'code_review'
  task.actor = 'claude'
  task.status = 'waiting'
  task.planVersion = 0
  task.inputSequence = 2
  task.handledInputSequence = 1
  task.reviewScopeRef = {
    id: crypto.randomUUID(),
    sha256: 'c'.repeat(64),
    bytes: 100,
    chars: 100,
  }
  delete task.planReference
  task.review = {
    runId: run.id,
    actor: 'claude',
    stage: 'code_review',
    verdict: 'accepted',
    inputSequence: 1,
    document: task.reviewScopeRef,
  }
  run.agentId = 'claude'
  run.nativeEffectsState = 'settled'
  run.collaboration = { taskId: task.id, kind: task.kind, stage: task.stage }
  delete run.workspaceChanges
  props.snapshot!.messages[0]!.runId = run.id
  props.snapshot!.nativeContexts = []
  const bridge = {
    ...composerBridgeFixture(),
    getConversation: vi.fn<DesktopBridge['getConversation']>().mockResolvedValue({
      ok: true,
      value: reportPage(task, {
        received: {
          id: crypto.randomUUID(),
          actor: 'claude',
          state: 'accepted',
          preview: 'Review the new user feedback.',
        },
      }),
    }),
    actOnCollaboration: vi.fn<DesktopBridge['actOnCollaboration']>(),
  }
  vi.stubGlobal('pact', bridge)
  render(<ConversationView {...props} />)
  await screen.findByRole('region', { name: 'Pact collaboration result' })
  expect(screen.queryByText('· Complete')).toBeNull()
  expect(screen.queryByText('Review complete')).toBeNull()
  expect(screen.getAllByRole('button', { name: 'Continue collaboration' })).toHaveLength(1)
  expect(bridge.actOnCollaboration).not.toHaveBeenCalled()
  expect(task.status).toBe('waiting')
})

it('reports plan availability only after the first complete plan has been submitted', async () => {
  const { props, run } = recordingFixture()
  run.status = 'running'
  run.collaboration = { taskId: crypto.randomUUID(), kind: 'plan', stage: 'plan' }
  delete run.workspaceChanges
  props.snapshot!.nativeContexts = []
  props.onPlanAvailable =
    vi.fn<NonNullable<ComponentProps<typeof ConversationView>['onPlanAvailable']>>()
  const task = collaborationTaskSchema.parse({
    protocol: 'native-workflow-v1',
    owner: 'codex',
    automation: 'paused',
    inputSequence: 0,
    handledInputSequence: 0,
    id: run.collaboration.taskId,
    sessionId: props.session.id,
    runId: run.id,
    taskMessageId: run.userMessageId,
    kind: 'plan',
    revision: 1,

    reviewer: 'claude',
    task: 'Draft ownership',
    stage: 'plan',
    actor: 'codex',
    status: 'running',
    planVersion: 0,
    discussionRounds: 0,

    reviewCycles: 0,
    repairAttempts: 0,
  })
  const read = vi.fn<DesktopBridge['getConversation']>().mockResolvedValue({
    ok: true,
    value: {
      scope: 'collaboration',
      sessionId: props.session.id,
      view: {
        availableActions: [],
        task,
        actionable: false,
        accepted: false,
        reportAvailable: false,
      },
    },
  })
  vi.stubGlobal('pact', { ...composerBridgeFixture(), getConversation: read })
  const view = render(<ConversationView {...props} />)
  await waitFor(() =>
    expect(props.onPlanAvailable).toHaveBeenCalledWith(props.session.id, undefined),
  )
  expect(screen.queryByRole('button', { name: 'Open current plan' })).toBeNull()
  task.planReference = {
    version: 1,
    sourceRunId: run.id,
    sourceMessageId: run.userMessageId,
    document: { id: crypto.randomUUID(), sha256: 'a'.repeat(64), chars: 20, bytes: 20 },
  }
  task.planVersion = 1
  task.status = 'waiting'
  run.status = 'completed'
  run.nativeEffectsState = 'settled'
  run.updatedAt = '2026-10-10T02:00:00.000Z'
  read.mockResolvedValue({
    ok: true,
    value: {
      scope: 'collaboration',
      sessionId: props.session.id,
      view: {
        task,
        availableActions: [],
        actionable: true,
        accepted: true,
        reportAvailable: true,
        planSource: { runId: run.id, messageId: run.userMessageId },
      },
    },
  })
  view.rerender(<ConversationView {...props} />)
  await waitFor(() => expect(props.onPlanAvailable).toHaveBeenCalledWith(props.session.id, task.id))
})

it.each([
  'Review the current plan and feedback.',
  'Update the current plan using the feedback.',
  'Continue with these user decisions: Choose native delivery.',
  'Draft the plan.',
  'Implement plan v2.',
  'Review the current implementation.',
  'Respond to the Review opinions without editing code.',
  'Repair the Review opinions within this task.',
])(
  'renders and copies the durable generated request %s without inventing a protocol footer',
  async (request) => {
    const { props, run } = recordingFixture()
    delete run.workspaceChanges
    props.snapshot!.nativeContexts = []
    run.collaboration = { taskId: crypto.randomUUID(), kind: 'plan', stage: 'plan_review' }
    const user = props.snapshot!.messages[0]!
    user.runId = run.id
    const visible = `@codex ${request}`
    const content = visible
    user.content = content
    vi.stubGlobal('pact', {
      ...composerBridgeFixture(),
      getConversation: vi.fn<DesktopBridge['getConversation']>().mockResolvedValue({
        ok: true,
        value: {
          scope: 'collaboration',
          sessionId: props.session.id,
          view: {
            availableActions: [],
            task: null,
            actionable: false,
            accepted: false,
            reportAvailable: false,
          },
        },
      }),
    })
    const writeText = vi.fn<(content: string) => Promise<void>>().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const { container } = render(<ConversationView {...props} />)
    await waitFor(() => expect(container.textContent).toContain(visible))
    expect(container.textContent).not.toMatch(/Submit plan_submission|reviewedPlan|verdict:/u)
    fireEvent.click(screen.getByRole('button', { name: 'Copy You message' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(visible))
    expect(user.content).toBe(content)
    if (request !== 'Review the current plan and feedback.') return
    const host = container.querySelector<HTMLElement>('[data-pact-message-content]')!
    expect(focusProjectionRange(host, 0, 6, { scroll: false, highlight: false })).toBe(true)
    fireEvent.keyUp(host)
    fireEvent.click(screen.getByRole('button', { name: 'Comment on selected text' }))
    await screen.findByRole('textbox', { name: 'Comment' })
    fireEvent.change(screen.getByRole('textbox', { name: 'Comment' }), {
      target: { value: 'Preserve this request.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add to comment' }))
    const digest = await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(content))
    const hash = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('')
    await waitFor(() =>
      expect(props.onSaveCommentDraft).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: 'create',
          anchor: expect.objectContaining({
            contentHash: hash,
            startOffset: 0,
            endOffset: 6,
            quote: '@codex',
          }),
        }),
      ),
    )
  },
)

it('preserves the visible row when an asynchronous offscreen card changes height during upward scrolling', async () => {
  virtualState.interactive = true
  const props = fixture()
  props.snapshot!.messages = Array.from({ length: 20 }, (_, sequence) => ({
    id: crypto.randomUUID(),
    sessionId: props.session.id,
    role: 'system' as const,
    content: `Visible record ${sequence}`,
    contentRevision: 0,
    state: 'complete' as const,
    sequence,
    createdAt: props.session.createdAt,
    updatedAt: props.session.updatedAt,
  }))
  const { container } = render(<ConversationView {...props} />)
  const transcript = container.querySelector<HTMLElement>('[data-pact-transcript]')!
  Object.defineProperties(transcript, {
    scrollHeight: { configurable: true, value: 4000 },
    clientHeight: { configurable: true, value: 600 },
  })
  await waitFor(() => expect(virtualState.instance?.itemSizeCache.size).toBeGreaterThan(0))
  await act(async () => {
    transcript.scrollTop = 1100
    fireEvent.scroll(transcript)
    fireEvent.wheel(transcript, { deltaY: -100 })
    transcript.scrollTop = 900
    fireEvent.scroll(transcript)
  })
  const virtualizer = virtualState.instance!
  const before = virtualizer.getVirtualItems().find((row) => row.index === 12)!
  expect(before).toBeDefined()
  const anchoredPixel = before.start - transcript.scrollTop
  await act(async () => virtualizer.resizeItem(0, 274))
  expect(transcript.scrollTop).toBe(1074)
  const after = virtualizer.getVirtualItems().find((row) => row.index === 12)!
  expect(after.start - transcript.scrollTop).toBe(anchoredPixel)
  // A current visible row grows in place rather than shifting the user's reading position.
  await act(async () => virtualizer.resizeItem(12, 420))
  expect(transcript.scrollTop).toBe(1074)
  expect(
    virtualizer.getVirtualItems().find((row) => row.index === 12)!.start - transcript.scrollTop,
  ).toBe(anchoredPixel)
  await act(async () => virtualizer.resizeItem(0, 100))
  expect(transcript.scrollTop).toBe(900)
  expect(
    virtualizer.getVirtualItems().find((row) => row.index === 12)!.start - transcript.scrollTop,
  ).toBe(anchoredPixel)
})

it.each([
  { actor: 'codex', inferred: false },
  { actor: 'claude', inferred: false },
  { actor: 'codex', inferred: true },
  { actor: 'claude', inferred: true },
] as const)(
  'routes document-backed feedback through the single Send to $actor (inferred: $inferred)',
  async ({ actor, inferred }) => {
    const { task, run } = collaborationFixture()
    task.planReference!.document = {
      id: crypto.randomUUID(),
      sha256: 'a'.repeat(64),
      bytes: 30000,
      chars: 30000,
    }
    const props = fixture()
    props.session.id = task.sessionId
    props.snapshot!.sessionId = task.sessionId
    props.snapshot!.messages = [
      {
        id: run.userMessageId,
        sessionId: task.sessionId,
        role: 'user',
        content: '/plan Define cancellation.',
        contentRevision: 0,
        state: 'complete',
        sequence: 0,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
        runId: run.id,
      },
    ]
    props.snapshot!.runs = [run]
    props.history.window!.latestRun = run
    props.composer = `@${actor} Address this review point.`
    if (inferred) {
      props.composerRoute = { type: 'agent', agentId: actor }
      props.composerMention = {
        route: props.composerRoute,
        token: `@${actor}`,
        start: 0,
        end: actor.length + 1,
      }
    }
    const planRead = Promise.withResolvers<Awaited<ReturnType<DesktopBridge['getConversation']>>>()
    props.onPlanAvailable = vi.fn<NonNullable<typeof props.onPlanAvailable>>()
    vi.stubGlobal('pact', {
      ...composerBridgeFixture(),
      getConversation: vi.fn<DesktopBridge['getConversation']>().mockReturnValue(planRead.promise),
    })
    render(<ConversationView {...props} />)
    expect(props.onSend).not.toHaveBeenCalled()
    await act(async () => {
      planRead.resolve({
        ok: true,
        value: reportPage(task, { planSource: { runId: run.id, messageId: run.userMessageId } }),
      })
    })
    await waitFor(() => expect(props.onPlanAvailable).toHaveBeenCalledWith(task.sessionId, task.id))
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() =>
      expect(props.onSend).toHaveBeenCalledWith(
        props.composer,
        [],
        { type: 'agent', agentId: actor },
        [],
      ),
    )
    expect(screen.queryByRole('button', { name: 'Review plan · Claude Code' })).toBeNull()
  },
)

function fixture(): ComponentProps<typeof ConversationView> {
  const sessionId = crypto.randomUUID()
  const timestamp = new Date().toISOString()
  const page: Extract<ConversationPage, { scope: 'messages' }> = {
    scope: 'messages',
    sessionId,
    observation: { incarnation: crypto.randomUUID(), sequence: 1 },
    header: {
      session: {
        id: sessionId,
        title: 'Fixture',
        titleSource: 'local',
        status: 'idle',
        activity: { state: 'idle' },
        hasUnread: false,
        updatedAt: timestamp,
      },
      commentsRevision: 0,
      sessionIssues: { sessionId, inputGate: 'open', agents: [] },
    },
    messages: [],
    runs: [],
    hasOlder: false,
    hasNewer: false,
  }
  const window = windowFromPage(page)
  return {
    visible: true,
    session: {
      ...page.header.session,
      projectId: crypto.randomUUID(),
      settingsRevision: 1,
      createdAt: timestamp,
      settings: {
        primaryAgentId: 'codex',
        agents: { codex: { model: null, effort: null }, claude: { model: null, effort: null } },
        maxDiscussionRounds: 3,

        maxReviewCycles: 3,
        maxRepairAttempts: 3,
      },
    },
    snapshot: window.view,
    history: {
      window,
      protectReading: vi.fn<ComponentProps<typeof ConversationView>['history']['protectReading']>(),
      readingPositionLost: false,
      loadingPage: false,
      gapRecoveryPending: false,
      draftLimitExceeded: false,
      draftsLoading: false,
      draftError: false,
      retryDrafts: vi.fn<ComponentProps<typeof ConversationView>['history']['retryDrafts']>(),
      retryComments: vi.fn<ComponentProps<typeof ConversationView>['history']['retryComments']>(),
      retryRead: vi.fn<ComponentProps<typeof ConversationView>['history']['retryRead']>(),
      oversizedActivities: {},
      loadOlder: vi
        .fn<ComponentProps<typeof ConversationView>['history']['loadOlder']>()
        .mockResolvedValue(undefined),
      loadLatest: vi
        .fn<ComponentProps<typeof ConversationView>['history']['loadLatest']>()
        .mockResolvedValue(undefined),
      recoverFromGap: vi
        .fn<ComponentProps<typeof ConversationView>['history']['recoverFromGap']>()
        .mockResolvedValue(undefined),
      historyResyncToken: 0,
      ensureMessage: vi
        .fn<ComponentProps<typeof ConversationView>['history']['ensureMessage']>()
        .mockResolvedValue(undefined),
      loadActivities: vi
        .fn<ComponentProps<typeof ConversationView>['history']['loadActivities']>()
        .mockResolvedValue(undefined),
      loadRunArtifacts: vi
        .fn<ComponentProps<typeof ConversationView>['history']['loadRunArtifacts']>()
        .mockResolvedValue(undefined),
      closeRunArtifacts:
        vi.fn<ComponentProps<typeof ConversationView>['history']['closeRunArtifacts']>(),
      loadMoreActivityBody:
        vi.fn<ComponentProps<typeof ConversationView>['history']['loadMoreActivityBody']>(),
    },
    composer: '',
    onComposerChange: vi.fn<ComponentProps<typeof ConversationView>['onComposerChange']>(),
    onComposerMentionChange:
      vi.fn<ComponentProps<typeof ConversationView>['onComposerMentionChange']>(),
    loading: false,
    sending: false,
    stopping: false,
    agentActionsEnabled: true,
    onSend: vi.fn<ComponentProps<typeof ConversationView>['onSend']>().mockResolvedValue(true),
    onSaveCommentDraft: vi
      .fn<ComponentProps<typeof ConversationView>['onSaveCommentDraft']>()
      .mockResolvedValue(true),
    onRemoveCommentDraft: vi
      .fn<ComponentProps<typeof ConversationView>['onRemoveCommentDraft']>()
      .mockResolvedValue(true),
    onStop: vi.fn<ComponentProps<typeof ConversationView>['onStop']>().mockResolvedValue(true),
    onRebuildNativeContext: vi
      .fn<ComponentProps<typeof ConversationView>['onRebuildNativeContext']>()
      .mockResolvedValue(false),
    onCheckNativeContext: vi
      .fn<ComponentProps<typeof ConversationView>['onCheckNativeContext']>()
      .mockResolvedValue(false),
    onAcceptPeerProposal: vi
      .fn<ComponentProps<typeof ConversationView>['onAcceptPeerProposal']>()
      .mockResolvedValue(true),
    onDismissPeerProposal: vi
      .fn<ComponentProps<typeof ConversationView>['onDismissPeerProposal']>()
      .mockResolvedValue(true),
    onUndoWorkspaceChanges: vi
      .fn<ComponentProps<typeof ConversationView>['onUndoWorkspaceChanges']>()
      .mockResolvedValue(true),
    onRespondNativeInput: vi
      .fn<ComponentProps<typeof ConversationView>['onRespondNativeInput']>()
      .mockResolvedValue(true),
    nativeInputDrafts: {},
    onNativeInputDraftChange:
      vi.fn<ComponentProps<typeof ConversationView>['onNativeInputDraftChange']>(),
    onRespondNativePermission: vi
      .fn<ComponentProps<typeof ConversationView>['onRespondNativePermission']>()
      .mockResolvedValue(true),
    onOpenWorkspaceChanges:
      vi.fn<ComponentProps<typeof ConversationView>['onOpenWorkspaceChanges']>(),
    onPrepareWorkspaceChanges: vi
      .fn<ComponentProps<typeof ConversationView>['onPrepareWorkspaceChanges']>()
      .mockReturnValue(1),
    onOpenProjectFile: vi.fn<ComponentProps<typeof ConversationView>['onOpenProjectFile']>(),
    onOpenComment: vi.fn<ComponentProps<typeof ConversationView>['onOpenComment']>(),
    onNotice: vi.fn<ComponentProps<typeof ConversationView>['onNotice']>(),
  }
}

function recordingFixture() {
  const props = fixture()
  const userMessageId = crypto.randomUUID()
  const run: AgentRun = {
    id: crypto.randomUUID(),
    sessionId: props.session.id,
    userMessageId,
    agentId: 'codex',
    status: 'completed',
    attemptCount: 1,
    settingsRevision: 1,
    model: null,
    effort: null,
    dispatchPhase: 'ended',
    nativeOutcome: 'completed',
    nativeEffectsState: 'pending',
    bindingGeneration: 1,
    nativeSessionId: 'healthy-server-owner',
    createdAt: props.session.createdAt,
    updatedAt: props.session.updatedAt,
  }
  const changeSet: WorkspaceChangeSet = {
    id: crypto.randomUUID(),
    runId: run.id,
    sessionId: props.session.id,
    projectId: props.session.projectId,
    agentId: 'codex',
    state: 'recording',
    revision: 1,
    fileCount: 1,
    additions: 2,
    deletions: 1,
    undoUnavailableReason: null,
    createdAt: props.session.createdAt,
    finalizedAt: null,
  }
  run.workspaceChanges = changeSet
  props.snapshot!.runs = [run]
  props.snapshot!.messages = [
    {
      id: userMessageId,
      sessionId: props.session.id,
      role: 'user',
      content: 'Edit and start the development server.',
      contentRevision: 0,
      state: 'complete',
      sequence: 0,
      createdAt: props.session.createdAt,
      updatedAt: props.session.updatedAt,
    },
  ]
  props.snapshot!.nativeContexts = [
    {
      sessionId: props.session.id,
      agentId: 'codex',
      nativeSessionId: run.nativeSessionId!,
      bindingGeneration: 1,
      lastRunId: run.id,
      state: 'active',
      continuationState: 'ready',
      updatedAt: props.session.updatedAt,
    },
  ]
  props.history.window!.latestRun = run
  props.history.window!.runArtifacts = [
    { userMessageId, agentId: 'codex', latestRunId: run.id, totalCount: 1 },
  ]
  const readWorkspaceChanges = vi.fn<DesktopBridge['readWorkspaceChanges']>().mockResolvedValue({
    ok: true,
    value: {
      changeSet,
      nextPath: null,
      files: [
        {
          path: 'src/main.ts',
          previousPath: null,
          kind: 'modified',
          before: { hash: 'a'.repeat(64), bytes: 10, mode: 420 },
          after: { hash: 'b'.repeat(64), bytes: 20, mode: 420 },
          additions: 2,
          deletions: 1,
          hidden: false,
          reason: null,
        },
      ],
    },
  })
  vi.stubGlobal('pact', { ...composerBridgeFixture(), readWorkspaceChanges })
  return { props, run, changeSet, readWorkspaceChanges }
}

it('does not expose a recording changes card while the model root is still responding', () => {
  const { props, run, readWorkspaceChanges } = recordingFixture()
  run.status = 'running'
  run.dispatchPhase = 'accepted'
  run.nativeOutcome = undefined
  props.snapshot!.nativeContexts[0]!.continuationState = 'responding'
  render(<ConversationView {...props} />)
  expect(screen.queryByRole('region', { name: 'Changes from this response' })).toBeNull()
  expect(readWorkspaceChanges).not.toHaveBeenCalled()
})

it('shows recorded changes after the root ends, even without a body, and permits review but not Undo', async () => {
  const { props, readWorkspaceChanges } = recordingFixture()
  render(<ConversationView {...props} />)
  expect(await screen.findByRole('region', { name: 'Changes from this response' })).toBeDefined()
  expect(
    screen.getByText(
      'Background work is still being observed. You can review recorded changes; Undo is unavailable until recording settles.',
    ),
  ).toBeDefined()
  const undo = screen.getByRole<HTMLButtonElement>('button', { name: 'Undo' })
  expect(undo.disabled).toBe(true)
  fireEvent.click(undo)
  expect(props.onUndoWorkspaceChanges).not.toHaveBeenCalled()
  await waitFor(() => expect(readWorkspaceChanges).toHaveBeenCalledTimes(1))
  fireEvent.click(screen.getByRole('button', { name: 'View changes' }))
  await waitFor(() =>
    expect(props.onOpenWorkspaceChanges).toHaveBeenCalledWith(
      props.snapshot!.runs[0]!.workspaceChanges!.id,
      'src/main.ts',
      1,
      1,
    ),
  )
  expect(screen.queryByRole('button', { name: 'Rebuild' })).toBeNull()
  expect(props.snapshot!.nativeContexts[0]!.continuationState).toBe('ready')
})

it('shows an unavailable recording warning without inventing a zero-file card or a native rebuild problem', async () => {
  const { props, run } = recordingFixture()
  run.workspaceChanges = undefined
  run.workspaceRecordingUnavailableReason =
    'Saved changes could not be recorded. Native work and your response are unchanged.'
  const nativeState = structuredClone(props.snapshot!.nativeContexts)
  render(<ConversationView {...props} />)
  expect(await screen.findByText(run.workspaceRecordingUnavailableReason)).toBeDefined()
  expect(screen.queryByRole('region', { name: 'Changes from this response' })).toBeNull()
  expect(screen.queryByText(/Edited 0 files/u)).toBeNull()
  expect(screen.queryByRole('button', { name: 'Rebuild' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Retry check' })).toBeNull()
  expect(props.snapshot!.nativeContexts).toEqual(nativeState)
})

it('reuses the same recorded revision, but reloads a newer revision from its first page while keeping expansion', async () => {
  const { props, run, changeSet, readWorkspaceChanges } = recordingFixture()
  changeSet.fileCount = 4
  const initialFile = {
    path: 'src/main.ts',
    previousPath: null,
    kind: 'modified' as const,
    before: { hash: 'a'.repeat(64), bytes: 10, mode: 420 },
    after: { hash: 'b'.repeat(64), bytes: 20, mode: 420 },
    additions: 2,
    deletions: 1,
    hidden: false,
    reason: null,
  }
  readWorkspaceChanges.mockResolvedValueOnce({
    ok: true,
    value: {
      changeSet,
      nextPath: 'src/third.ts',
      files: [
        initialFile,
        { ...initialFile, path: 'src/second.ts' },
        { ...initialFile, path: 'src/third.ts' },
      ],
    },
  })
  const rendered = render(<ConversationView {...props} />)
  await screen.findByText('src/main.ts')
  fireEvent.click(screen.getByRole('button', { name: 'Show 1 more file' }))
  fireEvent.click(screen.getByRole('button', { name: 'View changes' }))
  await waitFor(() => expect(props.onOpenWorkspaceChanges).toHaveBeenCalledTimes(1))
  expect(readWorkspaceChanges).toHaveBeenCalledTimes(1)
  const file = vi.mocked(readWorkspaceChanges).mock.results[0]!
  const firstReply = await file.value
  if (!firstReply.ok) throw new Error('Fixture files missing')
  const newer = { ...changeSet, revision: 2 }
  readWorkspaceChanges.mockResolvedValue({
    ok: true,
    value: {
      changeSet: newer,
      nextPath: null,
      files: [...firstReply.value.files, { ...firstReply.value.files[0]!, path: 'src/new.ts' }],
    },
  })
  props.snapshot = { ...props.snapshot!, runs: [{ ...run, workspaceChanges: newer }] }
  props.history.window!.latestRun = props.snapshot.runs[0]
  rendered.rerender(<ConversationView {...props} />)
  await screen.findByText('src/new.ts')
  expect(readWorkspaceChanges).toHaveBeenCalledTimes(2)
  expect(readWorkspaceChanges).toHaveBeenLastCalledWith({ changeSetId: changeSet.id })
  rendered.rerender(<ConversationView {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'View changes' }))
  await waitFor(() => expect(props.onOpenWorkspaceChanges).toHaveBeenCalledTimes(2))
  expect(readWorkspaceChanges).toHaveBeenCalledTimes(2)
})

it('ignores an old in-flight file-list response after the recorded revision advances', async () => {
  const { props, run, changeSet, readWorkspaceChanges } = recordingFixture()
  const stale = Promise.withResolvers<Awaited<ReturnType<DesktopBridge['readWorkspaceChanges']>>>()
  readWorkspaceChanges.mockReturnValueOnce(stale.promise)
  const rendered = render(<ConversationView {...props} />)
  await waitFor(() => expect(readWorkspaceChanges).toHaveBeenCalledTimes(1))
  const newer = { ...changeSet, revision: 2 }
  readWorkspaceChanges.mockResolvedValue({
    ok: true,
    value: {
      changeSet: newer,
      nextPath: null,
      files: [
        {
          path: 'src/current.ts',
          previousPath: null,
          kind: 'modified',
          before: { hash: 'a'.repeat(64), bytes: 10, mode: 420 },
          after: { hash: 'b'.repeat(64), bytes: 20, mode: 420 },
          additions: 2,
          deletions: 1,
          hidden: false,
          reason: null,
        },
      ],
    },
  })
  props.snapshot = { ...props.snapshot!, runs: [{ ...run, workspaceChanges: newer }] }
  props.history.window!.latestRun = props.snapshot.runs[0]
  rendered.rerender(<ConversationView {...props} />)
  await act(async () =>
    stale.resolve({
      ok: true,
      value: {
        changeSet,
        nextPath: null,
        files: [
          {
            path: 'src/stale.ts',
            previousPath: null,
            kind: 'modified',
            before: { hash: 'a'.repeat(64), bytes: 10, mode: 420 },
            after: { hash: 'b'.repeat(64), bytes: 20, mode: 420 },
            additions: 2,
            deletions: 1,
            hidden: false,
            reason: null,
          },
        ],
      },
    }),
  )
  await screen.findByText('src/current.ts')
  expect(screen.queryByText('src/stale.ts')).toBeNull()
  expect(readWorkspaceChanges).toHaveBeenCalledTimes(2)
  expect(readWorkspaceChanges).toHaveBeenLastCalledWith({ changeSetId: changeSet.id })
})

it('checks the candidate named by the backend and requires a fresh confirmation before another creation', async () => {
  const props = fixture()
  const operation = {
    id: crypto.randomUUID(),
    oldGeneration: 1,
    stage: 'unconfirmed' as const,
    provisionalNativeSessionId: 'candidate',
  }
  const issue = {
    agentId: 'claude' as const,
    generation: 1,
    rebuildId: operation.id,
    phase: 'unconfirmed' as const,
    title: 'Claude Code session not confirmed',
    reason: 'Pact couldn’t confirm the new session.',
    inputDisposition: 'not_submitted' as const,
    resultDisposition: 'pending' as const,
    action: 'inspect_rebuild' as const,
    abandon: false,
    previousCreationUnconfirmed: true,
  }
  props.snapshot!.rebuildOperations = [{ agentId: 'claude', operation }]
  props.snapshot!.sessionIssues = {
    sessionId: props.session.id,
    inputGate: 'read_only',
    agents: [issue],
  }
  const rendered = render(<ConversationView {...props} />)
  expect(screen.getAllByRole('region', { name: 'Session recovery' })).toHaveLength(1)
  expect(screen.queryByRole('button', { name: 'Rebuild…' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await waitFor(() =>
    expect(props.onRebuildNativeContext).toHaveBeenCalledWith('claude', {
      intent: 'inspect',
      clientOperationId: operation.id,
      expectedGeneration: 1,
    }),
  )
  await waitFor(() =>
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Retry' }).disabled).toBe(false),
  )
  // The Renderer cannot invent a different recovery action from a failed callback.
  expect(screen.queryByRole('button', { name: 'Rebuild…' })).toBeNull()
  props.snapshot = {
    ...props.snapshot!,
    sessionIssues: {
      sessionId: props.session.id,
      inputGate: 'read_only',
      agents: [{ ...issue, action: 'rebuild' }],
    },
  }
  rendered.rerender(<ConversationView {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'Rebuild…' }))
  expect(screen.queryByText(issue.reason)).toBeNull()
  expect(screen.getByText('The previous attempt may already have created a session.')).toBeDefined()
  let resolve!: (accepted: boolean) => void
  props.onRebuildNativeContext = vi.fn<
    ComponentProps<typeof ConversationView>['onRebuildNativeContext']
  >(
    () =>
      new Promise<boolean>((done) => {
        resolve = done
      }),
  )
  rendered.rerender(<ConversationView {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'Confirm rebuild' }))
  fireEvent.click(screen.getByRole('button', { name: 'Rebuilding…' }))
  expect(props.onRebuildNativeContext).toHaveBeenCalledTimes(1)
  const create = vi.mocked(props.onRebuildNativeContext).mock.calls[0]![1]!
  expect(create).toMatchObject({
    intent: 'create',
    expectedGeneration: 1,
    expectedRunId: null,
    expectedRebuildId: operation.id,
    abandon: false,
  })
  await act(async () => resolve(false))
  fireEvent.click(screen.getByRole('button', { name: 'Confirm rebuild' }))
  expect(vi.mocked(props.onRebuildNativeContext).mock.calls[1]![1]?.clientOperationId).toBe(
    create.clientOperationId,
  )
  await act(async () => resolve(false))
  props.snapshot = {
    ...props.snapshot,
    sessionIssues: {
      sessionId: props.session.id,
      inputGate: 'read_only',
      agents: [{ ...issue, generation: 2, rebuildId: crypto.randomUUID(), action: 'rebuild' }],
    },
  }
  rendered.rerender(<ConversationView {...props} />)
  expect(screen.queryByRole('button', { name: 'Confirm rebuild' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Rebuild…' })).toBeDefined()
})

it.each(['read_only', 'send_blocked', 'open'] as const)(
  'honors the %s input gate without offering session reexecution',
  (inputGate) => {
    const props = fixture()
    props.composer = 'Preserved draft'
    props.snapshot!.sessionIssues = { sessionId: props.session.id, inputGate, agents: [] }
    render(<ConversationView {...props} />)
    expect(screen.getByRole('combobox', { name: 'Message' }).getAttribute('aria-disabled')).toBe(
      String(inputGate === 'read_only'),
    )
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Send message' }).disabled).toBe(
      inputGate !== 'open',
    )
    expect(screen.getByRole('combobox', { name: 'Message' }).textContent).toBe('Preserved draft')
    expect(screen.queryByRole('button', { name: 'Reexecute…' })).toBeNull()
  },
)

it.each(['accept', 'cancel'] as const)(
  'replaces the composer with a native question and restores its draft after %s',
  async (action) => {
    const props = fixture()
    props.composer = 'Keep this ordinary draft'
    const request = {
      id: crypto.randomUUID(),
      operationId: crypto.randomUUID(),
      kind: 'questions' as const,
      title: 'Sort notes',
      detail: '',
      createdAt: new Date().toISOString(),
    }
    props.snapshot!.pendingNativeInteractions = [
      { agentId: 'claude', bindingGeneration: 1, request },
    ]
    props.nativeInputDrafts = {
      [request.id]: {
        operationId: request.operationId,
        agentId: 'claude',
        expiresAt: Date.now() + 60000,
        values: { order: 'recent' },
        page: 0,
      },
    }
    const read = vi.fn<DesktopBridge['readNativeInput']>().mockResolvedValue({
      ok: true,
      value: {
        kind: 'questions',
        title: 'Sort notes',
        message: '',
        fields: [
          {
            id: 'order',
            type: 'select',
            label: 'Sort order',
            required: true,
            options: [
              { value: 'recent', label: 'Recently edited' },
              { value: 'title', label: 'Title order' },
            ],
            allowOther: true,
          },
        ],
      },
    })
    vi.stubGlobal('pact', { ...composerBridgeFixture(), readNativeInput: read })
    const mounted = render(<ConversationView {...props} />)
    await screen.findByRole('radio', { name: 'Recently edited' })
    expect(read).toHaveBeenCalledExactlyOnceWith({
      operationId: request.operationId,
      requestId: request.id,
    })
    expect(screen.queryByRole('button', { name: 'Send message' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
    expect(screen.queryByText('Your message draft is kept while you answer.')).toBeNull()
    fireEvent.click(
      screen.getByRole('button', { name: action === 'accept' ? 'Submit answers' : 'Cancel' }),
    )
    await waitFor(() =>
      expect(props.onRespondNativeInput).toHaveBeenCalledExactlyOnceWith({
        operationId: request.operationId,
        requestId: request.id,
        action,
        ...(action === 'accept' ? { values: { order: 'recent' } } : {}),
      }),
    )
    expect(props.onSend).not.toHaveBeenCalled()
    expect(props.onStop).not.toHaveBeenCalled()
    expect(props.onComposerChange).not.toHaveBeenCalled()
    mounted.rerender(
      <ConversationView
        {...props}
        snapshot={{ ...props.snapshot!, pendingNativeInteractions: [] }}
      />,
    )
    expect(screen.getByRole('combobox', { name: 'Message' }).textContent).toBe(props.composer)
    expect(screen.queryByRole('region', { name: 'Claude Code native input' })).toBeNull()
  },
)

it('keeps native input cancellation available when details fail and retries the same identity', async () => {
  const props = fixture()
  const request = {
    id: crypto.randomUUID(),
    operationId: crypto.randomUUID(),
    kind: 'questions' as const,
    title: 'Unavailable question',
    detail: '',
    createdAt: new Date().toISOString(),
  }
  props.snapshot!.pendingNativeInteractions = [{ agentId: 'codex', bindingGeneration: 1, request }]
  const read = vi.fn<DesktopBridge['readNativeInput']>().mockResolvedValue({
    ok: false,
    error: { code: 'CONTEXT_UNAVAILABLE', message: 'Request unavailable' },
  })
  vi.stubGlobal('pact', { ...composerBridgeFixture(), readNativeInput: read })
  render(<ConversationView {...props} />)
  await screen.findByRole('alert')
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Submit answers' }).disabled).toBe(
    true,
  )
  expect(screen.queryByRole('button', { name: 'Send message' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2))
  expect(read.mock.calls[1]?.[0]).toEqual({
    operationId: request.operationId,
    requestId: request.id,
  })
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  await waitFor(() =>
    expect(props.onRespondNativeInput).toHaveBeenCalledWith({
      operationId: request.operationId,
      requestId: request.id,
      action: 'cancel',
    }),
  )
})

it.each([false, true])(
  'prioritizes plan recovery over stale question or processing without clearing drafts (pending: %s)',
  async (pending) => {
    const props = fixture()
    const { task, run } = collaborationFixture()
    task.sessionId = props.session.id
    run.sessionId = props.session.id
    task.inputProcessing = {
      decision: {
        runId: run.id,
        inputSequence: 0,
        actor: 'codex',
        questions: [{ id: 'q1', prompt: 'Preserve boundaries?', selection: 'single' }],
      },
      ...(pending ? { pending: { inputId: crypto.randomUUID(), inputSequence: 1 } } : {}),
    }
    if (pending) task.inputSequence = 1
    props.composer = 'Ordinary unsent draft'
    props.history.clearDecisionDraft = vi
      .fn<NonNullable<typeof props.history.clearDecisionDraft>>()
      .mockReturnValue(true)
    props.history.decisionDraft = {
      reference: {
        taskId: task.id,
        runId: run.id,
        decisionInputSequence: 0,
        expectedInputSequence: task.inputSequence,
      },
      questions: task.inputProcessing.decision!.questions!,
      answers: { q1: { optionIds: [], text: 'Keep boundaries' } },
    }
    props.snapshot!.runs = [run]
    props.history.window!.latestRun = run
    const read = vi.fn<DesktopBridge['getConversation']>().mockResolvedValue({
      ok: true,
      value: reportPage(task, {
        planSync: { state: 'recovery_required', kind: 'plan', runId: run.id, retainedVersion: 2 },
        availableActions: [],
      }),
    })
    vi.stubGlobal('pact', { ...composerBridgeFixture(), getConversation: read })
    render(<ConversationView {...props} />)
    await screen.findByRole('region', { name: 'Plan recovery required' })
    expect(screen.queryByText('Preserve boundaries?')).toBeNull()
    expect(screen.queryByRole('region', { name: 'Answer progress' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Send answers' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Send message' })).toBeNull()
    expect(props.history.clearDecisionDraft).not.toHaveBeenCalled()
    expect(props.onComposerChange).not.toHaveBeenCalled()
    expect(props.onSend).not.toHaveBeenCalled()
  },
)

it.each([true, false])(
  'labels decision replies with their actual Codex recipient despite a Claude primary (route recorded: %s)',
  async (recorded) => {
    const { props, run } = recordingFixture()
    props.session.settings.primaryAgentId = 'claude'
    run.collaboration = { taskId: crypto.randomUUID(), kind: 'plan', stage: 'reply' }
    delete run.workspaceChanges
    props.snapshot!.nativeContexts = []
    const message = props.snapshot!.messages[0]!
    message.runId = run.id
    message.content =
      '**Replies to your questions**\n\n**1. Preserve rules?**\n\n**Your answer:**\n\nYes.'
    if (recorded) message.route = { type: 'agent', agentId: 'codex' }
    vi.stubGlobal('pact', {
      ...composerBridgeFixture(),
      getConversation: vi.fn<DesktopBridge['getConversation']>().mockResolvedValue({
        ok: true,
        value: {
          scope: 'collaboration',
          sessionId: props.session.id,
          view: {
            task: null,
            actionable: false,
            accepted: false,
            reportAvailable: false,
            availableActions: [],
          },
        },
      }),
    })
    render(<ConversationView {...props} />)
    expect(await screen.findByText('@codex')).toBeDefined()
    expect(screen.queryByText('@claude')).toBeNull()
    expect(screen.getByText('Replies to your questions').closest('strong')).not.toBeNull()
    expect(screen.getByText('1. Preserve rules?').closest('p')).not.toBe(
      screen.getByText('Your answer:').closest('p'),
    )
  },
)
