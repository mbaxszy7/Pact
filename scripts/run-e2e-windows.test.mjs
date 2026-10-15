import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'

import { runWindows, validateWindowsArgumentMode } from './run-e2e-windows.mjs'
import { run } from './run-e2e.mjs'

const windowsOnly = { skip: process.platform !== 'win32', timeout: 20_000 }

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
    await writeFile(
      driver,
      `import {run} from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, 'run-e2e.mjs')).href)};import{writeFileSync}from'node:fs';
run([${JSON.stringify(fixture.entry)}],15000,{executable:process.execPath,cwd:${JSON.stringify(fixture.root)},write:()=>{},onState:s=>{if(s.kind===${JSON.stringify(phase === 'supervisor-killed' ? 'started' : phase)})writeFileSync(${JSON.stringify(stateFile)},JSON.stringify(s))}}).then(()=>process.exit(0),()=>process.exit(1));\n`,
    )
    const runner = spawn(process.execPath, [driver], {
        shell: false,
        windowsHide: true,
        stdio: 'ignore',
      }),
      exited = new Promise((r) => runner.once('close', r))
    context.after(async () => {
      if (runner.exitCode === null && runner.signalCode === null) runner.kill()
      await exited
    })
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
  })
}
