import { describe, expect, it } from 'vitest'

import type {
  AgentActivity,
  AgentRun,
  AnchoredComment,
  ConversationMessage,
  ConversationPage,
  ConversationPatch,
} from '@pact/contracts'

import { CONVERSATION_WINDOW_MESSAGES, conversationPatchSchema } from '@pact/contracts'

import {
  mergeActivityPage,
  mergeConversationPatch,
  mergeMessagePage,
  mergeSentComments,
  nativeRecoveryTargets,
  windowFromPage,
} from './conversation-window'

describe('native rebuild projection', () => {
  it('retains an unbound candidate across cold pages and patches without inventing a binding', () => {
    const source = page([])
    const operation = {
      id: crypto.randomUUID(),
      oldGeneration: 1,
      stage: 'unconfirmed' as const,
      provisionalNativeSessionId: 'candidate',
    }
    source.header.rebuildOperations = [{ agentId: 'claude', operation }]
    const cold = windowFromPage(source)
    expect(cold.view.nativeContexts).toEqual([])
    expect(nativeRecoveryTargets(cold.view)).toEqual([
      {
        sessionId,
        agentId: 'claude',
        context: undefined,
        run: undefined,
        rebuildOperation: operation,
      },
    ])
    const newer = patch(2)
    newer.rebuildOperations = [
      { agentId: 'claude', operation: { ...operation, stage: 'creating' } },
    ]
    const merged = mergeConversationPatch(cold, newer).window
    expect(nativeRecoveryTargets(merged.view)[0]?.rebuildOperation?.stage).toBe('creating')
    const older = page([], { observationSequence: 1 })
    older.header.rebuildOperations = []
    expect(mergeMessagePage(merged, older, 'around').view.rebuildOperations).toEqual(
      newer.rebuildOperations,
    )
    const ended = patch(3)
    ended.rebuildOperations = [
      { agentId: 'claude', operation: { ...operation, stage: 'completed' } },
    ]
    expect(nativeRecoveryTargets(mergeConversationPatch(merged, ended).window.view)).toEqual([])
  })

  it('returns one Agent target and prefers the independently projected operation', () => {
    const source = page([])
    const operation = { id: crypto.randomUUID(), oldGeneration: 2, stage: 'unconfirmed' as const }
    source.header.nativeContexts = [
      {
        sessionId,
        agentId: 'claude',
        nativeSessionId: 'old',
        state: 'unavailable',
        continuationState: 'recovery_required',
        bindingGeneration: 2,
        updatedAt: timestamp,
      },
    ]
    source.header.rebuildOperations = [{ agentId: 'claude', operation }]
    expect(nativeRecoveryTargets(windowFromPage(source).view)).toHaveLength(1)
    expect(nativeRecoveryTargets(windowFromPage(source).view)[0]?.rebuildOperation).toEqual(
      operation,
    )
  })
})

it('projects no-body artifacts when the root ends before background recording, and retains recording failures without fake cards', () => {
  const user = message(0)
  const run: AgentRun = {
    id: crypto.randomUUID(),
    sessionId,
    userMessageId: user.id,
    agentId: 'codex',
    status: 'running',
    dispatchPhase: 'accepted',
    attemptCount: 1,
    settingsRevision: 1,
    model: null,
    effort: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  }
  run.workspaceChanges = {
    id: crypto.randomUUID(),
    runId: run.id,
    sessionId,
    projectId: crypto.randomUUID(),
    agentId: 'codex',
    state: 'recording',
    revision: 1,
    fileCount: 1,
    additions: 2,
    deletions: 1,
    undoUnavailableReason: null,
    createdAt: timestamp,
    finalizedAt: null,
  }
  const running = patch(2)
  running.runs = [run]
  const first = mergeConversationPatch(windowFromPage(page([user])), running).window
  expect(first.runArtifacts ?? []).toEqual([])
  const terminal = patch(3)
  terminal.runs = [{ ...run, status: 'completed', dispatchPhase: 'ended' }]
  const ended = mergeConversationPatch(first, terminal).window
  expect(ended.runArtifacts).toEqual([
    { userMessageId: user.id, agentId: 'codex', latestRunId: run.id, totalCount: 1 },
  ])
  const unavailable = patch(4)
  unavailable.runs = [
    {
      ...terminal.runs[0]!,
      workspaceChanges: undefined,
      workspaceRecordingUnavailableReason: 'The saved change recording is unavailable.',
    },
  ]
  const warning = mergeConversationPatch(ended, unavailable).window
  expect(warning.runArtifacts).toEqual(ended.runArtifacts)
  expect(warning.view.runs[0]?.workspaceChanges).toBeUndefined()
  expect(warning.view.runs[0]?.workspaceRecordingUnavailableReason).toBe(
    'The saved change recording is unavailable.',
  )
})

