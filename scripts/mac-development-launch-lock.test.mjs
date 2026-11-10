import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import {
  copyFile,
  link,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const lockModule = new URL('../apps/desktop/build/mac-development-launch-lock.mjs', import.meta.url)
  .href
const options = { skip: process.platform !== 'darwin', timeout: 15_000 }
const ownerSource = `
import { acquireMacDevelopmentLaunchLock } from ${JSON.stringify(lockModule)}
let release
process.on('message', () => { release?.(); process.exit(0) })
try {
  release = await acquireMacDevelopmentLaunchLock(process.argv[1], process.argv[2])
  process.send({ kind: 'acquired' })
} catch (error) {
  process.send({ kind: 'rejected', message: error.message })
  process.disconnect()
  process.exitCode = 1
}
`

async function fixture(context) {
  const root = await mkdtemp(join(tmpdir(), 'pact-mac-launch-lock-'))
  const runtime = join(root, 'runtime')
  const bundle = join(runtime, 'Pact - Development - Local.app')
  const children = []
  await mkdir(runtime)
  context.after(async () => {
    await Promise.all(
      children.map(async ({ child, exited }) => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        await exited
      }),
    )
    await rm(root, { recursive: true, force: true })
  })
  const start = (source = ownerSource, args = [runtime, bundle], executable = process.execPath) => {
    const child = spawn(executable, ['--input-type=module', '-e', source, ...args], {
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      shell: false,
    })
    const exited = once(child, 'exit', { signal: AbortSignal.timeout(10_000) })
    const outcome = once(child, 'message', { signal: AbortSignal.timeout(10_000) }).then(
      ([message]) => message,
    )
    const owner = { child, exited, outcome }
    children.push(owner)
    return owner
  }
  return { root, runtime, bundle, start, lockPath: join(runtime, 'launch.lock') }
}

await test(
  'an abandoned empty launch.lock does not block development startup',
  options,
  async (context) => {
    const { lockPath, start } = await fixture(context)
    await writeFile(lockPath, '', { mode: 0o600 })
    const owner = start()
    assert.deepEqual(await owner.outcome, { kind: 'acquired' })
    owner.child.send('release')
    assert.deepEqual(await owner.exited, [0, null])
  },
)

await test(
  'a concurrent launch cannot take or release the current launch lock',
  options,
  async (context) => {
    const { lockPath, start } = await fixture(context)
    const owner = start()
    assert.deepEqual(await owner.outcome, { kind: 'acquired' })
    const kernelProbe = () =>
      spawnSync('/usr/bin/lockf', ['-k', '-s', '-t', '0', lockPath, '/usr/bin/true'], {
        stdio: 'ignore',
        timeout: 2000,
        shell: false,
      }).status
    assert.equal(kernelProbe(), 75)
    const contenders = [start(), start(), start()]
    await Promise.all(
      contenders.map(async (contender) => {
        assert.equal((await contender.outcome).kind, 'rejected')
        assert.deepEqual(await contender.exited, [1, null])
      }),
    )
    const stillBusy = start()
    assert.equal((await stillBusy.outcome).kind, 'rejected')
    owner.child.send('release')
    assert.deepEqual(await owner.exited, [0, null])
    assert.equal(kernelProbe(), 0)
    const next = start()
    assert.deepEqual(await next.outcome, { kind: 'acquired' })
  },
)

await test(
  'simultaneous launches elect exactly one owner of a fresh runtime',
  options,
  async (context) => {
    const { start } = await fixture(context)
    const contenders = Array.from({ length: 8 }, () => start())
    const outcomes = await Promise.all(contenders.map((contender) => contender.outcome))
    assert.equal(outcomes.filter((outcome) => outcome.kind === 'acquired').length, 1)
    assert.equal(outcomes.filter((outcome) => outcome.kind === 'rejected').length, 7)
    await Promise.all(
      contenders.map(async (contender, index) => {
        if (outcomes[index].kind === 'acquired') contender.child.send('release')
        assert.deepEqual(await contender.exited, [
          outcomes[index].kind === 'acquired' ? 0 : 1,
          null,
        ])
      }),
    )
    assert.deepEqual(await start().outcome, { kind: 'acquired' })
  },
)

await test(
  'SIGKILL releases launch ownership without manual lock-file deletion',
  options,
  async (context) => {
    const { start } = await fixture(context)
    const owner = start()
    assert.deepEqual(await owner.outcome, { kind: 'acquired' })
    owner.child.kill('SIGKILL')
    assert.deepEqual(await owner.exited, [null, 'SIGKILL'])
    const next = start()
    assert.deepEqual(await next.outcome, { kind: 'acquired' })
  },
)

