import { defineConfig } from 'vitest/config'

import { nativeProfile, nativeProfileSupports } from './scripts/native-profiles.mjs'
import base from './vitest.native.config.js'

const profile = nativeProfile('windows-owner')
if (!nativeProfileSupports(profile))
  throw new Error('The Windows owner native profile requires a native Windows x64 or arm64 host.')

export default defineConfig({
  ...base,
  test: { ...base.test, include: [...profile.files!], exclude: [] },
})
