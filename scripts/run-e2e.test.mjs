import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import { main, run } from './run-e2e.mjs'

const posixOnly = { skip: process.platform === 'win32', timeout: 20_000 }
const syntheticSecret = 'synthetic-only-runner-secret-0123456789'

function pidGone(pid) {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    if (error.code === 'ESRCH') return true
    if (error.code === 'EPERM') return false
    throw error
  }
}

function groupGone(pid) {
  return pidGone(-pid)
}

function actualProcesses() {
  const text = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,lstart='], {
    encoding: 'utf8',
    timeout: 1000,
    maxBuffer: 256 * 1024,
    env: { PATH: process.env.PATH, LC_ALL: 'C' },
  })
  return new Map(
    text
      .trim()
      .split('\n')
      .map((line) => {
        const [, pid, ppid, pgid, started] = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/u.exec(line)
        const row = { pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), started }
        return [row.pid, row]
      }),
  )
}

async function waitFor(check, timeout = 4000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- One bounded state probe is settled before the next poll.
    if (await check()) return
    // oxlint-disable-next-line eslint/no-await-in-loop -- The fixture owns this short bounded polling deadline.
    await delay(25)
  }
  throw new Error('Owned Node test process did not reach its expected state')
}

/** These are actual owned Node process trees, never pnpm, Pact, Electron, CLI providers or models. */
async function treeFixture(context) {
  const root = await mkdtemp(join(tmpdir(), 'pact-e2e-runner-unit-'))
  const parent = join(root, 'parent.mjs')
  const worker = join(root, 'worker.mjs')
  const report = join(root, 'pids.json')
  const term = join(root, 'term.txt')
  const groups = new Set()
  const states = []
  const lines = []
  context.after(async () => {
    for (const pid of groups) {
      try {
        process.kill(-pid, 'SIGKILL')
      } catch (error) {
        if (error.code !== 'ESRCH') throw error
      }
    }
    await waitFor(() => [...groups].every(groupGone))
    await rm(root, { recursive: true, force: true })
  })
  await writeFile(parent, parentSource(), { mode: 0o600 })
  await writeFile(worker, workerSource(), { mode: 0o600 })
  return {
    root,
    report,
    term,
    states,
    lines,
    execute(mode, timeout = 10_000, extra = {}) {
      return run([parent, worker, report, term, mode, syntheticSecret], timeout, {
        executable: process.execPath,
        cwd: root,
        write(channel, text) {
          lines.push({ channel, text })
        },
        redact: (text) => text.replaceAll(syntheticSecret, '[REDACTED]'),
        onState(value) {
          if (states.length >= 256) throw new Error('Node observer event capacity exceeded')
          states.push(value)
          if (value.pid) groups.add(value.pid)
        },
        ...extra,
      })
    },
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
      if (value.detached) groups.add(value.worker)
      return value
    },
  }
}

await test(
  'normal job exit is forwarded after bounded full-line and EOF redaction',
  posixOnly,
  async (context) => {
    const fixture = await treeFixture(context)
    const code = await fixture.execute('normal')
    assert.equal(code, 7)
    const text = fixture.lines.map((line) => line.text).join('')
    assert.ok(text.includes('normal output\n'))
    assert.ok(text.includes('[REDACTED]'))
    assert.ok(!text.includes(syntheticSecret))
    assert.ok(text.endsWith('EOF [REDACTED]\n'))
    assert.equal(fixture.states.at(-1).groupGone, true)
    assert.equal(fixture.states.at(-1).bufferedBytes, 0)
  },
)

await test(
  'deadline closes a verified detached group after its parent exits on TERM',
  posixOnly,
  async (context) => {
    const fixture = await treeFixture(context)
    const execution = fixture.execute('detached', 1500)
    const pids = await fixture.pids()
    assert.equal(await execution, 1)
    assert.equal(groupGone(pids.parent), true)
    assert.equal(groupGone(pids.worker), true)
    assert.equal(pidGone(pids.worker), true)
    assert.ok(fixture.states.some((value) => value.ownedGroupCount === 2))
    assert.ok(fixture.states.every((value) => value.ownedProcessCount <= 256))
    assert.ok(fixture.states.every((value) => value.ownedGroupCount <= 16))
    assert.equal(fixture.states.at(-1).groupGone, true)
  },
)

await test(
  'a detached ignored-TERM group remains owned when its original parent exits successfully',
  posixOnly,
  async (context) => {
    const fixture = await treeFixture(context)
    const execution = fixture.execute('detached-parent-exits')
    const pids = await fixture.pids()
    assert.equal(await execution, 1)
    assert.equal(groupGone(pids.parent), true)
    assert.equal(groupGone(pids.worker), true)
    assert.equal(pidGone(pids.worker), true)
    assert.equal(
      fixture.states.find((value) => value.kind === 'stopping').reason,
      'descendants-still-running',
    )
  },
)

