import { defineConfig } from 'vitest/config'

import { agyNativeFiles, nativeProfile, nativeProfileSupports } from './scripts/native-profiles.mjs'
import base from './vitest.native.config.js'

if (!nativeProfileSupports(nativeProfile('agy')))
  throw new Error('The Antigravity native protocol profile requires an x64 or arm64 runner.')

export default defineConfig({
  ...base,
  test: { ...base.test, include: [...agyNativeFiles], exclude: [] },
})
