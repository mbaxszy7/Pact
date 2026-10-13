import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { resolve } from 'node:path'

export default defineConfig({
  main: {
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
})
