import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import type { schema } from './schema/index.js'

export type PactDrizzleDatabase = BetterSQLite3Database<typeof schema>
