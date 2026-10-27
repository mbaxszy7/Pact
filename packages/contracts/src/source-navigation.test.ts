import { expect, test } from 'vitest'

import {
  collaborationSourceIndexNavigation,
  collaborationSourceWireResultSchema,
} from './collaboration-documents.js'
const runId = crypto.randomUUID(),
  grant = crypto.randomUUID(),
  document = { id: crypto.randomUUID(), sha256: 'a'.repeat(64), bytes: 10, chars: 10 },
  read = { source: 'document' as const, runId, grant, document, offset: 0 }
function batch() {
  const text = JSON.stringify({
    body: document,
    bodyRead: read,
    members: [{ commentId: crypto.randomUUID(), bodyRead: read }],
  })
  return {
    source: 'batch' as const,
    text,
    offset: 0,
    nextOffset: null,
    binding: {
      submitted: 'legacy' as const,
      callerRunId: runId,
      grantSha256: 'b'.repeat(64),
      referenceSha256: null,
    },
  }
}
test('direct navigation and compatibility index preserve the same exact issued requests', () => {
  const page = batch(),
    navigation = collaborationSourceIndexNavigation(page.source, page.text),
    wire = collaborationSourceWireResultSchema.parse({ ...page, ...navigation })
  expect(wire.bodyRead).toEqual(read)
  expect(wire.members?.[0]?.bodyRead).toEqual(read)
  expect(collaborationSourceWireResultSchema.parse(page).text).toBe(page.text)
})
test('a direct alias cannot select a document other than its frozen index', () => {
  const page = batch(),
    navigation = collaborationSourceIndexNavigation(page.source, page.text)
  expect(
    collaborationSourceWireResultSchema.safeParse({
      ...page,
      ...navigation,
      bodyRead: { ...read, document: { ...document, id: crypto.randomUUID() } },
    }).success,
  ).toBe(false)
})
test('plain document text cannot carry index navigation', () => {
  const page = batch()
  expect(collaborationSourceIndexNavigation('document', 'Plain user text.')).toEqual({})
  expect(
    collaborationSourceWireResultSchema.safeParse({
      ...page,
      source: 'document',
      text: 'Plain user text.',
      document,
      members: [],
    }).success,
  ).toBe(false)
})
test.each(['inputs', 'handoff_sources'] as const)(
  'direct %s navigation retains its real item shape',
  (source) => {
    const entry =
      source === 'inputs'
        ? {
            batchRead: {
              ...read,
              source: 'batch',
              document: undefined,
              batchId: crypto.randomUUID(),
            },
            bodyRead: read,
          }
        : { documents: [{ key: 'message', read }] }
    const navigation = collaborationSourceIndexNavigation(
      source,
      JSON.stringify({ items: [entry] }),
    )
    expect(navigation.members).toBeUndefined()
    expect(navigation.items).toHaveLength(1)
    const directRead =
      source === 'inputs'
        ? navigation.items?.[0]?.bodyRead
        : navigation.items?.[0]?.documents?.[0]?.read
    expect(directRead).toEqual(read)
  },
)
test('direct aliases still share the original physical page byte bound', () => {
  const page = batch(),
    index = JSON.parse(page.text)
  index.padding = 'x'.repeat(48 * 1024)
  const large = {
    ...page,
    text: JSON.stringify(index),
    ...collaborationSourceIndexNavigation(page.source, JSON.stringify(index)),
  }
  expect(collaborationSourceWireResultSchema.safeParse(large).success).toBe(false)
})

test('current NativeRoot document selectors require an exact part without document identities', async () => {
  const { collaborationSourceNativeReadSchema, codexCollaborationSourceWireReadSchema } =
    await import('./collaboration-documents.js')
  for (const part of ['body', 'user_information', 'clarification_answer', 'comment']) {
    const request = {
      context: 'native-root-v1',
      source: 'root_document',
      part,
      ...(part === 'comment' ? { ordinal: 0 } : {}),
      offset: 0,
    }
    expect(collaborationSourceNativeReadSchema.safeParse(request).success).toBe(true)
    expect(codexCollaborationSourceWireReadSchema.safeParse(request).success).toBe(true)
    for (const extra of [{ document }, { batchId: crypto.randomUUID() }, { grant }])
      expect(collaborationSourceNativeReadSchema.safeParse({ ...request, ...extra }).success).toBe(
        false,
      )
  }
  for (const fields of [
    {},
    { part: 'comment' },
    { part: 'comment', ordinal: -1 },
    { part: 'comment', ordinal: 0.5 },
    { part: 'body', ordinal: 0 },
    { part: 'unknown' },
  ])
    expect(
      collaborationSourceNativeReadSchema.safeParse({
        context: 'native-root-v1',
        source: 'root_document',
        offset: 0,
        ...fields,
      }).success,
    ).toBe(false)
  expect(
    collaborationSourceNativeReadSchema.safeParse({
      context: 'native-root-v1',
      source: 'document',
      document,
      part: 'body',
      offset: 0,
    }).success,
  ).toBe(false)
})
