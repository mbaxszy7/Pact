import type {
  CanUseTool,
  OnElicitation,
  query,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type { ChildProcess } from 'node:child_process'

import { createHash, randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

import type {
  AgentRunInput,
  NativePermissionRequester,
  NativeUserInputRequester,
} from '@pact/agent-runtime'
import type { NativePermissionRequest, SessionPermissionMode } from '@pact/contracts'

import { agentPromptImageGroups } from '@pact/agent-runtime'
import { NATIVE_PERMISSION_REQUESTS, nativePermissionRequestSchema } from '@pact/contracts'

import { AgentActivityDetail } from '../agent-activity-detail'
import { AgentExecutionError, PermissionModeRejectedError } from '../agent-execution-error'
import { cutoffSourceNavigator } from '../frozen-source-reader'
import { claudePromptContent, nativeImagePreparationBytes } from '../native-image-content'
import { encodeNativeJsonFrame, freezeNativeJsonFrame } from '../native-json-encoder'
import {
  exactNativeSessionScope,
  nativeApprovalDisplayFits,
  NativePermissionWait,
  safeNativePermissionText,
} from '../native-permission-wait'
import { claudeQuestions, nativeElicitation } from '../native-user-input'
import { NativeWorkingMemory, type NativeMemoryReservation } from '../native-working-memory'
import {
  FAST_MODE_CHECK_TIMEOUT_MS,
  PERMISSION_MODE_TIMEOUT_MS,
  type ClaudeEffort,
  type PlanSubmissionRejection,
} from './types'

export interface ClaudePermissionHandlerInput {
  readonly cwd: string
  readonly permissionMode?: SessionPermissionMode | undefined
  readonly requestPermission?: NativePermissionRequester | undefined
  readonly requestUserInput?: NativeUserInputRequester | undefined
}

export interface ClaudeElicitationHandlerInput {
  readonly requestUserInput?: NativeUserInputRequester | undefined
}

/** Custom SDK spawns leave stderr to this actor owner; never retain its contents. */
export function drainStderr(child: ChildProcess): void {
  const stderr = child.stderr
  if (!stderr) return
  const ignoreError = (): void => {
    stderr.resume()
  }
  stderr.on('error', ignoreError)
  stderr.resume()
  child.once('close', () => {
    stderr.pause()
    stderr.off('error', ignoreError)
  })
}

export function permissionOptions(mode?: SessionPermissionMode) {
  // SDK >=0.3.286 preserves omission instead of replacing it with 'default'.
  // Legacy/new Pact Sessions still default to Ask; Native is explicit opt-in.
  if (mode === 'native') return {}
  return mode === 'full'
    ? { permissionMode: 'bypassPermissions' as const, allowDangerouslySkipPermissions: true }
    : { permissionMode: mode === 'auto' ? ('auto' as const) : ('default' as const) }
}

/** Preserve native permission defaults while retiring a prior workflow's Plan mode. */
export async function confirmNativeExecutionMode(
  session: ReturnType<typeof query>,
  signal: AbortSignal,
  timeoutMs: number,
  planning = false,
): Promise<void> {
  let active = true
  try {
    await withDeadline(
      (async () => {
        const initialization = await session.initializationResult()
        if (!active || signal.aborted) return
        const mode = Reflect.get(initialization, 'current_permission_mode')
        if (
          !['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto'].includes(
            String(mode),
          )
        )
          throw new PermissionModeRejectedError(
            'Claude did not acknowledge its native permission mode. Nothing was submitted.',
          )
        if (planning && mode !== 'plan') await session.setPermissionMode('plan')
        else if (!planning && mode === 'plan') await session.setPermissionMode('default')
      })(),
      timeoutMs,
      signal,
    )
  } finally {
    active = false
  }
}

export async function confirmAutoMode(
  session: ReturnType<typeof query>,
  signal: AbortSignal,
  timeoutMs = PERMISSION_MODE_TIMEOUT_MS,
) {
  let active = true
  try {
    await withDeadline(
      (async () => {
        await session.initializationResult()
        // Deadline/cancellation ends this check, not native Hook work. A late
        // init must not install a mode after its input gate has been closed.
        if (!active || signal.aborted) return
        try {
          // This native ACK evaluates the actual model, managed/user/project
          // policy and runtime eligibility, including startup fallbacks.
          await session.setPermissionMode('auto')
        } catch (error) {
          if (
            error instanceof Error &&
            Reflect.get(error, 'errorClass') === 'control_request_failed' &&
            Reflect.get(error, 'telemetryMessage') ===
              'Claude Code control request failed (set_permission_mode)' &&
            /^Cannot set permission mode to auto(?::|$)/u.test(error.message)
          )
            throw new PermissionModeRejectedError(
              `${safeNativePermissionText(error.message)}. No task was submitted. Choose another permission mode.`,
            )
          throw error
        }
      })(),
      Math.min(PERMISSION_MODE_TIMEOUT_MS, timeoutMs),
      signal,
    )
  } finally {
    active = false
  }
}

export function runSettingsOptions(input: Pick<AgentRunInput, 'effort' | 'speed'>) {
  const options = explicitEffortOptions(input.effort)
  if (!input.speed || input.speed === 'native') return options
  // Fast starts disabled until the same Query confirms model compatibility.
  // Keep the explicit effort's env overlay in this single flag settings object.
  return { ...options, settings: { ...options.settings, fastMode: false } }
}

export async function configureFastMode(
  session: ReturnType<typeof query>,
  actor: () => ChildProcess | undefined,
  input: AgentRunInput,
  signal: AbortSignal,
  memory: NativeWorkingMemory,
  startupDeadline: number,
): Promise<string | undefined> {
  const controller = new AbortController()
  const observed = AbortSignal.any([signal, controller.signal])
  let flagAttempted = false
  let identityMismatch = false
  try {
    return await withDeadline(
      (async () => {
        const initialization = await session.initializationResult()
        observed.throwIfAborted()
        const models = initialization.models
        if (!Array.isArray(models) || models.length > 200)
          return 'The native model catalog could not confirm Fast compatibility. Continuing at standard speed.'
        const selection = models.find((entry) =>
          input.model ? entry.value === input.model : entry.value === 'default',
        )
        const wireModel = selection?.resolvedModel ?? input.model
        const model =
          selection?.supportsFastMode !== undefined
            ? selection
            : (models.find(
                (entry) =>
                  wireModel &&
                  (entry.value === wireModel || entry.resolvedModel === wireModel) &&
                  entry.supportsFastMode === true,
              ) ?? selection)
        if (model?.supportsFastMode !== true)
          return model?.supportsFastMode === false
            ? 'This model does not support Fast. Continuing at standard speed with the same model and effort.'
            : 'The native model catalog could not confirm Fast compatibility. Continuing at standard speed.'
        if (typeof session.applyFlagSettings !== 'function')
          return 'This Claude Code version cannot apply Fast to this execution. Continuing at standard speed.'
        const before = await readRunSettings(actor(), observed, memory)
        const expectedModel = model.resolvedModel ?? model.value
        if (
          (before.model !== expectedModel && before.model !== model.value) ||
          (input.effort && before.effort !== input.effort)
        ) {
          identityMismatch = true
          throw new AgentExecutionError(
            'runtime_incompatible',
            'Claude Code did not confirm the selected model and effort before enabling Fast. No task was submitted.',
            false,
          )
        }
        observed.throwIfAborted()
        // This is the Query-scoped flag layer, including the SDK's explicit
        // opt-in. Unlike /fast it does not promote or replace the model.
        flagAttempted = true
        await session.applyFlagSettings({ fastMode: true })
        observed.throwIfAborted()
        const after = await readRunSettings(actor(), observed, memory)
        if (after.model !== before.model || after.effort !== before.effort)
          throw new AgentExecutionError(
            'runtime_incompatible',
            'Claude Code changed the model or effort while applying Fast. No task was submitted.',
            false,
          )
        return undefined
      })(),
      Math.max(1, Math.min(FAST_MODE_CHECK_TIMEOUT_MS, startupDeadline - Date.now())),
      signal,
    )
  } catch (error) {
    signal.throwIfAborted()
    if (flagAttempted || identityMismatch) throw error
    // Catalog/read-only control failures cannot make the already-disabled
    // Query faster. Fall back without recreating it or delivering twice.
    return 'Native Fast compatibility could not be checked before dispatch. Continuing at standard speed.'
  } finally {
    // Retire read-only control listeners even if the SDK's own pending ACK
    // arrives late. Unknown flag application leaves the prompt gate closed.
    controller.abort()
  }
}

export function readRunSettings(
  child: ChildProcess | undefined,
  signal: AbortSignal,
  memory: NativeWorkingMemory,
): Promise<{
  model: string
  effort: string | null
  fastMode?: boolean
  fastModeDisabled: boolean
  configurationSha256?: string
}> {
  signal.throwIfAborted()
  if (!child?.stdout || !child.stdin)
    throw new Error('Claude Code has no owned native settings transport.')
  const requestId = randomUUID()
  const reservation = memory.reserve(8 * 1024 * 1024)
  return new Promise((resolve, reject) => {
    const decoder = new StringDecoder('utf8')
    let pending = ''
    let bytes = 0
    let settled = false
    const cleanup = (): void => {
      child.stdout!.off('data', data)
      child.off('close', closed)
      signal.removeEventListener('abort', aborted)
      pending = ''
      reservation.release()
    }
    const fail = (): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(new Error('Claude Code did not confirm its native execution settings.'))
    }
    const closed = (): void => fail()
    const aborted = (): void => fail()
    const data = (chunk: Buffer): void => {
      bytes += chunk.byteLength
      if (bytes > 1024 * 1024) return fail()
      pending += decoder.write(chunk)
      for (;;) {
        const newline = pending.indexOf('\n')
        if (newline < 0) return
        const line = pending.slice(0, newline)
        pending = pending.slice(newline + 1)
        let message: unknown
        try {
          message = JSON.parse(line)
        } catch {
          return fail()
        }
        if (!message || typeof message !== 'object') continue
        const response = Reflect.get(message, 'response')
        if (
          Reflect.get(message, 'type') !== 'control_response' ||
          !response ||
          typeof response !== 'object' ||
          Reflect.get(response, 'request_id') !== requestId
        )
          continue
        const value = Reflect.get(response, 'response')
        const applied = value && typeof value === 'object' ? Reflect.get(value, 'applied') : null
        const model = applied && typeof applied === 'object' ? Reflect.get(applied, 'model') : null
        const effort =
          applied && typeof applied === 'object' ? Reflect.get(applied, 'effort') : null
        const effective =
          value && typeof value === 'object' ? Reflect.get(value, 'effective') : undefined
        const fastMode =
          applied && typeof applied === 'object' ? Reflect.get(applied, 'fastMode') : undefined
        if (
          Reflect.get(response, 'subtype') !== 'success' ||
          typeof model !== 'string' ||
          !model ||
          model.length > 160 ||
          !applied ||
          typeof applied !== 'object' ||
          !Object.hasOwn(applied, 'effort') ||
          (effort != null && (typeof effort !== 'string' || effort.length > 80))
        )
          return fail()
        if (settled) return
        settled = true
        const settings = {
          model,
          effort: typeof effort === 'string' ? effort : null,
          ...(typeof fastMode === 'boolean' ? { fastMode } : {}),
          fastModeDisabled:
            effective &&
            typeof effective === 'object' &&
            Reflect.get(effective, 'fastMode') === false,
          ...(effective && typeof effective === 'object' && !Array.isArray(effective)
            ? {
                configurationSha256: createHash('sha256')
                  .update(
                    JSON.stringify({ effective, applied }, (_key, item: unknown) =>
                      item && typeof item === 'object' && !Array.isArray(item)
                        ? Object.fromEntries(
                            Object.entries(item).toSorted(([a], [b]) => a.localeCompare(b)),
                          )
                        : item,
                    ),
                  )
                  .digest('hex'),
              }
            : {}),
        }
        cleanup()
        resolve(settings)
        return
      }
    }
    child.stdout!.on('data', data)
    child.once('close', closed)
    signal.addEventListener('abort', aborted, { once: true })
    child.stdin!.write(
      JSON.stringify({
        type: 'control_request',
        request_id: requestId,
        request: { subtype: 'get_settings' },
      }) + '\n',
      (error) => {
        if (error) fail()
      },
    )
  })
}

export function fastModeDisabledDetail(reason: unknown): string | undefined {
  switch (reason) {
    case 'free':
      return 'Fast mode isn’t available for this account. Using standard speed.'
    case 'preference':
      return 'Fast mode is disabled by your settings or policy. Using standard speed.'
    case 'extra_usage_disabled':
      return 'Fast mode requires extra usage to be enabled. Using standard speed.'
    case 'network_error':
      return 'Fast mode is unavailable due to a network issue. Using standard speed.'
    case 'not_first_party':
      return 'Fast mode isn’t available for this provider. Using standard speed.'
    case 'disabled_by_env':
      return 'Fast mode is disabled by environment settings. Using standard speed.'
    case 'model_not_allowed':
      return 'This model doesn’t support Fast mode. Using standard speed.'
    case 'sdk_opt_in_required':
      return 'Fast mode isn’t enabled for this run. Using standard speed.'
    case 'pending':
      return 'Checking Fast mode availability. Using standard speed for now.'
    case 'unknown':
      return 'Fast mode is unavailable. Using standard speed.'
    default:
      return undefined
  }
}

export function permissionHandler(
  input: ClaudePermissionHandlerInput,
  providerSignal: AbortSignal,
  wait: NativePermissionWait,
  recordPlan?: (
    nativeId: string,
    toolInput: unknown,
  ) => Promise<'submitted' | 'retained' | PlanSubmissionRejection>,
): CanUseTool {
  const fullAccess = input.permissionMode === 'full'
  const pending = new Map<string, ReturnType<CanUseTool>>()
  return (toolName, toolInput, options) => {
    const signal = AbortSignal.any([providerSignal, options.signal])
    const key = `${options.requestId}:${options.toolUseID}:${options.agentID ?? ''}`
    const current = pending.get(key)
    if (current) return current
    const denied = {
      behavior: 'deny' as const,
      message: 'The native permission request was not approved.',
      toolUseID: options.toolUseID,
    }
    if (toolName === 'ExitPlanMode' && recordPlan) {
      if (
        signal.aborted ||
        options.agentID ||
        key.length > 2048 ||
        !options.toolUseID ||
        options.toolUseID.length > 1024
      )
        return Promise.resolve({
          ...denied,
          message: 'This plan submission does not belong to the active root.',
        })
      return recordPlan(options.toolUseID, toolInput).then((captured) => ({
        ...denied,
        message:
          captured === 'retained'
            ? 'The existing plan and your response will be sent for independent review. This is not implementation approval. End with your natural response and wait for Pact.'
            : captured === 'submitted'
              ? 'The native plan has been submitted to Pact for independent review. This is not implementation approval. Stay in plan mode; end with your natural response now and wait for Pact to arrange review.'
              : `No complete authenticated native plan is available. This is not implementation approval. Pact diagnostic: ${captured.reason}.${captured.latestCapture ? ` Latest capture: ${captured.latestCapture.code}/${captured.latestCapture.tool}/${captured.latestCapture.phase}.` : ''} Preserve the plan and report this code; rewriting it is not a confirmed remedy.`,
      }))
    }
    if (toolName === 'AskUserQuestion') {
      if (
        !input.requestUserInput ||
        signal.aborted ||
        pending.size >= NATIVE_PERMISSION_REQUESTS ||
        key.length > 2048
      )
        return Promise.reject(
          new Error('The native question could not obtain a current user response.'),
        )
      const endWait = wait.begin()
      const task: ReturnType<CanUseTool> = (async () => {
        try {
          const question = claudeQuestions(toolInput)
          const result = await NativePermissionWait.decision(
            input.requestUserInput!(question.request, signal),
            signal,
          )
          signal.throwIfAborted()
          if (result.action !== 'accept' || !result.values)
            return {
              ...denied,
              message:
                'The user declined or cancelled the native question. No answers were supplied.',
            }
          return {
            behavior: 'allow' as const,
            toolUseID: options.toolUseID,
            updatedInput: { ...toolInput, answers: question.answers(result.values) },
          }
        } catch {
          throw new Error('The native question did not receive a current user response.')
        } finally {
          endWait()
          pending.delete(key)
        }
      })()
      pending.set(key, task)
      return task
    }
    if (fullAccess)
      return Promise.resolve({
        ...denied,
        message:
          'This operation was blocked by native policy or this task’s scope. Full access does not override those restrictions, and no tool approval was requested. Continue within the current task’s authority.',
      })
    if (
      signal.aborted ||
      !input.requestPermission ||
      pending.size >= NATIVE_PERMISSION_REQUESTS ||
      key.length > 2048
    )
      return Promise.reject(
        new Error('The native permission request could not obtain a current user decision.'),
      )
    // Native suggestions form one indivisible update. Offer the entire set
    // only when every destination is this native Session; never rewrite or
    // partially apply a mixed/settings/CLI-argument suggestion set.
    const updates = options.suppressAlwaysAllowRule ? [] : (options.suggestions ?? [])
    const boundedSessionUpdates =
      updates.length > 0 &&
      updates.length <= 32 &&
      updates.every((update) => {
        if (update.destination !== 'session') return false
        if ('rules' in update)
          return (
            update.rules.length <= 32 &&
            update.rules.every(
              (rule) => rule.toolName.length <= 240 && (rule.ruleContent?.length ?? 0) <= 1024,
            )
          )
        if ('directories' in update)
          return (
            update.directories.length <= 32 &&
            update.directories.every((directory) => directory.length <= 1024)
          )
        return update.mode.length <= 80
      })
    const updateScope = boundedSessionUpdates
      ? exactNativeSessionScope([
          'Native Session permission updates:',
          JSON.stringify(updates, null, 2),
        ])
      : undefined
    const command = Reflect.get(toolInput, 'command'),
      path = Reflect.get(toolInput, 'file_path')
    const detailSource = [
      typeof command === 'string' ? `Command: ${command}` : undefined,
      typeof path === 'string' ? `File: ${path}` : undefined,
      `Session directory: ${input.cwd}`,
      options.blockedPath ? `Blocked path: ${options.blockedPath}` : undefined,
      options.description,
      options.decisionReason,
    ]
      .filter(Boolean)
      .join('\n')
    if (!nativeApprovalDisplayFits(detailSource))
      return Promise.reject(
        new Error(
          'This native approval cannot be displayed completely within the safe request budget. No decision was supplied.',
        ),
      )
    const detail = safeNativePermissionText(detailSource)
    const actions: NonNullable<NativePermissionRequest['actions']> = [
      { id: 'decline', label: 'Decline and continue', kind: 'decline' },
      { id: 'cancel', label: 'Cancel this turn', kind: 'cancel' },
      { id: 'allow', label: 'Allow this tool call', kind: 'allow' },
      ...(updateScope
        ? [
            {
              id: 'native-updates',
              label: 'Allow for this session…',
              kind: 'rule' as const,
              scope: updateScope,
              confirmation:
                'Allow this tool call and apply exactly the displayed permissions for this native session.',
            },
          ]
        : []),
    ]
    const approval = {
      title: safeNativePermissionText(
        options.title ?? `Claude Code wants to use ${options.displayName ?? toolName}`,
        240,
      ),
      detail,
      actions,
      ...(options.defaultToNo ? { defaultToNo: true } : {}),
    }
    if (
      !nativePermissionRequestSchema.safeParse({
        ...approval,
        id: randomUUID(),
        createdAt: new Date().toISOString(),
      }).success
    )
      return Promise.reject(
        new Error(
          'This native approval cannot be displayed completely within the request budget. No decision was supplied.',
        ),
      )
    const endWait = wait.begin()
    const task: ReturnType<CanUseTool> = (async () => {
      try {
        const decision = await NativePermissionWait.decision(
          input.requestPermission!(approval, signal),
          signal,
        )
        if (decision === 'cancel')
          return { ...denied, interrupt: true, message: 'The user cancelled this turn.' }
        signal.throwIfAborted()
        if (!actions.some((action) => action.id === decision))
          throw new Error('The native decision is not a current offered action.')
        if (decision === 'decline') return denied
        return {
          behavior: 'allow' as const,
          toolUseID: options.toolUseID,
          ...(decision === 'native-updates' && updateScope ? { updatedPermissions: updates } : {}),
        }
      } catch {
        throw new Error('The native permission request did not receive a current user decision.')
      } finally {
        endWait()
        pending.delete(key)
      }
    })()
    pending.set(key, task)
    return task
  }
}

export function elicitationHandler(
  input: ClaudeElicitationHandlerInput,
  providerSignal: AbortSignal,
  wait: NativePermissionWait,
): OnElicitation {
  const pending = new Map<string, ReturnType<OnElicitation>>()
  return (request, options) => {
    const existing = pending.get(options.requestId)
    if (existing) return existing
    const signal = AbortSignal.any([providerSignal, options.signal])
    if (
      !input.requestUserInput ||
      signal.aborted ||
      pending.size >= NATIVE_PERMISSION_REQUESTS ||
      options.requestId.length > 2048
    )
      return Promise.reject(
        new Error('The native input request could not obtain a current user response.'),
      )
    const endWait = wait.begin()
    const task: ReturnType<OnElicitation> = (async () => {
      try {
        const normalized = nativeElicitation({ ...request }, 'Claude Code')
        const result = await NativePermissionWait.decision(
          input.requestUserInput!(normalized, signal),
          signal,
        )
        signal.throwIfAborted()
        if (result.action !== 'accept')
          return { action: result.action === 'decline' ? 'decline' : 'cancel' }
        if (normalized.kind === 'url') return { action: 'accept' }
        if (!result.values) throw new Error('No submitted native form values were supplied.')
        return { action: 'accept', content: result.values }
      } catch {
        throw new Error('The native input request did not receive a current user response.')
      } finally {
        endWait()
        pending.delete(options.requestId)
      }
    })()
    pending.set(options.requestId, task)
    return task
  }
}

export function nextWithCancellation(
  signal: AbortSignal,
  read: Promise<IteratorResult<SDKMessage>>,
): Promise<IteratorResult<SDKMessage>> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (): boolean => {
      if (settled) return false
      settled = true
      signal.removeEventListener('abort', aborted)
      return true
    }
    const aborted = (): void => {
      if (finish())
        reject(
          new AgentExecutionError('agent_process_crash', 'Claude Code was interrupted.', false),
        )
    }
    if (signal.aborted) aborted()
    else signal.addEventListener('abort', aborted, { once: true })
    read.then(
      (result) => {
        if (finish()) return resolve(result)
        return undefined
      },
      (error: unknown) => {
        if (finish()) return reject(error instanceof Error ? error : new Error(String(error)))
        return undefined
      },
    )
  })
}

