import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

import { macDisplaySource, main, validateDisplayFacts } from './ci-display.mjs'

const hosted = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted' }
const small = { id: 1, width: 1024, height: 768, pixelWidth: 2048, pixelHeight: 1536 }
const sufficient = { id: 2, width: 1920, height: 1200, pixelWidth: 1920, pixelHeight: 1200 }

function facts(mode = sufficient, workAreaHeight = mode.height - 80) {
  return {
    display: 1,
    before: {
      mode,
      screen: {
        width: mode.width,
        height: mode.height,
        workAreaWidth: mode.width,
        workAreaHeight,
      },
    },
    selected: null,
    availableModes: [small, sufficient],
  }
}

function bridged(
  mode = small,
  modes = [small, sufficient],
  workArea = { width: 1024, height: 684 },
) {
  const calls = []
  const screen = {
    deviceDescription: { objectForKey: () => 1 },
    frame: { size: { width: mode.width, height: mode.height } },
    visibleFrame: { size: workArea },
  }
  const native = {
    CGMainDisplayID: () => 1,
    CGDisplayCopyDisplayMode: () => mode,
    CGDisplayCopyAllDisplayModes: () => modes,
    CGDisplayModeGetWidth: (value) => value.width,
    CGDisplayModeGetHeight: (value) => value.height,
    CGDisplayModeGetPixelWidth: (value) => value.pixelWidth,
    CGDisplayModeGetPixelHeight: (value) => value.pixelHeight,
    CGDisplayModeGetIODisplayModeID: (value) => value.id,
    CFArrayGetCount: (value) => value.length,
    CFArrayGetValueAtIndex: (value, index) => value[index],
    NSScreen: { screens: { js: [screen] } },
    CGDisplaySetDisplayMode: (_display, selected) => {
      calls.push(selected)
      return 0
    },
  }
  const invoke = (operation) =>
    JSON.parse(
      runInNewContext(`${macDisplaySource}\nrun(operation)`, {
        $: native,
        ObjC: { import() {}, bindFunction() {}, unwrap: (value) => value },
        operation: [operation],
      }),
    )
  return { calls, invoke, native }
}

await test('does not admit display changes on a developer or self-hosted machine', async () => {
  let observations = 0
  for (const source of [{}, { ...hosted, RUNNER_ENVIRONMENT: 'self-hosted' }]) {
    // oxlint-disable-next-line no-await-in-loop -- Check distinct authority inputs before admitting any native operation.
    await assert.rejects(
      main(['configure'], source, {
        platform: 'darwin',
        observe: () => observations++,
      }),
      /GitHub-hosted/,
    )
  }
  assert.equal(observations, 0)
})

await test('read-only inspection works without CI authority and does not pretend the screen is sufficient', async () => {
  const calls = []
  const result = await main(
    ['inspect'],
    {},
    {
      platform: 'darwin',
      observe: (operation) => {
        calls.push(operation)
        return facts(small, 684)
      },
    },
  )
  assert.deepEqual(calls, ['inspect'])
  assert.equal(result.observed.before.screen.workAreaHeight, 684)
})

await test('configuration independently observes the native logical work area after the setter', async () => {
  const calls = []
  const result = await main(['configure'], hosted, {
    platform: 'darwin',
    observe: (operation) => {
      calls.push(operation)
      return operation === 'configure' ? facts(small, 684) : facts()
    },
  })
  assert.deepEqual(calls, ['configure', 'inspect'])
  assert.equal(result.after.before.screen.workAreaHeight, 1120)
  assert.deepEqual(result.maximumContentViewport, { width: 1600, height: 1000 })
  assert.deepEqual(result.nativeFrameContentDelta, { width: 0, height: 0 })
  assert.deepEqual(result.minimumLogicalWorkArea, { width: 1600, height: 1000 })
})

await test('a setter return or large physical pixel count cannot replace measured logical capacity', async () => {
  await assert.rejects(
    main(['configure'], hosted, { platform: 'darwin', observe: () => facts(small, 684) }),
    /unchanged UI test viewports/,
  )
  assert.throws(() => validateDisplayFacts(facts(sufficient, 999)), /unchanged UI/)
  assert.doesNotThrow(() => validateDisplayFacts(facts(sufficient, 1000)))
  await assert.rejects(
    main(['configure'], hosted, {
      platform: 'darwin',
      observe: (operation) => ({ ...facts(), display: operation === 'configure' ? 1 : 2 }),
    }),
    /identity changed/,
  )
})

