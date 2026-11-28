import { defineConfig } from 'vitest/config'

import {
  codexExecutionNativeFiles,
  nativeProfile,
  nativeProfileSupports,
} from './scripts/native-profiles.mjs'
import base from './vitest.native.config.js'

if (!nativeProfileSupports(nativeProfile('execution-codex')))
  throw new Error('The Codex execution and historical-owner profile requires macOS arm64.')

export default defineConfig({
  ...base,
  test: { ...base.test, include: [...codexExecutionNativeFiles], exclude: [] },
})
