import { createServer, request } from 'node:http'
import { createServer as createSocketServer } from 'node:net'
import { expect, it } from 'vitest'

import { createDecisionResponseGuard } from './decision-response-guard'
import { DecisionMemoryLease } from './native-working-memory'

async function get(url: string, headers: Record<string, string> = {}) {
  return new Promise<number>((resolve, reject) => {
    const outgoing = request(url, { method: 'GET', headers, agent: false }, (incoming) => {
      incoming.resume()
      incoming.once('end', () => resolve(incoming.statusCode ?? 0))
    })
    outgoing.once('error', reject)
    outgoing.end()
  })
}
it('forwards only the frozen readonly native account route during its explicit metadata phase', async () => {
  let metadata = 0,
    other = 0
  const upstream = createServer((incoming, outgoing) => {
    if (incoming.method === 'GET' && incoming.url === '/backend-api/wham/accounts/check') metadata++
    else other++
    incoming.resume()
    outgoing.writeHead(200, { 'content-type': 'application/json' })
    outgoing.end('{"accounts":[]}')
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const address = upstream.address()
  if (!address || typeof address === 'string') throw Error('Owned server unavailable')
  const memory = new DecisionMemoryLease(),
    guard = await createDecisionResponseGuard(undefined, memory)
  try {
    guard.setMetadataDestination(`http://127.0.0.1:${address.port}/backend-api`)
    const url = guard.metadataBaseUrl + '/wham/accounts/check',
      headers = { authorization: 'Bearer OWNED-DUMMY-KEY' }
    await expect(get(url, headers)).rejects.toThrow(/socket hang up/u)
    expect(metadata).toBe(0)
    guard.metadataPhase(true)
    expect(await get(url, headers)).toBe(200)
    await expect(get(url + '?extra=true', headers)).rejects.toThrow(/socket hang up/u)
    await expect(get(url, { ...headers, cookie: 'owned-cookie' })).rejects.toThrow(
      /socket hang up/u,
    )
    guard.metadataPhase(false)
    await expect(get(url, headers)).rejects.toThrow(/socket hang up/u)
    expect({ metadata, other }).toEqual({ metadata: 1, other: 0 })
    expect(guard.facts.forwarded).toBe(0)
  } finally {
    await guard.close()
    memory.release()
    upstream.closeAllConnections()
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
  }
})
it('stops forwarding while retaining its listening port until the native owner permits physical release', async () => {
  const memory = new DecisionMemoryLease(),
    guard = await createDecisionResponseGuard(undefined, memory),
    competitor = createSocketServer()
  try {
    guard.stopForwarding()
    const refusal = await new Promise<unknown>((resolve) => {
      competitor.once('error', resolve)
      competitor.listen(guard.port, '127.0.0.1', () => resolve(null))
    })
    expect(refusal).toMatchObject({ code: 'EADDRINUSE' })
    expect(guard.facts.physicalReleased).toBe(false)
    await guard.close()
    expect(guard.facts.physicalReleased).toBe(true)
    await new Promise<void>((resolve) => competitor.listen(guard.port, '127.0.0.1', resolve))
  } finally {
    if (competitor.listening)
      await new Promise<void>((resolve) => competitor.close(() => resolve()))
    await guard.close()
    memory.release()
  }
})
