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
  const stages = []
  let currentMode = mode
  const excludedWidth = mode.width - workArea.width
  const excludedHeight = mode.height - workArea.height
  const screen = {
    deviceDescription: { objectForKey: () => 1 },
    frame: { size: { width: mode.width, height: mode.height } },
    visibleFrame: { size: workArea },
  }
  const native = {
    CGMainDisplayID: () => 1,
    CGDisplayCopyDisplayMode: () => currentMode,
    CGDisplayCopyAllDisplayModes: () => modes,
    CGDisplayModeGetWidth: (value) => value.width,
    CGDisplayModeGetHeight: (value) => value.height,
    CGDisplayModeGetPixelWidth: (value) => value.pixelWidth,
    CGDisplayModeGetPixelHeight: (value) => value.pixelHeight,
    CGDisplayModeGetIODisplayModeID: (value) => value.id,
    CFArrayGetCount: (value) => value.length,
    CFArrayGetValueAtIndex: (value, index) => value[index],
    NSScreen: { screens: { js: [screen] } },
    kCGConfigureForSession: 1,
    CGBeginDisplayConfiguration: (reference) => {
      stages.push('begin')
      reference[0] = { valid: true, selected: null }
      return 0
    },
    CGConfigureDisplayWithDisplayMode: (token, _display, selected) => {
      assert.equal(token.valid, true)
      stages.push('configure')
      calls.push(selected)
      token.selected = selected
      return 0
    },
    CGCompleteDisplayConfiguration: (token, scope) => {
      assert.equal(token.valid, true)
      assert.equal(scope, 1)
      stages.push('complete-session')
      token.valid = false
      currentMode = token.selected
      screen.frame.size = { width: currentMode.width, height: currentMode.height }
      screen.visibleFrame.size = {
        width: currentMode.width - excludedWidth,
        height: currentMode.height - excludedHeight,
      }
      return 0
    },
    CGCancelDisplayConfiguration: (token) => {
      assert.equal(token.valid, true)
      stages.push('cancel')
      token.valid = false
      return 0
    },
  }
  const invoke = (operation) =>
    JSON.parse(
      runInNewContext(`${macDisplaySource}\nrun(operation)`, {
        $: native,
        ObjC: { import() {}, bindFunction() {}, unwrap: (value) => value },
        Ref: () => [],
        operation: [operation],
      }),
    )
  return { calls, stages, invoke, native }
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
  failed.native.CGConfigureDisplayWithDisplayMode = () => {
    setters++
    return 1001
  }
  const evidence = failed.invoke('configure')
  assert.equal(evidence.failure, 'native-mode-configuration-failed')
  assert.equal(evidence.configuration.tokenReleased, true)
  assert.deepEqual(failed.stages, ['begin', 'cancel'])
  assert.equal(setters, 1)
  const oversized = bridged(
    small,
    Array.from({ length: 513 }, () => ({ ...sufficient })),
  )
  assert.throws(() => oversized.invoke('configure'), /mode count/)
  assert.equal(oversized.calls.length, 0)
})

await test('commits once for the login session and observes the genuine in-process mode before exit', () => {
  const native = bridged()
  const observed = native.invoke('configure')
  assert.deepEqual(native.stages, ['begin', 'configure', 'complete-session'])
  assert.equal(native.calls.length, 1)
  assert.equal(observed.configuration.scope, 'login-session')
  assert.equal(observed.configuration.tokenReleased, true)
  assert.deepEqual(observed.modeAfterSetter, sufficient)
})

await test('begin and complete failures do not cancel a nonexistent or consumed configuration token', () => {
  const denied = bridged()
  denied.native.CGBeginDisplayConfiguration = () => 1001
  assert.equal(denied.invoke('configure').failure, 'native-configuration-begin-failed')
  assert.deepEqual(denied.stages, [])
  const rejected = bridged()
  rejected.native.CGCompleteDisplayConfiguration = (token, scope) => {
    assert.equal(scope, 1)
    token.valid = false
    rejected.stages.push('complete-failed')
    return 1002
  }
  const result = rejected.invoke('configure')
  assert.equal(result.failure, 'native-session-commit-failed')
  assert.equal(result.configuration.tokenReleased, true)
  assert.deepEqual(rejected.stages, ['begin', 'configure', 'complete-failed'])
})

