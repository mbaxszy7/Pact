import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'

import { nativeAnswerParity } from './native-answer-parity.js'
import { nativeSnapshotStable, readNativeEvidence } from './real-native-evidence.js'

/** Protocol mechanics only; these controlled records never count as real-model evidence. */
function fixture() {
  const nativeSessionId = randomUUID(),
    nativeTurnId = randomUUID(),
    message = (id: string, text: string[], extra: Record<string, unknown> = {}) => ({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        id,
        content: text.map((part) => ({ type: 'output_text', text: part })),
        ...extra,
        internal_chat_message_metadata_passthrough: { turn_id: nativeTurnId },
      },
    }),
    records = [
      { type: 'session_meta', payload: { id: nativeSessionId } },
      { type: 'event_msg', payload: { type: 'task_started', turn_id: nativeTurnId } },
      message('first', ['intro', ' 🙂'], { phase: 'commentary' }),
      message('second', ['answer', ' tail'], { phase: 'final_answer' }),
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: nativeTurnId } },
    ],
    expected = {
      nativeSessionId,
      nativeTurnId,
      text: 'intro 🙂\n\nanswer tail',
      markers: ['intro', 'tail'],
    }
  return {
    records,
    expected,
    message,
    lines: () => records.map((record) => JSON.stringify(record)),
  }
}

