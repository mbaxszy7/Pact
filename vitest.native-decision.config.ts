import { defineConfig } from 'vitest/config'

import {
  decisionNativeFiles,
  nativeProfile,
  nativeProfileSupports,
} from './scripts/native-profiles.mjs'
import base from './vitest.native.config.js'

if (!nativeProfileSupports(nativeProfile('decision-codex')))
  throw new Error('The decision Codex native profile requires macOS arm64.')

export default defineConfig({
  ...base,
  test: { ...base.test, include: [...decisionNativeFiles], exclude: [] },
})
