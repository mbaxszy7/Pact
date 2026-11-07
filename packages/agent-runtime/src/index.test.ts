import { describe, expect, it } from 'vitest'

import { createUnavailableAgentAdapter, serializeAgentPromptEnvelope } from './index.js'

describe('agent adapter seam', () => {
  it.each(['claude', 'codex'] as const)('supports a fake %s adapter', async (id) => {
    const adapter = createUnavailableAgentAdapter(id, 'Foundation-only adapter')

    await expect(adapter.probe()).resolves.toEqual({
      id,
      available: false,
      reason: 'Foundation-only adapter',
    })
    await expect(adapter.dispose()).resolves.toBeUndefined()
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
