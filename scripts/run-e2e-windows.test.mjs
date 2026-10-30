import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createConnection, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setImmediate as nextTurn, setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'

import {
  disposeWindowsLauncherImage,
  windowsLauncherImageDiagnostic,
} from '../tests/e2e/windows-cli-launcher.ts'
import {
  runWindows,
  validateWindowsArgumentMode,
  windowsJobDiagnostic,
} from './run-e2e-windows.mjs'
import { run } from './run-e2e.mjs'

const windowsOnly = { skip: process.platform !== 'win32', timeout: 20_000 }

function diagnosticFixture() {
  const members = Array.from({ length: 16 }, (_, index) => ({
    pid: 4294967295 - index,
    createdMs: Number.MAX_SAFE_INTEGER,
    role: 'descendant',
    image: 'crash-reporter',
  }))
  return {
    version: 1,
    root: {
      pid: 4294967279,
      exitCode: -2147483648,
      elapsedMs: Number.MAX_SAFE_INTEGER,
      natural: false,
      active: 256,
      members,
      membersIncomplete: false,
    },
    stop: { reason: 'descendants-still-running', active: 256 },
    afterTerminate: { phase: 'after-terminate', members, membersIncomplete: false },
    errorCode: -2147483648,
  }
}

await test('Windows runner failure facts fit the original control bound with adjacent frames', () => {
  const diagnostic = diagnosticFixture()
  assert.deepEqual(windowsJobDiagnostic(diagnostic), diagnostic)
  const frames = [
    { kind: 'stopping', reason: 'descendants-still-running' },
    { kind: 'counts', active: 256 },
    { kind: 'counts', active: 256 },
    { kind: 'empty', active: 0, exitCode: -2147483648, diagnostic },
  ]
  assert(Buffer.byteLength(JSON.stringify(frames.at(-1))) <= 3584)
  assert(Buffer.byteLength(frames.map((frame) => JSON.stringify(frame) + '\r\n').join('')) < 4096)
})

await test('Windows runner diagnostics withhold arbitrary strings and never mutate empty evidence', () => {
  const diagnostic = diagnosticFixture()
  diagnostic.path = 'private path'
  diagnostic.root.argv = 'private argument'
  diagnostic.root.members[0].command = 'private command'
  const empty = { kind: 'empty', active: 0, exitCode: 7, diagnostic }
  const snapshot = structuredClone(empty)
  const result = windowsJobDiagnostic(empty.diagnostic)
  assert(!JSON.stringify(result).includes('private'))
  assert.deepEqual(empty, snapshot)
  assert.equal(result.root.exitCode, -2147483648)
  assert.equal(empty.exitCode, 7)
})

await test('missing malformed and oversized Windows diagnostics stay incomplete without throwing', () => {
  const extraMembers = diagnosticFixture()
  extraMembers.root.members.push(extraMembers.root.members[0])
  const privateImage = diagnosticFixture()
  privateImage.root.members[0].image = 'private executable name'
  const invalidCode = diagnosticFixture()
  invalidCode.root.exitCode = Number.MAX_SAFE_INTEGER
  const invalidPhase = diagnosticFixture()
  invalidPhase.afterTerminate.phase = 'before-stop'
  for (const value of [
    undefined,
    null,
    [],
    {},
    extraMembers,
    privateImage,
    invalidCode,
    invalidPhase,
  ])
    assert.deepEqual(windowsJobDiagnostic(value), { incomplete: true })
  const natural = { ...diagnosticFixture(), stop: null, afterTerminate: null, errorCode: null }
  assert.equal(windowsJobDiagnostic(natural).stop, null)
})