export async function* promptMessages(
  input: AgentRunInput,
  sessionId: string,
  dispatched: () => void | boolean,
  permissionInput?: Promise<boolean>,
  signal?: AbortSignal,
  skillInput?: Promise<boolean>,
  memory = new NativeWorkingMemory(),
  hold?: (reservation: NativeMemoryReservation) => void,
  steering?: { priority: 'next'; prefix?: string | undefined },
): AsyncIterable<SDKUserMessage> {
  if (!isRequestUuid(input.runId)) throw new Error('Invalid request identity.')
  if (permissionInput && !(await permissionInput)) return
  if (skillInput && !(await skillInput)) return
  if (signal?.aborted) return
  const reservation = memory.reserve(
    freezeNativeJsonFrame(input.promptEnvelope) +
      nativeImagePreparationBytes(
        agentPromptImageGroups(input.promptEnvelope).flatMap((group) => group.images),
      ) +
      256 * 1024,
  )
  hold?.(reservation)
  let message: SDKUserMessage
  let held: number
  try {
    const sourceReader = input.host?.workflow?.sourceReader
    const content = await claudePromptContent(
      input.promptEnvelope,
      signal,
      sourceReader ? (target) => sourceReader.navigation(target, 'legacy') : undefined,
      cutoffSourceNavigator(sourceReader, 'legacy'),
    )
    message = {
      type: 'user',
      message: {
        role: 'user',
        content: steering?.prefix
          ? typeof content === 'string'
            ? `${steering.prefix}\n\n${content}`
            : [{ type: 'text', text: steering.prefix }, ...content]
          : content,
      },
      parent_tool_use_id: null,
      session_id: sessionId,
      uuid: input.runId,
      ...(steering ? { priority: steering.priority, origin: { kind: 'human' as const } } : {}),
    }
    held = freezeNativeJsonFrame(input.promptEnvelope) + freezeNativeJsonFrame(message) + 256 * 1024
    reservation.resize(held)
  } catch (error) {
    reservation.release()
    throw error
  }
  let dispatchedToSdk = false
  try {
    let encodedBytes = 0
    // SDK owns JSON.stringify and stdin.write; budget their complete string/pipe copies before
    // yielding its unchanged API message. Measurement holds only one encoder processing chunk.
    for await (const chunk of encodeNativeJsonFrame(message, signal)) {
      encodedBytes += chunk.byteLength
      reservation.resize(held + encodedBytes * 4)
    }
    if (signal?.aborted) return
    if (dispatched() === false) return
    dispatchedToSdk = true
    yield message
  } finally {
    // The Query owner retains this allowance through actual reader+actor termination.
    if (!dispatchedToSdk || !hold) reservation.release()
  }
}

