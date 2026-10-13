import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'

import {
  agentPromptImageGroups,
  serializeAgentPromptEnvelope,
  type AgentPromptEnvelope,
  type AgentPromptImage,
} from '@pact/agent-runtime'

import { AgentExecutionError } from './agent-execution-error'

export interface NativeImageBlock {
  type: 'image'
  source: {
    type: 'base64'
    media_type: AgentPromptImage['mediaType']
    data: string
  }
}

export function nativeImagePreparationBytes(images: readonly AgentPromptImage[]): number {
  return (
    images.reduce((bytes, image) => bytes + Math.ceil(image.bytes / 3) * 4 * 6 + 1024, 0) +
    Math.max(0, ...images.map((image) => image.bytes))
  )
}

/** The caller admits the complete DTO/SDK work before reading or encoding immutable images. */
export async function nativeImageBlock(
  image: AgentPromptImage,
  signal?: AbortSignal,
): Promise<NativeImageBlock> {
  const observed = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
    : AbortSignal.timeout(10_000)
  observed.throwIfAborted()
  const named = process.platform === 'win32' ? await lstat(image.path, { bigint: true }) : undefined
  if (named && (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1n))
    throw new AgentExecutionError('protocol_error', 'The saved Pact image is unavailable.', false)
  const handle = await open(image.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || before.nlink !== 1n || before.size !== BigInt(image.bytes))
      throw new AgentExecutionError('protocol_error', 'The saved Pact image is unavailable.', false)
    if (
      named &&
      (named.dev !== before.dev ||
        named.ino !== before.ino ||
        named.size !== before.size ||
        named.mtimeNs !== before.mtimeNs ||
        named.ctimeNs !== before.ctimeNs)
    )
      throw new AgentExecutionError('protocol_error', 'The saved Pact image changed.', false)
    const bytes = await handle.readFile({ signal: observed })
    const after = await handle.stat({ bigint: true })
    const current = named ? await lstat(image.path, { bigint: true }) : undefined
    if (
      bytes.byteLength !== image.bytes ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      (current &&
        (!current.isFile() ||
          current.isSymbolicLink() ||
          current.nlink !== 1n ||
          current.dev !== after.dev ||
          current.ino !== after.ino ||
          current.size !== after.size ||
          current.mtimeNs !== after.mtimeNs ||
          current.ctimeNs !== after.ctimeNs)) ||
      createHash('sha256').update(bytes).digest('hex') !== image.sha256
    )
      throw new AgentExecutionError('protocol_error', 'The saved Pact image changed.', false)
    return {
      type: 'image',
      source: { type: 'base64', media_type: image.mediaType, data: bytes.toString('base64') },
    }
  } finally {
    await handle.close()
  }
}

export function codexPromptInput(envelope: AgentPromptEnvelope) {
  type Input =
    | { type: 'text'; text: string; text_elements: never[] }
    | { type: 'localImage'; path: string }
    | { type: 'skill'; name: string; path: string | undefined }
  const input: Input[] = [
    { type: 'text', text: serializeAgentPromptEnvelope(envelope), text_elements: [] },
  ]
  for (const group of agentPromptImageGroups(envelope)) {
    input.push({
      type: 'text',
      text: `Pact images from message ${group.messageId}, in reference order:`,
      text_elements: [],
    })
    for (const image of group.images) input.push({ type: 'localImage', path: image.path })
  }
  for (const entry of envelope.skillInvocation?.bindings ?? [])
    if (entry.agentId === 'codex') input.push({ type: 'skill', name: entry.name, path: entry.path })
  return input
}

export function requireNativeImageReference(
  image: AgentPromptImage,
  reference: Omit<AgentPromptImage, 'path'>,
): void {
  if (
    ['id', 'name', 'mediaType', 'bytes', 'width', 'height', 'sha256'].some(
      (key) => Reflect.get(image, key) !== Reflect.get(reference, key),
    )
  )
    throw new AgentExecutionError(
      'protocol_error',
      'The saved Pact image does not match its source manifest.',
      false,
    )
}

export async function claudePromptContent(envelope: AgentPromptEnvelope, signal?: AbortSignal) {
  const text = serializeAgentPromptEnvelope(envelope)
  const groups = agentPromptImageGroups(envelope)
  if (!groups.length) return text
  const blocks: Array<{ type: 'text'; text: string } | NativeImageBlock> = [{ type: 'text', text }]
  for (const group of groups) {
    blocks.push({
      type: 'text',
      text: `Pact images from message ${group.messageId}, in reference order:`,
    })
    for (const image of group.images) {
      // oxlint-disable-next-line no-await-in-loop -- Preserve message/image order and one read buffer.
      blocks.push(await nativeImageBlock(image, signal))
    }
  }
  return blocks
}

/** Only real user image blocks can account for the larger encoded-history allowance. */
export function nativeHistoryImageBytes(value: unknown): number {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 0
  const record = value
  const payload = Reflect.get(record, 'payload')
  const message =
    Reflect.get(record, 'type') === 'user'
      ? Reflect.get(record, 'message')
      : Reflect.get(record, 'type') === 'response_item' &&
          payload &&
          typeof payload === 'object' &&
          Reflect.get(payload, 'type') === 'message' &&
          Reflect.get(payload, 'role') === 'user'
        ? payload
        : undefined
  if (!message || typeof message !== 'object') return 0
  const content = Reflect.get(message, 'content')
  if (!Array.isArray(content)) return 0
  let bytes = 0
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const type = Reflect.get(block, 'type')
    let data: unknown
    if (type === 'input_image') {
      const url = Reflect.get(block, 'image_url')
      if (typeof url === 'string' && /^data:image\/(?:png|jpeg|webp);base64,/u.test(url))
        data = url.slice(url.indexOf(',') + 1)
    } else if (type === 'image') {
      const source = Reflect.get(block, 'source')
      if (
        source &&
        typeof source === 'object' &&
        Reflect.get(source, 'type') === 'base64' &&
        ['image/png', 'image/jpeg', 'image/webp'].includes(Reflect.get(source, 'media_type'))
      )
        data = Reflect.get(source, 'data')
    }
    if (typeof data === 'string' && data.length > 0 && /^[A-Za-z0-9+/]*={0,2}$/u.test(data))
      bytes += data.length
  }
  return bytes
}
