import {
  nativeInputDetailsSchema,
  nativeInputValueSchema,
  type NativeInputField,
  type NativeInputValues,
  type NativeUserInputRequest,
} from '@pact/contracts'

import { safeNativePermissionText } from './native-permission-wait'

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
function string(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`Native ${name} is unavailable.`)
  return value
}
function details(request: NativeUserInputRequest): NativeUserInputRequest {
  const { requestedSchema, ...publicDetails } = request
  return {
    ...nativeInputDetailsSchema.parse(publicDetails),
    ...(requestedSchema ? { requestedSchema } : {}),
  }
}
function options(value: unknown): NonNullable<NativeInputField['options']> {
  if (!Array.isArray(value) || value.length > 64)
    throw new Error('The native choices are unsupported.')
  return value.map((entry) => {
    if (!record(entry)) throw new Error('A native choice is invalid.')
    const label = string(entry.label, 'choice label')
    const choice: NonNullable<NativeInputField['options']>[number] = {
      value: label,
      label,
    }
    if (typeof entry.description === 'string') choice.description = entry.description
    return choice
  })
}

export function claudeQuestions(input: Record<string, unknown>): {
  request: NativeUserInputRequest
  answers: (values: NativeInputValues) => Record<string, string>
} {
  if (!Array.isArray(input.questions) || !input.questions.length || input.questions.length > 32)
    throw new Error('The native question list is unsupported.')
  const original: string[] = []
  const fields = input.questions.map((question, index): NativeInputField => {
    if (!record(question)) throw new Error('A native question is invalid.')
    const label = string(question.question, 'question')
    if (original.includes(label))
      throw new Error('Duplicate native question texts cannot be routed safely.')
    original.push(label)
    return {
      id: `question_${index}`,
      label,
      ...(typeof question.header === 'string' ? { description: question.header } : {}),
      type: question.multiSelect === true ? 'multi-select' : 'select',
      required: true,
      allowOther: true,
      options: options(question.options),
    }
  })
  return {
    request: details({
      kind: 'questions',
      title: 'Claude Code needs your input',
      message: '',
      fields,
    }),
    answers(values) {
      return Object.fromEntries(
        original.map((question, index) => {
          const value = values[`question_${index}`]
          if (
            typeof value !== 'string' &&
            !(Array.isArray(value) && value.every((part) => typeof part === 'string'))
          )
            throw new Error('A native question has no submitted answer.')
          return [question, Array.isArray(value) ? value.join(', ') : value]
        }),
      )
    },
  }
}

export function codexQuestions(params: Record<string, unknown>): {
  request: NativeUserInputRequest
  answers: (values: NativeInputValues) => Record<string, { answers: string[] }>
} {
  if (!Array.isArray(params.questions) || !params.questions.length || params.questions.length > 32)
    throw new Error('The native question list is unsupported.')
  const seen = new Set<string>()
  const fields = params.questions.map((question): NativeInputField => {
    if (!record(question)) throw new Error('A native question is invalid.')
    const id = string(question.id, 'question ID')
    if (seen.has(id)) throw new Error('Duplicate native question IDs cannot be routed safely.')
    seen.add(id)
    const choices = question.options == null ? undefined : options(question.options)
    return {
      id,
      label: string(question.question, 'question'),
      ...(typeof question.header === 'string' ? { description: question.header } : {}),
      type:
        question.isSecret === true
          ? 'secret'
          : question.multiSelect === true
            ? 'multi-select'
            : choices?.length
              ? 'select'
              : 'text',
      required: true,
      allowOther: question.isOther === true,
      ...(choices ? { options: choices } : {}),
    }
  })
  return {
    request: details({ kind: 'questions', title: 'Codex needs your input', message: '', fields }),
    answers(values) {
      return Object.fromEntries(
        fields.map((field) => {
          const value = values[field.id]
          if (
            typeof value !== 'string' &&
            !(Array.isArray(value) && value.every((part) => typeof part === 'string'))
          )
            throw new Error('A native question has no submitted answer.')
          return [field.id, { answers: Array.isArray(value) ? value : [value] }]
        }),
      )
    },
  }
}

