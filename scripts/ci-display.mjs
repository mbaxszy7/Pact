import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { isScriptEntry } from './script-entry.mjs'

const execute = promisify(execFile)
const minWorkArea = Object.freeze({ width: 1600, height: 1064 })

// Apple ships both bridges with macOS. No downloaded executable, virtual monitor,
// display name, or UI automation permission is needed. Width/height are logical
// points; pixel dimensions alone cannot establish the test's CSS viewport.
export const macDisplaySource = String.raw`
ObjC.import('AppKit');
ObjC.import('CoreGraphics');
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
  if (argv[0] === 'configure' && (before.screen.workAreaWidth < 1600 || before.screen.workAreaHeight < 1064)) {
    const candidates = modes.filter(m => m.facts.width >= 1920 && m.facts.height >= 1200 && m.facts.width <= 4096 && m.facts.height <= 4096);
    candidates.sort((a, b) => (a.facts.width * a.facts.height - b.facts.width * b.facts.height) || (a.facts.pixelWidth * a.facts.pixelHeight - b.facts.pixelWidth * b.facts.pixelHeight) || (a.facts.id - b.facts.id));
    if (candidates.length) {
      selected = candidates[0].facts;
      if (Number($.CGDisplaySetDisplayMode(display, candidates[0].reference, null)) !== 0) throw Error('The native display mode change failed');
    }
  }
  return JSON.stringify({ display: display, before: before, selected: selected, availableModes: modes.map(m => m.facts) });
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
    )
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
  const after = await observe('inspect')
  validateDisplayFacts(after)
  if (after.display !== before.display)
    throw new Error('The primary display identity changed during CI preparation')
  return { operation, before, after, minimumLogicalWorkArea: minWorkArea }
}

if (isScriptEntry(import.meta.url)) {
  try {
    console.log(JSON.stringify(await main()))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
