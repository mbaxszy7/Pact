import { describe, expect, it } from 'vitest'

import {
  createUnavailableAgentAdapter,
  serializeAgentPromptEnvelope,
  type AgentNativeContextRebuildResult,
  type AgentNativeForkBoundary,
  type AgentNativeForkWitness,
} from './index.js'

describe('agent adapter seam', () => {
  it.each(['claude', 'codex', 'agy'] as const)('supports a fake %s adapter', async (id) => {
    const adapter = createUnavailableAgentAdapter(id, 'Foundation-only adapter')

    await expect(adapter.probe()).resolves.toEqual({
      id,
      available: false,
      reason: 'Foundation-only adapter',
    })
    await expect(adapter.dispose()).resolves.toBeUndefined()
  })

  it('supports agy fork boundaries, B2 separate nativeInputIds, and rebuild initialization witnesses', () => {
    const boundary: AgentNativeForkBoundary = {
      provider: 'agy',
      nativeSessionId: 'agy-parent-uuid',
      nativeCutId: 'turn-2:step-7',
      nativeTurnId: 'turn-2',
      nativeInputIds: ['input-2a', 'input-2b'],
      agyCut: {
        version: 'pact-agy-fork-cut-v1',
        trajectoryId: 'agy-parent-uuid',
        executionId: 'exec-1',
        cutStepIdx: 7,
        genMetadataCount: 2,
        executorMetadataCount: 1,
        mediaCount: 0,
      },
      bindingGeneration: 1,
      throughSequence: 4,
      deliveryCursor: 2,
      prefixHash: 'b'.repeat(64),
      prefixRecords: 8,
      prefixBytes: 512,
    }
    const witness: AgentNativeForkWitness = {
      version: 'pact-native-fork-v1',
      provider: 'agy',
      sourceNativeSessionId: boundary.nativeSessionId,
      nativeSessionId: 'agy-child-uuid',
      sourceCutId: boundary.nativeCutId,
      sourcePrefixHash: boundary.prefixHash,
      candidatePrefixHash: boundary.prefixHash,
      idMap: [['turn-2', 'turn-2']],
      agyCut: boundary.agyCut,
      model: 'gemini-3.1-pro',
      effort: 'high',
      permissionMode: 'ask',
      initializedAt: '2026-11-19T00:00:00.000Z',
      initializedPrefixHash: 'c'.repeat(64),
      initializedPrefixBytes: 512,
      initializedPrefixRecords: 8,
    }
    const rebuild: AgentNativeContextRebuildResult = {
      nativeSessionId: 'agy-rebuilt-uuid',
      initializationWitness: {
        kind: 'agy_rebuild_v1',
        nativeSessionId: 'agy-rebuilt-uuid',
        pbSha256: 'd'.repeat(64),
        pbBytes: 1024,
        stepCount: 2,
        sourceHash: 'e'.repeat(64),
        coldLoadVerifiedAt: '2026-11-19T00:00:00.000Z',
      },
    }

    expect(boundary.nativeTurnId).toBe('turn-2')
    expect(boundary.nativeInputIds).toEqual(['input-2a', 'input-2b'])
    expect(witness.provider).toBe('agy')
    expect(rebuild.initializationWitness?.kind).toBe('agy_rebuild_v1')
  })
})