await test(
  'a cold Windows Job starts and releases without a PowerShell compiler dependency',
  windowsOnly,
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'pact-compiled-job-regression-'))
    let settled
    try {
      const result = await run(['-e', 'process.exit(0)'], 15_000, {
        executable: process.execPath,
        env: { ...process.env, PACT_E2E_POWERSHELL_EXECUTABLE: join(root, 'missing-pwsh.exe') },
        write() {},
        onState(state) {
          if (state.kind === 'settled') settled = state
        },
      })
      assert.equal(result, 0)
      assert.equal(settled?.groupGone, true)
      assert.equal(settled?.ownedProcessCount, 0)
      assert.equal(windowsLauncherImageDiagnostic().privateLinks, 0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
)

await test(
  'expired preparation cannot launch a helper or target with a fresh timeout',
  windowsOnly,
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'pact-expired-job-preparation-'))
    const states = []
    const began = performance.now()
    try {
      await assert.rejects(
        run(['-e', 'process.exit(0)'], 1000, {
          executable: process.execPath,
          write() {},
          onState(state) {
            states.push(state.kind)
            if (state.kind === 'prepared')
              Atomics.wait(
                new Int32Array(new SharedArrayBuffer(4)),
                0,
                0,
                Math.max(0, began + 1000 - performance.now()) + 20,
              )
          },
        }),
        /supervisor image preparation failed; no job was started/,
      )
      assert(states.includes('prepared'))
      assert(!states.includes('bootstrapping'))
      assert.equal(windowsLauncherImageDiagnostic().privateLinks, 0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
)

// Exercise real pipe/Job boundaries, including callbacks that outrun timer delivery.
for (const scenario of [
  { boundary: 'prepared', microtask: true, admitted: false, timeout: 1000 },
  { boundary: 'prepared', microtask: true, cancel: true, admitted: false, timeout: 1000 },
  { boundary: 'initializing', admitted: false, timeout: 15_000 },
  { boundary: 'initializing', cancel: true, admitted: false, timeout: 15_000 },
  {
    boundary: 'initializing',
    microtask: true,
    admitted: true,
    timeout: 30_000,
    startup: true,
    lateReceipt: true,
  },
  { boundary: 'bootstrapping', admitted: false, timeout: 30_000, startup: true },
  { boundary: 'started', admitted: true, timeout: 15_000 },
  { boundary: 'output', admitted: true, timeout: 15_000 },
  { boundary: 'settled', admitted: true, timeout: 15_000 },
]) {
  // oxlint-disable-next-line eslint/no-await-in-loop -- One invocation owns the shared Windows compiler/Job cache at a time.
  await test(
    `Windows ${scenario.boundary}${scenario.microtask ? ' microtask' : ''} ${scenario.cancel ? 'cancellation' : scenario.startup ? 'startup deadline' : 'absolute deadline'} cannot become a late success`,
    { ...windowsOnly, timeout: 35_000 },
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'pact-job-deadline-boundary-'))
      const marker = join(root, 'target-admitted.txt')
      const states = []
      const controller = new AbortController()
      const began = performance.now()
      let triggered = false
      const consumeBudget = () => {
        if (triggered) return
        triggered = true
        if (scenario.cancel) controller.abort()
        else {
          const boundary = scenario.startup ? performance.now() + 15_000 : began + scenario.timeout
          Atomics.wait(
            new Int32Array(new SharedArrayBuffer(4)),
            0,
            0,
            Math.max(0, boundary - performance.now()) + 50,
          )
        }
      }
      try {
        const result = await run(
          [
            '-e',
            'require("node:fs").writeFileSync(process.argv[1],"admitted"); console.log("done")',
            marker,
          ],
          scenario.timeout,
          {
            executable: process.execPath,
            signal: controller.signal,
            write() {
              if (scenario.boundary === 'output') consumeBudget()
            },
            onState(state) {
              states.push(state)
              if (state.kind !== scenario.boundary) return
              if (scenario.microtask) queueMicrotask(consumeBudget)
              else consumeBudget()
            },
          },
        )
        assert.equal(triggered, true, 'The actual requested process boundary must be reached')
        assert.equal(result, 1)
        if (scenario.boundary === 'prepared')
          assert(!states.some((state) => state.kind === 'bootstrapping'))
        assert.equal(states.at(-1)?.groupGone, true)
        assert.equal(states.at(-1)?.jobAdmitted, scenario.admitted)
        assert.equal(states.at(-1)?.ownedProcessCount, 0)
        if (scenario.lateReceipt) assert(!states.some((state) => state.kind === 'started'))
        assert.equal(
          await readFile(marker, 'utf8').then(
            () => true,
            () => false,
          ),
          scenario.admitted,
        )
        assert.equal(windowsLauncherImageDiagnostic().privateLinks, 0)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
  )
}

await test(
  'the compiled seed can retire while its owned command keeps a private image',
  windowsOnly,
  async () => {
    let retired = false,
      settled
    const controller = new AbortController()
    const result = await run(['-e', 'setInterval(()=>{},1000)'], 10_000, {
      executable: process.execPath,
      signal: controller.signal,
      write() {},
      onState(state) {
        if (state.kind === 'started') {
          disposeWindowsLauncherImage()
          assert.doesNotThrow(() => process.kill(state.pid, 0))
          retired = true
          controller.abort()
        }
        if (state.kind === 'settled') settled = state
      },
    })
    assert.equal(result, 1)
    assert.equal(retired, true)
    assert.equal(settled?.groupGone, true)
    assert.equal(windowsLauncherImageDiagnostic().privateLinks, 0)
  },
)