export function isRequestUuid(value: string): value is NonNullable<SDKUserMessage['uuid']> {
  return /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(value)
}

export function withDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(
      new AgentExecutionError('agent_process_crash', 'Claude Code was interrupted.', false),
    )
  }
  return new Promise((resolve, reject) => {
    const finish = (): void => {
      clearTimeout(timeout)
      signal.removeEventListener('abort', abort)
    }
    const abort = (): void => {
      finish()
      reject(new AgentExecutionError('agent_process_crash', 'Claude Code was interrupted.', false))
    }
    const timeout = setTimeout(() => {
      finish()
      reject(
        new AgentExecutionError(
          'transient_transport',
          'The Claude Code native operation did not complete before this check deadline.',
          false,
        ),
      )
    }, timeoutMs)
    signal.addEventListener('abort', abort, { once: true })
    promise.then(
      (value) => {
        finish()
        return resolve(value)
      },
      (error: unknown) => {
        finish()
        return reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

export function completedText(message: SDKMessage): string | undefined {
  if (message.type !== 'assistant' || message.parent_tool_use_id) return undefined
  const content = message.message.content
    .filter(
      (block): block is Extract<(typeof message.message.content)[number], { type: 'text' }> =>
        block.type === 'text',
    )
    .map((block) => block.text)
    .join('')
  return message.message.content.some((block) => block.type === 'text') ? content : undefined
}

export function explicitEffortOptions(value: string | null): {
  effort?: ClaudeEffort
  settings?: { env: { CLAUDE_CODE_EFFORT_LEVEL: ClaudeEffort } }
} {
  const parsed = parseClaudeEffort(value)
  // The native settings env tier outranks the SDK effort flag. A Session's
  // explicit selection must override that one key in this Query's flag tier.
  return parsed ? { effort: parsed, settings: { env: { CLAUDE_CODE_EFFORT_LEVEL: parsed } } } : {}
}

export function parseClaudeEffort(value: string | null): ClaudeEffort | undefined {
  switch (value) {
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
    case 'max':
      return value
    default:
      return undefined
  }
}

export function supportsReasoningSummaries(model: string | null): boolean {
  return model === null || /claude|opus|sonnet|haiku/iu.test(model)
}

export function describeTool(
  toolName: string,
  input: unknown,
  cwd: string,
): { title: string; detail?: string | undefined } {
  const values = input !== null && typeof input === 'object' ? input : undefined
  const filePath = values ? Reflect.get(values, 'file_path') : undefined
  const alternativePath = values ? Reflect.get(values, 'path') : undefined
  const pathValue = filePath ?? alternativePath
  const path = typeof pathValue === 'string' ? AgentActivityDetail.projectPath(pathValue, cwd) : ''
  const patternValue = values ? Reflect.get(values, 'pattern') : undefined
  const pattern =
    typeof patternValue === 'string' ? AgentActivityDetail.redact(patternValue) : undefined

  switch (toolName) {
    case 'Skill': {
      const name = values ? Reflect.get(values, 'skill') : undefined
      return {
        title:
          typeof name === 'string' ? `Skill /${name.slice(0, 160)}` : 'Native Skill invocation',
      }
    }
    case 'Read':
      return {
        title: path ? `Reading ${basename(path)}` : 'Reading a file',
        ...(path ? { detail: path } : {}),
      }
    case 'Grep':
      return {
        title: 'Searching the project',
        ...(pattern || path ? { detail: [pattern, path].filter(Boolean).join(' · ') } : {}),
      }
    case 'Glob':
      return {
        title: 'Finding files',
        ...(pattern ? { detail: pattern } : {}),
      }
    default:
      return { title: `Using ${humanizeToolName(toolName)}` }
  }
}

export function humanizeToolName(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .replace(/[_-]+/gu, ' ')
    .trim()
    .toLowerCase()
}
