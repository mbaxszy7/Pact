import { createHash } from 'node:crypto'
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { readCodexInitializationRollout } from './codex-native-rollout'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const markers = [0, 1].map((chunkIndex) =>
  JSON.stringify({
    pactContext: true,
    pactRebuildId: 'rebuild-1',
    pactSourceHash: 'a'.repeat(64),
    chunkIndex,
    content: `Reference ${chunkIndex}`,
  }),
)
const baseline = [
  { type: 'session_meta', payload: { id: 'native-1' } },
  {
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'developer',
      content: [{ type: 'input_text', text: 'Native instructions.' }],
    },
  },
  {
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: '# AGENTS.md instructions\nFollow project rules.' },
        {
          type: 'input_text',
          text: '<environment_context>Project directory</environment_context>',
        },
      ],
    },
  },
]
const response = (text: string) => ({
  type: 'response_item',
  payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
})
const encode = (records: unknown[]) =>
  records.map((record) => JSON.stringify(record) + '\n').join('')
async function fixture(records: unknown[] = [...baseline, ...markers.map(response)]) {
  const directory = await mkdtemp(join(tmpdir(), 'pact-rollout-test-'))
  directories.push(directory)
  const storageRoot = join(directory, 'home'),
    path = join(storageRoot, 'sessions', 'one.jsonl')
  await mkdir(join(storageRoot, 'sessions'), { recursive: true })
  await writeFile(path, encode(records))
  return {
    directory,
    input: {
      storageRoot,
      path,
      nativeSessionId: 'native-1',
      rebuildId: 'rebuild-1',
      sourceHash: 'a'.repeat(64),
      expectedSeedHashes: markers.map(hash),
      seedHash: hash(markers.join('')),
    },
  }
}

