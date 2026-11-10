import type { AgentPromptEnvelope, AgentPromptImage } from '@pact/agent-runtime'
import type {
  ConversationImage,
  FrozenExecutionEnvelope,
  FrozenSkillInvocation,
} from '@pact/contracts'

import { frozenExecutionEnvelopeSchema } from '@pact/contracts'

const pathlessImages = (values: AgentPromptImage[] | undefined) =>
  values?.map(({ path: _path, ...image }) => image)

/** Preserve complete business input while excluding process-local capabilities and image paths. */
export function pathlessExecutionInput(envelope: AgentPromptEnvelope): FrozenExecutionEnvelope {
  const { sourceGrant: _sourceGrant, ...base } = envelope
  const basis = envelope.collaborationBasis
  return frozenExecutionEnvelopeSchema.parse({
    ...base,
    message: { ...envelope.message, images: pathlessImages(envelope.message.images) },
    handoffContext: envelope.handoffContext?.map((entry) => ({
      ...entry,
      images: pathlessImages(entry.images),
    })),
    rebuiltContext: envelope.rebuiltContext?.map((entry) => ({
      ...entry,
      message: { ...entry.message, images: pathlessImages(entry.message.images) },
    })),
    collaborationBasis:
      basis &&
      Object.fromEntries(
        Object.entries(basis).map(([key, entry]) => [
          key,
          { ...entry, images: pathlessImages(entry.images) },
        ]),
      ),
    skillInvocation: envelope.skillInvocation && {
      ...envelope.skillInvocation,
      bindings: envelope.skillInvocation.bindings.map(({ path: _path, ...binding }) => binding),
    },
  })
}

/** Re-resolve immutable image identities in Utility; native Skill paths stay in their existing owner. */
export function restoreExecutionInput(
  input: FrozenExecutionEnvelope,
  resolveImage: (image: ConversationImage) => AgentPromptImage,
  originalSkills: FrozenSkillInvocation | undefined,
): AgentPromptEnvelope {
  const withImages = <T extends { images?: ConversationImage[] | undefined }>(value: T) => {
    const { images, ...base } = value
    return { ...base, ...(images ? { images: images.map(resolveImage) } : {}) }
  }
  const {
    skillInvocation: _capturedSkills,
    handoffContext,
    rebuiltContext,
    collaborationBasis,
    requestSessionTitle,
    targetAgentId,
    ...base
  } = input
  if (input.skillInvocation) {
    const expected = originalSkills && {
      ...originalSkills,
      bindings: originalSkills.bindings.map(({ path: _path, ...binding }) => binding),
    }
    if (JSON.stringify(expected) !== JSON.stringify(input.skillInvocation))
      throw new Error('The original frozen Skill invocation is unavailable.')
  } else if (originalSkills) throw new Error('The original Skill input changed.')
  return {
    ...base,
    ...(requestSessionTitle ? { requestSessionTitle } : {}),
    ...(targetAgentId ? { targetAgentId } : {}),
    ...(originalSkills ? { skillInvocation: originalSkills } : {}),
    message: withImages(input.message),
    ...(handoffContext ? { handoffContext: handoffContext.map(withImages) } : {}),
    ...(rebuiltContext
      ? {
          rebuiltContext: rebuiltContext.map((entry) =>
            Object.assign({}, entry, { message: withImages(entry.message) }),
          ),
        }
      : {}),
    ...(collaborationBasis
      ? {
          collaborationBasis: Object.fromEntries(
            Object.entries(collaborationBasis).flatMap(([key, entry]) =>
              entry ? [[key, withImages(entry)]] : [],
            ),
          ),
        }
      : {}),
  }
}
