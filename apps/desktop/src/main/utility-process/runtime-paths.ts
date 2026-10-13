import { app } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve as resolvePath } from 'node:path'

export interface RuntimePaths {
  databaseFile: string
  migrationsFolder: string
  workspaceStorageRoot: string
  simulateAppearanceWriteFailure?: boolean
}

const TEST_DATABASE_FILE_ENV = 'PACT_TEST_DB_FILE'
const TEST_APPEARANCE_WRITE_FAILURE_ENV = 'PACT_TEST_APPEARANCE_WRITE_FAILURE'
const ISOLATED_ROOT_ENV = 'PACT_E2E_ROOT'

/** Data location only: isolated launches retain the normal IPC, permissions and runtime. */
export function configureIsolatedProfile(): void {
  const root = isolatedRoot()
  if (!root) return
  app.setPath('userData', realpathSync(join(root, 'electron-profile')))
  app.setPath('sessionData', realpathSync(join(root, 'electron-session')))
  app.setPath('temp', realpathSync(join(root, 'tmp')))
}

function isolatedRoot(): string | undefined {
  const supplied = process.env[ISOLATED_ROOT_ENV]
  if (supplied === undefined) return undefined
  if (!supplied || !isAbsolute(supplied)) {
    throw new Error(`${ISOLATED_ROOT_ENV} must name an existing absolute private directory.`)
  }
  return realpathSync(supplied)
}

export function resolveRuntimePaths(): RuntimePaths {
  const repositoryRoot = resolvePath(__dirname, '../../../..')

  const root = isolatedRoot()
  if (root) {
    const databaseFile = join(root, 'pact.sqlite')
    const override = process.env[TEST_DATABASE_FILE_ENV]
    if (override && realpathSync(dirname(override)) !== root) {
      throw new Error('An isolated launch cannot select a database outside its private directory.')
    }
    if (override && basename(override) !== 'pact.sqlite') {
      throw new Error('An isolated launch cannot select a different database file.')
    }
    return {
      databaseFile,
      workspaceStorageRoot: join(root, 'workspace-versions'),
      migrationsFolder: app.isPackaged
        ? join(process.resourcesPath, 'persistence-migrations')
        : join(repositoryRoot, 'packages/persistence/drizzle'),
      ...(process.env.NODE_ENV === 'test' && !app.isPackaged
        ? {
            simulateAppearanceWriteFailure: process.env[TEST_APPEARANCE_WRITE_FAILURE_ENV] === '1',
          }
        : {}),
    }
  }

  if (process.env.NODE_ENV === 'test' && !app.isPackaged) {
    const testDatabaseFile = process.env[TEST_DATABASE_FILE_ENV]
    if (testDatabaseFile && !isAbsolute(testDatabaseFile)) {
      throw new Error(`${TEST_DATABASE_FILE_ENV} must be an absolute path during Electron tests.`)
    }

    return {
      databaseFile: testDatabaseFile ?? ':memory:',
      workspaceStorageRoot: testDatabaseFile
        ? join(dirname(testDatabaseFile), 'workspace-versions')
        : join(app.getPath('temp'), `pact-workspace-memory-${randomUUID()}`),
      migrationsFolder: join(repositoryRoot, 'packages/persistence/drizzle'),
      simulateAppearanceWriteFailure: process.env[TEST_APPEARANCE_WRITE_FAILURE_ENV] === '1',
    }
  }

  if (app.isPackaged) {
    return {
      databaseFile: join(app.getPath('userData'), 'pact.sqlite'),
      workspaceStorageRoot: join(app.getPath('userData'), 'workspace-versions'),
      migrationsFolder: join(process.resourcesPath, 'persistence-migrations'),
    }
  }

  return {
    databaseFile: join(repositoryRoot, '.pact-data/dev/pact.sqlite'),
    workspaceStorageRoot: join(
      app.getPath('userData'),
      'workspace-versions-development',
      createHash('sha256').update(repositoryRoot).digest('hex'),
    ),
    migrationsFolder: join(repositoryRoot, 'packages/persistence/drizzle'),
  }
}
