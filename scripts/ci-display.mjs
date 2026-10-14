import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { isScriptEntry } from './script-entry.mjs'

const execute = promisify(execFile)
// Main's hidden title bar uses a full-size content window. Genuine Pact/Electron
// getBounds/getContentBounds observations give a zero native frame/content delta;
// the 48px title overlay is already inside the requested content viewport.
const maxViewport = Object.freeze({ width: 1600, height: 1000 })
const nativeFrameDelta = Object.freeze({ width: 0, height: 0 })
const minWorkArea = Object.freeze({
  width: maxViewport.width + nativeFrameDelta.width,
  height: maxViewport.height + nativeFrameDelta.height,
})

// Apple ships both bridges with macOS. No downloaded executable, virtual monitor,
// display name, or UI automation permission is needed. Width/height are logical
// points; pixel dimensions alone cannot establish the test's CSS viewport.
export const macDisplaySource = String.raw`
ObjC.import('AppKit');
ObjC.import('CoreGraphics');
const minimumLogicalWorkArea = ${JSON.stringify(minWorkArea)};
ObjC.bindFunction('CGDisplayModeGetWidth', ['unsigned long', ['void *']]);
ObjC.bindFunction('CGDisplayModeGetHeight', ['unsigned long', ['void *']]);
ObjC.bindFunction('CGDisplayModeGetPixelWidth', ['unsigned long', ['void *']]);
ObjC.bindFunction('CGDisplayModeGetPixelHeight', ['unsigned long', ['void *']]);
ObjC.bindFunction('CGDisplayModeGetIODisplayModeID', ['unsigned int', ['void *']]);
ObjC.bindFunction('CGDisplaySetDisplayMode', ['int', ['unsigned int', 'void *', 'void *']]);
function modeFacts(mode) {
  return {
    id: Number($.CGDisplayModeGetIODisplayModeID(mode)),
    width: Number($.CGDisplayModeGetWidth(mode)),
    height: Number($.CGDisplayModeGetHeight(mode)),
    pixelWidth: Number($.CGDisplayModeGetPixelWidth(mode)),
    pixelHeight: Number($.CGDisplayModeGetPixelHeight(mode))
  };
}
function screenFacts(display) {
  const screens = $.NSScreen.screens.js;
  if (screens.length < 1 || screens.length > 16) throw Error('Display count is outside the CI bound');
  const screen = screens.find(s => Number(ObjC.unwrap(s.deviceDescription.objectForKey('NSScreenNumber'))) === display);
  if (!screen) throw Error('The primary Cocoa display is missing');
  return {
    width: Number(screen.frame.size.width),
    height: Number(screen.frame.size.height),
    workAreaWidth: Number(screen.visibleFrame.size.width),
    workAreaHeight: Number(screen.visibleFrame.size.height)
  };
}
function run(argv) {
  if (argv.length !== 1 || !['inspect', 'configure'].includes(argv[0])) throw Error('Unknown CI display operation');
  const display = Number($.CGMainDisplayID());
  const current = $.CGDisplayCopyDisplayMode(display);
  if (!current) throw Error('The primary display has no current mode');
  const before = { mode: modeFacts(current), screen: screenFacts(display) };
  const all = $.CGDisplayCopyAllDisplayModes(display, null);
  if (!all) throw Error('Display modes are unavailable');
  const count = Number($.CFArrayGetCount(all));
  if (count < 1 || count > 512) throw Error('Display mode count is outside the CI bound');
  const modes = [];
  for (let index = 0; index < count; index++) {
    const reference = $.CFArrayGetValueAtIndex(all, index);
    modes.push({ reference: reference, facts: modeFacts(reference) });
  }
  let selected = null;
  let failure = null;
  if (argv[0] === 'configure' && (before.screen.workAreaWidth < minimumLogicalWorkArea.width || before.screen.workAreaHeight < minimumLogicalWorkArea.height)) {
    const excludedWidth = Math.max(0, before.screen.width - before.screen.workAreaWidth);
    const excludedHeight = Math.max(0, before.screen.height - before.screen.workAreaHeight);
    const candidates = modes.filter(m => m.facts.width >= minimumLogicalWorkArea.width && m.facts.height >= minimumLogicalWorkArea.height && m.facts.width <= 4096 && m.facts.height <= 4096);
    const predicted = candidates.filter(m => m.facts.width - excludedWidth >= minimumLogicalWorkArea.width && m.facts.height - excludedHeight >= minimumLogicalWorkArea.height);
    // Current menu/Dock exclusions guide selection but are never acceptance
    // evidence. If none predict a fit, try the largest actual eligible mode once;
    // exclusions may change with the mode. Fresh Cocoa workArea is authoritative.
    const choices = predicted.length ? predicted : candidates;
    const direction = predicted.length ? 1 : -1;
    choices.sort((a, b) => direction * (a.facts.width * a.facts.height - b.facts.width * b.facts.height) || (a.facts.pixelWidth * a.facts.pixelHeight - b.facts.pixelWidth * b.facts.pixelHeight) || (a.facts.id - b.facts.id));
    if (choices.length) {
      selected = choices[0].facts;
      if (Number($.CGDisplaySetDisplayMode(display, choices[0].reference, null)) !== 0) failure = 'native-mode-change-failed';
    } else {
      failure = 'no-suitable-mode';
    }
  }
  return JSON.stringify({ display: display, before: before, selected: selected, failure: failure, availableModes: modes.map(m => m.facts) });
}
`

