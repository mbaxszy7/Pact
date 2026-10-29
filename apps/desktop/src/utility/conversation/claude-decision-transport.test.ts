import { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { PassThrough } from 'node:stream'
import { expect, it } from 'vitest'

import { ClaudeDecisionTransport } from './claude-decision-runtime'

const model = 'claude-haiku-5-5'
const answer = '{"candidateId":null,"highlights":[]}'
function fixture(native = true) {
  const stdin = new PassThrough(),
    stdout = new PassThrough(),
    stderr = new PassThrough()
  const stdio: [PassThrough, PassThrough, PassThrough, null, null] = [
    stdin,
    stdout,
    stderr,
    null,
    null,
  ]
  const child = Object.assign(new ChildProcess(), {
    stdin,
    stdout,
    stderr,
    stdio,
  })
  const sessionId = randomUUID()
  const transport = new ClaudeDecisionTransport(
    child,
    new AbortController().signal,
    sessionId,
    model,
    native,
  )
  const send = (value: object) => child.stdout.write(JSON.stringify(value) + '\n')
  const quota = (extra: object = {}) => ({
    type: 'rate_limit_event',
    session_id: sessionId,
    uuid: randomUUID(),
    rate_limit_info: {
      status: 'allowed',
      unifiedWindows: {
        five_hour: { utilization: 0.25, resetsAt: 1800000000 },
        seven_day: { utilization: 0.1, resetsAt: 1800000000 },
      },
      overageEnabled: false,
    },
    ...extra,
  })
  const start = () => {
    const pending = transport.prompt('Owned advice only.')
    const raw: unknown = JSON.parse(child.stdin.read().toString())
    if (!raw || typeof raw !== 'object' || typeof Reflect.get(raw, 'uuid') !== 'string')
      throw new Error('Owned request identity missing')
    const command = Reflect.get(raw, 'uuid')
    const lifecycle = (state: string) => ({
      type: 'command_lifecycle',
      command_uuid: command,
      state,
      uuid: randomUUID(),
      session_id: sessionId,
    })
    send(lifecycle('queued'))
    send(lifecycle('started'))
    send({
      type: 'system',
      subtype: 'init',
      session_id: sessionId,
      model,
      tools: [],
      mcp_servers: [],
    })
    return {
      pending,
      complete() {
        send({
          type: 'assistant',
          session_id: sessionId,
          uuid: randomUUID(),
          parent_tool_use_id: null,
          user_message_uuid: command,
          user_message_uuids: [command],
          message: { id: 'owned-assistant', model, content: [{ type: 'text', text: answer }] },
        })
        send({
          type: 'result',
          subtype: 'success',
          is_error: false,
          session_id: sessionId,
          num_turns: 1,
          queued_turn_count: 0,
          result_index: 0,
          user_message_uuid: command,
          user_message_uuids: [command],
          result: answer,
          usage: { input_tokens: 2, output_tokens: 3 },
        })
        send(lifecycle('completed'))
      },
    }
  }
  return {
    send,
    quota,
    start,
    transport,
    sessionId,
    async close() {
      transport.stop()
      child.emit('close', 0, null)
      await transport.release()
      child.stdin.destroy()
      child.stdout.destroy()
      child.stderr.destroy()
    },
  }
}

it('discards bounded subscription-window notifications before and during a single bound native result', async () => {
  const f = fixture()
  try {
    f.send(f.quota())
    const turn = f.start()
    f.send(f.quota())
    turn.complete()
    f.send(f.quota())
    expect(await turn.pending).toEqual({ result: answer })
    expect(f.transport.usage).toEqual({ inputTokens: 2, outputTokens: 3 })
    expect(f.transport.diagnostics().rateLimitFrames).toBe(3)
  } finally {
    await f.close()
  }
})

it.each(['session', 'envelope', 'capacity'] as const)(
  'refuses %s-invalid subscription metadata without resolving advice',
  async (kind) => {
    const f = fixture()
    try {
      const turn = f.start()
      const refused = turn.pending.then(
        () => undefined,
        (error: unknown) => error,
      )
      f.send(
        f.quota(
          kind === 'session'
            ? { session_id: randomUUID() }
            : kind === 'envelope'
              ? { command: 'not a permitted envelope field' }
              : { rate_limit_info: { status: 'allowed', extra: 'x'.repeat(4096) } },
        ),
      )
      expect(await refused).toMatchObject({ message: 'unsupported_protocol' })
    } finally {
      await f.close()
    }
  },
)

it('preserves guarded-mode rejection of previously unhandled subscription frames', async () => {
  const f = fixture(false)
  try {
    const turn = f.start(),
      refused = turn.pending.then(
        () => undefined,
        (error: unknown) => error,
      )
    f.send(f.quota())
    expect(await refused).toMatchObject({ message: 'unsupported_protocol' })
  } finally {
    await f.close()
  }
})