type MessagePage = Extract<ConversationPage, { scope: 'messages' }>

const sessionId = crypto.randomUUID()
const incarnation = crypto.randomUUID()
const timestamp = '2026-09-26T00:00:00.000Z'

function message(sequence: number, content = `Message ${sequence}`): ConversationMessage {
  return {
    id: crypto.randomUUID(),
    sessionId,
    role: sequence % 2 === 0 ? 'user' : 'assistant',
    content,
    contentRevision: 0,
    state: 'complete',
    sequence,
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}

function page(
  messages: ConversationMessage[],
  options: {
    observationSequence?: number
    pageIncarnation?: string
    hasOlder?: boolean
    hasNewer?: boolean
  } = {},
): MessagePage {
  return {
    scope: 'messages',
    sessionId,
    observation: {
      incarnation: options.pageIncarnation ?? incarnation,
      sequence: options.observationSequence ?? 1,
    },
    header: {
      session: {
        id: sessionId,
        title: 'Conversation window fixture',
        titleSource: 'local',
        status: 'idle',
        activity: { state: 'idle' },
        hasUnread: false,
        updatedAt: timestamp,
      },
      commentsRevision: 0,
    },
    messages: messages.map((item) => ({
      kind: 'complete',
      message: item,
      hasActivities: false,
      hasComments: false,
    })),
    runs: [],
    hasOlder: options.hasOlder ?? false,
    hasNewer: options.hasNewer ?? false,
  }
}

function patch(
  sequence: number,
  messages: ConversationPatch['messages'] = [],
  patchIncarnation = incarnation,
  activities: ConversationPatch['activities'] = [],
): ConversationPatch {
  return {
    version: 'conversation-patch-v1',
    sessionId,
    observation: { incarnation: patchIncarnation, sequence },
    session: {
      id: sessionId,
      title: 'Conversation window fixture',
      titleSource: 'local',
      status: 'idle',
      activity: { state: 'idle' },
      hasUnread: false,
      updatedAt: timestamp,
    },
    messages,
    runs: [],
    activities,
    activityStates: [],
  }
}

function withActivityRun(
  source: MessagePage,
  runId: string,
  status: AgentRun['status'] = 'running',
): MessagePage {
  const first = source.messages[0]!.message
  first.runId = runId
  source.runs = [
    {
      id: runId,
      sessionId,
      userMessageId: first.id,
      agentId: 'codex',
      status,
      attemptCount: 1,
      settingsRevision: 1,
      model: null,
      effort: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  ]
  source.header.latestRun = source.runs[0]
  return source
}

function messageChange(
  source: ConversationMessage,
  mode: ConversationPatch['messages'][number]['mode'],
  text?: string,
  previousRevision?: number,
): ConversationPatch['messages'][number] {
  const { content: _content, ...metadata } = source
  return {
    message: metadata,
    mode,
    ...(text === undefined ? {} : { text }),
    ...(previousRevision === undefined ? {} : { previousRevision }),
    hasActivities: false,
    hasComments: false,
  }
}

function sentComment(messageId: string): AnchoredComment {
  return {
    id: crypto.randomUUID(),
    sessionId,
    body: 'Review this text.',
    anchor: {
      type: 'message',
      messageId,
      contentHash: 'a'.repeat(64),
      textBasis: 'markdown-visible-v2',
      startOffset: 0,
      endOffset: 4,
      quote: 'text',
    },
    status: 'sent',
    position: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    sentWithMessageId: messageId,
  }
}

describe('Conversation resident window', () => {
  it('keeps the manual work log through another active Run and rejects foreign pages, then releases it on eviction', () => {
    const oldId = crypto.randomUUID(),
      nextId = crypto.randomUUID()
    const initialPage = withActivityRun(page([message(0)]), oldId, 'completed')
    const nextUser = message(1)
    nextUser.runId = nextId
    initialPage.messages.push({
      kind: 'complete',
      message: nextUser,
      hasActivities: true,
      hasComments: false,
    })
    const next: AgentRun = {
      ...initialPage.runs[0]!,
      id: nextId,
      userMessageId: nextUser.id,
      agentId: 'claude',
      status: 'running',
    }
    initialPage.runs.push(next)
    initialPage.header.latestRun = next
    const source = windowFromPage(initialPage)
    source.activityView = {
      runId: oldId,
      manual: true,
      truncated: false,
      observation: source.view.observation,
    }
    const activity: AgentActivity = {
      id: crypto.randomUUID(),
      sessionId,
      runId: oldId,
      agentId: 'codex',
      kind: 'tool',
      title: 'Frozen step',
      nativeId: 'frozen-step',
      detailRevision: 0,
      status: 'completed',
      sequence: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    const opened = mergeActivityPage(source, {
      scope: 'activities',
      sessionId,
      runId: oldId,
      observation: { incarnation, sequence: 1 },
      activities: [{ kind: 'complete', activity }],
      truncated: false,
    })!
    const update = patch(2)
    update.runs = [next]
    update.latestRunId = nextId
    const retained = mergeConversationPatch(opened, update).window
    expect(retained.activityView).toMatchObject({ runId: oldId, manual: true })
    expect(retained.view.activities).toEqual([activity])
    expect(
      mergeActivityPage(retained, {
        scope: 'activities',
        sessionId,
        runId: nextId,
        observation: { incarnation, sequence: 2 },
        activities: [],
        truncated: false,
      }),
    ).toBeUndefined()
    const around = withActivityRun(page([nextUser], { observationSequence: 3 }), nextId)
    const evicted = mergeMessagePage(retained, around, 'around')
    expect(evicted.activityView).toBeUndefined()
    expect(evicted.view.activities).toEqual([])
    expect(evicted.activityMeta).toEqual({})
    expect(
      mergeActivityPage(evicted, {
        scope: 'activities',
        sessionId,
        runId: oldId,
        observation: { incarnation, sequence: 1 },
        activities: [{ kind: 'complete', activity }],
        truncated: false,
      }),
    ).toBeUndefined()
  })
  it.each(['completed', 'failed', 'interrupted'] as const)(
    'keeps same-Run Work log across page replacement and settles %s metadata',
    (status) => {
      const runId = crypto.randomUUID(),
        activityId = crypto.randomUUID(),
        source = message(1)
      source.runId = runId
      const run: AgentRun = {
        id: runId,
        sessionId,
        userMessageId: crypto.randomUUID(),
        agentId: 'codex',
        status: 'running',
        attemptCount: 1,
        settingsRevision: 1,
        model: null,
        effort: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      }
      const initialPage = page([source])
      initialPage.header.latestRun = run
      initialPage.runs = [run]
      const activity: AgentActivity = {
        id: activityId,
        sessionId,
        runId,
        agentId: 'codex',
        nativeId: 'detail',
        kind: 'reasoning',
        title: 'Reasoning',
        status: 'running',
        sequence: 1,
        detailRevision: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      }
      const initial = mergeActivityPage(windowFromPage(initialPage), {
        scope: 'activities',
        sessionId,
        runId,
        observation: { incarnation, sequence: 1 },
        truncated: false,
        activities: [
          { kind: 'oversized', activity, detailBytes: 140_000, preview: 'old', previewChars: 3 },
        ],
      })!
      const updated = page([source], { observationSequence: 2 })
      updated.header.latestRun = { ...run, status }
      updated.runs = [updated.header.latestRun]
      const next = mergeMessagePage(initial, updated, 'around')
      const expected = status === 'completed' ? 'completed' : 'failed'
      expect(next.view.activities).toHaveLength(1)
      expect(next.activityView?.runId).toBe(runId)
      expect(next.view.activities[0]?.status).toBe(expected)
      expect(next.activityMeta[activityId]?.activity.status).toBe(expected)
      const reset = { ...updated, observation: { incarnation: crypto.randomUUID(), sequence: 1 } }
      expect(mergeMessagePage(initial, reset, 'around').view.activities).toEqual([])
      const unrelated = page([message(3)], { observationSequence: 2 })
      unrelated.header.latestRun = { ...run, id: crypto.randomUUID(), status: 'completed' }
      expect(mergeMessagePage(initial, unrelated, 'around').view.activities).toEqual([])
    },
  )
  it('keeps unseen new replies outside a historical reading window without empty rows', () => {
    const history = [message(0), message(1)]
    const current = windowFromPage(page(history, { hasNewer: true }))
    const next = message(3, 'New answer')
    next.replyToMessageId = history[0]!.id
    const merged = mergeConversationPatch(
      current,
      patch(2, [
        {
          message: next,
          mode: 'replace',
          text: next.content,
          hasActivities: false,
          hasComments: false,
        },
      ]),
    )
    expect(merged.window.view.messages).toEqual(history)
    expect(merged.window.messageMeta[next.id]).toBeUndefined()
    expect(merged.resyncMessages).toBe(false)
  })
  it('keeps a new interrupted partial reply introduced after an around-page was read', () => {
    const original = message(0, 'Question')
    const waiting = windowFromPage(page([original], { observationSequence: 2 }))
    const run: AgentRun = {
      id: crypto.randomUUID(),
      sessionId,
      userMessageId: original.id,
      agentId: 'codex',
      status: 'running',
      attemptCount: 1,
      settingsRevision: 1,
      model: null,
      effort: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    const partial = { ...message(1, 'Partial reply'), runId: run.id, state: 'streaming' as const }
    const addedPatch = patch(3, [messageChange(partial, 'replace', partial.content)])
    addedPatch.runs = [run]
    const added = mergeConversationPatch(waiting, addedPatch).window
    const terminalPatch = patch(4, [messageChange({ ...partial, state: 'incomplete' }, 'metadata')])
    terminalPatch.runs = [
      { ...run, status: 'interrupted' },
      { ...run, id: crypto.randomUUID(), status: 'completed' },
    ]
    terminalPatch.latestRunId = terminalPatch.runs[1]!.id
    const stopped = mergeConversationPatch(added, terminalPatch).window
    const merged = mergeMessagePage(stopped, page([original], { observationSequence: 2 }), 'around')
    expect(merged.view.messages).toHaveLength(2)
    expect(merged.view.messages[1]).toMatchObject({ content: 'Partial reply', state: 'incomplete' })
    expect(merged.view.runs).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: run.id, status: 'interrupted' })]),
    )
  })
  it('recovers invalidated text from an in-flight page while preserving newer terminal metadata', () => {
    const source = message(0, 'Old body')
    const corrected = { ...source, content: 'Correct final body', contentRevision: 1 }
    const invalidated = mergeConversationPatch(
      windowFromPage(page([source])),
      patch(2, [messageChange(corrected, 'invalidate')]),
    ).window
    const terminal = mergeConversationPatch(
      invalidated,
      patch(3, [messageChange({ ...corrected, state: 'incomplete' }, 'metadata')]),
    ).window
    const recovered = mergeMessagePage(
      terminal,
      page([corrected], { observationSequence: 2 }),
      'around',
    )
    expect(recovered.view.messages[0]).toMatchObject({
      content: 'Correct final body',
      contentRevision: 1,
      state: 'incomplete',
    })
  })

  it.each(['append', 'advance'] as const)(
    'does not certify a stale page after an unapplied %s',
    (mode) => {
      const source = message(0, 'Old')
      const revisionOne = { ...source, content: 'Revision one', contentRevision: 1 }
      const invalid = mergeConversationPatch(
        windowFromPage(page([source])),
        patch(2, [messageChange(revisionOne, 'invalidate')]),
      ).window
      const newer = mergeConversationPatch(
        invalid,
        patch(3, [
          messageChange(
            { ...source, contentRevision: 2 },
            mode,
            mode === 'append' ? ' and two' : undefined,
            1,
          ),
        ]),
      ).window
      const stale = mergeMessagePage(
        newer,
        page([revisionOne], { observationSequence: 2 }),
        'around',
      )
      expect(stale.messageMeta[source.id]?.bodyResync).toBe(true)
      const fresh = mergeMessagePage(
        stale,
        page([{ ...source, content: 'Revision two', contentRevision: 2 }], {
          observationSequence: 3,
        }),
        'around',
      )
      expect(fresh.view.messages[0]?.content).toBe('Revision two')
      expect(fresh.messageMeta[source.id]?.bodyResync).toBeUndefined()
    },
  )

  it('recovers Activity detail from a late page without losing terminal metadata or newer steps', () => {
    const runId = crypto.randomUUID()
    const activity: AgentActivity = {
      id: crypto.randomUUID(),
      sessionId,
      runId,
      agentId: 'codex',
      nativeId: 'invalid-detail',
      kind: 'reasoning',
      title: 'Reasoning',
      detailRevision: 0,
      status: 'running',
      sequence: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    const initial = mergeActivityPage(windowFromPage(withActivityRun(page([message(0)]), runId)), {
      scope: 'activities',
      sessionId,
      observation: { incarnation, sequence: 1 },
      runId,
      activities: [{ kind: 'complete', activity: { ...activity, detail: 'Old' } }],
      truncated: false,
    })!
    const invalid = mergeConversationPatch(
      initial,
      patch(2, [], incarnation, [
        { activity: { ...activity, detailRevision: 1 }, mode: 'invalidate' },
      ]),
    ).window
    const terminal = mergeConversationPatch(
      invalid,
      patch(3, [], incarnation, [
        { activity: { ...activity, detailRevision: 1, status: 'completed' }, mode: 'metadata' },
      ]),
    ).window
    const corrected = mergeActivityPage(terminal, {
      scope: 'activities',
      sessionId,
      observation: { incarnation, sequence: 2 },
      runId,
      activities: [
        { kind: 'complete', activity: { ...activity, detailRevision: 1, detail: 'Final detail' } },
      ],
      truncated: false,
    })!
    expect(corrected.view.activities[0]).toMatchObject({
      detail: 'Final detail',
      detailRevision: 1,
      status: 'completed',
    })
    expect(corrected.activityBodyResync).toEqual({})
  })
  it('keeps at most 100 Messages while moving backward through history', () => {
    const recent = Array.from({ length: CONVERSATION_WINDOW_MESSAGES }, (_, index) =>
      message(index + 25),
    )
    const older = Array.from({ length: 25 }, (_, index) => message(index))
    const current = windowFromPage(
      page(recent, { observationSequence: 2, hasOlder: true, hasNewer: false }),
    )

    const merged = mergeMessagePage(
      current,
      page(older, { observationSequence: 3, hasNewer: true }),
      'older',
    )

    expect(merged.view.messages).toHaveLength(CONVERSATION_WINDOW_MESSAGES)
    expect(merged.view.messages[0]?.sequence).toBe(0)
    expect(merged.view.messages.at(-1)?.sequence).toBe(99)
    expect(merged.hasNewer).toBe(true)
  })

  it('does not let an older page overwrite a newer streamed Message', () => {
    const identity = crypto.randomUUID()
    const streamed = { ...message(7, 'new streamed text'), id: identity }
    const stale = { ...message(7, 'old persisted text'), id: identity }
    const current = windowFromPage(page([streamed], { observationSequence: 9 }))

    const merged = mergeMessagePage(current, page([stale], { observationSequence: 4 }), 'around')

    expect(merged.view.messages).toMatchObject([{ id: identity, content: 'new streamed text' }])
    expect(merged.view.observation.sequence).toBe(9)
  })

  it('rejects an older-history page from a replaced repository incarnation', () => {
    const current = windowFromPage(page([message(25)], { observationSequence: 2 }))
    const stalePage = page([message(0)], {
      pageIncarnation: crypto.randomUUID(),
      observationSequence: 1,
      hasOlder: false,
    })

    expect(mergeMessagePage(current, stalePage, 'older')).toBe(current)
  })

  it('applies ordered text Patches once and requests resync for gaps', () => {
    const initial = message(0, 'First')
    const current = windowFromPage(page([initial]))
    const appended = { ...initial, contentRevision: 1, updatedAt: timestamp }

    const applied = mergeConversationPatch(
      current,
      patch(2, [messageChange(appended, 'append', ' second', 0)]),
    )
    expect(applied.applied).toBe(true)
    expect(applied.window.view.messages[0]?.content).toBe('First second')

    const duplicate = mergeConversationPatch(
      applied.window,
      patch(2, [messageChange(appended, 'append', ' second', 0)]),
    )
    expect(duplicate.applied).toBe(false)
    expect(duplicate.resyncMessages).toBe(false)

    const gap = mergeConversationPatch(applied.window, patch(4))
    // Gap metadata is authoritative; only dependent body edits await resync.
    expect(gap.applied).toBe(true)
    expect(gap.window.view.messages[0]?.content).toBe('First second')
    expect(gap.window.view.observation.sequence).toBe(4)
    expect(gap.resyncMessages).toBe(true)
  })

  it('switches an inline Message to a bounded preview when accumulated appends cross the limit', () => {
    const initial = message(0, 'a'.repeat(120 * 1024))
    const current = windowFromPage(page([initial]))
    const nextMessage = { ...initial, contentRevision: 1, updatedAt: timestamp }
    const merged = mergeConversationPatch(
      current,
      patch(2, [messageChange(nextMessage, 'append', 'b'.repeat(16 * 1024), 0)]),
    )
    expect(merged.window.view.messages[0]?.content).toBe('')
    expect(merged.window.messageMeta[initial.id]?.oversized).toMatchObject({
      contentBytes: expect.any(Number),
      previewChars: 2_048,
    })
  })

  it('preserves the bounded preview when an oversized Message receives metadata updates', () => {
    const oversized = message(0, 'Preview only')
    const current = windowFromPage(page([oversized]))
    const metadataPatch = patch(2, [messageChange(oversized, 'metadata')])
    current.messageMeta[oversized.id] = {
      hasActivities: false,
      hasComments: false,
      oversized: {
        kind: 'oversized',
        message: (() => {
          const { content: _content, ...metadata } = oversized
          return metadata
        })(),
        contentBytes: 200_000,
        preview: 'Preview only',
        previewChars: 12,
        hasActivities: false,
        hasComments: false,
      },
    }
    current.view.messages[0] = { ...oversized, content: '' }
    const merged = mergeConversationPatch(current, metadataPatch)
    expect(merged.window.messageMeta[oversized.id]?.oversized).toMatchObject({
      preview: 'Preview only',
      contentBytes: 200_000,
    })
  })

  it('rebuilds the descriptor when an oversized Message is replaced by short text', () => {
    const oversized = message(0, 'Preview only')
    const current = windowFromPage(page([oversized]))
    current.view.messages[0] = { ...oversized, content: '' }
    current.messageMeta[oversized.id] = {
      hasActivities: false,
      hasComments: false,
      oversized: {
        kind: 'oversized',
        message: (() => {
          const { content: _content, ...metadata } = oversized
          return metadata
        })(),
        contentBytes: 200_000,
        preview: 'Preview only',
        previewChars: 12,
        hasActivities: false,
        hasComments: false,
      },
    }
    const merged = mergeConversationPatch(
      current,
      patch(2, [messageChange(oversized, 'replace', 'Short replacement')]),
    )
    expect(merged.window.view.messages[0]?.content).toBe('Short replacement')
    expect(merged.window.messageMeta[oversized.id]?.oversized).toBeUndefined()
  })

  it('keeps oversized Message and Work log descriptors bounded at initial projection', () => {
    const oversized = message(0, 'ignored')
    const oversizedPage = page([])
    oversizedPage.messages = [
      {
        kind: 'oversized',
        message: (() => {
          const { content: _content, ...metadata } = oversized
          return metadata
        })(),
        contentBytes: 200_000,
        preview: 'Message preview',
        previewChars: 16,
        hasActivities: false,
        hasComments: false,
      },
    ]
    const current = windowFromPage(oversizedPage)
    expect(current.view.messages[0]).toMatchObject({ id: oversized.id, content: '' })
    expect(current.messageMeta[oversized.id]?.oversized).toMatchObject({
      contentBytes: 200_000,
      preview: 'Message preview',
    })

    const runId = crypto.randomUUID()
    current.view.messages[0]!.runId = runId
    current.view.runs = withActivityRun(page([message(0)]), runId).runs
    const activity: AgentActivity = {
      id: crypto.randomUUID(),
      sessionId,
      runId,
      agentId: 'codex',
      nativeId: 'oversized-detail',
      kind: 'reasoning',
      title: 'Reasoning',
      detailRevision: 1,
      status: 'completed',
      sequence: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    const activityPage = {
      scope: 'activities' as const,
      sessionId,
      observation: { incarnation, sequence: 2 },
      runId,
      activities: [
        {
          kind: 'oversized' as const,
          activity,
          detailBytes: 200_000,
          preview: 'Detail preview',
          previewChars: 14,
        },
      ],
      truncated: false,
    }
    const withActivity = mergeActivityPage(current, activityPage)
    expect(withActivity?.activityMeta[activity.id]).toMatchObject({
      detailBytes: 200_000,
      preview: 'Detail preview',
    })

    const activityPatch = patch(3, [], incarnation, [
      {
        activity: { ...activity, detailRevision: 2 },
        mode: 'append',
        detail: 'x'.repeat(16 * 1024),
        previousRevision: 1,
      },
    ])
    const crossed = withActivity ? mergeConversationPatch(withActivity, activityPatch) : undefined
    expect(crossed?.window.activityMeta[activity.id]).toMatchObject({
      detailBytes: expect.any(Number),
      previewChars: 14,
    })
  })

  it('requests resync for a new repository incarnation or invalidated Message body', () => {
    const initial = message(0, 'First')
    const current = windowFromPage(page([initial]))
    expect(mergeConversationPatch(current, patch(2, [], crypto.randomUUID()))).toMatchObject({
      applied: false,
      resyncMessages: true,
    })
    expect(
      mergeConversationPatch(current, patch(2, [messageChange(initial, 'invalidate')])),
    ).toMatchObject({ applied: true, resyncMessages: true })
  })

  it('resynchronizes an inline body after advance, but keeps an existing bounded preview', () => {
    const source = message(0, 'Original body')
    const current = windowFromPage(page([source]))
    const change = {
      ...messageChange({ ...source, contentRevision: 1 }, 'advance', undefined, 0),
      contentBytes: 200_000,
    }
    const advanced = conversationPatchSchema.parse(patch(2, [change]))
    expect(mergeConversationPatch(current, advanced).resyncMessages).toBe(true)

    const oversizedPage = page([])
    const { content: _content, ...metadata } = source
    oversizedPage.messages = [
      {
        kind: 'oversized',
        message: metadata,
        contentBytes: 150_000,
        preview: 'Original body',
        previewChars: 13,
        hasActivities: false,
        hasComments: false,
      },
    ]
    const bounded = mergeConversationPatch(windowFromPage(oversizedPage), advanced)
    expect(bounded.resyncMessages).toBe(false)
    expect(bounded.window.messageMeta[source.id]?.oversized).toMatchObject({
      contentBytes: 200_000,
      preview: 'Original body',
      message: { contentRevision: 1 },
    })
    expect(
      mergeConversationPatch(bounded.window, conversationPatchSchema.parse(patch(3, [change])))
        .resyncMessages,
    ).toBe(true)
  })

  it('bounds cumulative Activity text through legal Patches and clears the descriptor on replacement', () => {
    const runId = crypto.randomUUID()
    const activity: AgentActivity = {
      id: crypto.randomUUID(),
      sessionId,
      runId,
      agentId: 'codex',
      nativeId: 'growing-detail',
      kind: 'reasoning',
      title: 'Reasoning',
      detailRevision: 0,
      status: 'running',
      sequence: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    let current = mergeActivityPage(windowFromPage(withActivityRun(page([message(0)]), runId)), {
      scope: 'activities',
      sessionId,
      observation: { incarnation, sequence: 1 },
      runId,
      activities: [{ kind: 'complete', activity: { ...activity, detail: 'x'.repeat(120 * 1024) } }],
      truncated: false,
    })!
    const crossing = conversationPatchSchema.parse(
      patch(2, [], incarnation, [
        {
          activity: { ...activity, detailRevision: 1 },
          mode: 'append',
          previousRevision: 0,
          detail: 'x'.repeat(16 * 1024),
        },
      ]),
    )
    current = mergeConversationPatch(current, crossing).window
    expect(current.activityMeta[activity.id]).toMatchObject({
      detailBytes: 136 * 1024,
      previewChars: 2048,
    })
    expect(current.view.activities[0]?.detail).toHaveLength(2048)
    const advanced = mergeConversationPatch(
      current,
      conversationPatchSchema.parse(
        patch(3, [], incarnation, [
          {
            activity: { ...activity, detailRevision: 2 },
            mode: 'advance',
            previousRevision: 1,
            detailBytes: 200_000,
          },
        ]),
      ),
    )
    expect(advanced.resyncActivityRunIds).toEqual([])
    expect(advanced.window.activityMeta[activity.id]?.activity.detailRevision).toBe(2)
    const replaced = mergeConversationPatch(
      advanced.window,
      conversationPatchSchema.parse(
        patch(4, [], incarnation, [
          {
            activity: { ...activity, detailRevision: 3 },
            mode: 'replace',
            detail: 'Short final detail',
          },
        ]),
      ),
    )
    expect(replaced.window.activityMeta[activity.id]).toBeUndefined()
    expect(replaced.window.view.activities[0]?.detail).toBe('Short final detail')
  })

  it('attaches sent Comments only to resident Messages and records empty loaded results', () => {
    const first = message(0)
    const second = message(1)
    const absentId = crypto.randomUUID()
    const current = windowFromPage(page([first, second]))
    const firstComment = sentComment(first.id)
    const absentComment = sentComment(absentId)

    const merged = mergeSentComments(
      current,
      [first.id, second.id, absentId],
      [firstComment, absentComment],
    )

    expect(merged.sentCommentsByMessage).toEqual({
      [first.id]: [firstComment],
      [second.id]: [],
    })
    expect(merged.loadedCommentMessageIds).toEqual({ [first.id]: true, [second.id]: true })
  })
})
