import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { rmSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

import { WindowsLaunchPreparationError } from '../tests/e2e/windows-cli-launcher.ts'
import { runWindowsCompiler, WindowsCompilerError } from './run-windows-compiler.mjs'

// A real process and control socket stand in for the Windows-only Job API.
// These checks validate the compiler caller; they do not prove Windows kernel ownership.
const helper = String.raw`
const net=require('node:net');const c=JSON.parse(process.argv[1]);
const socket=net.createConnection(c.port,'127.0.0.1');let input='',ended=false;
function finish(){if(ended)return;ended=true;
  if(c.mode==='missing-empty'){socket.end();setTimeout(()=>process.exit(1),10);return;}
  const exit=c.mode==='cleanup'?1:(c.rootCode||0);
  if(c.mode==='cleanup')socket.write(JSON.stringify({kind:'stop',reason:c.stopReason||'control-closed'})+'\n');
  socket.write(JSON.stringify({kind:'empty',active:0,exitCode:exit})+'\n');
}
socket.on('connect',()=>{if(c.denied){socket.end();setTimeout(()=>process.exit(1),10);return;}socket.write(JSON.stringify({kind:'root',pid:process.pid,exitCode:c.rootCode||0,natural:true,active:c.mode==='natural'?0:1,elapsedMs:1})+'\n');if(c.mode==='natural')finish();});
socket.on('data',data=>{input+=data;while(input.includes('\n')){const at=input.indexOf('\n'),line=input.slice(0,at);input=input.slice(at+1);if(line==='cancel')finish();if(line==='received')setTimeout(()=>{if(c.outputBytes)process.stdout.write('x'.repeat(c.outputBytes));process.exit(c.helperCode??(c.mode==='cleanup'?1:(c.rootCode||0)))},c.closeDelay||0);}});
socket.on('error',()=>process.exit(1));
`

async function fixture(configuration = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'pact-compiler-host-'))
  const controlDirectory = join(directory, 'control')
  const rootExit = Promise.withResolvers(),
    empty = Promise.withResolvers()
  void rootExit.promise.catch(() => undefined)
  void empty.promise.catch(() => undefined)
  let socket,
    child,
    emptySeen = false,
    input = '',
    stopReason
  let calls = 0,
    closed = false,
    disposed = false
  let controlRoot, preparationDeadline, compilationCwd
  const server = createServer((connection) => {
    socket = connection
    connection.on('data', (chunk) => {
      input += chunk
      assert(input.length <= 4096)
      while (input.includes('\n')) {
        const at = input.indexOf('\n'),
          message = JSON.parse(input.slice(0, at))
        input = input.slice(at + 1)
        if (message.kind === 'root') {
          if (configuration.missingRoot) rootExit.reject(new Error('Missing root receipt'))
          else rootExit.resolve(message)
          if (configuration.stdinError) child.stdin.emit('error', new Error('Fixture input error'))
        } else if (message.kind === 'stop') stopReason = message.reason
        else if (message.kind === 'empty') {
          emptySeen = true
          connection.write('received\n')
          empty.resolve(message)
        }
      }
    })
    connection.on('close', () => {
      if (!emptySeen) empty.reject(new Error('Missing empty receipt'))
    })
    connection.on('error', () => {})
  })
  server.maxConnections = 1
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const owner = {
    directory: controlDirectory,
    executablePath: process.execPath,
    rootExit: rootExit.promise,
    empty: empty.promise,
    armStartup(deadline) {
      assert(deadline > performance.now())
      assert(deadline - performance.now() <= 15_000)
    },
    cancel() {
      if (socket && !socket.destroyed && !emptySeen) socket.write('cancel\n')
    },
    diagnostic() {
      return {
        stages: calls && !configuration.denied ? { go: 0 } : {},
        ...(stopReason ? { stoppingReason: stopReason } : {}),
        ...(configuration.nativeError !== undefined
          ? { nativeErrorCode: configuration.nativeError }
          : {}),
      }
    },
    async disposeControl() {
      disposed = true
      socket?.destroy()
      await new Promise((resolve) => server.close(resolve))
    },
  }
  const host = {
    async resolveCompiler() {
      return process.execPath
    },
    async prepare(root, _compiler, _lifetime, preparation) {
      controlRoot = root
      preparationDeadline = preparation?.deadlineAt
      await mkdir(controlDirectory)
      if (configuration.prepareDelay) await delay(configuration.prepareDelay)
      return owner
    },
    execute(_executable, _args, options, callback) {
      calls++
      compilationCwd = options.cwd
      child = execFile(
        process.execPath,
        [
          '-e',
          helper,
          JSON.stringify({ mode: 'cleanup', ...configuration, port: server.address().port }),
        ],
        options,
        callback,
      )
      child.once('close', () => {
        closed = true
      })
      return child
    },
    remove(path) {
      assert.equal(path, controlDirectory)
      rmSync(path, { recursive: true })
    },
  }
  return {
    directory,
    controlDirectory,
    host,
    owner,
    get calls() {
      return calls
    },
    get closed() {
      return closed
    },
    get controlRoot() {
      return controlRoot
    },
    get preparationDeadline() {
      return preparationDeadline
    },
    get compilationCwd() {
      return compilationCwd
    },
    options: { cwd: directory, timeout: 2000, maxBuffer: 1024 },
    async dispose() {
      if (child && !closed) child.kill()
      if (!disposed) await owner.disposeControl()
      await rm(directory, { recursive: true, force: true })
    },
  }
}