function dimensions(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return fields.every(
    (key) => Number.isSafeInteger(value[key]) && value[key] > 0 && value[key] <= 32768,
  )
}

/** Reject missing/native-invalid observations; a successful setter is not display proof. */
export function validateDisplayFacts(facts, requireWorkArea = true) {
  if (
    !facts ||
    !Number.isSafeInteger(facts.display) ||
    facts.display <= 0 ||
    !Number.isSafeInteger(facts.before?.mode?.id) ||
    facts.before.mode.id < 0 ||
    !dimensions(facts.before?.mode, ['width', 'height', 'pixelWidth', 'pixelHeight']) ||
    !dimensions(facts.before?.screen, ['width', 'height', 'workAreaWidth', 'workAreaHeight']) ||
    !Array.isArray(facts.availableModes) ||
    facts.availableModes.length < 1 ||
    facts.availableModes.length > 512 ||
    facts.availableModes.some(
      (mode) =>
        !Number.isSafeInteger(mode.id) ||
        mode.id < 0 ||
        !dimensions(mode, ['width', 'height', 'pixelWidth', 'pixelHeight']),
    ) ||
    (facts.selected != null &&
      (!Number.isSafeInteger(facts.selected.id) ||
        !dimensions(facts.selected, ['width', 'height', 'pixelWidth', 'pixelHeight']) ||
        !facts.availableModes.some(
          (mode) =>
            mode.id === facts.selected.id &&
            ['width', 'height', 'pixelWidth', 'pixelHeight'].every(
              (field) => mode[field] === facts.selected[field],
            ),
        ))) ||
    (facts.failure != null &&
      !['native-mode-change-failed', 'no-suitable-mode'].includes(facts.failure))
  )
    throw new Error('Native CI display evidence is invalid or exceeds its bound')
  if (
    requireWorkArea &&
    (facts.before.screen.workAreaWidth < minWorkArea.width ||
      facts.before.screen.workAreaHeight < minWorkArea.height)
  )
    throw new Error('The native logical work area cannot contain the unchanged UI test viewports')
  return facts
}

function modeEvidence(value) {
  return {
    id: value.id,
    width: value.width,
    height: value.height,
    pixelWidth: value.pixelWidth,
    pixelHeight: value.pixelHeight,
  }
}

function displayEvidence(facts) {
  return {
    display: facts.display,
    before: {
      mode: modeEvidence(facts.before.mode),
      screen: {
        width: facts.before.screen.width,
        height: facts.before.screen.height,
        workAreaWidth: facts.before.screen.workAreaWidth,
        workAreaHeight: facts.before.screen.workAreaHeight,
      },
    },
    failure: facts.failure ?? null,
    selected: facts.selected ? modeEvidence(facts.selected) : null,
    availableModes: facts.availableModes.map(modeEvidence),
  }
}

async function nativeDisplay(operation) {
  let result
  try {
    result = await execute(
      '/usr/bin/osascript',
      ['-l', 'JavaScript', '-e', macDisplaySource, operation],
      {
        shell: false,
        env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
        timeout: 15_000,
        maxBuffer: 64 * 1024,
        encoding: 'utf8',
      },
    )
  } catch {
    throw new Error('The bounded native CI display operation failed')
  }
  let facts
  try {
    facts = JSON.parse(result.stdout)
  } catch {
    throw new Error('Native CI display evidence is not complete JSON')
  }
  return validateDisplayFacts(facts, false)
}

/** Only a disposable GitHub-hosted macOS runner may change its display. */
export async function main(
  argv = process.argv.slice(2),
  source = process.env,
  { platform = process.platform, observe = nativeDisplay } = {},
) {
  if (argv.length !== 1 || !['inspect', 'configure'].includes(argv[0]))
    throw new Error('Use ci-display.mjs inspect or configure')
  if (platform !== 'darwin') throw new Error('Native CI display preparation requires macOS')
  const operation = argv[0]
  if (
    operation === 'configure' &&
    (source.GITHUB_ACTIONS !== 'true' || source.RUNNER_ENVIRONMENT !== 'github-hosted')
  )
    throw new Error('Display changes require a disposable GitHub-hosted runner')
  const before = await observe(operation)
  validateDisplayFacts(before, false)
  if (operation === 'inspect') return { operation, observed: before }
  // A second process obtains fresh AppKit state after the CoreGraphics change.
  // There is no setter retry or fallback that weakens the requested viewports.
  let after
  try {
    after = await observe('inspect')
    validateDisplayFacts(after, false)
    if (before.failure)
      throw new Error('The native CI display could not select or apply a suitable mode')
    validateDisplayFacts(after)
    if (after.display !== before.display)
      throw new Error('The primary display identity changed during CI preparation')
  } catch (error) {
    // Only validated fixed scalar fields enter failure evidence. Arbitrary native
    // stderr, environment entries and extra fields are never copied to a log.
    error.displayEvidence = { before: displayEvidence(before) }
    try {
      validateDisplayFacts(after, false)
      error.displayEvidence.after = displayEvidence(after)
    } catch {
      // An incomplete second observation is an error, not an invented screen.
    }
    throw error
  }
  return {
    operation,
    before,
    after,
    maximumContentViewport: maxViewport,
    nativeFrameContentDelta: nativeFrameDelta,
    minimumLogicalWorkArea: minWorkArea,
  }
}

if (isScriptEntry(import.meta.url)) {
  try {
    console.log(JSON.stringify(await main()))
  } catch (error) {
    if (error.displayEvidence) console.error(JSON.stringify(error.displayEvidence))
    console.error(error.message)
    process.exitCode = 1
  }
}
