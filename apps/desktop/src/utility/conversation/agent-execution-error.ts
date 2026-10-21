import type { RunFailureKind } from '@pact/contracts'

export class AgentExecutionError extends Error {
  constructor(
    readonly kind: RunFailureKind,
    message: string,
    readonly retryable: boolean,
    readonly reconciliationCause?: RunFailureKind,
  ) {
    super(message)
    this.name = 'AgentExecutionError'
  }
}

/** The live workflow admission fence withheld the root input before native I/O. */
export class NativeInputWithheldError extends AgentExecutionError {
  constructor(
    message = 'Collaboration paused before this input was sent. Continue collaboration when ready.',
  ) {
    super('user_stopped', message, false)
    this.name = 'NativeInputWithheldError'
  }
}

/** The binding was resumed, but its next-task permissions were not confirmed; no model input was sent. */
export class PermissionModeRejectedError extends AgentExecutionError {
  constructor(message: string) {
    super('runtime_incompatible', message, false)
  }
}

/** Native resume was explicitly refused by an existing writer; no User Turn was submitted. */
export class NativeThreadOccupiedError extends AgentExecutionError {
  constructor() {
    super(
      'native_session_occupied',
      'Another Codex client owns this native session. This request was not submitted. Rebuild to continue in Pact; the other session remains unchanged.',
      false,
    )
  }
}

/** Native resume refused an archived binding before any User Turn was submitted. */
export class NativeThreadArchivedError extends AgentExecutionError {
  constructor(message: string) {
    super('context_resume_failed', message, false)
  }
}

/** Also recognizes the bounded, durable resume rejection saved by older builds. */
export function isCodexArchivedSessionRejection(error: unknown, nativeSessionId: string): boolean {
  let payload = error
  if (typeof payload === 'string') {
    const prefix = 'Codex thread/resume rejected: '
    if (!payload.startsWith(prefix) || payload.length > 1024) return false
    try {
      payload = JSON.parse(payload.slice(prefix.length))
    } catch {
      return false
    }
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false
  const message = Reflect.get(payload, 'message')
  if (typeof message !== 'string') return false
  return ['session', 'thread'].some((subject) => {
    const statement = `${subject} ${nativeSessionId} is archived`
    // Native errors can append recovery instructions after this exact statement.
    return (
      message === statement || message === `${statement}.` || message.startsWith(`${statement}. `)
    )
  })
}

/** This attempt created no native actor and dispatched no startup/model request. */
export class NativeCapacityError extends AgentExecutionError {
  constructor(message: string) {
    super('runtime_incompatible', message, false)
  }
}

export function classifyAgentError(error: unknown): AgentExecutionError {
  if (error instanceof AgentExecutionError) return error
  const message = error instanceof Error ? error.message : 'The Agent process failed.'
  const normalized = message.toLowerCase()
  if (
    /context(?:\s|-)?(?:window|length|limit)|too many tokens|(?:prompt|input) is too long/u.test(
      normalized,
    )
  ) {
    return new AgentExecutionError('context_limit', message, false)
  }
  if (/unauthor|auth|login|credential/u.test(normalized)) {
    return new AgentExecutionError('authentication_required', message, false)
  }
  if (/quota|rate.?limit|usage.?limit|credits?/u.test(normalized)) {
    return new AgentExecutionError('quota_or_rate_limit', message, false)
  }
  if (/permission|approval/u.test(normalized)) {
    return new AgentExecutionError('permission_blocked', message, false)
  }
  if (/connect|network|socket|stream|timeout|temporar|overload/u.test(normalized)) {
    return new AgentExecutionError('transient_transport', message, true)
  }
  return new AgentExecutionError('agent_process_crash', message, true)
}