await test(
  'normal release preserves the lock inode and is idempotent',
  options,
  async (context) => {
    const { lockPath, start } = await fixture(context)
    const source = `
import { acquireMacDevelopmentLaunchLock } from ${JSON.stringify(lockModule)}
const release = await acquireMacDevelopmentLaunchLock(process.argv[1], process.argv[2])
release()
release()
process.send({ kind: 'released', listeners: process.listenerCount('exit') })
process.disconnect()
`
    const owner = start(source)
    assert.deepEqual(await owner.outcome, { kind: 'released', listeners: 0 })
    assert.deepEqual(await owner.exited, [0, null])
    const before = await stat(lockPath)
    const next = start()
    assert.deepEqual(await next.outcome, { kind: 'acquired' })
    assert.equal((await stat(lockPath)).ino, before.ino)
  },
)

await test(
  'a live legacy launcher holding the empty sentinel is not displaced',
  options,
  async (context) => {
    const { lockPath, start } = await fixture(context)
    const legacy = start(`
import { openSync } from 'node:fs'
openSync(${JSON.stringify(lockPath)}, 'wx', 0o600)
process.on('message', () => process.exit(0))
process.send({ kind: 'legacy' })
`)
    assert.deepEqual(await legacy.outcome, { kind: 'legacy' })
    const contender = start()
    assert.match((await contender.outcome).message, /already has a development launch/u)
    assert.deepEqual(await contender.exited, [1, null])
    legacy.child.kill('SIGKILL')
    await legacy.exited
    const next = start()
    assert.deepEqual(await next.outcome, { kind: 'acquired' })
  },
)

await test(
  'an orphaned application or helper blocks runtime replacement after launcher SIGKILL',
  options,
  async (context) => {
    const { bundle, lockPath, start } = await fixture(context)
    const executable = join(
      bundle,
      'Contents/Frameworks/Fixture Helper.app/Contents/MacOS/Fixture Helper',
    )
    await mkdir(join(executable, '..'), { recursive: true })
    await copyFile(process.execPath, executable)
    const owner = start()
    assert.deepEqual(await owner.outcome, { kind: 'acquired' })
    const app = start(
      "process.send({kind:'application'});process.on('message',()=>process.exit(0))",
      [],
      executable,
    )
    assert.deepEqual(await app.outcome, { kind: 'application' })
    const inode = (await stat(lockPath)).ino
    owner.child.kill('SIGKILL')
    await owner.exited
    const contender = start()
    assert.match((await contender.outcome).message, /application.*still running/u)
    assert.deepEqual(await contender.exited, [1, null])
    assert.equal((await stat(lockPath)).ino, inode)
    assert.equal(app.child.exitCode, null)
    app.child.send('exit')
    await app.exited
    const next = start()
    assert.deepEqual(await next.outcome, { kind: 'acquired' })
  },
)

await Promise.all(
  ['symlink', 'hardlink'].map((redirect) =>
    test(`a ${redirect} lock is rejected without changing its target`, options, async (context) => {
      const { root, lockPath, start } = await fixture(context)
      const target = join(root, 'user-file')
      await writeFile(target, 'preserve-me', { mode: 0o600 })
      if (redirect === 'symlink') await symlink(target, lockPath)
      else await link(target, lockPath)
      const owner = start()
      assert.equal((await owner.outcome).kind, 'rejected')
      assert.deepEqual(await owner.exited, [1, null])
      assert.equal(await readFile(target, 'utf8'), 'preserve-me')
    }),
  ),
)

await Promise.all(
  ['SIGINT', 'SIGTERM'].map((signal) =>
    test(
      `${signal} releases launch ownership while retaining the lock file`,
      options,
      async (context) => {
        const { lockPath, start } = await fixture(context)
        const owner = start()
        assert.deepEqual(await owner.outcome, { kind: 'acquired' })
        const inode = (await stat(lockPath)).ino
        owner.child.kill(signal)
        assert.deepEqual(await owner.exited, [null, signal])
        assert.equal((await stat(lockPath)).ino, inode)
        const next = start()
        assert.deepEqual(await next.outcome, { kind: 'acquired' })
      },
    ),
  ),
)

await test(
  'cancellation releases the descriptor and leaves no exit listener',
  options,
  async (context) => {
    const { start } = await fixture(context)
    const owner = start(`
import { acquireMacDevelopmentLaunchLock } from ${JSON.stringify(lockModule)}
const controller = new AbortController()
const acquisition = acquireMacDevelopmentLaunchLock(process.argv[1], process.argv[2], controller.signal)
controller.abort()
try {
  await acquisition
  process.send({ kind: 'unexpected' })
} catch {
  process.send({ kind: 'cancelled', listeners: process.listenerCount('exit') })
}
process.disconnect()
`)
    assert.deepEqual(await owner.outcome, { kind: 'cancelled', listeners: 0 })
    assert.deepEqual(await owner.exited, [0, null])
    const next = start()
    assert.deepEqual(await next.outcome, { kind: 'acquired' })
  },
)
