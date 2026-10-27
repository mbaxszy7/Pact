import type { Socket } from 'node:net'

import { createServer } from 'node:http'
import { expect, it } from 'vitest'

import { createDecisionResponseGuard } from '../../apps/desktop/src/utility/conversation/decision-response-guard.js'
import { DecisionMemoryLease } from '../../apps/desktop/src/utility/conversation/native-working-memory.js'

it('physically settles an unsolicited upstream 101 upgrade', async () => {
  const sockets = new Set<Socket>()
  const upstream = createServer((_request, response) => {
    response.writeHead(101, { connection: 'Upgrade', upgrade: 'websocket' })
    response.end()
  })
  upstream.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const address = upstream.address()
  if (!address || typeof address === 'string') throw Error('Owned upstream missing')
  const memory = new DecisionMemoryLease()
  const guard = await createDecisionResponseGuard(
    `http://127.0.0.1:${address.port}/v1`,
    memory,
    150,
  )
  guard.bind({
    threadId: 'owned-thread',
    accountId: 'owned-account',
    routingOverride: 'NO_CONSTRAINT',
    prompt: 'Owned upgrade probe',
    current: async () => true,
    dispatch: () => undefined,
  })
  try {
    const outcome = await fetch(`${guard.baseUrl}/responses`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer owned-test-only',
        'chatgpt-account-id': 'owned-account',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-6-luna',
        stream: true,
        store: false,
        prompt_cache_key: 'owned-thread',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Owned upgrade probe' }],
          },
        ],
      }),
    }).then(
      () => 'response',
      () => 'closed',
    )
    const close = guard.close()
    let timer: ReturnType<typeof setTimeout> | undefined
    const settlement = await Promise.race([
      close.then(
        () => 'released',
        () => 'rejected',
      ),
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve('observation-timeout'), 500)
      }),
    ])
    clearTimeout(timer)
    console.info(
      'Owned upstream upgrade observation',
      JSON.stringify({ outcome, settlement, facts: guard.facts }),
    )
    expect(settlement).toBe('released')
    expect(guard.facts).toMatchObject({ active: 0, physicalReleased: true, nativeBytes: 0 })
  } finally {
    await guard.close()
    memory.release()
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
  }
})