await test('NSIS mode admits only silent owned operations and an absolute final raw directory tail', () => {
  assert.equal(validateWindowsArgumentMode(['/S'], 'nsis'), 'nsis')
  for (const directory of [
    'C:\\Pact Dev\\安装 包',
    '\\\\server\\share\\Pact Dev',
    'D:\\a&b%literal\\',
  ])
    assert.equal(validateWindowsArgumentMode(['/S', `/D=${directory}`], 'nsis'), 'nsis')
  assert.equal(validateWindowsArgumentMode(['', 'a"b', '&|%$()']), 'crt')
  for (const args of [
    [],
    ['/s'],
    ['/S', '/D=relative'],
    ['/S', '/D=\\rooted'],
    ['/S', '/D=C:relative'],
    ['/S', '/D=C:\\bad"quote'],
    ['/S', '/D=C:\\bad\0name'],
    ['/S', '/D=C:\\bad\rname'],
    ['/S', '/D=C:\\bad\nname'],
    ['/S', '/D=C:\\first', '/D=C:\\second'],
    ['/D=C:\\last', '/S'],
    ['/S', '/D=C:\\one /D=C:\\two'],
    ['/S', '_?=C:\\Pact'],
  ])
    assert.throws(() => validateWindowsArgumentMode(args, 'nsis'), /Invalid/u)
  assert.throws(() => validateWindowsArgumentMode(['/S'], 'raw'), /Invalid/u)
})

await test('invalid NSIS descriptors fail before executable discovery or Job admission', async () => {
  await assert.rejects(
    runWindows(
      ['/S', '/D=relative'],
      1000,
      { windowsArgumentMode: 'nsis' },
      { failure: (message) => new Error(message), scrubHeaders: (text) => text },
    ),
    /failed admission; no job was started/u,
  )
  if (process.platform !== 'win32')
    await assert.rejects(
      run(['/S'], 1000, { windowsArgumentMode: 'nsis' }),
      /requires a Windows Job/u,
    )
})

await test(
  'Windows Job preserves NSIS silent switches and a final space/Unicode directory without CRT quotes',
  windowsOnly,
  async (context) => {
    const root = await mkdtemp(join(tmpdir(), 'pact-nsis-raw-arguments-'))
    let allReleased = true
    context.after(async () => {
      if (!allReleased)
        throw new Error('Windows argument probe release is unconfirmed; fixture retained')
      await rm(root, { recursive: true, force: true })
    })
    const runChecked = async (args, timeout, options) => {
      let released = false
      try {
        return await run(args, timeout, {
          ...options,
          onState: (state) => {
            if (state.kind === 'settled')
              released = state.groupGone === true && state.ownedProcessCount === 0
            options.onState?.(state)
          },
        })
      } finally {
        if (!released) allReleased = false
      }
    }
    const source = join(root, 'RawArguments.cs'),
      probe = join(root, 'RawArguments.exe')
    await writeFile(
      source,
      `using System;using System.Security.Cryptography;using System.Text;class RawArguments {static int Main(){var raw=Environment.CommandLine;var at=raw.IndexOf(" /D=",StringComparison.Ordinal);var tail=at<0?"":raw.Substring(at+4);string hash;using(var digest=SHA256.Create()){hash=BitConverter.ToString(digest.ComputeHash(Encoding.UTF8.GetBytes(tail))).Replace("-","").ToLowerInvariant();}Console.WriteLine("{\\"silent\\":"+(raw.Contains(" /S ")||raw.EndsWith(" /S",StringComparison.Ordinal)?"true":"false")+",\\"tailHash\\":\\""+hash+"\\",\\"tailQuoted\\":"+(tail.IndexOf('"')>=0?"true":"false")+"}");return 0;}}`,
    )
    const compiler = join(
      process.env.SystemRoot ?? process.env.WINDIR,
      'Microsoft.NET',
      'Framework64',
      'v4.0.30319',
      'csc.exe',
    )
    assert.equal(
      await runChecked(['/nologo', '/target:exe', `/out:${probe}`, source], 15_000, {
        executable: compiler,
        cwd: root,
        write: () => {},
      }),
      0,
    )
    const directory = join(root, '安装 package with spaces'),
      args = ['/S', `/D=${directory}`]
    const execute = async (windowsArgumentMode) => {
      let output = '',
        settled
      const code = await runChecked(args, 10_000, {
        executable: probe,
        cwd: root,
        windowsArgumentMode,
        write: (_channel, text) => {
          output += text
        },
        onState: (state) => {
          if (state.kind === 'settled') settled = state
        },
      })
      assert.equal(code, 0)
      assert.equal(settled?.groupGone, true)
      assert.equal(settled?.ownedProcessCount, 0)
      return JSON.parse(output)
    }
    const crt = await execute(undefined)
    assert.equal(crt.silent, false)
    assert.notEqual(crt.tailHash, createHash('sha256').update(directory).digest('hex'))
    const nsis = await execute('nsis')
    assert.deepEqual(nsis, {
      silent: true,
      tailHash: createHash('sha256').update(directory).digest('hex'),
      tailQuoted: false,
    })
  },
)

