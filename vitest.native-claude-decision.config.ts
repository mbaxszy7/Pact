import { execFileSync } from 'node:child_process'
import { defineConfig } from 'vitest/config'

import { nativeProfile, nativeProfileSupports } from './scripts/native-profiles.mjs'
import base from './vitest.native.config.js'

const profile = nativeProfile('decision-claude')
if (!nativeProfileSupports(profile))
  throw new Error('The Claude decision native profile requires macOS arm64.')
let version: string
try {
  version = execFileSync(process.env.PACT_NATIVE_CLAUDE_EXECUTABLE ?? 'claude', ['--version'], {
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    timeout: 5_000,
    maxBuffer: 1024,
  }).trim()
} catch {
  throw new Error('The fixed Claude decision executable could not confirm its bounded version.')
}
if (version !== `${profile.claudeVersion} (Claude Code)`)
  throw new Error('The Claude decision native profile requires exactly Claude Code 2.1.272.')

export default defineConfig({
  ...base,
  test: { ...base.test, include: [...profile.files!], exclude: [] },
})
