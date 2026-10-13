import { expect } from '@playwright/test'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

import type { DesktopBridge } from '../../packages/contracts/src/index.js'

import {
  authMarker,
  closeRealWorkspace,
  launchRealWorkspace,
  readRealConversation,
  restartRealWorkspace,
  sendRealMessage,
  waitForRealCompletion,
} from './real-harness.js'
import { findNativeRecord } from './real-native-evidence.js'
import { test } from './runtime-fixture.js'

// A real saved peer reply is deliberately made unreadable in the owned SQLite
// file. No IPC error, Agent response or Native evidence is manufactured.
test(
  'real source-read refusal remains distinct and accepts no input',
  { tag: '@real' },
  async () => {
    test.setTimeout(360_000)
    const ctx = await launchRealWorkspace('real-unreadable-source')
    let database: DatabaseSync | undefined
    let sourceId: string | undefined
    try {
      const marker = authMarker('AUTHENTIC_SOURCE')
      await sendRealMessage(ctx, `Briefly acknowledge ${marker}. Do not use tools.`, 'claude')
      const source = await waitForRealCompletion(ctx, 1)
      const answer = source.messages.find((row) => row.role === 'assistant')
      if (!answer) throw new Error('Authentic saved source unavailable')
      sourceId = answer.id
      const native = await findNativeRecord(ctx, 'claude', source.runs[0]!.nativeSessionId!)
      const bodyHash = createHash('sha256').update(answer.content).digest('hex')
      const draft = `@codex Preserve this draft ${authMarker('READ_FAILURE')}`
      const composer = ctx.page.getByRole('combobox', { name: 'Message' })
      await composer.fill(draft)
      const healthy = await ctx.page.evaluate(async () => {
        const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
        return bridge.getRuntimeHealth()
      })
      if (!healthy.ok) throw new Error('Source runtime is unavailable')
      database = new DatabaseSync(ctx.fixture.databaseFile)
      // SQLite TEXT affinity accepts a BLOB. This controlled storage fault keeps
      // the original bytes/body/revision but makes the source identity unreadable
      // across the two independent hydration reads. Restore it before source integrity checks.
      database
        .prepare(
          'UPDATE conversation_messages SET id = CAST(id AS BLOB) WHERE id = ? AND session_id = ?',
        )
        .run(sourceId, ctx.sessionId)
      expect(
        database
          .prepare('SELECT typeof(id) AS kind FROM conversation_messages WHERE id = ?')
          .get(Buffer.from(sourceId)),
      ).toEqual({ kind: 'blob' })
      const refusal = await ctx.page.evaluate(
        async ({ sessionId, content }) => {
          const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
          return bridge.sendConversationMessage({
            sessionId,
            content,
            clientMessageId: crypto.randomUUID(),
            route: { type: 'agent', agentId: 'codex' },
            commentIds: [],
            expectedCommentsRevision: 0,
          })
        },
        { sessionId: ctx.sessionId, content: draft },
      )
      expect(refusal).toMatchObject({ ok: false, error: { code: 'CONTEXT_UNAVAILABLE' } })
      // An unreadable page must fail this request while keeping the same Utility alive.
      const malformedPage = await ctx.page.evaluate(async (sessionId) => {
        const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
        return bridge.getConversation({ scope: 'messages', sessionId })
      }, ctx.sessionId)
      expect(malformedPage).toEqual({
        ok: false,
        error: { code: 'INTERNAL', message: 'Saved conversation history could not be read.' },
      })
      const surviving = await ctx.page.evaluate(async () => {
        const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
        return bridge.getRuntimeHealth()
      })
      expect(surviving).toMatchObject({
        ok: true,
        value: { status: 'ready', pid: healthy.value.pid },
      })
      await ctx.page.getByRole('button', { name: 'Send message', exact: true }).click()
      await expect(ctx.page.locator('[data-pact-toast-tone="error"]')).toHaveCount(1)
      await expect(ctx.page.locator('[data-pact-toast-tone="error"]')).toContainText(
        "Pact couldn't load the required context. Your draft is still here.",
      )
      await expect.poll(() => composer.textContent()).toBe(draft)
      const records = database
        .prepare('SELECT id FROM agent_runs WHERE session_id = ? ORDER BY created_at')
        .all(ctx.sessionId)
      expect(records.map((row) => row['id'])).toEqual(source.runs.map((row) => row.id))
      const messages = database
        .prepare('SELECT count(*) AS count FROM conversation_messages WHERE session_id = ?')
        .get(ctx.sessionId)
      expect(messages?.['count']).toBe(source.messages.length)
      database
        .prepare('UPDATE conversation_messages SET id = CAST(id AS TEXT) WHERE id = ?')
        .run(Buffer.from(sourceId))
      sourceId = undefined
      database.close()
      database = undefined
      const after = await readRealConversation(ctx)
      expect(after.runs.map((row) => row.id)).toEqual(source.runs.map((row) => row.id))
      expect(after.messages.map((row) => row.contentRevision)).toEqual(
        source.messages.map((row) => row.contentRevision),
      )
      expect(after.messages.map((row) => row.content)).toEqual(
        source.messages.map((row) => row.content),
      )
      expect(
        createHash('sha256')
          .update(after.messages.find((row) => row.id === answer.id)!.content)
          .digest('hex'),
      ).toBe(bodyHash)
      expect(after.nativeContexts.map((row) => row.nativeSessionId)).toEqual(
        source.nativeContexts.map((row) => row.nativeSessionId),
      )
      expect((await findNativeRecord(ctx, 'claude', source.runs[0]!.nativeSessionId!)).sha256).toBe(
        native.sha256,
      )
      await expect.poll(() => composer.textContent()).toBe(draft)
      // The controlled external write has no Event Journal invalidation. A
      // normal cold restart reads the repaired source through a fresh cache.
      await restartRealWorkspace(ctx)
      const rejected = await ctx.page.evaluate(async (sessionId) => {
        const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
        const history = await bridge.getConversation({ scope: 'messages', sessionId })
        return { readable: history.ok }
      }, ctx.sessionId)
      expect(rejected).toEqual({ readable: true })
      expect((await readRealConversation(ctx)).runs.map((row) => row.id)).toEqual(
        source.runs.map((row) => row.id),
      )
    } finally {
      try {
        if (database && sourceId)
          database
            .prepare('UPDATE conversation_messages SET id = CAST(id AS TEXT) WHERE id = ?')
            .run(Buffer.from(sourceId))
      } finally {
        database?.close()
        await closeRealWorkspace(ctx)
      }
    }
  },
)