void test(
  'Windows forwards the root exit while its libuv Job closes ordinary helpers',
  windowsOnly,
  async () => {
    const source = `const {spawn}=require('node:child_process');const children=Array.from({length:3},()=>spawn(process.execPath,['-e',"process.send('ready');setInterval(()=>{},1000)"],{stdio:['ignore','ignore','ignore','ipc'],shell:false}));let ready=0;for(const child of children)child.once('message',()=>{if(++ready===children.length){console.log(JSON.stringify(children.map(child=>child.pid)));process.exit(0)}})`
    let output = ''
    const result = await run(['-e', source], 10_000, {
      executable: process.execPath,
      write: async (_stream, text) => {
        output += text
      },
    })
    assert.equal(result, 0)
    const helpers = JSON.parse(output)
    assert.equal(helpers.length, 3)
    for (const pid of helpers) assert.equal(pidGone(pid), true)
  },
)

await test(
  'NSIS delegation owns its child until the original deadline while CRT retains its drain limit',
  { skip: process.platform !== 'win32', timeout: 60_000 },
  async (context) => {
    const root = await mkdtemp(join(tmpdir(), 'pact-nsis-delegation-'))
    let allReleased = true
    context.after(async () => {
      if (!allReleased) throw new Error('Delegated Job release is unconfirmed; fixture retained')
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 })
    })
    const source = join(root, 'Delegation.cs'),
      executable = join(root, 'Delegation.exe')
    await writeFile(
      source,
      `using System;using System.Diagnostics;using System.Reflection;using System.Threading;class Delegation{static int Main(string[] args){if(args.Length==1&&args[0]=="child"){Thread.Sleep(int.Parse(Environment.GetEnvironmentVariable("PACT_NSIS_CHILD_DELAY")));return 0;}var info=new ProcessStartInfo(Assembly.GetExecutingAssembly().Location,"child"){UseShellExecute=false,CreateNoWindow=true};using(var child=Process.Start(info)){Console.WriteLine("delegated");return int.Parse(Environment.GetEnvironmentVariable("PACT_NSIS_ROOT_EXIT"));}}}`,
    )
    const checked = async (args, timeout, options) => {
      let released = false
      try {
        return await run(args, timeout, {
          ...options,
          onState: (state) => {
            if (state.kind === 'settled')
              released = state.groupGone === true && state.ownedProcessCount === 0
            options.onState?.(state)
          },
        })
      } finally {
        if (!released) allReleased = false
      }
    }
    const compiler = join(
      process.env.SystemRoot ?? process.env.WINDIR,
      'Microsoft.NET',
      'Framework64',
      'v4.0.30319',
      'csc.exe',
    )
    assert.equal(
      await checked(['/nologo', '/target:exe', `/out:${executable}`, source], 15_000, {
        executable: compiler,
        cwd: root,
        write: () => {},
      }),
      0,
    )
    for (const scenario of ['nsis', 'crt', 'nonzero', 'deadline', 'cancel', 'observer-failure']) {
      const controller = new AbortController(),
        states = [],
        mode = scenario === 'crt' ? undefined : 'nsis'
      let delegated = false
      // oxlint-disable-next-line eslint/no-await-in-loop -- Every owned Job must physically settle before its next independent failure mode.
      const code = await checked(['/S'], scenario === 'deadline' ? 6000 : 15_000, {
        executable,
        cwd: root,
        env: {
          ...process.env,
          PACT_NSIS_CHILD_DELAY:
            scenario === 'nonzero' ? '50' : scenario === 'deadline' ? '12000' : '7000',
          PACT_NSIS_ROOT_EXIT: scenario === 'nonzero' ? '7' : '0',
        },
        windowsArgumentMode: mode,
        signal: controller.signal,
        write: (_channel, text) => {
          if (text.trim() === 'delegated') {
            delegated = true
            if (scenario === 'cancel') controller.abort()
          }
        },
        onState: (state) => {
          states.push(state)
          if (scenario === 'observer-failure' && state.kind === 'started')
            throw new Error('Controlled owner observation failure')
        },
      })
      assert.equal(code, scenario === 'nsis' ? 0 : scenario === 'nonzero' ? 7 : 1)
      if (scenario !== 'observer-failure') assert.equal(delegated, true)
      const stopping = states.filter((state) => state.kind === 'stopping')
      if (['nsis', 'nonzero'].includes(scenario)) assert.equal(stopping.length, 0)
      else
        assert.ok(
          stopping.some(
            (state) =>
              state.reason ===
              {
                crt: 'descendants-still-running',
                deadline: 'deadline',
                cancel: 'cancelled',
                'observer-failure': 'observer-failed',
              }[scenario],
          ),
        )
      assert.equal(states.at(-1).groupGone, true)
      assert.equal(states.at(-1).ownedProcessCount, 0)
    }
  },
)

