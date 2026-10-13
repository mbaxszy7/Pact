// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  frozenSkillInvocationSchema,
  type ConversationPatch,
  type DesktopBridge,
} from '@pact/contracts'

import {
  createInputReturnFixture,
  inputReturnTimestamp,
  type InputReturnFixture,
} from '../../../../../../../packages/persistence/src/conversation-input-return.test-helper.js'
import { createRendererQueryClient } from '../../query-client'
import { useConversation } from './useConversation'

const owned: Array<{
  fixture: InputReturnFixture
  client: ReturnType<typeof createRendererQueryClient>
}> = []
afterEach(() => {
  cleanup()
  for (const { fixture, client } of owned.splice(0)) {
    client.clear()
    fixture.db.close()
  }
  vi.unstubAllGlobals()
})
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function mountRecovery(
  options?: Parameters<typeof createInputReturnFixture>[0],
  setup?: (fixture: InputReturnFixture) => Promise<void>,
) {
  const fixture = await createInputReturnFixture(options)
  const client = createRendererQueryClient()
  owned.push({ fixture, client })
  if (setup) await setup(fixture)
  let listener: ((patch: ConversationPatch) => void) | undefined
  const inputOwner = 'input-return-window'
  const completeInput = (input: Parameters<DesktopBridge['sendConversationMessage']>[0]) => ({
    ...input,
    content: input.inputId
      ? fixture.repo.resolveConversationInput(
          input.sessionId,
          input.clientMessageId,
          input.inputId,
          inputOwner,
        )
      : input.content,
  })
  const getConversation = vi.fn<DesktopBridge['getConversation']>(async (input) => ({
    ok: true,
    value: fixture.repo.readPage(input),
  }))
  const rebuildNativeContext = vi.fn<DesktopBridge['rebuildNativeContext']>(async (input) => {
    if (input.intent === 'claim_input')
      return {
        ok: true,
        value: fixture.repo.claimReturnedInput(
          input.sessionId,
          input.expectedRebuildId!,
          input.expectedGeneration!,
          input.expectedCommentsRevision!,
        ),
      }
    if (input.intent === 'discard_input')
      return {
        ok: true,
        value: fixture.repo.discardReturnedInput(input.sessionId, input.expectedRebuildId!),
      }
    return {
      ok: true,
      value: (await fixture.rebuild({ onPatch: (patch) => listener?.(patch) })).patch,
    }
  })
  const sendConversationMessage = vi.fn<DesktopBridge['sendConversationMessage']>(async (input) => {
    // This fixture uses the same typed IPC request and public persistence transaction.
    // Native transport is outside the Hook's responsibility and is never called here.
    const route =
      input.route ??
      (input.returnedInputOperationId
        ? fixture.repo.returnedInputRoute(input.sessionId, input.returnedInputOperationId)
        : fixture.route)
    return { ok: true, value: fixture.send({ ...completeInput(input), route }).patch }
  })
  const bridge = {
    getConversation,
    rebuildNativeContext,
    sendConversationMessage,
    writeConversationInput: vi.fn<DesktopBridge['writeConversationInput']>(async (input) => ({
      ok: true,
      value: fixture.repo.writeConversationInput(input, inputOwner),
    })),
    setConversationInterest: vi
      .fn<DesktopBridge['setConversationInterest']>()
      .mockResolvedValue({ ok: true, value: { ready: true } }),
    onConversationChanged: (callback: (patch: ConversationPatch) => void) => {
      listener = callback
      return () => {
        listener = undefined
      }
    },
    saveCommentDraft: vi.fn<DesktopBridge['saveCommentDraft']>(async (input) => ({
      ok: true,
      value: fixture.repo.saveCommentDraft(input),
    })),
  }
  vi.stubGlobal('pact', bridge)
  const onNotice = vi.fn<(message: string) => void>()
  const initialProps: { selected: string; visible: boolean } = {
    selected: fixture.sessionId,
    visible: true,
  }
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children)
  const hook = renderHook(
    ({ selected, visible }: typeof initialProps) => useConversation(selected, onNotice, visible),
    { wrapper, initialProps },
  )
  await waitFor(() => {
    expect(hook.result.current.snapshot?.sessionId).toBe(fixture.sessionId)
    expect(hook.result.current.history.draftsLoading).toBe(false)
  })
  const rebuild = async () => {
    await act(async () => {
      expect(await hook.result.current.rebuildNativeContext(fixture.agentId)).toBe(true)
    })
  }
  const ready = async () => {
    await waitFor(() => {
      expect(hook.result.current.composer).toBe(fixture.content)
      expect(hook.result.current.history.draftsLoading).toBe(false)
      expect(hook.result.current.history.restoringInput).toBe(false)
    })
  }
  return {
    ...hook,
    fixture,
    bridge,
    client,
    onNotice,
    completeInput,
    rebuild,
    ready,
    publish: (patch: ConversationPatch) => listener?.(patch),
  }
}