describe('Codex single-rollout initialization readback', () => {
  it('verifies an image seed above the text read budget and preserves cold-prefix verification', async () => {
    const imageMarker = JSON.stringify({
      pactContext: true,
      formatVersion: 'pact-native-context-v2',
      pactRebuildId: 'rebuild-1',
      pactSourceHash: 'a'.repeat(64),
      chunkIndex: 1,
      kind: 'image',
      image: { id: 'source-image', mediaType: 'image/png', sha256: 'b'.repeat(64) },
    })
    const image = {
      type: 'input_image',
      image_url: `data:image/jpeg;base64,${'YWJj'.repeat(3 * 1024 * 1024)}`,
    }
    const seed = response(imageMarker)
    const { input } = await fixture([
      ...baseline,
      response(markers[0]!),
      { ...seed, payload: { ...seed.payload, content: [...seed.payload.content, image] } },
    ])
    const expected = {
      ...input,
      expectedSeedHashes: [hash(markers[0]!), hash(imageMarker)],
      seedHash: hash(markers[0]! + imageMarker),
    }
    const witness = await readCodexInitializationRollout(expected, new AbortController().signal)
    expect(witness.verifiedPrefixBytes).toBeGreaterThan(8 * 1024 * 1024)
    await expect(
      readCodexInitializationRollout({ ...expected, witness }, new AbortController().signal),
    ).resolves.toEqual(witness)
  })

  it.each(['missing', 'duplicate', 'unsupported'] as const)(
    'refuses a rebuilt image manifest whose Native content is %s',
    async (fault) => {
      const imageMarker = JSON.stringify({
        pactContext: true,
        formatVersion: 'pact-native-context-v2',
        pactRebuildId: 'rebuild-1',
        pactSourceHash: 'a'.repeat(64),
        chunkIndex: 0,
        kind: 'image',
      })
      const seed = response(imageMarker)
      const image = { type: 'input_image', image_url: 'data:image/png;base64,YWJj' }
      const images =
        fault === 'missing'
          ? []
          : fault === 'duplicate'
            ? [image, image]
            : [{ type: 'input_image', image_url: 'https://example.com/image.png' }]
      const { input } = await fixture([
        ...baseline,
        { ...seed, payload: { ...seed.payload, content: [...seed.payload.content, ...images] } },
      ])
      await expect(
        readCodexInitializationRollout(
          {
            ...input,
            expectedSeedHashes: [hash(imageMarker)],
            seedHash: hash(imageMarker),
          },
          new AbortController().signal,
        ),
      ).rejects.toThrow(/seed image/)
    },
  )

  it('seals the native baseline and complete source, then verifies the exact committed prefix cold', async () => {
    const { input } = await fixture()
    const witness = await readCodexInitializationRollout(input, new AbortController().signal)
    expect(witness).toMatchObject({
      kind: 'codex_rollout_v1',
      nativeSessionId: 'native-1',
      recordCount: 5,
    })
    expect(witness.verifiedPrefixSha256).toBe(hash(encode([...baseline, ...markers.map(response)])))
    await expect(
      readCodexInitializationRollout({ ...input, witness }, new AbortController().signal),
    ).resolves.toEqual(witness)
  })

  it.each([
    'missing',
    'duplicate',
    'reorder',
    'changed',
    'wrong-rebuild',
    'wrong-source',
    'wrong-session',
  ])('rejects incomplete or mismatched rollout evidence: %s', async (scenario) => {
    const source = [...markers]
    if (scenario === 'missing') source.pop()
    if (scenario === 'duplicate') source.push(source[0]!)
    if (scenario === 'reorder') source.reverse()
    if (scenario === 'changed') source[0] = source[0]!.replace('Reference 0', 'Different 0')
    if (scenario === 'wrong-rebuild') source[0] = source[0]!.replace('rebuild-1', 'rebuild-2')
    if (scenario === 'wrong-source') source[0] = source[0]!.replace('a'.repeat(64), 'b'.repeat(64))
    const records = structuredClone(baseline)
    if (scenario === 'wrong-session') records[0]!.payload.id = 'another-native'
    const { input } = await fixture([...records, ...source.map(response)])
    await expect(
      readCodexInitializationRollout(input, new AbortController().signal),
    ).rejects.toThrow(/native|aborted/iu)
  })

  it.each([
    'rewritten-prefix',
    'truncated-prefix',
    'extra-user',
    'extra-assistant',
    'extra-tool',
    'unclassified-tail',
  ])(
    'does not treat persisted initialization as permission to ignore later native changes: %s',
    async (scenario) => {
      const { input } = await fixture()
      const witness = await readCodexInitializationRollout(input, new AbortController().signal)
      let body = encode([...baseline, ...markers.map(response)])
      if (scenario === 'rewritten-prefix')
        body = body.replace('Native instructions.', 'Other instructions..')
      if (scenario === 'truncated-prefix') body = encode(baseline)
      if (scenario === 'extra-user') body += encode([response('A new native task.')])
      if (scenario === 'extra-assistant')
        body += encode([
          {
            type: 'response_item',
            payload: {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'New model result.' }],
            },
          },
        ])
      if (scenario === 'extra-tool')
        body += encode([
          { type: 'response_item', payload: { type: 'function_call', name: 'exec' } },
        ])
      if (scenario === 'unclassified-tail')
        body += encode([{ type: 'future_record', payload: { work: true } }])
      await writeFile(input.path, body)
      await expect(
        readCodexInitializationRollout({ ...input, witness }, new AbortController().signal),
      ).rejects.toThrow(/native|aborted/iu)
    },
  )

  it.each(['outside', 'symlink-outside', 'hardlink', 'directory', 'relative'])(
    'accepts only the metadata-selected ordinary file inside the effective runtime storage root: %s',
    async (scenario) => {
      const { directory, input } = await fixture()
      const outside = join(directory, 'outside.jsonl')
      await writeFile(outside, encode([...baseline, ...markers.map(response)]))
      let path = input.path
      if (scenario === 'outside') path = outside
      if (scenario === 'symlink-outside') {
        path = join(input.storageRoot, 'redirect.jsonl')
        await symlink(outside, path)
      }
      if (scenario === 'hardlink') {
        path = join(input.storageRoot, 'linked.jsonl')
        await link(input.path, path)
      }
      if (scenario === 'directory') path = join(input.storageRoot, 'sessions')
      if (scenario === 'relative') path = 'sessions/one.jsonl'
      await expect(
        readCodexInitializationRollout({ ...input, path }, new AbortController().signal),
      ).rejects.toThrow(/native|aborted/iu)
    },
  )

  it.each(['size', 'line', 'records', 'partial-line', 'aborted'])(
    'retains read budgets and cancellation without truncating evidence: %s',
    async (scenario) => {
      const { input } = await fixture()
      const controller = new AbortController()
      if (scenario === 'size') await writeFile(input.path, Buffer.alloc(8 * 1024 * 1024 + 1))
      if (scenario === 'line')
        await writeFile(input.path, encode([...baseline, response('x'.repeat(32 * 1024 * 1024))]))
      if (scenario === 'records')
        await writeFile(
          input.path,
          encode([
            ...baseline,
            ...markers.map(response),
            ...Array.from({ length: 10_000 }, () => ({ type: 'event_msg', payload: {} })),
          ]),
        )
      if (scenario === 'partial-line')
        await writeFile(input.path, encode([...baseline, ...markers.map(response)]).slice(0, -1))
      if (scenario === 'aborted') controller.abort()
      await expect(readCodexInitializationRollout(input, controller.signal)).rejects.toThrow(
        /native|aborted/iu,
      )
    },
  )
})