function choicesFromSchema(
  schema: Record<string, unknown>,
): NonNullable<NativeInputField['options']> | undefined {
  const source = schema.enum ?? schema.oneOf ?? schema.anyOf
  if (source === undefined) return undefined
  if (!Array.isArray(source) || !source.length || source.length > 64)
    throw new Error('The native enum schema is unsupported.')
  const choices = source.map((entry, index) => {
    const value = record(entry) ? entry.const : entry
    if (typeof value !== 'string')
      throw new Error('Only string selectable values can be represented faithfully.')
    const choice: NonNullable<NativeInputField['options']>[number] = {
      value,
      label:
        record(entry) && typeof entry.title === 'string'
          ? entry.title
          : Array.isArray(schema.enumNames) && typeof schema.enumNames[index] === 'string'
            ? schema.enumNames[index]
            : value,
    }
    if (record(entry) && typeof entry.description === 'string')
      choice.description = entry.description
    return choice
  })
  if (new Set(choices.map((choice) => choice.value)).size !== choices.length)
    throw new Error('Duplicate native selectable values are unsupported.')
  return choices
}

function formField(id: string, raw: unknown, required: boolean): NativeInputField {
  if (
    !record(raw) ||
    '$ref' in raw ||
    '$defs' in raw ||
    'allOf' in raw ||
    'not' in raw ||
    'if' in raw ||
    'then' in raw ||
    'else' in raw
  )
    throw new Error('This native form needs a deeper schema UI that is not supported.')
  const title = typeof raw.title === 'string' ? raw.title : id
  if (
    raw.writeOnly === true ||
    raw.format === 'password' ||
    /(?:^|[ _-])(?:password|api[ _-]?key|access[ _-]?token|refresh[ _-]?token|client[ _-]?secret|authorization|cookie)(?:$|[ _-])/iu.test(
      `${id} ${title}`,
    )
  )
    throw new Error(
      'Authentication credentials must be entered in the native browser flow, not a Pact form.',
    )
  let type: NativeInputField['type']
  let choices: NativeInputField['options']
  if (raw.type === 'array') {
    if (
      !record(raw.items) ||
      (raw.items.type !== undefined && raw.items.type !== 'string') ||
      '$ref' in raw.items
    )
      throw new Error('Only string selection arrays are supported by the native form UI.')
    choices = choicesFromSchema(raw.items)
    if (!choices) throw new Error('A native array must supply its selectable values.')
    type = 'multi-select'
  } else {
    choices = choicesFromSchema(raw)
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
                  throw new Error('This native form field type is unsupported.')
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
    ...(choices ? { options: choices } : {}),
    ...('default' in raw ? { default: nativeInputValueSchema.parse(raw.default) } : {}),
  }
}

export function nativeElicitation(
  request: Record<string, unknown>,
  provider: 'Claude Code' | 'Codex',
): NativeUserInputRequest {
  const mode = request.mode ?? 'form'
  const server = typeof request.serverName === 'string' ? request.serverName : 'MCP server'
  const title = safeNativePermissionText(
    typeof request.title === 'string' ? request.title : `${provider} · ${server}`,
    240,
  )
  const message = typeof request.message === 'string' ? request.message : ''
  if (mode === 'url') {
    const url = string(request.url, 'authorization URL')
    const parsed = new URL(url)
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password)
      throw new Error('The native authorization URL is unsupported.')
    return details({
      kind: 'url',
      title,
      message: safeNativePermissionText(message, 8192),
      fields: [],
      url,
    })
  }
  if (typeof mode !== 'string' || !['form', 'openaiForm', 'openai/form'].includes(mode))
    throw new Error('This native elicitation mode is unsupported.')
  const schema = request.requestedSchema
  if (
    !record(schema) ||
    schema.type !== 'object' ||
    !record(schema.properties) ||
    '$ref' in schema ||
    '$defs' in schema ||
    'allOf' in schema ||
    'anyOf' in schema ||
    'oneOf' in schema
  )
    throw new Error('This native form needs a deeper schema UI that is not supported.')
  const required = schema.required ?? []
  const properties = schema.properties
  if (
    !Array.isArray(required) ||
    !required.every((key) => typeof key === 'string') ||
    Object.keys(schema.properties).length > 32
  )
    throw new Error('The native form field list is unsupported.')
  if (required.some((key) => !Object.hasOwn(properties, key)))
    throw new Error('The native form requires an undeclared field.')
  return details({
    kind: 'form',
    title,
    message: safeNativePermissionText(message, 8192),
    fields: Object.entries(properties).map(([id, field]) =>
      formField(id, field, required.includes(id)),
    ),
    requestedSchema: schema,
  })
}