await test('an exceptional configure call still releases its one open transaction', () => {
  const native = bridged()
  native.native.CGConfigureDisplayWithDisplayMode = () => {
    throw new Error('synthetic-native-call-exception')
  }
  const result = native.invoke('configure')
  assert.equal(result.failure, 'native-configuration-call-failed')
  assert.equal(result.configuration.tokenReleased, true)
  assert.deepEqual(native.stages, ['begin', 'cancel'])
})

await test('a bridge exception at Complete preserves unconfirmed token state and never double-cancels', () => {
  const native = bridged()
  native.native.CGCompleteDisplayConfiguration = () => {
    throw new Error('synthetic-complete-bridge-exception')
  }
  const result = native.invoke('configure')
  assert.equal(result.failure, 'native-configuration-call-failed')
  assert.equal(result.configuration.tokenReleased, false)
  assert.deepEqual(native.stages, ['begin', 'configure'])
})

await test('failed cancellation preserves its unresolved token as a blocking fact', () => {
  const native = bridged()
  native.native.CGConfigureDisplayWithDisplayMode = () => 1001
  native.native.CGCancelDisplayConfiguration = () => {
    throw new Error('synthetic-cancel-bridge-exception')
  }
  const result = native.invoke('configure')
  assert.equal(result.failure, 'native-configuration-cancel-failed')
  assert.equal(result.configuration.tokenReleased, false)
})

function selectedFacts() {
  return {
    ...facts(small, 684),
    selected: sufficient,
    modeAfterSetter: sufficient,
    configuration: {
      scope: 'login-session',
      beginCode: 0,
      configureCode: 0,
      completeCode: 0,
      cancelCode: null,
      tokenReleased: true,
    },
  }
}

await test('post-exit observations retain restored and settled states without repeating the mutation', async () => {
  let clock = 0
  const calls = []
  const result = await main(['configure'], hosted, {
    platform: 'darwin',
    now: () => clock,
    pause: (ms) => {
      clock += ms
    },
    observe: (operation, options) => {
      calls.push({ operation, clock, timeout: options.timeout })
      if (operation === 'configure') return selectedFacts()
      return clock === 0 ? facts(small, 684) : facts()
    },
  })
  assert.deepEqual(
    calls.map((call) => call.operation),
    ['configure', 'inspect', 'inspect', 'inspect'],
  )
  assert.deepEqual(
    calls.map((call) => call.clock),
    [0, 0, 250, 2000],
  )
  assert.equal(result.samples[0].before.screen.workAreaHeight, 684)
  assert.equal(result.samples[2].before.screen.workAreaHeight, 1120)
  assert.equal(result.after.availableModes, undefined)
  assert(calls.every((call) => call.timeout <= 15_000))
})

await test('a mode that reverts after the helper exits remains a failure with all bounded samples', async () => {
  let clock = 0
  let mutations = 0
  await assert.rejects(
    main(['configure'], hosted, {
      platform: 'darwin',
      now: () => clock,
      pause: (ms) => {
        clock += ms
      },
      observe: (operation) => {
        if (operation === 'configure') {
          mutations++
          return selectedFacts()
        }
        return facts(small, 684)
      },
    }),
    (error) => {
      assert.equal(error.displayEvidence.before.modeAfterSetter.id, sufficient.id)
      assert.deepEqual(
        error.displayEvidence.samples.map((sample) => sample.requestedOffsetMs),
        [0, 250, 2000],
      )
      assert(error.displayEvidence.samples.every((sample) => sample.before.mode.id === small.id))
      return /unchanged UI/.test(error.message)
    },
  )
  assert.equal(mutations, 1)
})

await test('the original combined deadline bounds all read-only observations and creates no late timer', async () => {
  let clock = 0,
    reads = 0,
    timers = 0
  await assert.rejects(
    main(['configure'], hosted, {
      platform: 'darwin',
      now: () => clock,
      pause: () => {
        timers++
      },
      observe: (operation) => {
        if (operation === 'configure') {
          clock = 30_001
          return selectedFacts()
        }
        reads++
        return facts()
      },
    }),
    /deadline expired/,
  )
  assert.equal(reads, 0)
  assert.equal(timers, 0)
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
