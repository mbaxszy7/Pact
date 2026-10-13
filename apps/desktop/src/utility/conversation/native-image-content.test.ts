import { createHash, randomUUID } from 'node:crypto'
import {
  link,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
  type FileHandle,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentPromptEnvelope, AgentPromptImage } from '@pact/agent-runtime'

import { serializeAgentPromptEnvelope } from '@pact/agent-runtime'

import {
  claudePromptContent,
  codexPromptInput,
  nativeHistoryImageBytes,
  nativeImageBlock,
  requireNativeImageReference,
} from './native-image-content'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function savedImage(
  bytes = Buffer.from('immutable original image'),
): Promise<AgentPromptImage> {
  const directory = await mkdtemp(join(tmpdir(), 'pact-native-image-test-'))
  directories.push(directory)
  const path = join(directory, 'original.png')
  await writeFile(path, bytes)
  return {
    id: randomUUID(),
    name: 'original.png',
    mediaType: 'image/png',
    bytes: bytes.length,
    width: 640,
    height: 480,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    path,
  }
}

function prompt(images: AgentPromptImage[]): AgentPromptEnvelope {
  return {
    version: 'pact-agent-prompt-v1',
    sessionId: 'session-1',
    message: { id: 'current-message', content: '', images: images.slice(2) },
    comments: [],
    handoffContext: [
      {
        messageId: 'handoff-message',
        speaker: 'user',
        content: 'Earlier input',
        comments: [],
        images: images.slice(0, 1),
      },
    ],
    rebuiltContext: [
      {
        message: {
          id: 'rebuilt-message',
          role: 'user',
          content: 'Restored input',
          images: images.slice(1, 2),
        },
        comments: [],
      },
    ],
  }
}

describe('Native image input', () => {
  it.skipIf(process.platform !== 'win32')(
    'refuses a named Windows image replaced during its opened read',
    async () => {
      const image = await savedImage()
      const handle = await open(image.path, 'r')
      const prototype: FileHandle = Object.getPrototypeOf(handle)
      // oxlint-disable-next-line typescript/unbound-method -- The intercept invokes the original with its actual FileHandle receiver.
      const originalRead = prototype.readFile
      await handle.close()
      const intercepted = vi
        .spyOn(prototype, 'readFile')
        .mockImplementationOnce(async function (this: FileHandle, options) {
          const bytes = await originalRead.call(this, options)
          await rename(image.path, image.path + '.original')
          await writeFile(image.path, Buffer.from('immutable original image'))
          return bytes
        })
      try {
        await expect(nativeImageBlock(image)).rejects.toThrow(/Pact image changed/u)
        expect(await readFile(image.path)).toEqual(Buffer.from('immutable original image'))
      } finally {
        intercepted.mockRestore()
      }
    },
  )

  it('delivers original bytes above the old frame ceiling without altering the saved file', async () => {
    const bytes = Buffer.alloc(1024 * 1024 + 1, 0xab)
    const image = await savedImage(bytes)
    const block = await nativeImageBlock(image)
    expect(block.source.media_type).toBe('image/png')
    expect(Buffer.from(block.source.data, 'base64')).toEqual(bytes)
    expect(await readFile(image.path)).toEqual(bytes)
  })

  it('preserves message provenance and image order for both Native providers', async () => {
    const images = await Promise.all(
      ['old', 'restored', 'first', 'second'].map((value) => savedImage(Buffer.from(value))),
    )
    const envelope = prompt(images)
    const codex = codexPromptInput(envelope)
    expect(codex.filter((entry) => entry.type === 'localImage').map((entry) => entry.path)).toEqual(
      images.map((image) => image.path),
    )
    const claude = await claudePromptContent(envelope)
    expect(claude).toEqual([
      { type: 'text', text: serializeAgentPromptEnvelope(envelope) },
      { type: 'text', text: 'Pact images from message handoff-message, in reference order:' },
      await nativeImageBlock(images[0]!),
      { type: 'text', text: 'Pact images from message rebuilt-message, in reference order:' },
      await nativeImageBlock(images[1]!),
      { type: 'text', text: 'Pact images from message current-message, in reference order:' },
      await nativeImageBlock(images[2]!),
      await nativeImageBlock(images[3]!),
    ])
    for (const image of images)
      expect(serializeAgentPromptEnvelope(envelope)).not.toContain(image.path)
  })

  it.each(['bytes', 'hash', 'hardlink', 'symlink', 'aborted'] as const)(
    'refuses an unavailable or changed immutable source: %s',
    async (fault) => {
      const image = await savedImage()
      const controller = new AbortController()
      if (fault === 'bytes') await writeFile(image.path, 'different length')
      if (fault === 'hash') await writeFile(image.path, Buffer.alloc(image.bytes, 0xff))
      if (fault === 'hardlink') await link(image.path, join(directories.at(-1)!, 'linked.png'))
      if (fault === 'symlink') {
        const redirect = join(directories.at(-1)!, 'redirect.png')
        await symlink(image.path, redirect)
        image.path = redirect
      }
      if (fault === 'aborted') controller.abort()
      await expect(nativeImageBlock(image, controller.signal)).rejects.toThrow(
        /Pact image|aborted|ELOOP/u,
      )
    },
  )

  it('rejects a reference mismatch before it can be used for rebuilt image input', async () => {
    const image = await savedImage()
    const { path: _path, ...reference } = image
    expect(() => requireNativeImageReference(image, reference)).not.toThrow()
    expect(() =>
      requireNativeImageReference(image, { ...reference, sha256: '0'.repeat(64) }),
    ).toThrow(/source manifest/)
  })
})

describe('Native history image accounting', () => {
  it('counts legitimate Native image bytes independently of Pact original format and hash', () => {
    expect(
      nativeHistoryImageBytes({
        type: 'user',
        message: {
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'YWJj' } },
          ],
        },
      }),
    ).toBe(4)
    expect(
      nativeHistoryImageBytes({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_image', image_url: 'data:image/webp;base64,YWJj' }],
        },
      }),
    ).toBe(4)
  })

  it.each([
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'YWJj' } },
        ],
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'input_image', image_url: 'data:image/png;base64,YWJj' }],
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'data:image/png;base64,YWJj' }],
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_image', image_url: 'https://example.com/image.png' }],
      },
    },
    {
      type: 'user',
      message: {
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/gif', data: 'YWJj' } },
        ],
      },
    },
    {
      type: 'user',
      message: {
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'invalid data' },
          },
        ],
      },
    },
  ])(
    'does not give text or unsupported blocks the larger image-history allowance (%#)',
    (record) => {
      expect(nativeHistoryImageBytes(record)).toBe(0)
    },
  )
})
