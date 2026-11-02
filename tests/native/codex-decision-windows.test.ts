import { access, mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'

import { CodexAppServerConnection } from '../../apps/desktop/src/utility/conversation/codex-app-server-connection.js'
import { CodexDecisionRuntime } from '../../apps/desktop/src/utility/conversation/codex-decision-runtime.js'
import { nativeWorkingMemoryCapacities } from '../../apps/desktop/src/utility/conversation/native-working-memory.js'
import { RuntimePreparation } from '../../apps/desktop/src/utility/runtime-preparation/runtime-preparation.js'
import { decisionFixture } from '../../packages/persistence/src/decision-fixture.test-support.js'
import { ownedRoot, isolatedEnv, cleanupNativeFixture } from './native-harness.js'

it.each([
  'answer',
  'tool',
  'cancel',
  'probe',
  'foreign-terminal',
  'missing-terminal',
  'foreign-answer',
] as const)('Windows Codex native decision accepts only tool-free output: %s', async (mode) => {
  const owned = await ownedRoot()
  const source = await decisionFixture(':memory:', owned.cwd)
  const marker = join(owned.cwd, 'unwanted-write.txt')
  const controller = new AbortController()
  let requests = 0
  let tools = -1
  let inherited = false
  const server = createServer((request, response) => {
    void (async () => {
      let raw = ''
      for await (const chunk of request) {
        raw += chunk
        if (raw.length > 1024 * 1024) {
          response.writeHead(413).end()
          return
        }
      }
      if (request.method !== 'POST') {
        response.writeHead(404).end()
        return
      }
      requests++
      if (requests > 1) {
        response.writeHead(400).end()
        return
      }
      const body = JSON.parse(raw)
      tools = body.tools?.length ?? 0
      inherited = raw.includes('OWNED_UNWANTED_CONTEXT')
      if (mode === 'cancel') {
        controller.abort()
        return
      }
      const item =
        mode === 'tool'
          ? {
              id: 'fc-owned',
              type: 'custom_tool_call',
              name: 'apply_patch',
              call_id: 'owned-call',
              input: `*** Begin Patch\n*** Add File: unwanted-write.txt\n+unwanted\n*** End Patch`,
              status: 'completed',
            }
          : {
              id: 'msg-owned',
              type: 'message',
              role: 'assistant',
              status: 'completed',
              content: [
                {
                  type: 'output_text',
                  text: '{"candidateId":"wait","highlights":[]}',
                  annotations: [],
                },
              ],
            }
      const result = {
        id: 'resp-owned',
        object: 'response',
        model: body.model,
        status: 'completed',
        output: [item],
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          total_tokens: 2,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      }
      response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' })
      const send = (type: string, value: object) =>
        response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`)
      send('response.created', { response: { ...result, status: 'in_progress', output: [] } })
      send('response.output_item.added', { output_index: 0, item })
      send('response.output_item.done', { output_index: 0, item })
      send('response.completed', { response: result })
      response.end()
    })().catch(() => response.destroy())
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw Error('No owned provider')
  const selected = await new RuntimePreparation({
    hasCompletedFirstUseSetup: () => true,
    readSelectedExecutablePath: () => undefined,
    saveSelectedExecutablePath: () => {
      throw Error('Read-only discovery')
    },
  }).findRecoveryExecutable('codex', new AbortController().signal)
  if (!selected) throw Error('Installed Codex is required')
  await mkdir(join(owned.home, 'skills', 'owned'), { recursive: true })
  await writeFile(
    join(owned.home, 'skills', 'owned', 'SKILL.md'),
    '---\nname: owned\ndescription: OWNED_UNWANTED_CONTEXT\n---\nOWNED_UNWANTED_CONTEXT',
  )
  await writeFile(join(owned.cwd, 'AGENTS.md'), 'OWNED_UNWANTED_CONTEXT')
  await writeFile(
    join(owned.home, 'auth.json'),
    JSON.stringify({ OPENAI_API_KEY: 'OWNED_LOOPBACK_ONLY' }),
  )
  await writeFile(
    join(owned.home, 'config.toml'),
    `model="gpt-6-luna"\nmodel_provider="owned"\n[model_providers.owned]\nname="owned"\nbase_url="http://127.0.0.1:${address.port}/v1"\nwire_api="responses"\nrequires_openai_auth=true\nrequest_max_retries=0\nstream_max_retries=0\n`,
  )
  const dispatch = vi.fn<() => void>()
  const runtime = new CodexDecisionRuntime({
    executable: selected,
    cwd: owned.cwd,
    current: () => true,
    environment: isolatedEnv(owned.root, owned.home),
    reserve: () => 'reserved',
    dispatch,
  })
  // oxlint-disable-next-line typescript/unbound-method -- Called below with the actual connection receiver.
  const nativeNext = CodexAppServerConnection.prototype.nextNotification
  const altered = ['foreign-terminal', 'missing-terminal', 'foreign-answer'].includes(mode)
    ? vi
        .spyOn(CodexAppServerConnection.prototype, 'nextNotification')
        .mockImplementation(async function (this: CodexAppServerConnection, ...args) {
          const event = await nativeNext.apply(this, args)
          if (event && typeof event === 'object') {
            const method = Reflect.get(event, 'method'),
              params = Reflect.get(event, 'params')
            if (method === 'turn/completed' && mode !== 'foreign-answer')
              return {
                ...event,
                params: {
                  ...params,
                  turn: {
                    ...params.turn,
                    id: mode === 'missing-terminal' ? undefined : 'foreign-terminal-turn',
                  },
                },
              }
            if (
              method === 'item/completed' &&
              mode === 'foreign-answer' &&
              params.item?.type === 'agentMessage'
            )
              return { ...event, params: { ...params, turnId: 'foreign-answer-turn' } }
          }
          return event
        })
    : undefined
  try {
    const result =
      mode === 'probe'
        ? await runtime.probeAdmission(controller.signal)
        : await runtime.evaluateDecision(source.input, controller.signal)
    expect(result).toMatchObject(
      mode === 'probe'
        ? { supported: true, physicalReleased: true }
        : { kind: mode === 'answer' ? 'recommendation' : 'unavailable' },
    )
    expect(await runtime.settlement()).toBe(true)
    expect(tools).toBe(mode === 'probe' ? -1 : 0)
    expect(inherited).toBe(false)
    expect(requests).toBe(mode === 'probe' ? 0 : 1)
    expect(dispatch).toHaveBeenCalledTimes(mode === 'probe' ? 0 : 1)
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(nativeWorkingMemoryCapacities().decision.chargedBytes).toBe(0)
  } finally {
    altered?.mockRestore()
    expect(await runtime.dispose()).toBe(true)
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    source.db.close()
    await cleanupNativeFixture(owned)
  }
})