async function waitFor(check) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- The fixture owns one bounded lifecycle probe.
    if (await check()) return
    // oxlint-disable-next-line eslint/no-await-in-loop -- Poll only until this owned process reaches its expected state.
    await delay(25)
  }
  throw new Error('Windows fixture did not settle within its deadline')
}

function pidGone(pid) {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    if (error.code === 'ESRCH') return true
    throw error
  }
}

async function tree(context, mode) {
  const root = await mkdtemp(join(tmpdir(), 'pact-windows-runner-test-'))
  context.after(() => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 }))
  const entry = join(root, 'parent.mjs'),
    worker = join(root, 'worker.mjs'),
    report = join(root, 'pids.json')
  await writeFile(
    worker,
    `process.send('ready'); if(process.argv[2]==='finite')setTimeout(()=>process.exit(0),1800);else setInterval(()=>{},1000)\n`,
  )
  await writeFile(
    entry,
    `import {spawn} from 'node:child_process'; import {writeFileSync} from 'node:fs';
const child=spawn(process.execPath,[${JSON.stringify(worker)},${JSON.stringify(mode)}],{detached:true,shell:false,stdio:['ignore','ignore','ignore','ipc']});
child.once('message',()=>{writeFileSync(${JSON.stringify(report)},JSON.stringify({parent:process.pid,worker:child.pid}));
if(${JSON.stringify(mode)}==='fast-exit'||${JSON.stringify(mode)}==='finite')process.exit(0);
else if(${JSON.stringify(mode)}==='overflow'){process.stdout.write('partial synthetic-secret');setInterval(()=>{process.stdout.write('x'.repeat(32768));process.stderr.write('y'.repeat(32768))},10)}
else setInterval(()=>{},1000);});\n`,
  )
  return {
    root,
    entry,
    report,
    async pids() {
      let value
      await waitFor(async () => {
        try {
          value = JSON.parse(await readFile(report, 'utf8'))
          return true
        } catch (error) {
          if (error.code === 'ENOENT' || error instanceof SyntaxError) return false
          throw error
        }
      })
      return value
    },
  }
}

await test(
  'Windows forwards the real exit code and redacts complete output',
  windowsOnly,
  async (context) => {
    const root = await mkdtemp(join(tmpdir(), 'pact-windows-runner-test-'))
    context.after(() => rm(root, { recursive: true, force: true }))
    const entry = join(root, 'normal.mjs')
    const secret = 'synthetic-windows-runner-secret'
    await writeFile(
      entry,
      `process.stdout.write('normal output\\nAuthorization: Bearer ' + ${JSON.stringify(secret)}); process.exitCode = 7\n`,
    )
    const lines = []
    const states = []
    const code = await run([entry], 10_000, {
      executable: process.execPath,
      cwd: root,
      redact: (text) => text.replaceAll(secret, '[REDACTED]'),
      write: (channel, text) => lines.push({ channel, text }),
      onState: (state) => states.push(state),
    })
    assert.equal(code, 7)
    assert.ok(lines.some((line) => line.text.includes('normal output')))
    assert.ok(lines.some((line) => line.text.includes('[REDACTED]')))
    assert.ok(lines.every((line) => !line.text.includes(secret)))
    assert.equal(states.at(-1).kind, 'settled')
    assert.equal(states.at(-1).groupGone, true)
  },
)