await test(
  'a successful parent preserves its exit code while its finite child closes naturally',
  posixOnly,
  async (context) => {
    const fixture = await treeFixture(context)
    const execution = fixture.execute('natural-tail')
    const pids = await fixture.pids()
    assert.equal(await execution, 0)
    assert.equal(groupGone(pids.parent), true)
    assert.equal(pidGone(pids.worker), true)
    assert.equal(
      fixture.states.some((value) => value.kind === 'stopping'),
      false,
    )
    await assert.rejects(readFile(fixture.term), { code: 'ENOENT' })
  },
)

for (const sequence of ['gone', 'restored']) {
  // oxlint-disable-next-line no-await-in-loop -- OS observation doubles must settle their real owned Node group before the next sequence.
  await test(
    `uncertain observation accepts only ${sequence} original identity without signalling`,
    posixOnly,
    async (context) => {
      const fixture = await treeFixture(context)
      let root
      let observations = 0
      let hidden = 0
      const execution = fixture.execute('normal-held', 10_000, {
        inspectProcesses: async () => {
          const rows = actualProcesses()
          root ??= [...rows.values()].find(
            (row) => row.ppid === process.pid && row.pgid === row.pid,
          )
          observations++
          if (root && observations >= 2 && (sequence === 'gone' || hidden === 0)) {
            rows.delete(root.pid)
            hidden++
          }
          return rows
        },
      })
      assert.equal(await execution, 7)
      assert.ok(hidden > 0)
      assert.ok(observations >= 3)
      assert.equal(groupGone(root.pgid), true)
      assert.equal(
        fixture.states.some((value) => value.kind === 'stopping'),
        false,
      )
      await assert.rejects(readFile(fixture.term), { code: 'ENOENT' })
    },
  )
}

for (const sequence of ['unknown', 'leader-changed']) {
  // oxlint-disable-next-line no-await-in-loop -- A failed ownership observation cannot leave an owned Node group running into the next case.
  await test(
    `persistent ${sequence} never signals an unverified group`,
    { ...posixOnly, timeout: 25_000 },
    async (context) => {
      const fixture = await treeFixture(context)
      let root
      let observations = 0
      const execution = fixture.execute('hold', 20_000, {
        inspectProcesses: async () => {
          const rows = actualProcesses()
          root ??= [...rows.values()].find(
            (row) => row.ppid === process.pid && row.pgid === row.pid,
          )
          observations++
          if (root && observations >= 2) {
            if (sequence === 'unknown') {
              for (const [pid, row] of rows) if (row.pgid === root.pgid) rows.delete(pid)
            } else if (rows.has(root.pid))
              rows.set(root.pid, { ...rows.get(root.pid), started: root.started + ' changed' })
          }
          return rows
        },
      })
      await fixture.pids()
      await assert.rejects(
        execution,
        /could not be confirmed closed|verifiable process identity|live process anchor/,
      )
      assert.ok(observations >= 2)
      await assert.rejects(readFile(fixture.term), { code: 'ENOENT' })
    },
  )
}

await test(
  'an expired unknown detached group does not block cleanup of a verified root',
  { ...posixOnly, timeout: 25_000 },
  async (context) => {
    const fixture = await treeFixture(context)
    let root
    let detached
    let observations = 0
    const execution = fixture.execute('detached', 20_000, {
      inspectProcesses: async () => {
        const rows = actualProcesses()
        root ??= [...rows.values()].find((row) => row.ppid === process.pid && row.pgid === row.pid)
        detached ??= [...rows.values()].find(
          (row) => row.ppid === root?.pid && row.pgid === row.pid,
        )
        observations++
        if (detached && observations >= 3) {
          for (const [pid, row] of rows) if (row.pgid === detached.pgid) rows.delete(pid)
        }
        return rows
      },
    })
    const pids = await fixture.pids()
    await assert.rejects(
      execution,
      /could not be confirmed closed|identity remains unconfirmed|live process anchor/,
    )
    assert.equal(pidGone(pids.parent), true)
    assert.equal(pidGone(pids.worker), false)
    await assert.rejects(readFile(fixture.term), { code: 'ENOENT' })
  },
)

await test(
  'a shared delayed observation cannot downgrade KILL back to TERM',
  posixOnly,
  async (context) => {
    const fixture = await treeFixture(context)
    let delayed = false
    const execution = fixture.execute('hold', 500, {
      inspectProcesses: async () => {
        if (!delayed) {
          delayed = true
          await delay(6200)
        }
        return actualProcesses()
      },
    })
    const pids = await fixture.pids()
    assert.equal(await execution, 1)
    assert.equal(groupGone(pids.parent), true)
    assert.equal(pidGone(pids.worker), true)
    await assert.rejects(readFile(fixture.term), { code: 'ENOENT' })
  },
)

