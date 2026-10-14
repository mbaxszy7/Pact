import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'

import { OwnedProcessGroup } from '../../apps/desktop/src/utility/owned-process-group.js'
import { NativeRpc, within } from './native-harness.js'

function gate(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

it('retains ownership when child close cleanup has not settled before its deadline', async () => {
  const owned = await protocolChild()
  const held = gate()
  const originalClosed: unknown = Reflect.get(owned.client, 'closed')
  if (!(originalClosed instanceof Promise)) throw new Error('Missing Native close settlement seam')
  // Real child/group release remains genuine; only the final async launcher-cleanup
  // settlement is held, as on a slow Windows filesystem. This is not Windows OS proof.
  Reflect.set(
    owned.client,
    'closed',
    originalClosed.then(() => held.promise),
  )
  try {
    await expect(owned.client.close()).rejects.toThrow('Owned child close deadline')
    await owned.childClosed
    expect(owned.group.released).toBe(true)
    expect(owned.client.cleanupFacts().released).toBe(false)
    expect(owned.client.cleanupFacts().phase).toBe('unconfirmed')
    expect(owned.onReleased).not.toHaveBeenCalled()
  } finally {
    held.resolve()
    await originalClosed
    await owned.group.close()
    await within(owned.childClosed, 4000, 'Controlled protocol child did not close')
    if (owned.group.released) await rm(owned.directory, { recursive: true, force: true })
  }
})

async function protocolChild(withGroup = true): Promise<{
  directory: string
  group: OwnedProcessGroup
  client: NativeRpc
  onReleased: ReturnType<typeof vi.fn<() => void>>
  childClosed: Promise<void>
  eofPath: string
}> {
  const directory = await mkdtemp(join(tmpdir(), 'pact-rpc-lifecycle-'))
  const eofPath = join(directory, 'eof')
  const group = new OwnedProcessGroup()
  let client: NativeRpc | undefined
  try {
    // Node receives NativeRpc's actual app-server argv. This bounded protocol child
    // acknowledges initialization, deliberately leaves hold pending, and records EOF.
    await writeFile(
      join(directory, 'app-server'),
      `const fs = require('node:fs');
const readline = require('node:readline');
const input = readline.createInterface({ input: process.stdin });
input.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.id && request.method !== 'hold') process.stdout.write(JSON.stringify({ id: request.id, result: {} }) + '\\n');
});
input.once('close', () => { fs.writeFileSync(${JSON.stringify(eofPath)}, 'natural-eof'); });
`,
      { mode: 0o600 },
    )
    const onReleased = vi.fn<() => void>()
    client = new NativeRpc(
      process.execPath,
      directory,
      {
        PATH: process.env.PATH,
        HOME: directory,
        USERPROFILE: directory,
        TMPDIR: directory,
        TEMP: directory,
      },
      withGroup ? group : undefined,
      onReleased,
    )
    const created = client
    const childClosed = new Promise<void>((done) => created.child.once('close', () => done()))
    await client.initialize()
    if (withGroup) await group.observe()
    return { directory, group, client, onReleased, childClosed, eofPath }
  } catch (error) {
    await client?.close().catch(() => undefined)
    await group.close()
    if (group.released && (!client || client.cleanupFacts().released))
      await rm(directory, { recursive: true, force: true })
    throw error
  }
}

it('settles pending requests and shares one close after real child and group release', async () => {
  const owned = await protocolChild()
  const pending = owned.client.request('hold', {}).catch((error: unknown) => error)
  try {
    const closing = owned.client.close()
    expect(owned.client.close()).toBe(closing)
    const admitted = owned.client.methods.length
    await expect(owned.client.request('after-closing', {})).rejects.toThrow(/clos/iu)
    expect(owned.client.methods).toHaveLength(admitted)
    await closing
    await owned.childClosed
    expect(await pending).toBeInstanceOf(Error)
    expect(await readFile(owned.eofPath, 'utf8')).toBe('natural-eof')
    expect(owned.group.released).toBe(true)
    expect(owned.client.cleanupFacts()).toMatchObject({
      childExit: true,
      childClosed: true,
      stdinEnded: true,
      groupReleased: true,
      pendingRequests: 0,
      lifetimeReleased: true,
      released: true,
    })
    expect(owned.onReleased).toHaveBeenCalledOnce()
    expect(owned.client.close()).toBe(closing)
  } finally {
    await owned.client.close().catch(() => undefined)
    await owned.group.close()
    await within(owned.childClosed, 4000, 'Controlled protocol child did not close')
    expect(owned.group.released).toBe(true)
    await rm(owned.directory, { recursive: true, force: true })
  }
})

it('continues EOF and physical release after the single ownership observation rejects', async () => {
  const owned = await protocolChild()
  const failure = new Error('Controlled ownership observation failure')
  const observe = vi.spyOn(owned.group, 'observe').mockRejectedValueOnce(failure)
  try {
    const closing = owned.client.close()
    await expect(closing).rejects.toBe(failure)
    expect(owned.client.close()).toBe(closing)
    await within(owned.childClosed, 2000, 'Rejected observation prevented real child closure')
    expect(await readFile(owned.eofPath, 'utf8')).toBe('natural-eof')
    expect(owned.group.released).toBe(true)
    expect(owned.client.cleanupFacts()).toMatchObject({
      phase: 'released-with-errors',
      childClosed: true,
      stdinEnded: true,
      groupReleased: true,
      pendingRequests: 0,
      lifetimeReleased: true,
      released: true,
    })
    const facts = owned.client.cleanupFacts()
    expect(facts.stages).toContainEqual({
      stage: 'observe',
      milliseconds: expect.any(Number),
      errorClass: 'Error',
    })
    expect(facts.stages.length).toBeLessThanOrEqual(7)
    expect(
      facts.stages.every(
        (stage) =>
          Object.keys(stage).toSorted().join(',') === 'errorClass,milliseconds,stage' &&
          Number.isSafeInteger(stage.milliseconds) &&
          stage.milliseconds >= 0,
      ),
    ).toBe(true)
    expect(JSON.stringify(facts)).not.toContain(failure.message)
    expect(observe).toHaveBeenCalledOnce()
    expect(owned.onReleased).toHaveBeenCalledOnce()
  } finally {
    observe.mockRestore()
    await owned.client.close().catch(() => undefined)
    await owned.group.close()
    await within(owned.childClosed, 4000, 'Controlled protocol child did not close')
    expect(owned.group.released).toBe(true)
    await rm(owned.directory, { recursive: true, force: true })
  }
})

it('keeps release notification behind the real process-group release gate', async () => {
  const owned = await protocolChild()
  const held = gate()
  const originalClose = owned.group.close.bind(owned.group)
  const close = vi.spyOn(owned.group, 'close').mockImplementation(async () => {
    await held.promise
    await originalClose()
  })
  try {
    const closing = owned.client.close()
    await within(owned.childClosed, 2000, 'Natural EOF did not close the controlled protocol child')
    expect(owned.group.released).toBe(false)
    expect(owned.client.cleanupFacts()).toMatchObject({ childClosed: true, released: false })
    expect(owned.onReleased).not.toHaveBeenCalled()
    expect(owned.client.close()).toBe(closing)
    held.resolve()
    await closing
    expect(owned.group.released).toBe(true)
    expect(owned.onReleased).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
  } finally {
    held.resolve()
    close.mockRestore()
    await owned.client.close().catch(() => undefined)
    await originalClose()
    await within(owned.childClosed, 4000, 'Controlled protocol child did not close')
    expect(owned.group.released).toBe(true)
    await rm(owned.directory, { recursive: true, force: true })
  }
})

it('does not notify release when the group remains unconfirmed despite real child closure', async () => {
  const owned = await protocolChild()
  const failure = new Error('Controlled group release failure')
  const close = vi.spyOn(owned.group, 'close').mockRejectedValueOnce(failure)
  try {
    const closing = owned.client.close()
    await expect(closing).rejects.toBe(failure)
    await owned.childClosed
    expect(owned.group.released).toBe(false)
    expect(owned.client.cleanupFacts()).toMatchObject({
      phase: 'unconfirmed',
      childClosed: true,
      groupReleased: false,
      pendingRequests: 0,
      released: false,
    })
    expect(owned.onReleased).not.toHaveBeenCalled()
    expect(owned.client.close()).toBe(closing)
    await expect(owned.client.close()).rejects.toBe(failure)
    expect(close).toHaveBeenCalledOnce()
  } finally {
    close.mockRestore()
    await owned.group.close()
    await within(owned.childClosed, 4000, 'Controlled protocol child did not close')
    expect(owned.group.released).toBe(true)
    expect(owned.onReleased).not.toHaveBeenCalled()
    await rm(owned.directory, { recursive: true, force: true })
  }
})

it('confirms the real child close event before notifying release without a group owner', async () => {
  const owned = await protocolChild(false)
  const closeEvent = vi.fn<() => void>()
  owned.client.child.once('close', closeEvent)
  try {
    await owned.client.close()
    expect(closeEvent).toHaveBeenCalledOnce()
    expect(owned.onReleased).toHaveBeenCalledOnce()
    expect(owned.onReleased.mock.invocationCallOrder[0]).toBeGreaterThan(
      closeEvent.mock.invocationCallOrder[0]!,
    )
    expect(owned.client.cleanupFacts()).toMatchObject({
      childExit: true,
      childClosed: true,
      pendingRequests: 0,
      lifetimeReleased: true,
      released: true,
    })
  } finally {
    await owned.client.close().catch(() => undefined)
    await within(owned.childClosed, 4000, 'Controlled protocol child did not close')
    await owned.group.close()
    await rm(owned.directory, { recursive: true, force: true })
  }
})
