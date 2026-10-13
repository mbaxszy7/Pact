import { build } from 'electron-vite'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Bundle the actual process seam into one owned temporary fixture; never alter application output. */
export async function nativeWorkerFixture(names: readonly string[]) {
  const directory = await mkdtemp(join(tmpdir(), 'pact-native-workers-test-')),
    desktopRoot = resolve(import.meta.dirname, '../../..'),
    require = createRequire(join(desktopRoot, 'package.json')),
    configFile = join(directory, 'worker.config.mjs')
  try {
    await writeFile(
      configFile,
      `import {externalizeDepsPlugin} from ${JSON.stringify(pathToFileURL(require.resolve('electron-vite')).href)}; export default {main:{plugins:[externalizeDepsPlugin({exclude:['@pact/contracts']})],build:{outDir:${JSON.stringify(join(directory, 'bundle'))},rollupOptions:{input:${JSON.stringify(Object.fromEntries(names.map((name) => [name, join(import.meta.dirname, `${name}.ts`)])))}}}}};`,
    )
    await build({ root: desktopRoot, configFile, ignoreConfigWarning: true, logLevel: 'silent' })
    return {
      paths: Object.fromEntries(
        names.map((name) => [name, join(directory, 'bundle', `${name}.js`)]),
      ),
      dispose: () => rm(directory, { recursive: true, force: true }),
    }
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}