describe('Rebuild input recovery in the mounted Conversation Hook', () => {
  it.each(['direct ACK', 'lost reply and Message page'] as const)(
    'settles large Skill metadata from %s without keeping or replaying pending input',
    async (mode) => {
      const value = await mountRecovery()
      await value.rebuild()
      await value.ready()
      const text = '/x '.repeat(518) + 'task'
      const skills = Array.from({ length: 518 }, (_, index) => ({
        id: 'a'.repeat(64),
        agentId: 'codex' as const,
        name: 'x',
        start: index * 3,
        end: index * 3 + 2,
      }))
      const invocation = frozenSkillInvocationSchema.parse({
        version: 'pact-skills-v1',
        arguments: 'task',
        selections: skills,
        bindings: [
          {
            id: 'a'.repeat(64),
            agentId: 'codex',
            name: 'x',
            description: '',
            argumentHint: '',
            source: 'user',
          },
        ],
      })
      await act(() => value.result.current.setComposerDocument({ text, skills }))
      value.bridge.sendConversationMessage.mockImplementationOnce(async (input) => {
        const route = value.fixture.repo.returnedInputRoute(
          value.fixture.sessionId,
          input.returnedInputOperationId!,
        )
        const committed = value.fixture.send({
          ...value.completeInput(input),
          route,
          skillInvocation: invocation,
        })
        expect(committed.patch.messages).toHaveLength(0)
        expect(committed.patch.resync?.messages).toBe(true)
        if (mode === 'lost reply and Message page') throw new Error('Owned lost reply')
        return { ok: true, value: committed.patch }
      })
      await act(async () => {
        expect(await value.result.current.send(text, [], undefined, skills)).toBe(
          mode === 'direct ACK',
        )
      })
      expect(value.result.current.composer).toBe(mode === 'direct ACK' ? '' : text)
      if (mode === 'lost reply and Message page') {
        await act(async () => value.result.current.history.loadLatest())
      }
      await waitFor(() => expect(value.result.current.composer).toBe(''))
      expect(value.bridge.sendConversationMessage).toHaveBeenCalledTimes(1)
      act(() => value.result.current.setComposer('another task'))
      value.bridge.sendConversationMessage.mockResolvedValueOnce({
        ok: false,
        error: { code: 'VALIDATION', message: 'Owned new submission' },
      })
      await act(async () => value.result.current.send('another task', []))
      expect(value.bridge.sendConversationMessage).toHaveBeenCalledTimes(2)
    },
  )

  it.each([
    { type: 'agent' as const, agentId: 'codex' as const },
    { type: 'all' as const, firstAgentId: 'claude' as const, secondAgentId: 'codex' as const },
  ])(
    'restores body, sent Comments and frozen $type route, and consumes exactly one explicit Send',
    async (route) => {
      const value = await mountRecovery({
        route,
        comments: ['First sent Comment', 'Second sent Comment'],
      })
      await value.rebuild()
      await value.ready()
      expect(value.result.current.snapshot?.draftComments.map((comment) => comment.body)).toEqual([
        'First sent Comment',
        'Second sent Comment',
      ])
      expect(value.result.current.snapshot?.rebuildInputRecovery?.route).toEqual(route)
      // The View owns following a detected history gap; exercise its public resync action.
      if (value.result.current.history.historyResyncToken > 0)
        await act(async () => value.result.current.history.loadLatest())
      await waitFor(() =>
        expect(
          value.result.current.snapshot?.messages.some(
            (message) => message.id === value.fixture.messageId,
          ),
        ).toBe(false),
      )
      const operationId = value.result.current.snapshot!.rebuildInputRecovery!.operationId
      expect(value.bridge.sendConversationMessage).not.toHaveBeenCalled()
      const ids = value.result.current.snapshot!.draftComments.map((comment) => comment.id)
      const restoredCommentsRevision = value.fixture.revision()
      await act(async () => {
        expect(await value.result.current.send(value.result.current.composer, ids)).toBe(true)
      })
      expect(value.bridge.sendConversationMessage).toHaveBeenCalledTimes(1)
      expect(value.bridge.sendConversationMessage.mock.calls[0]![0]).toMatchObject({
        content: value.fixture.content,
        returnedInputOperationId: operationId,
        expectedCommentsRevision: restoredCommentsRevision,
        commentIds: [],
        freezeDrafts: true,
      })
      expect(value.result.current.composer).toBe('')
      expect(value.fixture.repo.rebuildInputRecovery(value.fixture.sessionId)).toBeNull()
      const newRun = value.fixture.repo.latestAgentRun(
        value.fixture.sessionId,
        value.fixture.agentId,
      )!
      const request = value.bridge.sendConversationMessage.mock.calls[0]![0]
      expect(request.batchId).toBe(request.clientMessageId)
      const batch = value.fixture.repo.inputBatchForRun(newRun.id)!
      expect(batch).toEqual({
        id: request.batchId,
        revision: restoredCommentsRevision,
        memberCount: ids.length,
      })
      const frozen = value.fixture.repo.readFrozenInputBatch(newRun.id, batch.id)
      expect(frozen.hasMore).toBe(false)
      expect(
        frozen.members.map((member) => ({ id: member.commentId, revision: member.revision })),
      ).toEqual(ids.map((id) => ({ id, revision: 1 })))
      expect(
        value.fixture.repo
          .read(value.fixture.sessionId)
          .messages.find((message) => message.id === newRun.userMessageId)?.route,
      ).toEqual(route)
    },
  )

  it('preserves a newer Composer draft and selected mention while recovery stays pending', async () => {
    const value = await mountRecovery({ comments: ['Original Comment'] })
    act(() => {
      value.result.current.setComposer('@claude a new draft')
      value.result.current.setComposerMention({
        route: { type: 'agent', agentId: 'claude' },
        token: '@claude',
        start: 0,
        end: 7,
      })
    })
    await value.rebuild()
    expect(value.result.current.composer).toBe('@claude a new draft')
    expect(value.result.current.composerMention).toEqual({
      route: { type: 'agent', agentId: 'claude' },
      token: '@claude',
      start: 0,
      end: 7,
    })
    expect(value.result.current.snapshot?.rebuildInputRecovery?.state).toBe('pending')
    expect(
      value.bridge.getConversation.mock.calls.some(([input]) => input.scope === 'rebuild-input'),
    ).toBe(false)
    await act(async () => {
      expect(await value.result.current.history.restoreReturnedInput!()).toBe(false)
    })
    expect(value.fixture.drafts()).toHaveLength(0)
    await act(async () => {
      value.result.current.setComposerDocument({ text: '', skills: [], mention: undefined })
    })
    await value.ready()
    expect(value.fixture.drafts().map((comment) => comment.body)).toEqual(['Original Comment'])
  })

  it('preserves new Comment drafts instead of replacing them with returned Comments', async () => {
    const value = await mountRecovery({ comments: ['Old sent Comment'] }, async (fixture) => {
      fixture.repo.saveCommentDraft({
        mode: 'create',
        sessionId: fixture.sessionId,
        commentId: crypto.randomUUID(),
        expectedCommentsRevision: fixture.revision(),
        body: 'New Comment draft',
        anchor: JSON.parse(fixture.sourceComments[0]!.anchorJson),
      })
    })
    await value.rebuild()
    expect(value.result.current.composer).toBe('')
    expect(value.result.current.snapshot?.draftComments.map((comment) => comment.body)).toEqual([
      'New Comment draft',
    ])
    expect(value.result.current.snapshot?.rebuildInputRecovery?.state).toBe('pending')
    expect(
      value.bridge.rebuildNativeContext.mock.calls.filter(
        ([input]) => input.intent === 'claim_input',
      ),
    ).toHaveLength(0)
  })

  it('waits for the cloned Comment page before permitting Send', async () => {
    const value = await mountRecovery({ comments: ['Restored Comment'] })
    const restoredCommentsRevision = value.fixture.revision() + 1
    const drafts = deferred<Awaited<ReturnType<DesktopBridge['getConversation']>>>()
    const originalRead = value.bridge.getConversation.getMockImplementation()!
    value.bridge.getConversation.mockImplementation(async (input) =>
      input.scope === 'drafts' && input.expectedRevision === restoredCommentsRevision
        ? drafts.promise
        : originalRead(input),
    )
    await value.rebuild()
    await waitFor(() => expect(value.result.current.composer).toBe(value.fixture.content))
    expect(value.result.current.history.draftsLoading).toBe(true)
    await act(async () => {
      expect(await value.result.current.send(value.result.current.composer, [])).toBe(false)
    })
    expect(value.bridge.sendConversationMessage).not.toHaveBeenCalled()
    await act(async () => {
      drafts.resolve({
        ok: true,
        value: value.fixture.repo.readPage({
          scope: 'drafts',
          sessionId: value.fixture.sessionId,
          expectedRevision: restoredCommentsRevision,
        }),
      })
      await drafts.promise
    })
    await value.ready()
    expect(value.result.current.snapshot?.draftComments).toHaveLength(1)
  })

  it('does not loop when returning a Comment-only message with an empty body', async () => {
    const value = await mountRecovery({ content: '', comments: ['Only Comment'] })
    await value.rebuild()
    await value.ready()
    expect(value.result.current.snapshot?.draftComments.map((comment) => comment.body)).toEqual([
      'Only Comment',
    ])
    expect(
      value.bridge.rebuildNativeContext.mock.calls.filter(
        ([input]) => input.intent === 'claim_input',
      ),
    ).toHaveLength(1)
    act(() => value.result.current.setComposer(''))
    await act(async () => {
      await Promise.resolve()
    })
    expect(
      value.bridge.rebuildNativeContext.mock.calls.filter(
        ([input]) => input.intent === 'claim_input',
      ),
    ).toHaveLength(1)
    await act(async () => {
      expect(
        await value.result.current.send(
          '',
          value.result.current.snapshot!.draftComments.map((comment) => comment.id),
        ),
      ).toBe(true)
    })
    expect(value.fixture.repo.rebuildInputRecovery(value.fixture.sessionId)).toBeNull()
  })

  it('respects clearing restored text instead of restoring it repeatedly', async () => {
    const value = await mountRecovery()
    await value.rebuild()
    await value.ready()
    act(() => value.result.current.setComposer(''))
    await act(async () => {
      await Promise.resolve()
    })
    expect(value.result.current.composer).toBe('')
    expect(
      value.bridge.rebuildNativeContext.mock.calls.filter(
        ([input]) => input.intent === 'claim_input',
      ),
    ).toHaveLength(1)
    expect(value.result.current.snapshot?.rebuildInputRecovery?.state).toBe('installed')
  })

  it('permits a manual Restore after a failed automatic body read, without sending', async () => {
    const value = await mountRecovery()
    const originalRead = value.bridge.getConversation.getMockImplementation()!
    let failed = false
    value.bridge.getConversation.mockImplementation(async (input) => {
      if (input.scope === 'rebuild-input' && !failed) {
        failed = true
        return { ok: false, error: { code: 'CONFLICT', message: 'Owned read failure' } }
      }
      return originalRead(input)
    })
    await value.rebuild()
    await waitFor(() => expect(value.onNotice).toHaveBeenCalledWith('Owned read failure'))
    expect(value.result.current.composer).toBe('')
    await act(async () => {
      expect(await value.result.current.history.restoreReturnedInput!()).toBe(true)
    })
    await value.ready()
    expect(value.bridge.sendConversationMessage).not.toHaveBeenCalled()
  })

  it('reloads installed input and preserves edited cloned Comments without duplication or a stuck loading state', async () => {
    let beforeCloneRevision = 0
    const value = await mountRecovery({ comments: ['Original Comment'] }, async (fixture) => {
      const { operationId } = await fixture.rebuild()
      beforeCloneRevision = fixture.revision()
      fixture.repo.claimReturnedInput(fixture.sessionId, operationId, 2, fixture.revision())
      fixture.repo.saveCommentDraft({
        mode: 'edit',
        sessionId: fixture.sessionId,
        commentId: fixture.drafts()[0]!.id,
        expectedCommentsRevision: fixture.revision(),
        body: 'Edited cloned Comment',
      })
    })
    expect(value.result.current.snapshot?.rebuildInputRecovery?.state).toBe('installed')
    expect(value.result.current.snapshot?.draftComments.map((comment) => comment.body)).toEqual([
      'Edited cloned Comment',
    ])
    await value.ready()
    expect(value.result.current.snapshot?.draftComments.map((comment) => comment.body)).toEqual([
      'Edited cloned Comment',
    ])
    expect(value.fixture.drafts()).toHaveLength(1)
    expect(value.fixture.revision()).toBe(beforeCloneRevision + 2)
    expect(
      value.bridge.rebuildNativeContext.mock.calls.filter(
        ([input]) => input.intent === 'claim_input',
      ),
    ).toHaveLength(1)
    const comments = value.result.current.snapshot!.draftComments.map((comment) => comment.id)
    await act(async () => {
      expect(await value.result.current.send(value.result.current.composer, comments)).toBe(true)
    })
    expect(value.bridge.sendConversationMessage).toHaveBeenCalledTimes(1)
  })

  it.each(['additional', 'replacement'] as const)(
    'keeps an unrelated %s draft separate from installed returned Comments after reload',
    async (mode) => {
      const value = await mountRecovery({ comments: ['Returned Comment'] }, async (fixture) => {
        const { operationId } = await fixture.rebuild()
        fixture.repo.claimReturnedInput(fixture.sessionId, operationId, 2, fixture.revision())
        if (mode === 'replacement')
          fixture.repo.removeCommentDraft({
            sessionId: fixture.sessionId,
            commentId: fixture.drafts()[0]!.id,
            expectedCommentsRevision: fixture.revision(),
          })
        fixture.repo.saveCommentDraft({
          mode: 'create',
          sessionId: fixture.sessionId,
          commentId: crypto.randomUUID(),
          expectedCommentsRevision: fixture.revision(),
          body: 'Independent new Comment',
          anchor: JSON.parse(fixture.sourceComments[0]!.anchorJson),
        })
      })
      expect(value.result.current.composer).toBe('')
      expect(value.result.current.snapshot?.rebuildInputRecovery?.state).toBe('installed')
      const expectedBodies =
        mode === 'additional'
          ? ['Returned Comment', 'Independent new Comment']
          : ['Independent new Comment']
      expect(value.result.current.snapshot?.draftComments.map((comment) => comment.body)).toEqual(
        expectedBodies,
      )
      await act(async () => {
        expect(await value.result.current.history.restoreReturnedInput!()).toBe(false)
      })
      expect(value.fixture.drafts().map((comment) => comment.body)).toEqual(expectedBodies)
      expect(value.bridge.rebuildNativeContext).not.toHaveBeenCalled()
      expect(value.bridge.sendConversationMessage).not.toHaveBeenCalled()
    },
  )

  it('cancels an old Session body read without filling or disabling the newly selected Session', async () => {
    const value = await mountRecovery()
    const secondId = crypto.randomUUID()
    value.fixture.db.sessionRepository.create(
      {
        id: secondId,
        projectId: value.fixture.projectId,
        title: 'Second Session',
        createdAt: inputReturnTimestamp,
      },
      value.fixture.settings,
    )
    const body = deferred<Awaited<ReturnType<DesktopBridge['getConversation']>>>()
    const originalRead = value.bridge.getConversation.getMockImplementation()!
    value.bridge.getConversation.mockImplementation(async (input) =>
      input.scope === 'rebuild-input' ? body.promise : originalRead(input),
    )
    await value.rebuild()
    await waitFor(() => expect(value.result.current.history.restoringInput).toBe(true))
    act(() => value.rerender({ selected: secondId, visible: true }))
    await waitFor(() => {
      expect(value.result.current.snapshot?.sessionId).toBe(secondId)
      expect(value.result.current.history.restoringInput).toBe(false)
    })
    act(() => value.result.current.setComposer('New Session draft'))
    const operationId = value.fixture.repo.rebuildInputRecovery(
      value.fixture.sessionId,
    )!.operationId
    await act(async () => {
      body.resolve({
        ok: true,
        value: value.fixture.repo.readReturnedInput(value.fixture.sessionId, operationId, 0),
      })
      await body.promise
    })
    expect(value.result.current.composer).toBe('New Session draft')
    expect(
      value.bridge.rebuildNativeContext.mock.calls.filter(
        ([input]) => input.intent === 'claim_input',
      ),
    ).toHaveLength(0)
    expect(value.fixture.repo.rebuildInputRecovery(value.fixture.sessionId)?.state).toBe('pending')
  })

  it('preserves a new draft typed before a delayed Send ACK and detaches the consumed receipt', async () => {
    const value = await mountRecovery()
    await value.rebuild()
    await value.ready()
    const ack = deferred<Awaited<ReturnType<DesktopBridge['sendConversationMessage']>>>()
    let patch: ConversationPatch | undefined
    value.bridge.sendConversationMessage.mockImplementationOnce(async (input) => {
      patch = value.fixture.send(input).patch
      return ack.promise
    })
    let sent!: Promise<boolean>
    act(() => {
      sent = value.result.current.send(value.result.current.composer, [])
    })
    await waitFor(() => expect(patch).toBeDefined())
    act(() => value.result.current.setComposer('@claude next draft'))
    await act(async () => {
      ack.resolve({ ok: true, value: patch! })
      expect(await sent).toBe(true)
    })
    expect(value.result.current.composer).toBe('@claude next draft')
    expect(value.fixture.repo.rebuildInputRecovery(value.fixture.sessionId)).toBeNull()
    const run = value.fixture.repo.latestAgentRun(value.fixture.sessionId, value.fixture.agentId)!
    act(() =>
      value.publish(
        value.fixture.repo.failRun(run.id, 'native_session_occupied', 'Owned conflict', false),
      ),
    )
    await waitFor(() => expect(value.result.current.history.draftsLoading).toBe(false))
    await act(async () => {
      expect(
        await value.result.current.send('@claude next draft', [], {
          type: 'agent',
          agentId: 'claude',
        }),
      ).toBe(true)
    })
    expect(value.bridge.sendConversationMessage.mock.calls[1]![0]).not.toHaveProperty(
      'returnedInputOperationId',
    )
  })

  it('dismisses pending recovery while retaining a newer draft', async () => {
    const value = await mountRecovery()
    act(() => value.result.current.setComposer('Keep this draft'))
    await value.rebuild()
    await act(async () => {
      expect(await value.result.current.history.discardReturnedInput!()).toBe(true)
    })
    expect(value.result.current.composer).toBe('Keep this draft')
    expect(value.result.current.snapshot?.rebuildInputRecovery).toBeNull()
    expect(value.fixture.sourceMessage().content).toBe(value.fixture.content)
  })
})