describe('Agent Prompt envelope', () => {
  it('requests all target Skills with shared arguments while retaining exact Comment and peer references', () => {
    const argumentsText = 'inspect "quoted" 中文\nsecond line'
    const comment = {
      id: 'comment-1',
      body: 'Keep this reference',
      anchor: {
        type: 'message' as const,
        messageId: '35faefab-c57c-4c44-bfcb-4f54dc566fd4',
        contentHash: 'a'.repeat(64),
        textBasis: 'markdown-visible-v2' as const,
        startOffset: 0,
        endOffset: 4,
        quote: 'text',
      },
    }
    const envelope = {
      version: 'pact-agent-prompt-v1' as const,
      sessionId: 'session-1',
      targetAgentId: 'claude' as const,
      message: { id: 'message-1', content: '/first /second original' },
      comments: [comment],
      handoffContext: [
        {
          messageId: 'peer-1',
          speaker: 'codex' as const,
          content: 'Exact peer reference',
          comments: [],
        },
      ],
      skillInvocation: {
        version: 'pact-skills-v1' as const,
        arguments: argumentsText,
        selections: [],
        bindings: (['first', 'second', 'codex-only'] as const).map((name) => ({
          id: 'a'.repeat(64),
          agentId: name === 'codex-only' ? ('codex' as const) : ('claude' as const),
          name,
          description: '',
          argumentHint: '',
          source: 'user' as const,
          path: '/private/SKILL.md',
        })),
      },
    }
    const serialized = serializeAgentPromptEnvelope(envelope)
    expect(serialized).toContain('Explicit native Skill request: use /first, /second.')
    expect(serialized).toContain(
      `Pass the exact same arguments to each: ${JSON.stringify(argumentsText)}`,
    )
    expect(serialized).not.toContain('codex-only')
    expect(serialized).not.toContain('/private/SKILL.md')
    const context = JSON.parse(serialized.slice(serialized.lastIndexOf('\n') + 1))
    expect(context.comments).toEqual([comment])
    expect(context.handoffContext).toEqual(envelope.handoffContext)
  })
  it('keeps the user request human-readable before Pact reference data', () => {
    const serialized = serializeAgentPromptEnvelope({
      version: 'pact-agent-prompt-v1',
      sessionId: 'session-1',
      message: { id: 'message-1', content: 'Explain the previous answer.' },
      comments: [],
    })

    expect(serialized).toMatch(/^Explain the previous answer\.\n\nPact context/)
    expect(serialized).toContain('"version":"pact-agent-prompt-v1"')
    expect(serialized).not.toContain('"content":"Explain the previous answer."')
  })

  it('uses an explicit request when the turn only sends Comments', () => {
    expect(
      serializeAgentPromptEnvelope({
        version: 'pact-agent-prompt-v1',
        sessionId: 'session-1',
        message: { id: 'message-1', content: '   ' },
        comments: [],
      }),
    ).toMatch(/^Review the attached Pact Comments\./)
  })

  it('keeps the frozen native intent host-only while serializing the active scope and source grant', () => {
    const replyIntentBasis = {
      kind: 'explanation_only' as const,
      inputId: 'user-input',
      inputDigest: 'e'.repeat(64),
      priorInputSequence: 1,
      taskRevision: 3,
      review: {
        runId: 'review-run',
        actor: 'claude' as const,
        stage: 'plan_review' as const,
        verdict: 'accepted' as const,
        inputSequence: 1,
        document: { id: 'review-document', sha256: 'a'.repeat(64), bytes: 4, chars: 4 },
      },
    }
    const envelope = {
      version: 'pact-agent-prompt-v1' as const,
      sessionId: 'session',
      message: { id: 'user-input', content: 'Explain the previous design.' },
      comments: [],
      sourceGrant: { runId: 'reply', grant: 'grant' },
      inputBatchRef: { id: 'batch', revision: 0, memberCount: 0 },
      collaborationAuthorization: {
        runId: 'reply',
        taskId: 'task',
        taskRevision: 5,
        actor: 'codex' as const,
        stage: 'reply' as const,
        inputSequence: 2,
        inputProcessing: { pending: { inputId: 'user-input', inputSequence: 2 } },
        replyIntentBasis,
      },
    }
    const serialized = serializeAgentPromptEnvelope(envelope)
    const context: unknown = JSON.parse(serialized.slice(serialized.lastIndexOf('\n') + 1))
    expect(context).toMatchObject({
      sourceGrant: envelope.sourceGrant,
      inputBatchRef: envelope.inputBatchRef,
      collaborationAuthorization: {
        runId: 'reply',
        taskId: 'task',
        stage: 'reply',
        actor: 'codex',
        taskRevision: 5,
        inputSequence: 2,
        inputProcessing: envelope.collaborationAuthorization.inputProcessing,
      },
    })
    expect(serialized).not.toContain('replyIntentBasis')
    expect(serialized).not.toContain('explanation_only')
    expect(envelope.collaborationAuthorization.replyIntentBasis).toEqual(replyIntentBasis)
  })

  it('serializes frozen stageRoles in the collaboration and authorization maps', () => {
    const stageRoles = {
      version: 'task-stage-roles-v1' as const,
      revision: 0 as const,
      planAuthor: 'claude' as const,
      planReviewer: 'codex' as const,
      codeAuthor: 'claude' as const,
      codeReviewer: 'codex' as const,
    }
    const serialized = serializeAgentPromptEnvelope({
      version: 'pact-agent-prompt-v1',
      sessionId: 'session-1',
      message: { id: 'message-1', content: 'Review the change.' },
      comments: [],
      collaboration: {
        protocol: 'native-workflow-v1',
        id: 'task-1',
        sessionId: 'session-1',
        kind: 'plan',
        revision: 0,
        owner: 'codex',
        reviewer: 'claude',
        rolePolicy: 'split-stages-v1',
        stageRoles,
        task: 'Keep scope.',
        taskMessageId: 'message-1',
        stage: 'plan',
        actor: 'claude',
        status: 'running',
        automation: 'active',
        runId: 'run-1',
        inputSequence: 1,
        handledInputSequence: 0,
        planVersion: 0,
        discussionRounds: 0,
        reviewCycles: 0,
        repairAttempts: 0,
      },
      collaborationAuthorization: {
        runId: 'run-1',
        taskId: 'task-1',
        taskRevision: 0,
        actor: 'claude',
        stage: 'plan',
        stageRoles,
        inputSequence: 1,
        inputBatchRef: { id: 'batch-1', revision: 1, memberCount: 0 },
      },
    })
    const context = JSON.parse(serialized.slice(serialized.lastIndexOf('\n') + 1))
    expect(context.collaboration.stageRoles).toEqual(stageRoles)
    expect(context.collaboration.actor).toBe('claude')
    expect(context.collaborationAuthorization.stageRoles).toEqual(stageRoles)
  })
})
