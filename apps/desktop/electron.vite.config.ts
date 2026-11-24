import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SHA256_RE = /^[a-f0-9]{64}$/u
const MAX_BINARY_BYTES = 4 * 1024 * 1024
const MAX_METADATA_BYTES = 4096

interface EmbeddedAgySqliteFileMeta {
  readonly version: 1
  readonly platform: string
  readonly architecture: string
  readonly sourceSha256: string
  readonly binarySha256: string
  readonly binaryBytes: number
  readonly machoPreSigSha256?: string
}

interface EmbeddedTerminalHelperMeta {
  readonly protocolVersion: 1
  readonly platform: string
  readonly arch: string
  readonly filename: string
  readonly sourceSha256: string
  readonly binarySha256: string
  readonly binaryBytes: number
  readonly machoPreSignatureSha256?: string
}

function readEmbeddedTerminalHelperMeta(requireValid: boolean): EmbeddedTerminalHelperMeta | null {
  const filename =
    process.platform === 'darwin'
      ? `terminal-darwin-${process.arch}`
      : process.platform === 'win32'
        ? `terminal-win32-${process.arch}.exe`
        : null
  if (!filename) return null
  const metaPath = resolve(__dirname, `out/native/${filename}.json`)
  if (!existsSync(metaPath)) {
    if (requireValid) {
      throw new Error(
        `Missing required terminal helper build metadata at ${metaPath}; run "node scripts/build-terminal-helper.mjs" before building.`,
      )
    }
    return null
  }
  const stat = lstatSync(metaPath)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_METADATA_BYTES) {
    throw new Error(`Invalid terminal helper metadata file at ${metaPath}.`)
  }
  const parsed: unknown = JSON.parse(readFileSync(metaPath, 'utf8'))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Malformed terminal helper metadata JSON at ${metaPath}.`)
  }
  const protocolVersion: unknown = Reflect.get(parsed, 'protocolVersion')
  const platform: unknown = Reflect.get(parsed, 'platform')
  const arch: unknown = Reflect.get(parsed, 'arch')
  const metaFilename: unknown = Reflect.get(parsed, 'filename')
  const sourceSha256: unknown = Reflect.get(parsed, 'sourceSha256')
  const binarySha256: unknown = Reflect.get(parsed, 'binarySha256')
  const binaryBytes: unknown = Reflect.get(parsed, 'binaryBytes')
  const machoPreSignatureSha256: unknown = Reflect.get(parsed, 'machoPreSignatureSha256')
  const sourcePath = resolve(
    __dirname,
    process.platform === 'win32' ? 'native/terminal-win32.cpp' : 'native/terminal-darwin.c',
  )
  const expectedSourceSha256 = createHash('sha256').update(readFileSync(sourcePath)).digest('hex')
  if (
    protocolVersion !== 1 ||
    platform !== process.platform ||
    arch !== process.arch ||
    metaFilename !== filename ||
    typeof sourceSha256 !== 'string' ||
    !SHA256_RE.test(sourceSha256) ||
    sourceSha256 !== expectedSourceSha256 ||
    typeof binarySha256 !== 'string' ||
    !SHA256_RE.test(binarySha256) ||
    typeof binaryBytes !== 'number' ||
    !Number.isSafeInteger(binaryBytes) ||
    binaryBytes < 64 ||
    binaryBytes > MAX_BINARY_BYTES ||
    (process.platform === 'darwin'
      ? typeof machoPreSignatureSha256 !== 'string' || !SHA256_RE.test(machoPreSignatureSha256)
      : machoPreSignatureSha256 !== undefined &&
        (typeof machoPreSignatureSha256 !== 'string' || !SHA256_RE.test(machoPreSignatureSha256)))
  ) {
    throw new Error(
      `terminal helper metadata at ${metaPath} failed schema/target/source validation; rebuild native helper before packaging.`,
    )
  }
  return {
    protocolVersion: 1,
    platform: process.platform,
    arch: process.arch,
    filename,
    sourceSha256,
    binarySha256,
    binaryBytes,
    ...(typeof machoPreSignatureSha256 === 'string' ? { machoPreSignatureSha256 } : {}),
  }
}

function readEmbeddedAgySqliteFileMeta(requireValid: boolean): EmbeddedAgySqliteFileMeta | null {
  const filename = `agy-sqlite-file-${process.platform}-${process.arch}.node.json`
  const metaPath = resolve(__dirname, `out/native/${filename}`)
  if (!existsSync(metaPath)) {
    if (requireValid) {
      throw new Error(
        `Missing required agy-sqlite-file build metadata at ${metaPath}; run "node scripts/build-agy-sqlite-file.mjs" before building.`,
      )
    }
    return null
  }
  const stat = lstatSync(metaPath)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_METADATA_BYTES) {
    throw new Error(`Invalid agy-sqlite-file metadata file at ${metaPath}.`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(metaPath, 'utf8'))
  } catch (error) {
    throw new Error(
      `Malformed agy-sqlite-file metadata JSON at ${metaPath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`agy-sqlite-file metadata at ${metaPath} must be a JSON object.`)
  }
  const version: unknown = Reflect.get(parsed, 'version')
  const platform: unknown = Reflect.get(parsed, 'platform')
  const architecture: unknown = Reflect.get(parsed, 'architecture')
  const sourceSha256: unknown = Reflect.get(parsed, 'sourceSha256')
  const binarySha256: unknown = Reflect.get(parsed, 'binarySha256')
  const binaryBytes: unknown = Reflect.get(parsed, 'binaryBytes')
  const machoPreSigSha256: unknown = Reflect.get(parsed, 'machoPreSigSha256')
  const sourcePath = resolve(__dirname, 'native/agy-sqlite-file.c')
  const expectedSourceSha256 = createHash('sha256').update(readFileSync(sourcePath)).digest('hex')
  if (
    version !== 1 ||
    platform !== process.platform ||
    architecture !== process.arch ||
    typeof sourceSha256 !== 'string' ||
    !SHA256_RE.test(sourceSha256) ||
    sourceSha256 !== expectedSourceSha256 ||
    typeof binarySha256 !== 'string' ||
    !SHA256_RE.test(binarySha256) ||
    typeof binaryBytes !== 'number' ||
    !Number.isSafeInteger(binaryBytes) ||
    binaryBytes < 64 ||
    binaryBytes > MAX_BINARY_BYTES ||
    (process.platform === 'darwin'
      ? typeof machoPreSigSha256 !== 'string' || !SHA256_RE.test(machoPreSigSha256)
      : machoPreSigSha256 !== undefined &&
        (typeof machoPreSigSha256 !== 'string' || !SHA256_RE.test(machoPreSigSha256)))
  ) {
    throw new Error(
      `agy-sqlite-file metadata at ${metaPath} failed schema/target/source validation; rebuild native addon before packaging.`,
    )
  }
  return {
    version: 1,
    platform: process.platform,
    architecture: process.arch,
    sourceSha256,
    binarySha256,
    binaryBytes,
    ...(typeof machoPreSigSha256 === 'string' ? { machoPreSigSha256 } : {}),
  }
}

