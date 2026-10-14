import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import { runCiE2EJob } from './ci.mjs'
import { evaluateRealReport, realCases } from './real-e2e-policy.mjs'

await test('natural exit 1 remains distinguishable from a stopped supervisor', async () => {
  assert.equal(
    await runCiE2EJob(['-e', 'process.exit(1)'], 20_000, {
      executable: process.execPath,
      write() {},
    }),
    1,
  )
})

await test(
  'a passing report written before actual process cancellation cannot become completed evidence',
  { timeout: 40_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pact-ci-e2e-completion-'))
    const path = join(directory, 'real.json'),
      controller = new AbortController()
    const passed = {
      errors: [],
      suites: [
        {
          specs: realCases
            .filter((item) => item.tier === 'core')
            .map((item) => ({
              file: item.path,
              title: item.title,
              tests: [
                {
                  projectName: 'real',
                  expectedStatus: 'passed',
                  status: 'expected',
                  results: [{ status: 'passed', duration: 1 }],
                },
              ],
            })),
        },
      ],
    }
    const code =
      'require("node:fs").writeFileSync(process.argv[1],process.argv[2]);setInterval(()=>{},1000)'
    let completed = false
    try {
      const pending = runCiE2EJob(['-e', code, path, JSON.stringify(passed)], 30_000, {
        executable: process.execPath,
        signal: controller.signal,
        write() {},
      }).then((value) => {
        completed = true
        return value
      })
      const rejected = assert.rejects(pending, /did not finish naturally/)
      let observed
      const deadline = performance.now() + 15_000
      while (performance.now() < deadline) {
        try {
          // oxlint-disable-next-line eslint/no-await-in-loop -- One actual readiness file is polled before signalling the owned process.
          observed = JSON.parse(await readFile(path, 'utf8'))
          break
        } catch (error) {
          if (error.code !== 'ENOENT') throw error
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- Fixed readiness deadline, no blind rerun or paid request.
        await delay(25)
      }
      assert.equal(evaluateRealReport(observed).gatePassed, true)
      controller.abort()
      await rejected
      assert.equal(completed, false)
    } finally {
      controller.abort()
      await rm(directory, { recursive: true, force: true })
    }
  },
)
