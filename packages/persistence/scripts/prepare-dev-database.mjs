import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const databaseFile =
  process.env.PACT_DB_FILE ?? resolve(packageRoot, '../../.pact-data/dev/pact.sqlite')

await mkdir(dirname(databaseFile), { recursive: true })
process.stdout.write(`${databaseFile}\n`)
