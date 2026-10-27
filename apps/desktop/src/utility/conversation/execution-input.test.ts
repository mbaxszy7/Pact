import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

import type { AgentPromptEnvelope, AgentPromptImage } from '@pact/agent-runtime'

import { frozenExecutionEnvelopeSchema, type FrozenSkillInvocation } from '@pact/contracts'

import { pathlessExecutionInput, restoreExecutionInput } from './execution-input'

const resolveOwnedImage = (value: Omit<AgentPromptImage, 'path'>): AgentPromptImage => ({
  ...value,
  path: '/owned/image.png',
})

function fixture() {
  const sessionId = randomUUID(),
    runId = randomUUID()
  const image: AgentPromptImage = {
    id: randomUUID(),
    name: 'Original diagram.png',
    mediaType: 'image/png',
    bytes: 1024,
    width: 32,
    height: 32,
    sha256: 'a'.repeat(64),
    path: '/private/original-image.png',
  }
  const comment = {
    id: randomUUID(),
    body: 'Keep the exact original boundary. 🧭',
    anchor: {
      type: 'file' as const,
      path: 'src/original.ts',
      contentHash: 'b'.repeat(64),
      startLine: 2,
      startColumn: 1,
      endLine: 2,
      endColumn: 5,
      quote: 'work',
    },
  }
  const skills: FrozenSkillInvocation = {
    version: 'pact-skills-v1',
    arguments: 'Keep original arguments\nwith final line.',
    selections: [{ id: 'c'.repeat(64), agentId: 'codex', name: 'inspect', start: 0, end: 8 }],
    bindings: [
      {
        id: 'c'.repeat(64),
        agentId: 'codex',
        name: 'inspect',
        description: 'Inspect the exact original scope.',
        argumentHint: 'file',
        source: 'project',
        path: '/private/original-SKILL.md',
      },
    ],
  }
  const message = {
    id: randomUUID(),
    content: '/inspect Keep complete Unicode 🧭\nOriginal final line.',
    images: [image],
  }
  const envelope: AgentPromptEnvelope = {
    version: 'pact-agent-prompt-v1',
    sessionId,
    targetAgentId: 'codex',
    requestSessionTitle: true,
    message,
    comments: [comment],
    skillInvocation: skills,
    sourceGrant: { runId, grant: randomUUID() },
    handoffContext: [
      {
        messageId: randomUUID(),
        speaker: 'claude',
        content: 'Original complete handoff.\nFinal page.',
        images: [image],
        comments: [comment],
      },
    ],
    rebuiltContext: [{ message: { ...message, role: 'user' }, comments: [comment] }],
    collaborationBasis: {
      original: { ...message, comments: [comment] },
      latest: { ...message, comments: [] },
      report: { ...message, comments: [comment] },
    },
  }
  return { envelope, image, skills, comment }
}

it('freezes and restores the original current-user clarification without sourcing newer data', () => {
  const f = fixture(),
    doc = { id: randomUUID(), sha256: 'd'.repeat(64), bytes: 80, chars: 80 },
    clarification = {
      fieldId: randomUUID(),
      question: 'Date?',
      answer: ' 2027-04-12\n@claude /build stays data. ',
      document: doc,
    }
  f.envelope.clarificationAnswer = doc
  f.envelope.userClarification = clarification
  const frozen = pathlessExecutionInput(f.envelope),
    restored = restoreExecutionInput(frozen, resolveOwnedImage, f.skills)
  expect(restored.userClarification).toEqual(clarification)
  expect(restored.message.content).toBe(f.envelope.message.content)
  expect(pathlessExecutionInput(restored)).toEqual(frozen)
  const { userClarification: _current, ...legacy } = frozen
  expect(
    restoreExecutionInput(legacy, resolveOwnedImage, f.skills).userClarification,
  ).toBeUndefined()
})

