import { randomUUID } from 'node:crypto'
import { basename, isAbsolute, relative } from 'node:path'

import {
  nativeInputDetailsSchema,
  nativeInputValueSchema,
  nativePermissionRequestSchema,
  type NativeInputField,
  type NativePermissionRequest,
  type NativeUserInputRequest,
} from '@pact/contracts'

import { AgentExecutionError } from '../agent-execution-error'
import { nativeApprovalDisplayFits, safeNativePermissionText } from '../native-permission-wait'
import {
  asString,
  isPlainObject,
  type AcpConfigOptionEntry,
  type AcpSessionDescriptor,
} from './types'

export function parseAcpSessionDescriptor(
  result: object,
  fallbackSessionId?: string,
): AcpSessionDescriptor {
  const sessionId = asString(Reflect.get(result, 'sessionId')) ?? fallbackSessionId
  if (!sessionId || sessionId.length > 1024) {
    throw new AgentExecutionError(
      'protocol_error',
      'Antigravity ACP server did not return a valid sessionId.',
      false,
    )
  }
  const modesRaw = Reflect.get(result, 'modes')
  const currentModeId = isPlainObject(modesRaw) ? asString(modesRaw.currentModeId) : undefined
  const availableModes =
    isPlainObject(modesRaw) && Array.isArray(modesRaw.availableModes)
      ? modesRaw.availableModes
          .map((entry) =>
            typeof entry === 'string'
              ? entry
              : isPlainObject(entry)
                ? asString(entry.id ?? entry.modeId)
                : undefined,
          )
          .filter((id): id is string => Boolean(id))
      : undefined

  const modelsRaw = Reflect.get(result, 'models')
  const currentModelId = isPlainObject(modelsRaw) ? asString(modelsRaw.currentModelId) : undefined
  const availableModels =
    isPlainObject(modelsRaw) && Array.isArray(modelsRaw.availableModels)
      ? modelsRaw.availableModels
          .map((entry) =>
            typeof entry === 'string'
              ? entry
              : isPlainObject(entry)
                ? asString(entry.modelId ?? entry.id)
                : undefined,
          )
          .filter((id): id is string => Boolean(id))
      : undefined

  const configOptions = parseConfigOptions(Reflect.get(result, 'configOptions'))
  return {
    sessionId,
    currentModeId,
    availableModes,
    currentModelId,
    availableModels,
    configOptions,
  }
}

export function parseConfigOptions(raw: unknown): AcpConfigOptionEntry[] {
  if (!Array.isArray(raw) || raw.length > 32) return []
  const entries: AcpConfigOptionEntry[] = []
  for (const item of raw) {
    if (!isPlainObject(item)) continue
    const id = asString(item.id ?? item.configId)
    if (!id) continue
    const currentValue = asString(item.currentValue ?? item.value)
    const rawOptions = Array.isArray(item.options) ? item.options : undefined
    const options =
      rawOptions && rawOptions.length <= 128
        ? rawOptions
            .map((opt) => {
              if (!isPlainObject(opt)) return undefined
              const val = asString(opt.value ?? opt.id)
              if (!val) return undefined
              const mapped: { value: string; name?: string | undefined } = { value: val }
              const optName = asString(opt.name)
              if (optName) mapped.name = optName
              return mapped
            })
            .filter((opt): opt is { value: string; name?: string | undefined } => opt !== undefined)
        : undefined
    entries.push({ id, currentValue, options })
  }
  return entries
}

export function collectAmbiguousPermissionOptionIds(options: readonly unknown[]): Set<string> {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const option of options) {
    if (!isPlainObject(option)) continue
    const optionId = asString(option.optionId)
    if (!optionId) continue
    if (seen.has(optionId)) {
      duplicates.add(optionId)
    } else {
      seen.add(optionId)
    }
  }
  return duplicates
}

export function findRejectOnceOptionId(options: unknown): string | undefined {
  if (!Array.isArray(options) || options.length === 0 || options.length > 32) return undefined
  const ambiguousIds = collectAmbiguousPermissionOptionIds(options)
  for (const option of options) {
    if (!isPlainObject(option)) continue
    const optionId = asString(option.optionId)
    if (!optionId || optionId.length > 80 || ambiguousIds.has(optionId)) continue
    const rawKind = option.kind
    if (typeof rawKind === 'string' && rawKind.length > 0) {
      if (rawKind === 'reject_once') return optionId
      continue
    }
    if (rawKind !== undefined) continue
    if (optionId === 'deny' || optionId === 'reject_once') {
      return optionId
    }
  }
  return undefined
}

