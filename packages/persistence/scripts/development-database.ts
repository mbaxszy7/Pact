import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { PactDatabase } from '../src/pact-database.js'

// Tooling uses an isolated repository database unless the operator selects an app database.
const packageRoot = resolve(import.meta.dirname, '..')
const filePath = resolve(
  process.env.PACT_DB_FILE ?? resolve(packageRoot, '../../.pact-data/dev/pact.sqlite'),
)
const command = process.argv[2]
if (command !== 'migrate' && command !== 'studio') throw new Error('Expected migrate or studio')

const database = await PactDatabase.open({
  filePath,
  migrationsFolder: resolve(packageRoot, 'drizzle'),
})
if (command === 'migrate') {
  database.close()
} else {
  // Studio must run in the SAME process as the reservation. A child could outlive its owner.
  process.env.PACT_DB_FILE = filePath
  const require = createRequire(import.meta.url)
  const executable = resolve(dirname(require.resolve('drizzle-kit')), 'bin.cjs')
  process.argv = [
    process.execPath,
    executable,
    'studio',
    '--config=drizzle.config.ts',
    '--host=127.0.0.1',
    '--port=4983',
  ]
  process.once('exit', () => database.close())
  try {
    await import(pathToFileURL(executable).href)
  } catch (error) {
    database.close()
    throw error
  }
}