export default defineConfig(({ command }) => ({
  main: {
    define: {
      __PACT_AGY_SQLITE_FILE_META__: JSON.stringify(
        readEmbeddedAgySqliteFileMeta(command === 'build'),
      ),
      __PACT_TERMINAL_HELPER_META__: JSON.stringify(
        readEmbeddedTerminalHelperMeta(command === 'build'),
      ),
    },
    plugins: [
      externalizeDepsPlugin({
        exclude: [
          '@pact/agent-runtime',
          '@pact/contracts',
          '@pact/contracts/diagnostics',
          '@pact/contracts/images',
          '@pact/persistence',
        ],
      }),
    ],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          'diagnostics/log-worker': resolve(__dirname, 'src/diagnostics/log-worker.ts'),
          'utility/index': resolve(__dirname, 'src/utility/index.ts'),
          'utility/workspace-directory-worker': resolve(
            __dirname,
            'src/utility/workspace-changes/workspace-directory-worker.ts',
          ),
          'utility/markdown-projection-worker': resolve(
            __dirname,
            'src/utility/conversation/markdown-projection-worker.ts',
          ),
          'utility/image-codec-worker': resolve(
            __dirname,
            'src/utility/conversation/image-codec-worker.ts',
          ),
          'utility/native-json-parser-worker': resolve(
            __dirname,
            'src/utility/conversation/native-json-parser-worker.ts',
          ),
          'utility/native-fork-worker': resolve(
            __dirname,
            'src/utility/conversation/native-fork-worker.ts',
          ),
          'utility/terminal-worker': resolve(__dirname, 'src/utility/terminal/terminal-worker.ts'),
          'utility/agy-storage-child': resolve(__dirname, 'src/utility/agy-storage-child.ts'),
        },
        output: {
          interop: (id) =>
            id !== null && ['remark-parse', 'remark-gfm', 'remark-rehype'].includes(id)
              ? 'esModule'
              : 'default',
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ['@pact/contracts'] })],
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve(__dirname, 'src/renderer/src'),
      },
    },
    plugins: [tailwindcss(), react()],
  },
}))
