import type {
  AgentRun,
  NativeAgentContext,
  NativeRebuildOperation,
  RuntimeAgentId,
  SessionIssue,
  SessionIssues,
} from '@pact/contracts'

import { isCodexArchivedSessionRejection } from './agent-execution-error'
import { safeNativePermissionText } from './native-permission-wait'

/** Pure, bounded projection of durable facts; never dispatches or infers an ending. */
export function presentSessionIssues(
  sessionId: string,
  contexts: NativeAgentContext[],
  runs: Array<AgentRun | undefined>,
  cursors: Array<AgentRun | undefined> = [],
  incompleteResults: string[] = [],
  operations: Array<{ agentId: RuntimeAgentId; operation: NativeRebuildOperation }> = [],
): SessionIssues {
  const agents: SessionIssue[] = []
  let inputGate: SessionIssues['inputGate'] = 'open'
  for (const agentId of ['codex', 'claude'] as const) {
    const context = contexts.find((item) => item.agentId === agentId)
    const run = runs.find((item) => item?.agentId === agentId)
    const savedOperation =
      context?.rebuildOperation ?? operations.find((item) => item.agentId === agentId)?.operation
    const operation =
      context?.continuationState === 'ready' && savedOperation?.stage === 'failed'
        ? undefined
        : savedOperation
    const pending =
      operation && ['preparing', 'creating', 'seeding', 'unconfirmed'].includes(operation.stage)
    const state = context?.continuationState
    const blocked =
      state === 'recovery_required' ||
      state === 'rebuilding' ||
      state === 'checking' ||
      Boolean(pending)
    const lostForeground =
      (state === 'responding' || state === 'waiting_user') &&
      run &&
      ['failed', 'interrupted'].includes(run.status)
    const failed = run && ['failed', 'interrupted'].includes(run.status)
    const processing = run && ['starting', 'running', 'recovering'].includes(run.status)
    const incomplete =
      !processing &&
      run?.dispatchPhase === 'ended' &&
      (!run.nativeOutcome || incompleteResults.includes(run.id))
    const unsettledEffects =
      !processing && run && ['pending', 'unknown'].includes(run.nativeEffectsState ?? '')
    if (!blocked && !lostForeground && !failed && !incomplete && !unsettledEffects) continue
    const name = agentId === 'codex' ? 'Codex' : 'Claude Code'
    const inputDisposition: SessionIssue['inputDisposition'] =
      !run || run.dispatchPhase === 'not_sent' || run.dispatchPhase === 'rejected'
        ? 'not_submitted'
        : run.dispatchPhase === 'possibly_sent'
          ? 'possibly_submitted'
          : 'submitted'
    const currentFailure = context?.recoveryFailureKind ?? (!blocked ? run?.failureKind : undefined)
    const archived =
      agentId === 'codex' &&
      state === 'recovery_required' &&
      context &&
      isCodexArchivedSessionRejection(
        context.recoveryFailureMessage ?? context.recoveryReason,
        context.nativeSessionId,
      )
    const repairRuntime =
      currentFailure &&
      [
        'authentication_required',
        'quota_or_rate_limit',
        'permission_blocked',
        'runtime_incompatible',
        'response_too_large',
      ].includes(currentFailure)
    let phase: SessionIssue['phase'] = 'warning'
    let action: SessionIssue['action'] = 'retry_check'
    let title = `${name} session needs attention`
    let reason =
      (pending ? operation?.failureReason : context?.recoveryFailureMessage) ??
      (operation?.stage === 'failed' && context?.recoveryAction !== 'rebuild'
        ? operation.failureReason
        : undefined) ??
      context?.recoveryReason ??
      run?.failureMessage ??
      'The session status could not be confirmed.'
    // Display a cause, not the transport's follow-up instructions or repeated assurances.
    reason =
      reason.replace(/^Native state check failed:\s*/u, '').split(/(?<=[.!?])\s+/u)[0] ?? reason
    if (state === 'checking' && run?.dispatchPhase === 'ended' && context?.state === 'active') {
      if (inputGate === 'open') inputGate = 'send_blocked'
    } else if (blocked || lostForeground) inputGate = 'read_only'
    if (state === 'checking') {
      phase = 'checking'
      action = 'none'
      title = `Checking ${name} session`
      reason = ''
    } else if (pending && ['preparing', 'creating', 'seeding'].includes(operation.stage)) {
      phase = 'rebuilding'
      action = 'none'
      title = `Rebuilding ${name} session`
      reason = 'Restoring your saved conversation.'
    } else if (operation?.stage === 'unconfirmed') {
      phase = 'unconfirmed'
      title = `${name} session not confirmed`
      action =
        operation.provisionalNativeSessionId && operation.checkAction !== 'rebuild'
          ? 'inspect_rebuild'
          : 'rebuild'
      reason = 'Pact couldn’t confirm the new session.'
    } else if (
      !context &&
      run &&
      !run.nativeOutcome &&
      ['possibly_sent', 'accepted'].includes(run.dispatchPhase ?? '')
    ) {
      inputGate = 'read_only'
      phase = 'rebuild_offer'
      action = 'rebuild'
      title = `${name} session not confirmed`
      reason = 'Pact couldn’t confirm which session received this request.'
    } else if (!context && !pending) {
      action = 'none'
    } else if (operation?.stage === 'failed' && context?.recoveryAction !== 'rebuild') {
      action = context ? 'retry_check' : 'none'
      title = `${name} session setup couldn’t start`
      if (/adapter slots/iu.test(reason)) reason = 'All agent slots are currently in use.'
      else if (/interaction slots/iu.test(reason))
        reason = 'Too many requests are waiting for input.'
      else if (/history.*(?:exceeds|limit|large)/iu.test(reason))
        reason = 'The saved conversation exceeds the restore limit.'
    } else if (!blocked && !lostForeground && inputDisposition === 'not_submitted') {
      phase = 'resolved'
      action = 'none'
      title = `${name} request was not started`
      reason = 'Your message wasn’t sent. This session is ready.'
    } else if (repairRuntime) {
      action = context ? 'retry_check' : 'none'
    } else if (currentFailure === 'native_session_occupied' && (blocked || lostForeground)) {
      inputGate = 'read_only'
      phase = 'rebuild_offer'
      action = 'rebuild'
      title = `${name} session is in use`
      reason = 'Another app is using this session.'
    } else if (context?.recoveryAction === 'rebuild' || archived) {
      phase = 'rebuild_offer'
      action = 'rebuild'
      if (archived) {
        title = `${name} session is archived`
        reason = 'The saved session has been archived.'
      } else if (context?.state === 'missing') {
        title = `${name} session not found`
        reason = 'The saved session could not be found.'
      } else title = `${name} session check failed`
    } else if (context?.recoveryAction === 'none') {
      action = 'none'
    } else if (incomplete && !blocked) {
      phase = 'resolved'
      title = `${name} response incomplete`
      reason = 'The task has ended, but its full response is unavailable.'
    } else if (unsettledEffects && !blocked && !lostForeground && !failed) {
      // Historical effects uncertainty is not a new Session-wide admission rule.
      // Native continuation and the live Adapter still own current work admission.
      action = 'none'
      title = `${name} earlier background work unconfirmed`
      reason = 'The reply is complete. Some earlier background work could not be verified.'
    }
    // A just-failed setup reports its own cause, even when the old binding still needs replacement.
    if (
      operation?.stage === 'failed' &&
      (!context || context.recoveryReason === operation.failureReason)
    ) {
      title = `${name} session setup couldn’t start`
      reason = operation.failureReason?.split(/(?<=[.!?])\s+/u)[0] ?? reason
      if (/adapter slots/iu.test(reason)) reason = 'All agent slots are currently in use.'
      else if (/interaction slots/iu.test(reason))
        reason = 'Too many requests are waiting for input.'
      else if (/history.*(?:exceeds|limit|large)/iu.test(reason))
        reason = 'The saved conversation exceeds the restore limit.'
    } else if (phase === 'warning' && lostForeground) {
      reason =
        state === 'waiting_user'
          ? 'The previous task is waiting for your input.'
          : 'The previous task is still running.'
    } else if (phase === 'warning' && repairRuntime) {
      if (currentFailure === 'authentication_required') {
        title = `${name} authentication needed`
        reason = 'Authentication failed. Check your sign-in or API credentials.'
      } else if (currentFailure === 'quota_or_rate_limit') {
        title = `${name} limit reached`
        reason = 'A usage limit is blocking this request.'
      } else if (currentFailure === 'permission_blocked') {
        title = `${name} request blocked`
        reason = 'The current permissions blocked this request.'
      } else if (currentFailure === 'response_too_large') {
        title = `${name} response too large`
        reason = 'The response exceeds Pact’s size limit.'
      } else if (/executable.*unavailable/iu.test(reason)) {
        title = `${name} unavailable`
        reason = `The ${name} executable is unavailable. Check its installation.`
      }
    } else if (phase === 'warning' && /native transport disconnected/iu.test(reason)) {
      title = `${name} connection lost`
      reason = `The connection to ${name} was interrupted.`
    }
    if (/connection reset|ECONNRESET/iu.test(reason))
      reason = 'The connection was reset during the session check.'
    const cursor = cursors.find((item) => item?.agentId === agentId)
    const uncertainWork =
      state === 'responding' ||
      state === 'waiting_user' ||
      [run, cursor].some(
        (item) =>
          item &&
          ((!['not_sent', 'rejected', 'ended'].includes(item.dispatchPhase ?? '') &&
            !item.nativeOutcome) ||
            item.nativeEffectsState === 'pending' ||
            item.nativeEffectsState === 'unknown'),
      )
    agents.push({
      agentId,
      generation: context?.bindingGeneration ?? run?.bindingGeneration ?? 1,
      ...(context ? { nativeSessionId: context.nativeSessionId } : {}),
      ...(run ? { runId: run.id } : {}),
      ...(operation && !['completed', 'superseded'].includes(operation.stage)
        ? { rebuildId: operation.id }
        : {}),
      phase,
      title,
      reason: safeNativePermissionText(reason, 1024),
      inputDisposition,
      resultDisposition: incomplete
        ? 'incomplete'
        : run?.nativeOutcome === 'completed'
          ? 'complete'
          : inputDisposition === 'not_submitted'
            ? 'unavailable'
            : 'pending',
      action,
      abandon: uncertainWork,
      previousCreationUnconfirmed: operation?.stage === 'unconfirmed',
    })
  }
  return { sessionId, inputGate, agents }
}