await test(
  'deadline kills an ignored-TERM descendant after the direct job PID has exited',
  posixOnly,
  async (context) => {
    const fixture = await treeFixture(context)
    const execution = fixture.execute('hold', 1000)
    const pids = await fixture.pids()
    assert.equal(await execution, 1)
    assert.equal(pidGone(pids.parent), true)
    assert.equal(pidGone(pids.worker), true)
    assert.equal(groupGone(pids.parent), true)
    assert.ok((await readFile(fixture.term, 'utf8')).includes(String(pids.worker)))
    assert.equal(fixture.states.find((value) => value.kind === 'stopping').reason, 'deadline')
  },
)

await test(
  'a direct successful exit still reaps its ignored-TERM background descendant',
  posixOnly,
  async (context) => {
    const fixture = await treeFixture(context)
    const execution = fixture.execute('parent-exits')
    const pids = await fixture.pids()
    assert.equal(await execution, 1)
    assert.equal(groupGone(pids.parent), true)
    assert.equal(pidGone(pids.parent), true)
    assert.equal(pidGone(pids.worker), true)
    assert.equal(
      fixture.states.find((value) => value.kind === 'stopping').reason,
      'descendants-still-running',
    )
  },
)

for (const signal of ['SIGINT', 'SIGTERM']) {
  // oxlint-disable-next-line no-await-in-loop -- Each owned process group must settle before testing the next signal.
  await test(
    `manual ${signal} closes the complete owned group and releases signal listeners`,
    posixOnly,
    async (context) => {
      const fixture = await treeFixture(context)
      const listeners = process.listenerCount(signal)
      const execution = fixture.execute('hold')
      const pids = await fixture.pids()
      process.kill(process.pid, signal)
      assert.equal(await execution, 1)
      assert.equal(groupGone(pids.parent), true)
      assert.equal(pidGone(pids.parent), true)
      assert.equal(pidGone(pids.worker), true)
      assert.equal(process.listenerCount(signal), listeners)
      assert.equal(
        fixture.states.find((value) => value.kind === 'stopping').reason,
        `interrupted-${signal}`,
      )
    },
  )
}

await test(
  'shared 256 KiB limit discards a continuing noisy producer without emitting partial secrets',
  posixOnly,
  async (context) => {
    const fixture = await treeFixture(context)
    let redactions = 0
    const execution = fixture.execute('overflow', 10_000, {
      redact(text) {
        redactions += 1
        return text.replaceAll(syntheticSecret, '[REDACTED]')
      },
    })
    const pids = await fixture.pids()
    assert.equal(await execution, 1)
    assert.equal(groupGone(pids.parent), true)
    assert.equal(pidGone(pids.worker), true)
    assert.equal(fixture.lines.length, 0)
    assert.equal(redactions, 0)
    const stopped = fixture.states.findIndex((value) => value.kind === 'stopping')
    assert.ok(stopped >= 0)
    assert.equal(fixture.states[stopped].reason, 'output-budget')
    assert.ok(
      fixture.states.every(
        (value) => value.bufferedBytes <= 256 * 1024 && value.maxBufferedBytes <= 256 * 1024,
      ),
    )
    assert.ok(fixture.states.slice(stopped).every((value) => value.bufferedBytes === 0))
    assert.equal(
      fixture.states.filter(
        (value) => value.kind === 'buffered' && fixture.states.indexOf(value) > stopped,
      ).length,
      0,
    )
  },
)

await test(
  'unexpected spawn and execution errors withhold raw credential-bearing details',
  posixOnly,
  async () => {
    await assert.rejects(
      run([], 1000, { executable: `/synthetic/missing/${syntheticSecret}` }),
      (error) => {
        assert.ok(error.message.includes('ENOENT'))
        assert.ok(!error.message.includes(syntheticSecret))
        return true
      },
    )
    await assert.rejects(
      main({
        lane: 'ui',
        runJob: async () => {
          throw new Error(syntheticSecret)
        },
      }),
      (error) => {
        assert.ok(!error.message.includes(syntheticSecret))
        return true
      },
    )
  },
)

await test('all and real configuration admission happens before any build spawn', async () => {
  for (const lane of ['all', 'real']) {
    let executions = 0
    // oxlint-disable-next-line eslint/no-await-in-loop -- Each DI-only lane independently proves pre-spawn rejection without reading any native files.
    await assert.rejects(
      main({
        lane,
        loadConfiguration: async () => {
          throw new Error(syntheticSecret)
        },
        runJob: async () => {
          executions += 1
          return 0
        },
      }),
      /preparation or execution failed/,
    )
    assert.equal(executions, 0)
  }
})