test('same-snapshot diagnostics distinguish literal matching from complete ordered Native assistant items', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pact-answer-parity-'))
  try {
    const f = fixture(),
      path = join(root, 'native.jsonl')
    await writeFile(path, f.lines().join('\n') + '\n')
    const native = await readNativeEvidence(path)
    expect(native.containsLiteralText(f.expected.text)).toBe(false)
    expect(native.containsText(f.expected.text)).toBe(true)
    expect(native.containsText('intro 🙂\n\nanswer')).toBe(false)
    expect(native.answerParity(f.expected)).toMatchObject({
      completeProjection: true,
      exactMatch: true,
      blockCount: 4,
      file: { identityStable: true, snapshotStable: true, modifiedDuringRead: false },
      items: [
        { startOffset: 0, phase: 'commentary' },
        { startOffset: 10, phase: 'final_answer' },
      ],
    })
    const before = native.answerParity(f.expected)
    await writeFile(
      path,
      f.lines().join('\n') + '\n' + JSON.stringify(f.message('third', ['later'])) + '\n',
    )
    expect(native.answerParity(f.expected)).toEqual(before)
    expect((await readNativeEvidence(path)).answerParity(f.expected).exactMatch).toBe(false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test.each([
  'missing-item',
  'duplicate-item',
  'reordered',
  'extra-item',
  'second-task',
  'conflicting-scope',
  'aborted',
  'failed-terminal',
  'error-terminal',
  'before-start',
  'after-terminal',
  'conflicting-id',
  'unknown-block',
  'duplicate-start',
  'duplicate-terminal',
  'task-aborted',
  'task-failed',
  'turn-failed',
  'thread-alias-conflict',
  'turn-started',
] as const)(
  'complete canonical matching refuses %s rather than widening source evidence',
  (fault) => {
    const f = fixture(),
      records: unknown[] = f.records,
      terminal = {
        type: 'event_msg',
        payload: { type: 'task_complete', turn_id: f.expected.nativeTurnId },
      }
    if (fault === 'missing-item') records.splice(2, 1)
    if (fault === 'duplicate-item') records.splice(3, 0, f.message('duplicate', ['intro', ' 🙂']))
    if (fault === 'reordered') [records[2], records[3]] = [records[3], records[2]]
    if (fault === 'extra-item') records.splice(4, 0, f.message('extra', ['extra']))
    if (fault === 'second-task')
      records.push({ type: 'event_msg', payload: { type: 'task_started', turn_id: randomUUID() } })
    if (fault === 'conflicting-scope')
      records.splice(2, 0, { type: 'turn_context', payload: { turn_id: randomUUID() } })
    if (fault === 'aborted')
      records[4] = { ...terminal, payload: { ...terminal.payload, type: 'turn_aborted' } }
    if (fault === 'failed-terminal')
      records[4] = { ...terminal, payload: { ...terminal.payload, status: 'failed' } }
    if (fault === 'error-terminal')
      records[4] = { ...terminal, payload: { ...terminal.payload, error: { message: 'failure' } } }
    if (fault === 'before-start') records.splice(1, 0, f.message('outside', ['extra']))
    if (fault === 'after-terminal') records.push(f.message('outside', ['extra']))
    if (fault === 'conflicting-id') records.splice(3, 0, f.message('first', ['different']))
    if (fault === 'unknown-block')
      records[2] = f.message('first', ['intro 🙂'], {
        content: [{ type: 'unknown', text: 'intro 🙂' }],
      })
    if (fault === 'duplicate-start') records.splice(2, 0, records[1])
    if (fault === 'duplicate-terminal') records.push(terminal)
    if (['task-aborted', 'task-failed', 'turn-failed'].includes(fault))
      records.splice(3, 0, {
        type: 'event_msg',
        payload: {
          type: fault.replaceAll('-', '_'),
          turn_id: f.expected.nativeTurnId,
        },
      })
    if (fault === 'thread-alias-conflict')
      records.splice(2, 0, {
        type: 'event_msg',
        payload: { type: 'agent_message', threadId: randomUUID() },
      })
    if (fault === 'turn-started')
      records.splice(3, 0, {
        type: 'event_msg',
        payload: { type: 'turn_started', turn_id: f.expected.nativeTurnId },
      })
    expect(
      nativeAnswerParity(
        records.map((item) => JSON.stringify(item)),
        f.expected,
      ).exactMatch,
    ).toBe(false)
  },
)

test.each([
  'dev',
  'ino',
  'size',
  'mtimeMs',
  'ctimeMs',
  'not-file',
  'short-read',
  'missing-observation',
] as const)('canonical fallback refuses a file snapshot with %s instability', (fault) => {
  const snapshot = { isFile: () => true, dev: 1, ino: 2, size: 300, mtimeMs: 4, ctimeMs: 5 }
  const observations = Array.from({ length: 4 }, () => ({ ...snapshot }))
  let bytes = 300
  expect(nativeSnapshotStable(observations, bytes)).toBe(true)
  if (fault === 'not-file') observations[3]!.isFile = () => false
  else if (fault === 'short-read') bytes -= 1
  else if (fault === 'missing-observation') observations.pop()
  else observations[3]![fault] += 1
  expect(nativeSnapshotStable(observations, bytes)).toBe(false)
})

test.each([
  'foreign-session',
  'foreign-turn',
  'missing-terminal',
  'tool',
  'user',
  'sidechain',
] as const)('Native parity cannot prove an answer from %s records', (fault) => {
  const f = fixture()
  if (fault === 'foreign-session') f.expected.nativeSessionId = randomUUID()
  if (fault === 'foreign-turn') f.expected.nativeTurnId = randomUUID()
  if (fault === 'missing-terminal') f.records.pop()
  if (fault === 'tool' || fault === 'user') {
    f.records[2] = f.message('first', ['intro', ' 🙂'], { role: fault })
    f.records[3] = f.message('second', ['answer', ' tail'], { role: fault })
  }
  if (fault === 'sidechain') {
    f.records[2] = f.message('first', ['intro', ' 🙂'], { parent_tool_call_id: 'child' })
    f.records[3] = f.message('second', ['answer', ' tail'], { parent_tool_call_id: 'child' })
  }
  expect(nativeAnswerParity(f.lines(), f.expected).exactMatch).toBe(false)
})

test('Native answer summaries export hashes and bounded structure without source text', () => {
  const f = fixture(),
    secret = 'private-source-text-not-for-diagnostics'
  f.records[2] = f.message('first', [secret])
  f.expected.text = `${secret}\n\nanswer tail`
  const summary = nativeAnswerParity(f.lines(), f.expected)
  expect(summary.exactMatch).toBe(true)
  expect(JSON.stringify(summary)).not.toContain(secret)
})

test('Native answer summaries bound item metadata and refuse omitted parts', () => {
  const f = fixture()
  f.records.splice(
    2,
    2,
    ...Array.from({ length: 129 }, (_, index) => f.message(`item-${index}`, ['a'])),
  )
  const summary = nativeAnswerParity(f.lines(), f.expected)
  expect(summary.items).toHaveLength(128)
  expect(summary.omittedItems).toBe(1)
  expect(summary.completeProjection).toBe(false)
  expect(Buffer.byteLength(JSON.stringify(summary))).toBeLessThan(64 * 1024)
})
