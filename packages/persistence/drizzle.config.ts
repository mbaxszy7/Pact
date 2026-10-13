import { defineConfig } from 'drizzle-kit'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = dirname(fileURLToPath(import.meta.url))
const developmentDatabase =
  process.env.PACT_DB_FILE ?? resolve(packageRoot, '../../.pact-data/dev/pact.sqlite')

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/schema/index.ts',
  out: './drizzle',
  dbCredentials: {
    url: developmentDatabase,
  },
  strict: true,
  verbose: true,
})