export function findAllowOnceOptionId(options: unknown): string | undefined {
  if (!Array.isArray(options) || options.length === 0 || options.length > 32) return undefined
  const ambiguousIds = collectAmbiguousPermissionOptionIds(options)
  for (const option of options) {
    if (!isPlainObject(option)) continue
    const optionId = asString(option.optionId)
    if (!optionId || optionId.length > 80 || ambiguousIds.has(optionId)) continue
    const rawKind = option.kind
    if (typeof rawKind === 'string' && rawKind.length > 0) {
      // NEVER auto-select or expose `allow_always` as session-scoped because Antigravity persists it globally.
      if (rawKind === 'allow_once') return optionId
      continue
    }
    if (rawKind !== undefined) continue
    if (optionId === 'allow_always') continue
    if (optionId === 'allow' || optionId === 'allow_once') {
      return optionId
    }
  }
  return undefined
}

export function buildAgyPermissionCard(
  params: Record<string, unknown>,
  cwd: string,
): {
  request: Omit<NativePermissionRequest, 'id' | 'createdAt'>
  responses: Map<string, object>
} {
  const toolCall = isPlainObject(params.toolCall) ? params.toolCall : {}
  const toolName = asString(toolCall.name) ?? asString(toolCall.title) ?? 'tool'
  const rawTitle = asString(toolCall.title) ?? `Antigravity wants to run ${toolName}`
  const title = safeNativePermissionText(rawTitle, 240) || 'Antigravity permission request'

  const args = isPlainObject(toolCall.args)
    ? toolCall.args
    : isPlainObject(toolCall.rawInput)
      ? toolCall.rawInput
      : undefined
  const detailLines: string[] = [`Tool: ${toolName}`]
  if (args) {
    const command = asString(args.CommandLine ?? args.command)
    const targetPath = asString(args.Path ?? args.path ?? args.file_path ?? args.filePath)
    if (command) detailLines.push(`Command: ${command}`)
    if (targetPath) {
      const displayPath = isAbsolute(targetPath)
        ? relative(cwd, targetPath) || basename(targetPath)
        : targetPath
      detailLines.push(`Path: ${displayPath}`)
    }
  }
  const rawDetail = detailLines.join('\n')
  const detailComplete = nativeApprovalDisplayFits(rawDetail, 2048)
  const detail = safeNativePermissionText(rawDetail, 2048)

  const allowOnceOptionId = detailComplete ? findAllowOnceOptionId(params.options) : undefined
  const rejectOnceOptionId = findRejectOnceOptionId(params.options)

  const actions: NonNullable<NativePermissionRequest['actions']> = []
  const responses = new Map<string, object>()

  if (allowOnceOptionId) {
    actions.push({
      id: 'agy-allow-once',
      label: 'Allow once',
      kind: 'allow',
    })
    responses.set('agy-allow-once', {
      outcome: { outcome: 'selected', optionId: allowOnceOptionId },
    })
  }
  if (rejectOnceOptionId) {
    actions.push({
      id: 'agy-reject-once',
      label: 'Decline and continue',
      kind: 'decline',
    })
    responses.set('agy-reject-once', {
      outcome: { outcome: 'selected', optionId: rejectOnceOptionId },
    })
  }
  actions.push({
    id: 'agy-cancel',
    label: 'Cancel this turn',
    kind: 'cancel',
  })
  responses.set('agy-cancel', { outcome: { outcome: 'cancelled' } })

  // Validate against public contract budget; never expose `allow_always` (`kind: 'rule'`).
  nativePermissionRequestSchema.parse({
    id: randomUUID(),
    kind: 'approval',
    title,
    detail,
    actions,
    defaultToNo: true,
    createdAt: new Date().toISOString(),
  })

  return {
    request: {
      kind: 'approval',
      title,
      detail,
      actions,
      defaultToNo: true,
    },
    responses,
  }
}

export function choicesFromAgySchema(
  schema: Record<string, unknown>,
): NonNullable<NativeInputField['options']> | undefined {
  const source = schema.enum ?? schema.oneOf ?? schema.anyOf
  if (source === undefined) return undefined
  if (!Array.isArray(source) || source.length === 0 || source.length > 64) {
    throw new Error('The native Antigravity enum schema is unsupported.')
  }
  const choices = source.map((entry, index) => {
    const value = isPlainObject(entry) ? entry.const : entry
    if (typeof value !== 'string') {
      throw new Error('Only string selectable values can be represented faithfully.')
    }
    const label =
      isPlainObject(entry) && typeof entry.title === 'string'
        ? entry.title
        : Array.isArray(schema.enumNames) && typeof schema.enumNames[index] === 'string'
          ? schema.enumNames[index]
          : value
    const choice: NonNullable<NativeInputField['options']>[number] = { value, label }
    if (isPlainObject(entry) && typeof entry.description === 'string') {
      choice.description = entry.description
    }
    return choice
  })
  if (new Set(choices.map((c) => c.value)).size !== choices.length) {
    throw new Error('Duplicate native selectable values are unsupported.')
  }
  return choices
}