await test(
  'Windows native argv preserves quoting, Unicode and shell metacharacters',
  windowsOnly,
  async (context) => {
    const root = await mkdtemp(join(tmpdir(), 'pact-windows-runner-test-'))
    context.after(() => rm(root, { recursive: true, force: true }))
    const entry = join(root, 'arguments with spaces.mjs')
    await writeFile(entry, "process.stdout.write(JSON.stringify(process.argv.slice(2))+'\\n')\n")
    const args = ['', 'with spaces', '中文', 'a"b', 'trailing\\', '&|%$()', 'back\\"quote']
    const lines = []
    assert.equal(
      await run([entry, ...args], 10000, {
        executable: process.execPath,
        cwd: root,
        write: (_channel, text) => lines.push(text),
      }),
      0,
    )
    assert.deepEqual(JSON.parse(lines.join('')), args)
  },
)

await test(
  'Windows settles an interrupted output sink without leaking listeners',
  windowsOnly,
  async (context) => {
    const root = await mkdtemp(join(tmpdir(), 'pact-windows-runner-test-'))
    context.after(() => rm(root, { recursive: true, force: true }))
    const entry = join(root, 'output.mjs')
    await writeFile(entry, "console.log('bounded output')\n")
    const interrupts = process.listenerCount('SIGINT')
    assert.equal(
      await run([entry], 4000, {
        executable: process.execPath,
        cwd: root,
        write: () => new Promise(() => {}),
      }),
      1,
    )
    assert.equal(process.listenerCount('SIGINT'), interrupts)
  },
)

await test('Windows startup failures withhold credential-bearing paths', windowsOnly, async () => {
  const secret = 'synthetic-startup-secret'
  await assert.rejects(run([], 10000, { executable: join(tmpdir(), `${secret}.exe`) }), (error) => {
    assert.ok(!error.message.includes(secret))
    return true
  })
})

for (const mode of ['hold', 'fast-exit', 'overflow', 'finite']) {
  // oxlint-disable-next-line eslint/no-await-in-loop -- Each real Windows Job must settle before the next lifecycle fixture.
  await test(
    `Windows Job owns detached descendants during ${mode}`,
    windowsOnly,
    async (context) => {
      const fixture = await tree(context, mode),
        states = [],
        lines = []
      const sentinel = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
        shell: false,
        windowsHide: true,
        stdio: 'ignore',
      })
      const sentinelClosed = new Promise((r) => sentinel.once('close', r))
      context.after(async () => {
        sentinel.kill()
        await sentinelClosed
      })
      const result = run([fixture.entry], mode === 'hold' ? 3000 : 12000, {
        executable: process.execPath,
        cwd: fixture.root,
        onState: (s) => states.push(s),
        write: (_channel, text) => lines.push(text),
      })
      const pids = await fixture.pids()
      assert.equal(await result, mode === 'finite' ? 0 : 1)
      await waitFor(() => pidGone(pids.parent) && pidGone(pids.worker))
      assert.equal(sentinel.exitCode, null)
      assert.equal(sentinel.signalCode, null)
      assert.equal(states.at(-1).groupGone, true)
      assert.equal(states.at(-1).ownedProcessCount, 0)
      assert.ok(
        states.every((s) => s.bufferedBytes <= 256 * 1024 && s.maxBufferedBytes <= 256 * 1024),
      )
      if (mode === 'overflow') {
        assert.equal(lines.length, 0)
        assert.ok(states.some((s) => s.reason === 'output-budget'))
      }
      if (mode === 'fast-exit')
        assert.ok(states.some((s) => s.reason === 'descendants-still-running'))
      if (mode === 'finite')
        assert.equal(
          states.some((s) => s.kind === 'stopping'),
          false,
        )
    },
  )
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  // oxlint-disable-next-line eslint/no-await-in-loop -- Event dispatch tests each independent owned Job and listener cleanup.
  await test(
    `Windows ${signal} cancels its Job and releases listeners`,
    windowsOnly,
    async (context) => {
      const fixture = await tree(context, 'hold'),
        listeners = process.listenerCount(signal),
        states = []
      const result = run([fixture.entry], 12000, {
        executable: process.execPath,
        cwd: fixture.root,
        onState: (s) => states.push(s),
        write: () => {},
      })
      const pids = await fixture.pids()
      process.emit(signal)
      assert.equal(await result, 1)
      await waitFor(() => pidGone(pids.parent) && pidGone(pids.worker))
      assert.equal(process.listenerCount(signal), listeners)
      assert.ok(states.some((s) => s.reason === `interrupted-${signal}`))
    },
  )
}

