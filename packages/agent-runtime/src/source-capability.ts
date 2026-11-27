import type {
  CodexCollaborationSourceWireRead,
  CollaborationSourceAnyRead,
  CollaborationSourceNativeRoot,
  CollaborationSourceReadResult,
  CollaborationSourceWireResult,
  CollaborationTask,
  CollaborationTurnAuthorization,
} from '@pact/contracts'

import type { AgentId } from './types.js'

export type AgentSourceTarget = Omit<CollaborationSourceAnyRead, 'runId' | 'grant' | 'offset'>
export type AgentSourceReadForm = 'legacy' | 'sourceReference' | 'nativeRoot'
export type AgentSourceReadCapabilityTier = 'none' | AgentSourceReadForm
export type AgentSourceNavigation = (target: AgentSourceTarget) => CodexCollaborationSourceWireRead

export interface AgentCollaborationSourceCapability {
  readonly tier: AgentSourceReadCapabilityTier
  readonly forms: readonly AgentSourceReadForm[]
  readonly legacy: boolean
  readonly sourceReference: boolean
  readonly nativeRoot: boolean
}

export interface AgentCollaborationSourceReader {
  readonly identity: Readonly<{ runId: string; grant: string }>
  readonly supportedForms?: readonly AgentSourceReadForm[] | undefined
  navigation(
    target: AgentSourceTarget,
    form: AgentSourceReadForm,
  ): ReturnType<AgentSourceNavigation>
  read(raw: unknown): {
    submitted: AgentSourceReadForm
    request: CollaborationSourceAnyRead
    page: CollaborationSourceWireResult
  }
  /** Internal transport entry: its caller must authenticate the exact ACKed native Root first. */
  readNativeRoot?(
    raw: unknown,
    root: CollaborationSourceNativeRoot,
  ): ReturnType<AgentCollaborationSourceReader['read']>
  retire(): void
}

export function resolveAgentCollaborationSourceCapability(input: {
  readCollaborationSourcePart?: ((input: unknown) => CollaborationSourceReadResult) | undefined
  collaborationSourceReader?: AgentCollaborationSourceReader | undefined
}): AgentCollaborationSourceCapability {
  const reader = input.collaborationSourceReader
  const allowedForms =
    reader?.supportedForms !== undefined
      ? new Set<AgentSourceReadForm>(reader.supportedForms)
      : undefined
  const hasNativeRoot =
    typeof reader?.readNativeRoot === 'function' &&
    (allowedForms === undefined || allowedForms.has('nativeRoot'))
  const hasSourceReader =
    Boolean(reader) && (allowedForms === undefined || allowedForms.has('sourceReference'))
  const hasLegacy = reader
    ? allowedForms === undefined || allowedForms.has('legacy')
    : Boolean(input.readCollaborationSourcePart)
  const tier: AgentSourceReadCapabilityTier = hasNativeRoot
    ? 'nativeRoot'
    : hasSourceReader
      ? 'sourceReference'
      : hasLegacy
        ? 'legacy'
        : 'none'
  const forms: AgentSourceReadForm[] = []
  if (hasLegacy) forms.push('legacy')
  if (hasSourceReader) forms.push('sourceReference')
  if (hasNativeRoot) forms.push('nativeRoot')
  return {
    tier,
    forms,
    legacy: hasLegacy,
    sourceReference: hasSourceReader,
    nativeRoot: hasNativeRoot,
  }
}

export interface SourceGrantValidationResult {
  readonly ok: boolean
  readonly reason?: string | undefined
  readonly grant?: { readonly runId: string; readonly grant: string } | undefined
}

/**
 * Single authoritative validation of an ephemeral frozen-source capability grant
 * shared across Claude, Codex, and Agy adapters.
 */
export function validateSourceGrant(input: {
  readonly runId: string
  readonly nativeGeneration?: string | undefined
  readonly hasSourceReader: boolean
  readonly sourceGrant?: { readonly runId: string; readonly grant: string } | undefined
  readonly readerIdentity?: Readonly<{ runId: string; grant: string }> | undefined
}): SourceGrantValidationResult {
  if (!input.hasSourceReader) {
    return {
      ok: true,
      ...(input.sourceGrant ? { grant: { ...input.sourceGrant } } : {}),
    }
  }
  const grant = input.sourceGrant
  if (
    !grant ||
    grant.runId !== input.runId ||
    (input.nativeGeneration && grant.grant !== input.nativeGeneration)
  ) {
    return { ok: false, reason: 'The source reader has no exact root owner.' }
  }
  if (
    input.readerIdentity &&
    (input.readerIdentity.runId !== grant.runId || input.readerIdentity.grant !== grant.grant)
  ) {
    return { ok: false, reason: 'The source reader identity does not match the frozen root grant.' }
  }
  return { ok: true, grant: { ...grant } }
}

export interface WorkflowAuthorizationValidationResult {
  readonly ok: boolean
  readonly reason?: string | undefined
}

/**
 * Single authoritative validation of frozen Pact collaboration duty authorization
 * shared across Claude, Codex, and Agy adapters.
 */
export function validateWorkflowAuthorization(input: {
  readonly adapterId: AgentId
  readonly runId: string
  readonly sessionId: string
  readonly envelopeSessionId: string
  readonly collaboration?: CollaborationTask | undefined
  readonly authorization?: CollaborationTurnAuthorization | undefined
}): WorkflowAuthorizationValidationResult {
  const { collaboration: workflow, authorization } = input
  if (!workflow) return { ok: true }
  if (
    !authorization ||
    authorization.runId !== input.runId ||
    authorization.taskId !== workflow.id ||
    authorization.taskRevision !== workflow.revision ||
    authorization.stage !== workflow.stage ||
    authorization.inputSequence !== workflow.inputSequence ||
    workflow.sessionId !== input.sessionId ||
    input.envelopeSessionId !== input.sessionId ||
    authorization.actor !== input.adapterId ||
    workflow.actor !== input.adapterId
  ) {
    return {
      ok: false,
      reason: 'The frozen Pact duty authorization is missing or inconsistent. Nothing was sent.',
    }
  }
  return { ok: true }
}