await test('rejects invalid observations and excessive inventories rather than dropping modes', () => {
  for (const candidate of [
    undefined,
    { ...facts(), display: 0 },
    { ...facts(), availableModes: [] },
    { ...facts(), availableModes: Array.from({ length: 513 }, () => ({ ...sufficient })) },
    { ...facts(), before: { ...facts().before, screen: { workAreaWidth: NaN } } },
  ])
    assert.throws(() => validateDisplayFacts(candidate), /invalid or exceeds/)
})

await test('rejects unsupported platforms and unknown operations before invoking native APIs', async () => {
  await assert.rejects(main(['configure'], hosted, { platform: 'win32' }), /macOS/)
  await assert.rejects(main(['configure', '--anything'], hosted), /Use ci-display/)
})

await test('native selection uses a bounded existing logical mode rather than a HiDPI pixel illusion', () => {
  const larger = { id: 3, width: 2560, height: 1440, pixelWidth: 2560, pixelHeight: 1440 }
  const native = bridged(small, [larger, small, sufficient])
  assert.equal(native.invoke('configure').selected.id, sufficient.id)
  assert.deepEqual(native.calls, [sufficient])
  const inspect = bridged()
  assert.equal(inspect.invoke('inspect').selected, null)
  assert.equal(inspect.calls.length, 0)
})

await test('an already sufficient work area is preserved and a missing mode is not invented', () => {
  const ready = bridged(sufficient, [small, sufficient], { width: 1900, height: 1120 })
  assert.equal(ready.invoke('configure').selected, null)
  assert.equal(ready.calls.length, 0)
  const unavailable = bridged(small, [small])
  assert.equal(unavailable.invoke('configure').selected, null)
  assert.equal(unavailable.calls.length, 0)
})

await test('the actual 1920x1080 display with 1050 logical work height needs no oversized mode', () => {
  const mode = { id: 4, width: 1920, height: 1080, pixelWidth: 3840, pixelHeight: 2160 }
  const actual = bridged(mode, [small, mode], { width: 1862, height: 1050 })
  const observed = actual.invoke('configure')
  assert.equal(observed.failure, null)
  assert.equal(observed.selected, null)
  assert.equal(actual.calls.length, 0)
  assert.doesNotThrow(() => validateDisplayFacts(observed))
})

await test('selection admits a genuine 1920x1080 mode and accounts for actual menu/Dock exclusions', () => {
  const mode = { id: 4, width: 1920, height: 1080, pixelWidth: 1920, pixelHeight: 1080 }
  const native = bridged(small, [small, mode], { width: 1024, height: 738 })
  assert.equal(native.invoke('configure').selected.id, mode.id)
  assert.deepEqual(native.calls, [mode])
  const narrow = { id: 5, width: 1600, height: 1200, pixelWidth: 1600, pixelHeight: 1200 }
  const excluded = bridged(small, [narrow, sufficient], { width: 994, height: 738 })
  assert.equal(excluded.invoke('configure').selected.id, sufficient.id)
})

await test('predicted exclusions cannot falsely prove a mode unavailable before fresh measurement', () => {
  const mode = { id: 4, width: 1920, height: 1080, pixelWidth: 1920, pixelHeight: 1080 }
  const native = bridged(small, [small, mode])
  assert.equal(native.invoke('configure').failure, null)
  assert.deepEqual(native.calls, [mode])
})

await test('native API failure and mode overflow are explicit failures with no second setter attempt', () => {
  const failed = bridged()
  let setters = 0
  failed.native.CGDisplaySetDisplayMode = () => {
    setters++
    return 1001
  }
  assert.equal(failed.invoke('configure').failure, 'native-mode-change-failed')
  assert.equal(setters, 1)
  const oversized = bridged(
    small,
    Array.from({ length: 513 }, () => ({ ...sufficient })),
  )
  assert.throws(() => oversized.invoke('configure'), /mode count/)
  assert.equal(oversized.calls.length, 0)
})

await test('failed preparation retains only validated bounded screen metadata', async () => {
  const source = facts(small, 684)
  source.extra = 'synthetic-secret-not-display-evidence'
  await assert.rejects(
    main(['configure'], hosted, { platform: 'darwin', observe: () => source }),
    (error) => {
      assert.equal(error.displayEvidence.before.before.screen.workAreaHeight, 684)
      assert.equal(error.displayEvidence.after.before.screen.workAreaHeight, 684)
      assert.equal(JSON.stringify(error.displayEvidence).includes(source.extra), false)
      return /unchanged UI/.test(error.message)
    },
  )
})