for (const phase of ['bootstrapping', 'initializing', 'started', 'supervisor-killed']) {
  // oxlint-disable-next-line eslint/no-await-in-loop -- Strong-kill fixtures are isolated external Node runners, never this test process.
  await test(`Windows Job closes when ${phase} loses its owner`, windowsOnly, async (context) => {
    const fixture = await tree(context, 'hold'),
      driver = join(fixture.root, 'runner.mjs'),
      stateFile = join(fixture.root, 'state.json')
    const reportedPhases = [
      'preparing',
      'prepared',
      'bootstrapping',
      'initializing',
      'started',
      'stopping',
      'settled',
    ]
    const began = performance.now()
    const phases = []
    await writeFile(
      driver,
      `import {run} from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, 'run-e2e.mjs')).href)};import{writeFileSync}from'node:fs';
const phases=new Set(${JSON.stringify(reportedPhases)});
run([${JSON.stringify(fixture.entry)}],15000,{executable:process.execPath,cwd:${JSON.stringify(fixture.root)},write:()=>{},onState:s=>{if(phases.has(s.kind))process.send({kind:s.kind,ownerPid:s.ownerPid},()=>{});if(s.kind===${JSON.stringify(phase === 'supervisor-killed' ? 'started' : phase)})writeFileSync(${JSON.stringify(stateFile)},JSON.stringify(s))}}).then(()=>process.exit(0),()=>process.exit(1));\n`,
    )
    const runner = spawn(process.execPath, [driver], {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      }),
      exited = new Promise((r) => runner.once('close', r))
    const recordPhase = (message) => {
      if (
        reportedPhases.includes(message?.kind) &&
        (message.ownerPid === null || Number.isSafeInteger(message.ownerPid)) &&
        phases.length < 8
      )
        phases.push({
          kind: message.kind,
          ownerPid: message.ownerPid,
          elapsedMs: Math.round(performance.now() - began),
        })
    }
    runner.on('message', recordPhase)
    context.after(async () => {
      if (runner.exitCode === null && runner.signalCode === null) runner.kill()
      await exited
      runner.removeListener('message', recordPhase)
    })
    try {
      let state
      await waitFor(async () => {
        try {
          state = JSON.parse(await readFile(stateFile, 'utf8'))
          return true
        } catch (e) {
          if (e.code === 'ENOENT' || e instanceof SyntaxError) return false
          throw e
        }
      })
      if (phase === 'initializing' || phase === 'bootstrapping') {
        runner.kill()
        await exited
        await waitFor(() => pidGone(state.ownerPid))
        await assert.rejects(readFile(fixture.report), { code: 'ENOENT' })
      } else {
        const pids = await fixture.pids()
        if (phase === 'supervisor-killed') process.kill(state.ownerPid, 'SIGKILL')
        else runner.kill()
        await exited
        await waitFor(() => pidGone(state.ownerPid) && pidGone(pids.parent) && pidGone(pids.worker))
      }
    } catch (error) {
      context.diagnostic(
        JSON.stringify({ phase, phases, exitCode: runner.exitCode, signalCode: runner.signalCode }),
      )
      throw error
    }
  })
}

