import { expect } from '@playwright/test'
import { open } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { DesktopBridge } from '../../packages/contracts/src/index.js'

import {
  diagnosticRecordSchema,
  type DiagnosticRecord,
} from '../../packages/contracts/src/diagnostics.js'
import { quitPact } from './native-quit.js'
import { createRuntimeFixture, test } from './runtime-fixture.js'

/** UI-only data; Main/Utility, Worker, IPC and log files are the production implementation. */
test(
  'native Debug controls produce named bounded file logs without model work',
  { tag: '@ui' },
  async () => {
    const fixture = await createRuntimeFixture()
    const app = await fixture.launch()
    try {
      const page = await app.firstWindow()
      await expect
        .poll(
          () =>
            page.evaluate(async () => {
              const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
              return (await bridge.getDiagnosticStatus?.())?.state
            }),
          { timeout: 15_000 },
        )
        .toBe('ready')

      const toggle = (enabled: boolean) =>
        app.evaluate(({ Menu }, value) => {
          const item = Menu.getApplicationMenu()
            ?.items.find((entry) => entry.label === 'Diagnostics')
            ?.submenu?.items.find((entry) => entry.label === 'Debug logging (30 minutes)')
          if (!item) throw new Error('Expected the native diagnostic menu')
          if (item.checked !== value)
            item.click(item, undefined, {
              shiftKey: false,
              ctrlKey: false,
              altKey: false,
              metaKey: false,
              triggeredByAccelerator: false,
            })
        }, enabled)
      await toggle(true)
      await expect
        .poll(() =>
          page.evaluate(async () => {
            const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
            return ((await bridge.getDiagnosticStatus?.())?.debugUntil ?? 0) > Date.now()
          }),
        )
        .toBe(true)
      await page.evaluate(async () => {
        const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
        await bridge.getRuntimeHealth()
      })

      const readRecords = async (): Promise<DiagnosticRecord[]> => {
        const handle = await open(
          join(dirname(fixture.databaseFile), 'logs/development/pact-0.jsonl'),
          'r',
        )
        try {
          const size = (await handle.stat()).size
          if (size > 64 * 1024) throw new Error('UI log fixture exceeded 64 KiB')
          const bytes = Buffer.alloc(size)
          const result = await handle.read(bytes, 0, bytes.length, 0)
          const text = bytes.subarray(0, result.bytesRead).toString('utf8')
          const lines = text
            .slice(0, text.lastIndexOf('\n') + 1)
            .split('\n')
            .filter(Boolean)
          if (lines.length > 200) throw new Error('UI log fixture exceeded 200 records')
          return lines.map((line) => diagnosticRecordSchema.parse(JSON.parse(line)))
        } finally {
          await handle.close()
        }
      }
      await expect
        .poll(
          async () =>
            (await readRecords()).filter(
              (record) =>
                record.requestType === 'runtime.health.request' && record.phase === 'completed',
            ).length,
        )
        .toBe(1)
      const records = await readRecords()
      const health = records.filter((record) => record.requestType === 'runtime.health.request')
      expect(health.map((record) => record.phase)).toEqual(['started', 'completed'])
      expect(health[0]?.operationId).toBe(health[1]?.operationId)
      expect(
        records.some((record) => record.operation === 'debug' && record.phase === 'started'),
      ).toBe(true)
      await toggle(false)
      await expect
        .poll(() =>
          page.evaluate(async () => {
            const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
            return (await bridge.getDiagnosticStatus?.())?.debugUntil
          }),
        )
        .toBe(0)
      await page.evaluate(async () => {
        const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
        await bridge.getRuntimeHealth()
      })
      await expect
        .poll(async () =>
          (await readRecords()).some(
            (record) => record.operation === 'debug' && record.phase === 'closed',
          ),
        )
        .toBe(true)
      expect(
        (await readRecords()).filter((record) => record.requestType === 'runtime.health.request'),
      ).toHaveLength(2)
    } finally {
      await quitPact(app)
      await fixture.dispose()
    }
  },
)