await test('lane routing keeps one build, strict admission, integrity and a shared two-hour deadline', async (context) => {
  let clock = 0
  context.mock.method(Date, 'now', () => clock)
  const events = []
  const calls = []
  const code = await main({
    lane: 'all',
    forwarded: ['--', '--grep', 'selected case'],
    loadConfiguration: async () => {
      events.push('configuration')
      return {
        redact: (text) => text.replaceAll(syntheticSecret, '[REDACTED]'),
        assertSourceIntegrity: async () => {
          events.push('integrity')
        },
      }
    },
    runJob: async (args, timeout, options) => {
      calls.push({ args, timeout })
      assert.equal(options.redact(syntheticSecret), '[REDACTED]')
      if (args[0] === 'build') {
        events.push('build')
        clock = 300_000
        return 0
      }
      events.push('test')
      return 7
    },
  })
  assert.equal(code, 7)
  assert.deepEqual(events, ['configuration', 'build', 'test', 'integrity'])
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[0].args, ['build'])
  assert.equal(calls[0].timeout, 300_000)
  assert.equal(calls[1].timeout, 2 * 60 * 60_000 - 300_000)
  assert.deepEqual(calls[1].args, [
    'exec',
    'playwright',
    'test',
    '--project=ui',
    '--project=real',
    '--project=deterministic',
    '--grep',
    'selected case',
  ])
})

await test('UI and deterministic lanes skip credential files while project overrides stay forbidden', async () => {
  for (const lane of ['ui', 'deterministic']) {
    const calls = []
    assert.equal(
      // oxlint-disable-next-line eslint/no-await-in-loop -- These two independent DI-only cases must not read the user's configuration.
      await main({
        lane,
        loadConfiguration: async () => {
          throw new Error('Must not load')
        },
        runJob: async (args) => {
          calls.push(args)
          return 0
        },
      }),
      0,
    )
    assert.deepEqual(calls[1], ['exec', 'playwright', 'test', `--project=${lane}`])
  }
  await assert.rejects(
    main({
      lane: 'all',
      forwarded: ['--project=ui'],
      loadConfiguration: async () => {
        throw new Error('Must not load')
      },
      runJob: async () => {
        throw new Error('Must not spawn')
      },
    }),
    /second --project override/,
  )
})

await test('source integrity remains checked when the sole build fails', async () => {
  let checks = 0
  let jobs = 0
  assert.equal(
    await main({
      lane: 'real',
      loadConfiguration: async () => ({
        redact: (text) => text,
        assertSourceIntegrity: async () => {
          checks += 1
        },
      }),
      runJob: async () => {
        jobs += 1
        return 11
      },
    }),
    11,
  )
  assert.equal(checks, 1)
  assert.equal(jobs, 1)
})

function workerSource() {
  return `import { appendFileSync } from 'node:fs'
const term = process.argv[2]
process.on('SIGTERM', () => appendFileSync(term, String(process.pid) + '\\n'))
setInterval(() => {}, 1000)
process.send({ ready: true })
if (process.argv[3] === 'natural-tail') setTimeout(() => process.exit(0), 2700)
`
}

function parentSource() {
  return `import { spawn } from 'node:child_process'
import { appendFileSync, writeFileSync } from 'node:fs'
const [worker, report, term, mode, secret] = process.argv.slice(2)
if (mode === 'normal' || mode === 'normal-held') {
  process.stdout.write('normal output\\nAuthorization: Bearer ' + secret.slice(0, 14))
  setTimeout(() => { process.stdout.write(secret.slice(14) + '\\nEOF ' + secret); process.exitCode = 7 }, mode === 'normal' ? 20 : 2500)
} else {
  const detached = mode.startsWith('detached')
  const child = spawn(process.execPath, [worker, term, mode], { detached, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], shell: false })
  child.once('message', () => {
    writeFileSync(report, JSON.stringify({ parent: process.pid, worker: child.pid, detached }))
    // Leave time for the external owner to establish child identity before the
    // original parent exits. Loss of every known anchor must fail closed.
    if (mode === 'parent-exits' || mode === 'detached-parent-exits' || mode === 'natural-tail') setTimeout(() => process.exit(0), 2250)
    if (mode === 'overflow') {
      process.on('SIGTERM', () => appendFileSync(term, String(process.pid) + '\\n'))
      const chunk = Buffer.alloc(32 * 1024, 120)
      process.stdout.write('partial credential ' + secret)
      setInterval(() => { process.stdout.write(chunk); process.stderr.write(chunk) }, 10)
    } else setInterval(() => {}, 1000)
  })
}
`
}