for (const attack of ['null-frame', 'authenticated-reconnect']) {
  // oxlint-disable-next-line eslint/no-await-in-loop -- Each isolated real named-pipe fixture restores TEMP/TMP before the next case.
  await test(`Windows control authentication rejects ${attack}`, windowsOnly, async () => {
    const root = await mkdtemp(join(tmpdir(), 'pact-control-authentication-'))
    const marker = join(root, 'target-must-not-start.txt')
    const heldPipe = `\\\\.\\pipe\\pact-e2e-held-${process.pid}-${randomUUID()}`
    const sockets = new Set()
    const held = createServer((socket) => {
      sockets.add(socket)
      socket.on('error', () => {})
      socket.on('close', () => sockets.delete(socket))
      socket.resume() // Hold the genuine helper before go; no Job can be created here.
    })
    held.maxConnections = 1
    held.listen(heldPipe)
    await once(held, 'listening')
    const oldTemp = process.env.TEMP,
      oldTmp = process.env.TMP,
      states = []
    let descriptor,
      directory,
      exercise = Promise.resolve(),
      fixtureError,
      ownerPid,
      secondClosed = false
    let firstAcknowledged = false
    process.env.TEMP = root
    process.env.TMP = root
    try {
      const outcome = await run(
        ['-e', 'require("node:fs").writeFileSync(process.argv[1],"unexpected")', marker],
        15000,
        {
          executable: process.execPath,
          write() {},
          onState(state) {
            assert(states.length < 128)
            states.push(state)
            if (state.ownerPid) ownerPid = state.ownerPid
            if (state.kind === 'prepared') {
              const names = readdirSync(root).filter((name) =>
                name.startsWith('pact-test-image-runner-'),
              )
              assert.equal(names.length, 1)
              directory = join(root, names[0])
              const path = join(directory, 'runner.json')
              descriptor = JSON.parse(readFileSync(path, 'utf8'))
              writeFileSync(
                path,
                JSON.stringify({ ...descriptor, pipe: heldPipe.split('\\').at(-1) }),
              )
            }
            if (state.kind !== 'bootstrapping') return
            exercise = (async () => {
              const first = createConnection(`\\\\.\\pipe\\${descriptor.pipe}`)
              sockets.add(first)
              first.on('error', () => {})
              await once(first, 'connect')
              const firstClose = new Promise((resolveClose) => first.once('close', resolveClose))
              if (attack === 'null-frame') {
                first.write('null\n')
                await firstClose
                return
              }
              const go = new Promise((resolveGo, rejectGo) => {
                let bytes = Buffer.alloc(0)
                const finishGo = (error) => {
                  clearTimeout(timer)
                  first.removeListener('data', onData)
                  first.removeListener('error', onFailure)
                  first.removeListener('close', onFailure)
                  if (error) rejectGo(error)
                  else resolveGo(bytes.toString('ascii'))
                }
                const onFailure = () => finishGo(new Error('Controlled pipe closed before go'))
                const onData = (chunk) => {
                  if (bytes.length + chunk.length > 16)
                    return finishGo(new Error('Controlled go receipt exceeded its bound'))
                  bytes = Buffer.concat([bytes, chunk])
                  if (bytes.includes(10)) finishGo()
                }
                const timer = setTimeout(onFailure, 5000)
                first.on('data', onData)
                first.on('error', onFailure)
                first.on('close', onFailure)
              })
              first.write(JSON.stringify({ kind: 'hello', token: descriptor.token }) + '\n')
              assert.equal(await go, 'go\n')
              firstAcknowledged = true
              first.destroy()
              await firstClose
              await nextTurn()
              await nextTurn()
              const second = createConnection(`\\\\.\\pipe\\${descriptor.pipe}`)
              sockets.add(second)
              second.on('error', () => {})
              await once(second, 'connect')
              const secondClose = new Promise((resolveClose) => second.once('close', resolveClose))
              second.write('{"kind":"empty","active":0,"exitCode":0}\n')
              await secondClose
              secondClosed = true
            })().catch((error) => {
              fixtureError = error
            })
          },
        },
      ).then(
        (code) => ({ code }),
        (error) => ({ error }),
      )
      await exercise
      assert.ifError(fixtureError)
      assert(ownerPid && pidGone(ownerPid), 'The genuine helper must have actually closed')
      assert(!states.some((state) => state.kind === 'started'))
      await assert.rejects(readFile(marker), { code: 'ENOENT' })
      if (attack === 'null-frame') {
        assert.equal(outcome.code, 1)
        assert(states.some((state) => state.reason === 'control-invalid'))
        assert.equal(states.at(-1)?.groupGone, true)
        assert.equal(states.at(-1)?.jobAdmitted, false)
      } else {
        assert(firstAcknowledged && secondClosed)
        assert.match(
          outcome.error?.message ?? '',
          /Job closure could not be confirmed/u,
          'Reconnected peer must not supply the original release proof',
        )
        assert.equal(states.at(-1)?.groupGone, false)
        assert.equal(states.at(-1)?.jobAdmitted, true)
        assert((await readFile(join(directory, 'runner.json'))).length > 0)
      }
    } finally {
      for (const socket of sockets) socket.destroy()
      await new Promise((resolveClose) => held.close(resolveClose))
      if (oldTemp === undefined) delete process.env.TEMP
      else process.env.TEMP = oldTemp
      if (oldTmp === undefined) delete process.env.TMP
      else process.env.TMP = oldTmp
      // Fixture-only proof: the genuine helper was routed to held and never got go.
      // Preserve the runner's rejection/retention assertion above; never invent Job-empty.
      if (ownerPid && pidGone(ownerPid)) {
        disposeWindowsLauncherImage()
        await rm(root, { recursive: true, force: true })
      }
    }
    assert.equal(windowsLauncherImageDiagnostic().privateLinks, 0)
  })
}