export function parseAgyFormField(id: string, raw: unknown, required: boolean): NativeInputField {
  if (
    !isPlainObject(raw) ||
    '$ref' in raw ||
    '$defs' in raw ||
    'allOf' in raw ||
    'not' in raw ||
    'if' in raw ||
    'then' in raw ||
    'else' in raw
  ) {
    throw new Error('This native Antigravity form needs a deeper schema UI that is not supported.')
  }
  const title = typeof raw.title === 'string' && raw.title ? raw.title : id
  if (
    raw.writeOnly === true ||
    raw.format === 'password' ||
    /(?:^|[ _-])(?:password|api[ _-]?key|access[ _-]?token|refresh[ _-]?token|client[ _-]?secret|authorization|cookie)(?:$|[ _-])/iu.test(
      `${id} ${title}`,
    )
  ) {
    throw new Error(
      'Authentication credentials must be entered in the native browser flow, not a Pact form.',
    )
  }
  let type: NativeInputField['type']
  let choices: NativeInputField['options']
  if (raw.type === 'array') {
    if (
      !isPlainObject(raw.items) ||
      (raw.items.type !== undefined && raw.items.type !== 'string') ||
      '$ref' in raw.items
    ) {
      throw new Error('Only string selection arrays are supported by the native form UI.')
    }
    choices = choicesFromAgySchema(raw.items)
    if (!choices) throw new Error('A native array field must supply selectable options.')
    type = 'multi-select'
  } else {
    choices = choicesFromAgySchema(raw)
    type = choices
      ? 'select'
      : raw.type === 'string'
        ? 'text'
        : raw.type === 'number'
          ? 'number'
          : raw.type === 'integer'
            ? 'integer'
            : raw.type === 'boolean'
              ? 'boolean'
              : (() => {
                  throw new Error('This native Antigravity form field type is unsupported.')
                })()
  }
  const constraints = [
    typeof raw.minimum === 'number' ? `Minimum: ${raw.minimum}` : undefined,
    typeof raw.maximum === 'number' ? `Maximum: ${raw.maximum}` : undefined,
  ]
    .filter(Boolean)
    .join(' · ')
  const description = [
    typeof raw.description === 'string' ? raw.description : undefined,
    constraints || undefined,
  ]
    .filter(Boolean)
    .join('\n')

  return {
    id,
    label: title,
    ...(description ? { description } : {}),
    type,
    required,
    ...(raw.allowOther === true ? { allowOther: true } : {}),
    ...(choices ? { options: choices } : {}),
    ...('default' in raw ? { default: nativeInputValueSchema.parse(raw.default) } : {}),
  }
}

export function agyElicitationRequest(params: Record<string, unknown>): NativeUserInputRequest {
  const mode = params.mode ?? 'form'
  const server = typeof params.serverName === 'string' && params.serverName ? params.serverName : ''
  const defaultTitle = server ? `Antigravity · ${server}` : 'Antigravity needs your input'
  const title = safeNativePermissionText(
    typeof params.title === 'string' && params.title ? params.title : defaultTitle,
    240,
  )
  const message = typeof params.message === 'string' ? params.message : ''

  if (mode === 'url') {
    const url = asString(params.url)
    if (!url) throw new Error('Native authorization URL is unavailable.')
    const parsed = new URL(url)
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error('The native authorization URL is unsupported.')
    }
    const publicDetails = nativeInputDetailsSchema.parse({
      kind: 'url',
      title,
      message: safeNativePermissionText(message, 8192),
      fields: [],
      url,
    })
    return publicDetails
  }

  if (typeof mode !== 'string' || mode !== 'form') {
    throw new Error('This native Antigravity elicitation mode is unsupported.')
  }
  const schema = params.requestedSchema
  if (
    !isPlainObject(schema) ||
    schema.type !== 'object' ||
    !isPlainObject(schema.properties) ||
    '$ref' in schema ||
    '$defs' in schema ||
    'allOf' in schema ||
    'anyOf' in schema ||
    'oneOf' in schema
  ) {
    throw new Error('This native Antigravity form needs a deeper schema UI that is not supported.')
  }
  const required = schema.required ?? []
  const properties = schema.properties
  if (
    !Array.isArray(required) ||
    !required.every((key) => typeof key === 'string') ||
    Object.keys(properties).length === 0 ||
    Object.keys(properties).length > 32
  ) {
    throw new Error('The native Antigravity form field list is unsupported.')
  }
  if (required.some((key) => !Object.hasOwn(properties, key))) {
    throw new Error('The native Antigravity form requires an undeclared field.')
  }
  const fields = Object.entries(properties).map(([id, field]) =>
    parseAgyFormField(id, field, required.includes(id)),
  )
  const publicDetails = nativeInputDetailsSchema.parse({
    kind: 'form',
    title,
    message: safeNativePermissionText(message, 8192),
    fields,
  })
  return {
    ...publicDetails,
    requestedSchema: schema,
  }
}