async function preparationRetention() {
  const directory = await mkdtemp(join(tmpdir(), 'pact-compiler-preparation-failure-'))
  const controlDirectory = join(directory, 'control')
  await mkdir(controlDirectory)
  let attempts = 0
  const host = {
    async resolveCompiler() {
      return process.execPath
    },
    async prepare() {
      attempts++
      throw new WindowsLaunchPreparationError(false, controlDirectory)
    },
  }
  const options = { cwd: directory, timeout: 2000, maxBuffer: 1024 }
  try {
    await assert.rejects(runWindowsCompiler(['fixture'], options, host), (error) => {
      assert(error instanceof WindowsCompilerError)
      assert.equal(error.physicalReleased, false)
      assert.equal(error.preserveWorkspace, true)
      return true
    })
    assert((await stat(controlDirectory)).isDirectory())
    await assert.rejects(runWindowsCompiler(['fixture'], options, host), /capacity-unavailable/)
    assert.equal(attempts, 1)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

if (process.argv[2] === 'preparation-retention') {
  await preparationRetention()
  process.stdout.write('preparation-retention-confirmed\n')
} else {
  for (const mode of ['cleanup', 'natural']) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Each real helper uses the sole compiler admission slot.
    await test(`compiler host seam accepts ${mode} completion only after empty and actual close`, async () => {
      const f = await fixture({ mode, closeDelay: 80 })
      try {
        await runWindowsCompiler(['fixture'], f.options, f.host)
        assert.equal(f.closed, true)
        assert.equal(f.controlRoot, tmpdir())
        assert.notEqual(f.controlRoot, f.directory)
        assert.equal(f.compilationCwd, f.directory)
        assert(Number.isFinite(f.preparationDeadline))
        await assert.rejects(stat(f.controlDirectory), { code: 'ENOENT' })
      } finally {
        await f.dispose()
      }
    })
  }

  for (const scenario of [
    { name: 'natural compiler failure', mode: 'natural', rootCode: 7 },
    { name: 'native error zero', mode: 'natural', nativeError: 0 },
    { name: 'unexpected helper exit', mode: 'natural', helperCode: 1 },
    { name: 'unrequested descendant stop', stopReason: 'descendants-still-running' },
    { name: 'missing root observation', mode: 'natural', missingRoot: true },
    { name: 'output overflow after empty', mode: 'natural', outputBytes: 2048 },
    { name: 'stdin error', stdinError: true },
  ]) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Physical release must precede the next admitted compiler action.
    await test(`compiler host seam rejects ${scenario.name}`, async () => {
      const f = await fixture(scenario)
      try {
        await assert.rejects(runWindowsCompiler(['fixture'], f.options, f.host), (error) => {
          assert(error instanceof WindowsCompilerError)
          assert.equal(error.physicalReleased, true)
          assert.equal(error.preserveWorkspace, false)
          return true
        })
        assert.equal(f.closed, true)
      } finally {
        await f.dispose()
      }
    })
  }

  for (const scenario of ['lookup-deadline', 'prepare-deadline', 'prepare-cancel']) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- The outstanding preparation must release before the next action.
    await test(`compiler tracks ${scenario} until late preparation is reclaimed`, async () => {
      const directory = await mkdtemp(join(tmpdir(), 'pact-compiler-late-'))
      const controlDirectory = join(directory, 'control')
      await mkdir(controlDirectory)
      const gate = Promise.withResolvers(),
        entered = Promise.withResolvers()
      const controller = new AbortController()
      let disposed = false,
        removed = false,
        executions = 0,
        preparation
      const owner = {
        directory: controlDirectory,
        async disposeControl() {
          disposed = true
        },
      }
      const host = {
        async resolveCompiler() {
          if (scenario.startsWith('lookup')) {
            entered.resolve()
            return gate.promise
          }
          return process.execPath
        },
        async prepare(_root, _compiler, _lifetime, options) {
          preparation = options
          entered.resolve()
          return gate.promise
        },
        execute() {
          executions++
          throw new Error('Late compiler must not start')
        },
        remove(path) {
          assert.equal(path, controlDirectory)
          rmSync(path, { recursive: true })
          removed = true
        },
      }
      const options = {
        cwd: directory,
        timeout: scenario.endsWith('cancel') ? 2000 : 100,
        maxBuffer: 1024,
        signal: controller.signal,
      }
      const began = performance.now()
      const operation = runWindowsCompiler(['fixture'], options, host)
      let guard
      const watchdog = new Promise((_, reject) => {
        guard = setTimeout(() => {
          gate.resolve(scenario.startsWith('lookup') ? process.execPath : owner)
          reject(new Error('Preparation ignored its deadline or cancellation'))
        }, 500)
      })
      try {
        await entered.promise
        if (scenario.endsWith('cancel')) controller.abort()
        await assert.rejects(Promise.race([operation, watchdog]), WindowsCompilerError)
        assert.equal(executions, 0)
        assert.equal(disposed, false)
        await assert.rejects(runWindowsCompiler(['fixture'], options, host), /capacity-unavailable/)
        if (preparation) {
          assert(preparation.deadlineAt <= began + options.timeout + 10)
          assert.equal(preparation.signal.aborted, true)
        }
        gate.resolve(scenario.startsWith('lookup') ? process.execPath : owner)
        await delay(0)
        if (preparation) {
          assert.equal(disposed, true)
          assert.equal(removed, true)
        }
        const next = await fixture()
        try {
          await runWindowsCompiler(['fixture'], next.options, next.host)
        } finally {
          await next.dispose()
        }
      } finally {
        clearTimeout(guard)
        gate.resolve(scenario.startsWith('lookup') ? process.execPath : owner)
        await operation.catch(() => undefined)
        await delay(0)
        await rm(directory, { recursive: true, force: true })
      }
    })
  }

  await test('a closed compiler helper denied before go releases its unadmitted preparation', async () => {
    const f = await fixture({ denied: true })
    try {
      await assert.rejects(runWindowsCompiler(['fixture'], f.options, f.host), (error) => {
        assert(error instanceof WindowsCompilerError)
        assert.equal(error.physicalReleased, true)
        assert.equal(error.preserveWorkspace, false)
        return true
      })
      assert.equal(f.closed, true)
      await assert.rejects(stat(f.controlDirectory), { code: 'ENOENT' })
    } finally {
      await f.dispose()
    }
  })

  await test('cancelled preparation releases its slot only after the factory confirms cleanup', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pact-compiler-prepare-'))
    const controlDirectory = join(directory, 'control')
    await mkdir(controlDirectory)
    const entered = Promise.withResolvers(),
      cleaned = Promise.withResolvers()
    const controller = new AbortController()
    let executions = 0
    const host = {
      async resolveCompiler() {
        return process.execPath
      },
      async prepare(_root, _compiler, _lifetime, preparation) {
        entered.resolve(preparation)
        await new Promise((resolve) =>
          preparation.signal.addEventListener('abort', resolve, { once: true }),
        )
        await delay(30)
        rmSync(controlDirectory, { recursive: true })
        cleaned.resolve()
        throw new WindowsLaunchPreparationError(true, controlDirectory)
      },
      execute() {
        executions++
        throw new Error('Cancelled preparation must not dispatch')
      },
    }
    const options = { cwd: directory, timeout: 2000, maxBuffer: 1024, signal: controller.signal }
    const operation = runWindowsCompiler(['fixture'], options, host)
    try {
      const preparation = await entered.promise
      assert(preparation.signal instanceof AbortSignal)
      controller.abort()
      await assert.rejects(operation, WindowsCompilerError)
      assert((await stat(controlDirectory)).isDirectory())
      await assert.rejects(runWindowsCompiler(['fixture'], options, host), /capacity-unavailable/)
      await cleaned.promise
      await delay(0)
      assert.equal(executions, 0)
      const next = await fixture()
      try {
        await runWindowsCompiler(['fixture'], next.options, next.host)
      } finally {
        await next.dispose()
      }
    } finally {
      controller.abort()
      await operation.catch(() => undefined)
      await cleaned.promise
      await rm(directory, { recursive: true, force: true })
    }
  })

  await test('compiler host seam admits one action and does not queue another compilation', async () => {
    const f = await fixture({ closeDelay: 80 })
    try {
      const first = runWindowsCompiler(['fixture'], f.options, f.host)
      await assert.rejects(
        runWindowsCompiler(['fixture'], f.options, f.host),
        /capacity-unavailable/,
      )
      await first
      assert.equal(f.calls, 1)
    } finally {
      await f.dispose()
    }
  })

  await test('compiler empty cannot bypass delayed helper close or the original deadline', async () => {
    const f = await fixture({ mode: 'natural', closeDelay: 150 })
    try {
      await assert.rejects(
        runWindowsCompiler(['fixture'], { ...f.options, timeout: 100 }, f.host),
        WindowsCompilerError,
      )
      assert.equal(f.closed, true)
    } finally {
      await f.dispose()
    }
  })

  await test('compiler cancellation joins its owned helper but cannot accept root zero', async () => {
    const f = await fixture({ closeDelay: 100 })
    const controller = new AbortController()
    const cancel = f.owner.rootExit.then(() => controller.abort())
    try {
      await assert.rejects(
        runWindowsCompiler(['fixture'], { ...f.options, signal: controller.signal }, f.host),
        WindowsCompilerError,
      )
      await cancel
      assert.equal(f.closed, true)
    } finally {
      await f.dispose()
    }
  })

  await test('unconfirmed factory rejection before deadline retains capacity until process restart', async () => {
    const output = await new Promise((resolve, reject) => {
      execFile(
        process.execPath,
        [fileURLToPath(import.meta.url), 'preparation-retention'],
        { shell: false, timeout: 5000, maxBuffer: 4096 },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      )
    })
    assert.equal(output, 'preparation-retention-confirmed\n')
  })

  await test('missing empty retains recovery evidence and refuses another compiler generation', async () => {
    const f = await fixture({ mode: 'missing-empty' })
    try {
      await assert.rejects(runWindowsCompiler(['fixture'], f.options, f.host), (error) => {
        assert(error instanceof WindowsCompilerError)
        assert.equal(error.physicalReleased, false)
        assert.equal(error.preserveWorkspace, true)
        return true
      })
      assert.equal(f.closed, true)
      const evidence = JSON.parse(
        await readFile(join(f.controlDirectory, 'compiler-failure.json'), 'utf8'),
      )
      assert.equal(evidence.physicalReleased, false)
      await assert.rejects(
        runWindowsCompiler(['fixture'], f.options, f.host),
        /capacity-unavailable/,
      )
      assert.equal(f.calls, 1)
    } finally {
      await f.dispose()
    }
  })
}
