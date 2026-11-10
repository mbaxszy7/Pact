import { lstat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'

import type { DesktopBridge } from '../../packages/contracts/src/index.js'

import { within } from '../native/native-harness.js'
import { quitPact } from './native-quit.js'
import { createRuntimeFixture, type RuntimeFixture } from './runtime-fixture.js'

const sourceError =
  'Real Relay tests require an owned private .env containing OPENAI_API_KEY; use PACT_E2E_RELAY_API_KEY_FILE or tests/e2e/env/codex/.env.'

/**
 * Save into a fresh real fixture, then join Quit before callers seed SQLite.
 * Only Main reads the private file. Playwright carries its path and fixed facts,
 * never the key or the script that Main sends to the registered Renderer.
 */
export async function createRealRelayFixture(): Promise<RuntimeFixture> {
  const file =
    process.env['PACT_E2E_RELAY_API_KEY_FILE'] ?? resolve(import.meta.dirname, 'env/codex/.env')
  try {
    if (!isAbsolute(file) || file.length > 4096) throw Error(sourceError)
    const identity = await lstat(file)
    if (
      !identity.isFile() ||
      identity.isSymbolicLink() ||
      identity.nlink !== 1 ||
      identity.size < 1 ||
      identity.size > 8192 ||
      (process.platform !== 'win32' && identity.uid !== process.getuid?.())
    )
      throw Error(sourceError)
  } catch {
    // No raw filesystem/parser error or private source data enters test evidence.
    throw Error(sourceError)
  }
  const fixture = await createRuntimeFixture({ mode: 'real', realRelayCredentialStore: true })
  let bootstrap: Promise<{ ok: boolean; phase: string }> | undefined
  let phase = 'launch'
  try {
    const app = await fixture.launch()
    phase = 'bootstrap'
    bootstrap = (async () => {
      const page = await app.firstWindow()
      await page.waitForFunction(
        async () => {
          const bridge: DesktopBridge | undefined = Reflect.get(globalThis, 'pact')
          return (await bridge?.getSchedulingSettings())?.ok === true
        },
        undefined,
        { timeout: 5000, polling: 100 },
      )
      return app.evaluate(async ({ BrowserWindow }, path) => {
        // This entire callback runs in Main. Its only serialized input is a path.
        const fs = process.getBuiltinModule('node:fs')
        const util = process.getBuiltinModule('node:util')
        const crypto = process.getBuiltinModule('node:crypto')
        // oxlint-disable-next-line unicorn/consistent-function-scoping -- Playwright serializes this Main callback; module helpers cannot be captured.
        const isRecord = (value: unknown): value is Record<string, unknown> =>
          value !== null && typeof value === 'object' && !Array.isArray(value)
        let stage = 'read'
        const bytes = Buffer.alloc(8193)
        let descriptor: number | undefined
        try {
          const before = fs.lstatSync(path)
          descriptor = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
          const opened = fs.fstatSync(descriptor)
          if (
            !before.isFile() ||
            before.isSymbolicLink() ||
            before.nlink !== 1 ||
            opened.dev !== before.dev ||
            opened.ino !== before.ino ||
            before.size < 1 ||
            before.size > 8192 ||
            (process.platform !== 'win32' && before.uid !== process.getuid?.())
          )
            return { ok: false, phase: stage }
          const length = fs.readSync(descriptor, bytes, 0, bytes.length, 0)
          const after = fs.fstatSync(descriptor)
          fs.closeSync(descriptor)
          descriptor = undefined
          if (
            length !== before.size ||
            after.size !== before.size ||
            after.mtimeMs !== before.mtimeMs
          )
            return { ok: false, phase: stage }
          stage = 'format'
          const key = util.parseEnv(bytes.subarray(0, length).toString('utf8'))['OPENAI_API_KEY']
          bytes.fill(0)
          if (!key || key.length > 4096 || !/^[!-~]+$/u.test(key))
            return { ok: false, phase: stage }
          stage = 'window'
          const windows = BrowserWindow.getAllWindows()
          if (windows.length !== 1) return { ok: false, phase: stage }
          const contents = windows[0]!.webContents
          const url = new URL(contents.getURL())
          if (url.protocol !== 'app:' || url.host !== 'bundle' || url.pathname !== '/index.html')
            return { ok: false, phase: stage }
          stage = 'state'
          const state: unknown = await contents.executeJavaScript(
            'globalThis.pact.getSchedulingSettings()',
          )
          if (
            !isRecord(state) ||
            state.ok !== true ||
            !isRecord(state.value) ||
            state.value.enabled !== false ||
            !isRecord(state.value.credential) ||
            state.value.credential.configured !== false
          )
            return { ok: false, phase: stage }
          const revision = state.value.credential.revision
          if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0)
            return { ok: false, phase: stage }
          stage = 'save'
          const nonce = crypto.randomUUID()
          const saved: unknown = await contents.executeJavaScript(
            `(() => { try { return globalThis.pact.saveRelayApiKey(${JSON.stringify({
              nonce,
              expectedRevision: revision,
              deadlineAt: Date.now() + 5000,
              key,
            })}).catch(() => ({ ok: false })) } catch { return { ok: false } } })()`,
          )
          if (
            !isRecord(saved) ||
            saved.ok !== true ||
            !isRecord(saved.value) ||
            saved.value.nonce !== nonce ||
            saved.value.operation !== 'save' ||
            saved.value.configured !== true ||
            saved.value.revision !== revision + 1
          )
            return { ok: false, phase: stage }
          stage = 'readback'
          const current: unknown = await contents.executeJavaScript(
            'globalThis.pact.getSchedulingSettings()',
          )
          return {
            ok:
              isRecord(current) &&
              current.ok === true &&
              isRecord(current.value) &&
              current.value.enabled === false &&
              isRecord(current.value.credential) &&
              current.value.credential.configured === true &&
              current.value.credential.revision === revision + 1,
            phase: stage,
          }
        } catch {
          return { ok: false, phase: stage }
        } finally {
          bytes.fill(0)
          if (descriptor !== undefined) fs.closeSync(descriptor)
        }
      }, file)
    })()
    const result = await within(bootstrap, 15_000, 'Real Relay credential bootstrap timed out')
    phase = result.phase
    if (!result.ok) throw Error('Real Relay credential bootstrap failed')
    phase = 'quit'
    await quitPact(app)
    return fixture
  } catch {
    let released = false
    try {
      await fixture.dispose()
      await within(
        bootstrap?.then(
          () => undefined,
          () => undefined,
        ) ?? Promise.resolve(),
        1000,
        'Credential bootstrap did not join its closed app',
      )
      released = true
    } catch {
      // The existing fixture retains its root and recovery facts on uncertain release.
      void bootstrap?.catch(() => undefined)
    }
    throw Error(
      `Real Relay credential bootstrap failed during ${phase}; isolated resources ${
        released ? 'were released' : 'have unconfirmed cleanup'
      }.`,
    )
  }
}