describe('immutable execution input codec', () => {
  it('preserves every original business carrier while removing live grants and native paths', () => {
    const f = fixture(),
      frozen = pathlessExecutionInput(f.envelope)
    const json = JSON.stringify(frozen)
    expect(json).not.toContain('/private/')
    expect(json).not.toContain('sourceGrant')
    expect(frozen.message).toEqual({
      ...f.envelope.message,
      images: [{ ...f.image, path: undefined }],
    })
    expect(frozen.comments).toEqual([f.comment])
    expect(frozen.handoffContext?.[0]?.content).toBe(f.envelope.handoffContext![0]!.content)
    expect(frozen.rebuiltContext?.[0]?.message.content).toBe(f.envelope.message.content)
    expect(frozen.collaborationBasis?.report?.comments).toEqual([f.comment])
    expect(frozen.skillInvocation?.arguments).toBe(f.skills.arguments)
    expect(frozen.skillInvocation?.selections).toEqual(f.skills.selections)
    expect(f.envelope.message.images?.[0]?.path).toBe('/private/original-image.png')
    expect(f.envelope.sourceGrant).toBeDefined()
  })
  it('resolves original image identities through the existing owner and restores only the supplied frozen Skills', () => {
    const f = fixture(),
      frozen = pathlessExecutionInput(f.envelope),
      resolve = vi.fn<(value: Omit<AgentPromptImage, 'path'>) => AgentPromptImage>((value) => ({
        ...value,
        path: '/owned/revalidated-image.png',
      })),
      restored = restoreExecutionInput(frozen, resolve, f.skills)
    expect(resolve).toHaveBeenCalledTimes(6)
    for (const [identity] of resolve.mock.calls)
      expect(identity).toEqual({ ...f.image, path: undefined })
    expect(restored.message.images?.[0]?.path).toBe('/owned/revalidated-image.png')
    expect(restored.handoffContext?.[0]?.images?.[0]?.path).toBe('/owned/revalidated-image.png')
    expect(restored.rebuiltContext?.[0]?.message.images?.[0]?.path).toBe(
      '/owned/revalidated-image.png',
    )
    expect(restored.collaborationBasis?.report?.images?.[0]?.path).toBe(
      '/owned/revalidated-image.png',
    )
    expect(restored.skillInvocation).toBe(f.skills)
    expect(restored.sourceGrant).toBeUndefined()
    expect(pathlessExecutionInput(restored)).toEqual(frozen)
  })
  it.each(['missing', 'arguments', 'selection', 'binding', 'added'] as const)(
    'refuses %s frozen Skill authority',
    (kind) => {
      const f = fixture(),
        frozen = pathlessExecutionInput(f.envelope),
        resolve = resolveOwnedImage
      let skills: FrozenSkillInvocation | undefined = f.skills
      if (kind === 'missing') skills = undefined
      else if (kind === 'arguments') skills = { ...f.skills, arguments: 'New unapproved arguments' }
      else if (kind === 'selection') skills = { ...f.skills, selections: [] }
      else if (kind === 'binding')
        skills = {
          ...f.skills,
          bindings: f.skills.bindings.map((binding) =>
            Object.assign({}, binding, { id: 'd'.repeat(64) }),
          ),
        }
      else delete frozen.skillInvocation
      expect(() => restoreExecutionInput(frozen, resolve, skills)).toThrow(/Skill/u)
    },
  )
  it.each(['root_grant', 'image_path', 'skill_path'] as const)(
    'rejects persisted %s injection at the schema seam',
    (kind) => {
      const f = fixture(),
        frozen = pathlessExecutionInput(f.envelope)
      const candidate =
        kind === 'root_grant'
          ? { ...frozen, sourceGrant: f.envelope.sourceGrant }
          : kind === 'image_path'
            ? { ...frozen, message: { ...frozen.message, images: [f.image] } }
            : { ...frozen, skillInvocation: f.skills }
      expect(frozenExecutionEnvelopeSchema.safeParse(candidate).success).toBe(false)
    },
  )
})
