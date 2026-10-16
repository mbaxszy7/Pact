import { PactDatabase, DatabaseOpenError } from '../src/pact-database.js'

let database: PactDatabase | undefined
try {
  database = await PactDatabase.open({
    filePath: process.argv[2]!,
    migrationsFolder: process.argv[3]!,
  })
  process.send?.({ state: 'open' })
} catch (error) {
  process.send?.({
    state: 'rejected',
    code: error instanceof DatabaseOpenError ? error.code : 'unexpected',
  })
  process.disconnect?.()
}
process.on('message', (message) => {
  if (message === 'close') {
    database?.close()
    process.disconnect?.()
  }
})
process.once('disconnect', () => {
  database?.close()
})
