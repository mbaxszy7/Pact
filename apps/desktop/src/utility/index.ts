import { randomUUID } from 'node:crypto'
import { realpath, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute } from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'

import {
  utilityEventSchema,
  utilityRequestSchema,
  utilityResponseSchema,
  workspaceStorageRootSchema,
  runtimeStartupFailureSchema,
  runtimeStartupFailureAckSchema,
} from '@pact/contracts'
import { PactDatabase, DatabaseOpenError } from '@pact/persistence'

import { closeDiagnostics, receiveDiagnostic, recordDiagnostic } from '../diagnostics/utility-log'
import { hasLogicalIpcFixtureNonce, LogicalIpcWorkerTraffic } from '../shared/logical-ipc-traffic'
import { AppUpdates } from './app-updates/app-updates'
import { handleAppearanceRequest } from './appearance/handler'
import { Conversation } from './conversation/conversation'
import { ConversationImages } from './conversation/conversation-images'
import { nativeWorkingMemoryDiagnostics } from './conversation/native-working-memory'
import { DefaultSessionSettings } from './default-session-settings/default-session-settings'
import { ProjectCatalog } from './project-catalog/project-catalog'
import { ProjectFileReader } from './project-file/project-file-reader'
import { RuntimePreparation } from './runtime-preparation/runtime-preparation'
import { SessionWorkspace } from './session-workspace/session-workspace'
import { UtilityDirectoryFileClient } from './workspace-changes/directory-file-client'
import { WorkspaceChanges } from './workspace-changes/workspace-changes'

const parentPort = process.parentPort
const databaseFile = process.argv[2]
const migrationsFolder = process.argv[3]
const workspaceStorageRoot = workspaceStorageRootSchema.parse(process.argv[5])
let database: PactDatabase | undefined
let conversation: Conversation | undefined
let workspaceChanges: WorkspaceChanges | undefined
let directoryFiles: UtilityDirectoryFileClient | undefined
let eventLoopProbe: ReturnType<typeof monitorEventLoopDelay> | undefined
let resourceHighWater = 0
let workerTraffic: LogicalIpcWorkerTraffic | undefined

if (!parentPort) throw new Error('Pact utility runtime requires an Electron parent port')
if (
  !databaseFile ||
  !migrationsFolder ||
  !workspaceStorageRoot ||
  !isAbsolute(workspaceStorageRoot)
) {
  throw new Error('Pact utility runtime requires database, migration and private workspace paths')
}
if (
  databaseFile === ':memory:' &&
  !/^pact-workspace-memory-[a-f\d-]{36}$/u.test(basename(workspaceStorageRoot))
)
  throw new Error('Memory-only workspace storage requires an owned temporary directory.')

function performanceSnapshot(
  openedDatabase: PactDatabase,
): import('@pact/contracts').RuntimeHealth['performance'] {
  const probe = eventLoopProbe
  const sqlite = openedDatabase.performanceDiagnostics()
  if (!probe || !sqlite) return undefined
  const resources = process.getActiveResourcesInfo()
  resourceHighWater = Math.max(resourceHighWater, resources.length)
  const activeResources: Record<string, number> = {}
  const resourceCapacityExceeded =
    resources.length > 256 || resources.some((name) => name.length > 64)
  if (!resourceCapacityExceeded)
    for (const name of resources) activeResources[name] = (activeResources[name] ?? 0) + 1
  const eventLoopSamples = probe.count
  const eventLoopLagP95Ms = eventLoopSamples
    ? Math.max(0, probe.percentile(95) / 1_000_000 - 10)
    : 0
  probe.reset()
  return {
    ...sqlite,
    eventLoopLagP95Ms,
    eventLoopSamples,
    activeResources,
    resourceHighWater,
    resourceCapacityExceeded,
    nativeMemory: nativeWorkingMemoryDiagnostics(),
  }
}

async function bootstrap(
  runtimeDatabaseFile: string,
  runtimeMigrationsFolder: string,
  runtimeWorkspaceStorageRoot: string,
): Promise<void> {
  recordDiagnostic({ operation: 'utility', phase: 'started' })
  const measurementRoot = process.env.PACT_E2E_ROOT
  const measurePerformance = Boolean(
    measurementRoot &&
    hasLogicalIpcFixtureNonce(process.env) &&
    runtimeDatabaseFile !== ':memory:' &&
    (await realpath(dirname(runtimeDatabaseFile))) === (await realpath(measurementRoot)),
  )
  const openedDatabase = await PactDatabase.open({
    filePath: runtimeDatabaseFile,
    migrationsFolder: runtimeMigrationsFolder,
    measurePerformance,
  })
  database = openedDatabase
  if (measurePerformance) {
    workerTraffic = new LogicalIpcWorkerTraffic(
      ['utility-markdown', 'utility-image', 'utility-native-json', 'utility-native-fork'],
      randomUUID(),
    )
    eventLoopProbe = monitorEventLoopDelay({ resolution: 10 })
    eventLoopProbe.enable()
  }
  const directoryOwner = new UtilityDirectoryFileClient(parentPort)
  directoryFiles = directoryOwner

  workspaceChanges = new WorkspaceChanges(
    openedDatabase.workspaceChangesRepository,
    openedDatabase.sessionRepository,
    openedDatabase.projectCatalogRepository,
    runtimeWorkspaceStorageRoot,
    (input, signal) => directoryOwner.run(input, signal),
    runtimeDatabaseFile === ':memory:' ? undefined : await realpath(runtimeDatabaseFile),
  )
  const workspaceOwner = workspaceChanges
  for (const summary of await workspaceOwner.initialize()) {
    openedDatabase.conversationRepository.recordWorkspaceChanges(summary)
  }

  const runtimePreparation = new RuntimePreparation(openedDatabase.runtimePreparationRepository)
  const defaultSessionSettings = new DefaultSessionSettings(
    runtimePreparation,
    openedDatabase.defaultSessionSettingsRepository,
  )
  const projectCatalog = new ProjectCatalog(openedDatabase.projectCatalogRepository)
  const projectFileReader = new ProjectFileReader(
    openedDatabase.sessionRepository,
    openedDatabase.projectCatalogRepository,
  )
  const sessionWorkspace = new SessionWorkspace(
    openedDatabase.projectCatalogRepository,
    openedDatabase.sessionRepository,
    defaultSessionSettings,
    (sessionId) => conversation?.sessionTitleChanged(sessionId),
    () => conversation?.nativeMetadataChanged(),
  )
  const images = new ConversationImages(
    openedDatabase.conversationRepository,
    runtimeWorkspaceStorageRoot,
    workerTraffic,
  )
  await images.initialize()
  conversation = new Conversation(
    openedDatabase.conversationRepository,
    openedDatabase.sessionRepository,
    openedDatabase.projectCatalogRepository,
    runtimePreparation,
    projectFileReader,
    runtimeDatabaseFile === ':memory:' ? undefined : workspaceOwner,
    images,
    workerTraffic,
  )
  conversation.subscribe((patch, progress) => {
    parentPort.postMessage(
      utilityEventSchema.parse({ type: 'conversation.patch.event', patch, progress }),
    )
  })
  conversation.subscribeNativePresence((version) => {
    parentPort.postMessage(
      utilityEventSchema.parse({ type: 'native-presence.changed.event', version }),
    )
  })
  void conversation.initializeNativePresence().catch(() => {
    recordDiagnostic({ operation: 'utility', phase: 'failed' })
  })
  const shouldFailAppearanceWrites = process.argv[4] === '1'
  const appUpdates = new AppUpdates(openedDatabase.appUpdatesRepository)
  const conversationOwner = conversation
  let closing = false
  let activeRequests = 0
  let resolveIdle: (() => void) | undefined
  let shutdown: Promise<void> | undefined
  // No second request queue: count the async handlers already owned here. Quit
  // has one idle waiter; Main's shutdown deadline bounds its lifetime.
  const runRequest = (work: () => Promise<void>): void => {
    activeRequests += 1
    void work().finally(() => {
      activeRequests -= 1
      if (activeRequests === 0) {
        resolveIdle?.()
        resolveIdle = undefined
      }
    })
  }

  parentPort.on('message', (event) => {
    if (receiveDiagnostic(event.data)) return
    const request = utilityRequestSchema.safeParse(event.data)
    if (!request.success) return
    if (closing && request.data.type !== 'runtime.shutdown.request') return

    switch (request.data.type) {
      case 'updates.check.request': {
        const requestId = request.data.requestId
        runRequest(async () => {
          const result = await appUpdates.check()
          parentPort.postMessage(
            utilityResponseSchema.parse({ type: 'updates.state.response', requestId, result }),
          )
        })
        return
      }
      case 'updates.get.request':
      case 'updates.preferences.request':
      case 'updates.notice.request': {
        const input = request.data
        try {
          const repository = openedDatabase.appUpdatesRepository
          if (input.type === 'updates.notice.request') {
            const current = repository.read()
            const claimed =
              current.latest?.version === input.input.version &&
              conversationOwner.canPresentUpdateNotice() &&
              repository.claimNotice(input.input.version)
            parentPort.postMessage(
              utilityResponseSchema.parse({
                type: 'updates.notice.response',
                requestId: input.requestId,
                result: { ok: true, value: { claimed } },
              }),
            )
          } else {
            const result =
              input.type === 'updates.preferences.request' && !repository.update(input.input)
                ? {
                    ok: false,
                    error: { code: 'CONFLICT', message: 'Settings changed. Try again.' },
                  }
                : { ok: true, value: repository.read() }
            parentPort.postMessage(
              utilityResponseSchema.parse({
                type: 'updates.state.response',
                requestId: input.requestId,
                result,
              }),
            )
          }
        } catch {
          parentPort.postMessage(
            utilityResponseSchema.parse({
              type:
                input.type === 'updates.notice.request'
                  ? 'updates.notice.response'
                  : 'updates.state.response',
              requestId: input.requestId,
              result: {
                ok: false,
                error: { code: 'INTERNAL', message: 'Update settings are unavailable. Try again.' },
              },
            }),
          )
        }
        return
      }
      case 'native-presence.read.request': {
        parentPort.postMessage(
          utilityResponseSchema.parse({
            type: 'native-presence.read.response',
            requestId: request.data.requestId,
            result: conversationOwner.getNativePresence(),
          }),
        )
        return
      }
      case 'native-attention.read.request': {
        parentPort.postMessage(
          utilityResponseSchema.parse({
            type: 'native-attention.read.response',
            requestId: request.data.requestId,
            result: conversationOwner.readNativeAttention(request.data.input),
          }),
        )
        return
      }
      case 'native-session.resolve.request': {
        parentPort.postMessage(
          utilityResponseSchema.parse({
            type: 'native-session.resolve.response',
            requestId: request.data.requestId,
            result: sessionWorkspace.resolveNativeSession(request.data.input.sessionId),
          }),
        )
        return
      }
      case 'native-session.opened.request': {
        const result = sessionWorkspace.recordNativeSessionOpened(request.data.input)
        parentPort.postMessage(
          utilityResponseSchema.parse({
            type: 'native-session.opened.response',
            requestId: request.data.requestId,
            result,
          }),
        )
        return
      }
      case 'native-jump-list.suppression.request': {
        const result = sessionWorkspace.updateNativeJumpListSuppression(request.data.input)
        parentPort.postMessage(
          utilityResponseSchema.parse({
            type: 'native-jump-list.suppression.response',
            requestId: request.data.requestId,
            result,
          }),
        )
        return
      }
      case 'native-quit.prepare.request': {
        parentPort.postMessage(
          utilityResponseSchema.parse({
            type: 'native-quit.prepare.response',
            requestId: request.data.requestId,
            result: conversationOwner.prepareNativeQuit(request.data.input, activeRequests > 0),
          }),
        )
        return
      }
      case 'native-quit.cancel.request': {
        parentPort.postMessage(
          utilityResponseSchema.parse({
            type: 'native-quit.cancel.response',
            requestId: request.data.requestId,
            result: conversationOwner.cancelNativeQuit(request.data.input),
          }),
        )
        return
      }
      case 'workspace-archive.prepare.request': {
        const { input, requestId } = request.data
        parentPort.postMessage(
          utilityResponseSchema.parse({
            type: 'workspace-archive.prepare.response',
            requestId,
            result: conversationOwner.prepareWorkspaceArchive(input),
          }),
        )
        return
      }
      case 'workspace-archive.read.request':
      case 'workspace-archive.cancel.request': {
        const { input, requestId, type } = request.data
        parentPort.postMessage(
          utilityResponseSchema.parse({
            type: 'workspace-archive.receipt.response',
            requestId,
            result:
              type === 'workspace-archive.read.request'
                ? conversationOwner.readWorkspaceArchive(input.operationId)
                : conversationOwner.cancelWorkspaceArchive(input.operationId),
          }),
        )
        return
      }
      case 'session.fork.request': {
        const { input, requestId } = request.data
        runRequest(async () => {
          const result = closing
            ? {
                ok: false as const,
                error: { code: 'RUNTIME_UNAVAILABLE' as const, message: 'Pact is shutting down.' },
              }
            : await conversationOwner.forkSession(input)
          parentPort.postMessage(
            utilityResponseSchema.parse({ type: 'session.fork.response', requestId, result }),
          )
        })
        return
      }
      case 'conversation.interests.request': {
        parentPort.postMessage(
          utilityResponseSchema.parse({
            type: 'conversation.interests.response',
            requestId: request.data.requestId,
            result: conversationOwner.setInterests(request.data.input.sessionIds),
          }),
        )
        return
      }
      case 'runtime.shutdown.request': {
        const requestId = request.data.requestId
        shutdown ??= (async () => {
          closing = true
          await appUpdates.dispose()
          projectCatalog.dispose()
          const drainRequests =
            activeRequests === 0
              ? Promise.resolve()
              : new Promise<void>((resolve) => {
                  resolveIdle = resolve
                })
          // Await every request before closing its database, even if one owner's
          // cleanup fails. A failed owner never produces a successful flush ACK.
          const results = await Promise.allSettled([
            conversationOwner.dispose(),
            defaultSessionSettings.dispose(),
            drainRequests,
          ])
          try {
            await workspaceOwner.dispose()
            if (results.some((result) => result.status === 'rejected'))
              throw new Error('Conversation cleanup did not finish successfully.')
            parentPort.postMessage(
              utilityEventSchema.parse({
                type: 'native-presence.quit-recent.event',
                version: conversationOwner.nativePresenceVersion(),
                sessions: sessionWorkspace.readQuitRecent(),
              }),
            )
          } finally {
            directoryOwner.dispose()
            openedDatabase.close()
            database = undefined
            if (runtimeDatabaseFile === ':memory:')
              await rm(runtimeWorkspaceStorageRoot, { recursive: true, force: true })
          }
        })()
        void shutdown.then(
          () => {
            closeDiagnostics()
            parentPort.postMessage(
              utilityResponseSchema.parse({
                type: 'runtime.shutdown.response',
                requestId,
                result: { ok: true, value: { flushed: true } },
              }),
            )
            return undefined
          },
          () => {
            parentPort.postMessage(
              utilityResponseSchema.parse({
                type: 'runtime.shutdown.response',
                requestId,
                result: {
                  ok: false,
                  error: { code: 'INTERNAL', message: 'Pact could not finish its shutdown flush.' },
                },
              }),
            )
          },
        )
        return
      }
      case 'runtime.health.request':
        parentPort.postMessage(
          utilityResponseSchema.parse({
            type: 'runtime.health.response',
            requestId: request.data.requestId,
            health: {
              status: 'ready',
              database: 'ready',
              pid: process.pid,
              checkedAt: new Date().toISOString(),
              ...(eventLoopProbe ? { performance: performanceSnapshot(openedDatabase) } : {}),
              ...(workerTraffic
                ? {
                    ipcTraffic: {
                      schemaVersion: 1 as const,
                      unit: 'json-utf8-regexp-source-flags-null-binary-skeleton-plus-visible-binary-bytes-v1' as const,
                      complete: false,
                      owners: workerTraffic.snapshots(),
                      uncovered: [
                        'renderer-main-bridge',
                        'main-utility-diagnostic-control',
                        'main-directory-worker',
                        'main-diagnostic-log-worker',
                        'renderer-monaco-workers',
                      ] as const,
                    },
                  }
                : {}),
              conversation: {
                ...conversationOwner.diagnostics(),
                completeReads: openedDatabase.conversationRepository.diagnostics().completeReads,
              },
            },
          }),
        )
        return

      case 'runtime-preparation.get.request':
        runRequest(async () => {
          const result = await runtimePreparation.inspectReadiness()
          parentPort.postMessage(
            utilityResponseSchema.parse({
              type: 'runtime-preparation.response',
              requestId: request.data.requestId,
              result,
            }),
          )
        })
        return

      case 'runtime-preparation.path.update.request': {
        const { input, requestId } = request.data
        runRequest(async () => {
          const result = await runtimePreparation.selectExecutable(input)
          parentPort.postMessage(
            utilityResponseSchema.parse({
              type: 'runtime-preparation.response',
              requestId,
              result,
            }),
          )
        })
        return
      }

      case 'default-session-settings.get.request': {
        const { requestId } = request.data
        runRequest(async () => {
          const result = await defaultSessionSettings.loadEditorState()
          parentPort.postMessage(
            utilityResponseSchema.parse({
              type: 'default-session-settings.get.response',
              requestId,
              result,
            }),
          )
        })
        return
      }

      case 'default-session-settings.save.request': {
        const { input, requestId } = request.data
        runRequest(async () => {
          const result = await defaultSessionSettings.saveDefaults(input)
          parentPort.postMessage(
            utilityResponseSchema.parse({
              type: 'default-session-settings.save.response',
              requestId,
              result,
            }),
          )
        })
        return
      }

      case 'project-catalog.get.request': {
        const { requestId } = request.data
        parentPort.postMessage(
          utilityResponseSchema.parse({
            type: 'project-catalog.response',
            requestId,
            result: projectCatalog.load(),
          }),
        )
        return
      }

      case 'project-context.read.request': {
        const { input, requestId } = request.data
        runRequest(async () => {
          parentPort.postMessage(
            utilityResponseSchema.parse({
              type: 'project-context.read.response',
              requestId,
              result: await projectCatalog.readContext(input),
            }),
          )
        })
        return
      }

      case 'project-catalog.add.request': {
        const { input, requestId } = request.data
        runRequest(async () => {
          const result = await projectCatalog.add(input)
          conversationOwner.nativeMetadataChanged()
          parentPort.postMessage(
            utilityResponseSchema.parse({
              type: 'project-catalog.response',
              requestId,
              result,
            }),
          )
        })
        return
      }

      case 'project-catalog.archive.request': {
        const { input, requestId } = request.data
        runRequest(async () => {
          parentPort.postMessage(
            utilityResponseSchema.parse({
              type: 'project-catalog.response',
              requestId,
              result: await conversationOwner.archiveWorkspace(
                { kind: 'project', projectId: input.projectId },
                input.operationId,
                (operationId) => projectCatalog.archive({ ...input, operationId }),
                () => projectCatalog.load(),
              ),
            }),
          )
          conversationOwner.nativeMetadataChanged()
        })
        return
      }

      case 'project-catalog.rename.request': {
        const { input, requestId } = request.data
        parentPort.postMessage(
          utilityResponseSchema.parse({
            type: 'project-catalog.rename.response',
            requestId,
            result: projectCatalog.rename(input),
          }),
        )
        conversationOwner.nativeMetadataChanged()
        return
      }

      case 'project-catalog.restore.request': {
        const { input, requestId } = request.data
        parentPort.postMessage(
          utilityResponseSchema.parse({
            type: 'project-catalog.response',
            requestId,
            result: projectCatalog.restore(input),
          }),
        )
        conversationOwner.nativeMetadataChanged()
        return
      }

      case 'session-catalog.get.request': {
        const { input, requestId } = request.data
        parentPort.postMessage(
          utilityResponseSchema.parse({
            type: 'session-catalog.response',
            requestId,
            result: sessionWorkspace.load(input),
          }),
        )
        return
      }

      case 'session-creation.prepare.request': {
        const { input, requestId } = request.data
        runRequest(async () => {
          parentPort.postMessage(
            utilityResponseSchema.parse({
              type: 'session-creation.prepare.response',
              requestId,
              result: await sessionWorkspace.prepareCreation(input.projectId),
            }),
          )
        })
        return
      }

      case 'session.create.request': {
        const { input, requestId } = request.data
        runRequest(async () => {
          parentPort.postMessage(
            utilityResponseSchema.parse({
              type: 'session-catalog.response',
              requestId,
              result: await sessionWorkspace.create(input),
            }),
          )
        })
        return
      }

      case 'session.rename.request': {
        const { input, requestId } = request.data
        parentPort.postMessage(
          utilityResponseSchema.parse({
            type: 'session-catalog.response',
            requestId,
            result: sessionWorkspace.rename(input),
          }),
        )
        return
      }

      case 'session.mark-read.request': {
        const { input, requestId } = request.data
        parentPort.postMessage(
          utilityResponseSchema.parse({
            type: 'session-catalog.response',
            requestId,
            result: sessionWorkspace.markRead(input),
          }),
        )
        return
      }

      case 'session.archive.request': {
        const { input, requestId } = request.data
        runRequest(async () => {
          parentPort.postMessage(
            utilityResponseSchema.parse({
              type: 'session-catalog.response',
              requestId,
              result: await conversationOwner.archiveWorkspace(
                { kind: 'session', sessionId: input.sessionId },
                input.operationId,
                (operationId) => sessionWorkspace.archive({ ...input, operationId }),
                () => sessionWorkspace.archiveReceipt(input.sessionId),
              ),
            }),
          )
        })
        return
      }

      case 'session.restore.request': {
        const { input, requestId } = request.data
        parentPort.postMessage(
          utilityResponseSchema.parse({
            type: 'session-catalog.response',
            requestId,
            result: sessionWorkspace.restore(input),
          }),
        )
        return
      }

      case 'session-settings.get.request': {
        const { input, requestId } = request.data
        runRequest(async () => {
          parentPort.postMessage(
            utilityResponseSchema.parse({
              type: 'session-settings.response',
              requestId,
              result: await sessionWorkspace.loadSettings(input),
            }),
          )
        })
        return
      }

      case 'session-settings.save.request': {
        const { input, requestId } = request.data
        runRequest(async () => {
          parentPort.postMessage(
            utilityResponseSchema.parse({
              type: 'session-settings.save.response',
              requestId,
              result: await sessionWorkspace.saveSettings(input),
            }),
          )
        })
        return
      }

      case 'session-permission.save.request': {
        const { input, requestId } = request.data
        parentPort.postMessage(
          utilityResponseSchema.parse({
            type: 'session-catalog.response',
            requestId,
            result: sessionWorkspace.savePermission(input),
          }),
        )
        return
      }

      case 'session-speed.save.request': {
        const { input, requestId } = request.data
        parentPort.postMessage(
          utilityResponseSchema.parse({
            type: 'session-catalog.response',
            requestId,
            result: sessionWorkspace.saveSpeed(input),
          }),
        )
        return
      }

      case 'skills.cancel.request': {
        const { input, requestId } = request.data
        conversation?.cancelSkillCatalog(input.sessionId)
        parentPort.postMessage(
          utilityResponseSchema.parse({
            type: 'conversation.interests.response',
            requestId,
            result: { ok: true, value: { ready: true } },
          }),
        )
        return
      }
      case 'skills.read.request': {
        const { input, requestId } = request.data
        runRequest(async () => {
          const result = conversation
            ? await conversation.readSkillCatalog(input)
            : {
                ok: false as const,
                error: {
                  code: 'RUNTIME_UNAVAILABLE' as const,
                  message: 'Conversation runtime is unavailable.',
                },
              }
          parentPort.postMessage(
            utilityResponseSchema.parse({ type: 'skills.page.response', requestId, result }),
          )
        })
        return
      }
      case 'skill-document.cancel.request': {
        conversation?.cancelSkillDocument(request.data.input.requestId)
        parentPort.postMessage(
          utilityResponseSchema.parse({
            type: 'skill-document.cancel.response',
            requestId: request.data.requestId,
            result: { ok: true, value: { ready: true } },
          }),
        )
        return
      }
      case 'skill-document.read.request': {
        const { input, requestId } = request.data
        runRequest(async () => {
          const result = conversation
            ? await conversation.readSkillDocument(input)
            : {
                ok: false as const,
                error: {
                  code: 'RUNTIME_UNAVAILABLE' as const,
                  message: 'Conversation runtime is unavailable.',
                },
              }
          parentPort.postMessage(
            utilityResponseSchema.parse({
              type: 'skill-document.read.response',
              requestId,
              result,
            }),
          )
        })
        return
      }

      case 'conversation.get.request': {
        const { input, requestId } = request.data
        runRequest(async () => {
          // A malformed saved page fails this read without terminating other owned work.
          const response = utilityResponseSchema.safeParse({
            type: 'conversation.page.response',
            requestId,
            result: (await conversation?.load(input)) ?? {
              ok: false,
              error: {
                code: 'RUNTIME_UNAVAILABLE',
                message: 'Conversation runtime is unavailable.',
              },
            },
          })
          parentPort.postMessage(
            response.success
              ? response.data
              : utilityResponseSchema.parse({
                  type: 'conversation.page.response',
                  requestId,
                  result: {
                    ok: false,
                    error: {
                      code: 'INTERNAL',
                      message: 'Saved conversation history could not be read.',
                    },
                  },
                }),
          )
        })
        return
      }

      case 'conversation.image.write.request': {
        const { input, ownerKey, requestId } = request.data
        runRequest(async () => {
          const result = await conversationOwner.writeImage(input, ownerKey)
          parentPort.postMessage(
            utilityResponseSchema.parse({
              type: 'conversation.image.write.response',
              requestId,
              result,
            }),
          )
        })
        return
      }
      case 'conversation.image.choose.request': {
        const { sessionId, paths, ownerKey, requestId } = request.data
        runRequest(async () => {
          const result = await conversationOwner.chooseImages(sessionId, paths, ownerKey)
          parentPort.postMessage(
            utilityResponseSchema.parse({
              type: 'conversation.image.choose.response',
              requestId,
              result,
            }),
          )
        })
        return
      }
      case 'conversation.image.read.request': {
        const { input, ownerKey, requestId } = request.data
        runRequest(async () => {
          const result = await conversationOwner.readImage(input, ownerKey)
          parentPort.postMessage(
            utilityResponseSchema.parse({
              type: 'conversation.image.read.response',
              requestId,
              result,
            }),
          )
        })
        return
      }

      case 'conversation.input.request': {
        const { input, ownerKey, requestId } = request.data
        parentPort.postMessage(
          utilityResponseSchema.parse({
            type: 'conversation.input.response',
            requestId,
            result: conversation?.writeInput(input, ownerKey) ?? {
              ok: false,
              error: {
                code: 'RUNTIME_UNAVAILABLE',
                message: 'Conversation runtime is unavailable.',
              },
            },
          }),
        )
        return
      }
      case 'conversation.input.release-owner.request': {
        const { ownerKey, requestId } = request.data
        conversation?.releaseInputOwner(ownerKey)
        parentPort.postMessage(
          utilityResponseSchema.parse({
            type: 'conversation.input.release-owner.response',
            requestId,
            result: { ok: true, value: { ready: true } },
          }),
        )
        return
      }

      case 'conversation.send.request': {
        const { input, requestId, ownerKey } = request.data
        runRequest(async () => {
          const result = conversation
            ? await conversation.send(input, ownerKey)
            : {
                ok: false as const,
                error: {
                  code: 'RUNTIME_UNAVAILABLE' as const,
                  message: 'Conversation runtime is unavailable.',
                },
              }
          parentPort.postMessage(
            utilityResponseSchema.parse({ type: 'conversation.patch.response', requestId, result }),
          )
        })
        return
      }

      case 'conversation.queue.steer.request':
      case 'conversation.queue.return.request':
      case 'conversation.queue.remove.request':
      case 'conversation.queue.resume.request':
      case 'conversation.queue.enabled.request': {
        const operation = request.data
        runRequest(async () => {
          let result
          if (!conversation)
            result = {
              ok: false as const,
              error: {
                code: 'RUNTIME_UNAVAILABLE' as const,
                message: 'Conversation runtime is unavailable.',
              },
            }
          else
            switch (operation.type) {
              case 'conversation.queue.steer.request':
                result = await conversation.steerQueuedConversationMessage(operation.input)
                break
              case 'conversation.queue.return.request':
                result = conversation.returnQueuedConversationMessage(operation.input)
                break
              case 'conversation.queue.remove.request':
                result = conversation.removeQueuedConversationMessage(operation.input)
                break
              case 'conversation.queue.resume.request':
                result = conversation.resumeConversationQueue(operation.input)
                break
              case 'conversation.queue.enabled.request':
                result = conversation.setConversationQueueEnabled(operation.input)
                break
            }
          parentPort.postMessage(
            utilityResponseSchema.parse({
              type: 'conversation.patch.response',
              requestId: operation.requestId,
              result,
            }),
          )
        })
        return
      }

      case 'conversation.stop.request': {
        const { input, requestId } = request.data
        runRequest(async () => {
          const result = conversation
            ? conversation.stop(input)
            : {
                ok: false as const,
                error: {
                  code: 'RUNTIME_UNAVAILABLE' as const,
                  message: 'Conversation runtime is unavailable.',
                },
              }
          parentPort.postMessage(
            utilityResponseSchema.parse({ type: 'conversation.patch.response', requestId, result }),
          )
        })
        return
      }

      case 'collaboration.action.request': {
        const { input, requestId } = request.data
        runRequest(async () => {
          const result = conversation
            ? await conversation.actOnCollaboration(input)
            : {
                ok: false as const,
                error: {
                  code: 'RUNTIME_UNAVAILABLE' as const,
                  message: 'Conversation runtime is unavailable.',
                },
              }
          parentPort.postMessage(
            utilityResponseSchema.parse({ type: 'conversation.patch.response', requestId, result }),
          )
        })
        return
      }
      case 'peer-proposal.accept.request': {
        const { input, requestId } = request.data
        runRequest(async () => {
          const result = conversation
            ? await conversation.acceptPeerProposal(input)
            : {
                ok: false as const,
                error: {
                  code: 'RUNTIME_UNAVAILABLE' as const,
                  message: 'Conversation runtime is unavailable.',
                },
              }
          parentPort.postMessage(
            utilityResponseSchema.parse({ type: 'conversation.patch.response', requestId, result }),
          )
        })
        return
      }

      case 'peer-proposal.dismiss.request': {
        const { input, requestId } = request.data
        runRequest(async () => {
          const result = conversation
            ? conversation.dismissPeerProposal(input)
            : {
                ok: false as const,
                error: {
                  code: 'RUNTIME_UNAVAILABLE' as const,
                  message: 'Conversation runtime is unavailable.',
                },
              }
          parentPort.postMessage(
            utilityResponseSchema.parse({ type: 'conversation.patch.response', requestId, result }),
          )
        })
        return
      }

      case 'native-input.read.request': {
        const { input, requestId } = request.data
        const result = conversation?.readNativeInput(input) ?? {
          ok: false,
          error: { code: 'RUNTIME_UNAVAILABLE', message: 'Conversation runtime is unavailable.' },
        }
        parentPort.postMessage(
          utilityResponseSchema.parse({ type: 'native-input.read.response', requestId, result }),
        )
        return
      }
      case 'native-input.respond.request':
      case 'native-input.opened.request': {
        const { input, requestId } = request.data
        const result =
          request.data.type === 'native-input.respond.request'
            ? conversation?.respondNativeInput(request.data.input)
            : conversation?.confirmNativeInputURL(input)
        parentPort.postMessage(
          utilityResponseSchema.parse({
            type: 'conversation.patch.response',
            requestId,
            result: result ?? {
              ok: false,
              error: {
                code: 'RUNTIME_UNAVAILABLE',
                message: 'Conversation runtime is unavailable.',
              },
            },
          }),
        )
        return
      }

      case 'native-permission.respond.request': {
        const { input, requestId } = request.data
        const result = conversation?.respondNativePermission(input) ?? {
          ok: false as const,
          error: {
            code: 'RUNTIME_UNAVAILABLE' as const,
            message: 'Conversation runtime is unavailable.',
          },
        }
        parentPort.postMessage(
          utilityResponseSchema.parse({ type: 'conversation.patch.response', requestId, result }),
        )
        return
      }

      case 'conversation.retry.request': {
        const { input, requestId } = request.data
        runRequest(async () => {
          const result = conversation
            ? await conversation.retry(input)
            : {
                ok: false as const,
                error: {
                  code: 'RUNTIME_UNAVAILABLE' as const,
                  message: 'Conversation runtime is unavailable.',
                },
              }
          parentPort.postMessage(
            utilityResponseSchema.parse({ type: 'conversation.patch.response', requestId, result }),
          )
        })
        return
      }

      case 'native-context.rebuild.request': {
        const { input, requestId } = request.data
        runRequest(async () => {
          const result = conversation
            ? await conversation.rebuildNativeContext(input)
            : {
                ok: false as const,
                error: {
                  code: 'RUNTIME_UNAVAILABLE' as const,
                  message: 'Conversation runtime is unavailable.',
                },
              }
          parentPort.postMessage(
            utilityResponseSchema.parse({ type: 'conversation.patch.response', requestId, result }),
          )
        })
        return
      }

      case 'comment-draft.save.request': {
        const { input, requestId } = request.data
        runRequest(async () => {
          const result = conversation
            ? await conversation.saveCommentDraft(input)
            : {
                ok: false as const,
                error: {
                  code: 'RUNTIME_UNAVAILABLE' as const,
                  message: 'Conversation runtime is unavailable.',
                },
              }
          parentPort.postMessage(
            utilityResponseSchema.parse({ type: 'conversation.patch.response', requestId, result }),
          )
        })
        return
      }

      case 'comment-draft.remove.request': {
        const { input, requestId } = request.data
        const result = conversation
          ? conversation.removeCommentDraft(input)
          : {
              ok: false as const,
              error: {
                code: 'RUNTIME_UNAVAILABLE' as const,
                message: 'Conversation runtime is unavailable.',
              },
            }
        parentPort.postMessage(
          utilityResponseSchema.parse({ type: 'conversation.patch.response', requestId, result }),
        )
        return
      }

      case 'comment-source.resolve.request': {
        const { sessionId, commentId, requestId } = request.data
        runRequest(async () => {
          const result = conversation
            ? await conversation.resolveCommentSource(sessionId, commentId)
            : {
                ok: false as const,
                error: {
                  code: 'RUNTIME_UNAVAILABLE' as const,
                  message: 'Conversation runtime is unavailable.',
                },
              }
          parentPort.postMessage(
            utilityResponseSchema.parse({ type: 'comment-source.response', requestId, result }),
          )
        })
        return
      }

      case 'project-file.read.request': {
        const { input, requestId } = request.data
        runRequest(async () => {
          parentPort.postMessage(
            utilityResponseSchema.parse({
              type: 'project-file.response',
              requestId,
              result: await projectFileReader.read(input),
            }),
          )
        })
        return
      }

      case 'workspace-changes.read.request': {
        const { input, requestId } = request.data
        parentPort.postMessage(
          utilityResponseSchema.parse({
            type: 'workspace-changes.response',
            requestId,
            result: conversationOwner.readWorkspaceChanges(input),
          }),
        )
        return
      }

      case 'workspace-changes.file-read.request': {
        const { input, requestId } = request.data
        runRequest(async () => {
          parentPort.postMessage(
            utilityResponseSchema.parse({
              type: 'workspace-changes.file-response',
              requestId,
              result: await conversationOwner.readWorkspaceChangeFile(input),
            }),
          )
        })
        return
      }

      case 'workspace-changes.undo.request': {
        const { input, requestId } = request.data
        runRequest(async () => {
          parentPort.postMessage(
            utilityResponseSchema.parse({
              type: 'conversation.patch.response',
              requestId,
              result: await conversationOwner.undoWorkspaceChanges(input),
            }),
          )
        })
        return
      }

      case 'appearance.get.request':
      case 'appearance.update.request':
      case 'appearance.reset.request':
        parentPort.postMessage(
          utilityResponseSchema.parse({
            type: 'appearance.response',
            requestId: request.data.requestId,
            result: handleAppearanceRequest(
              openedDatabase.appearanceSettingsRepository,
              request.data,
              shouldFailAppearanceWrites,
            ),
          }),
        )
    }
  })
  // Publish only after initialization and the sole request handler are ready.
  parentPort.postMessage(utilityEventSchema.parse({ type: 'runtime.ready.event' }))
  recordDiagnostic({ operation: 'utility', phase: 'ready' })
}

process.on('uncaughtExceptionMonitor', (_error, origin) => {
  recordDiagnostic({
    operation: 'process',
    phase: 'failed',
    level: 'error',
    code: origin === 'unhandledRejection' ? 'UNHANDLED_REJECTION' : 'UNHANDLED_ERROR',
  })
})

process.once('exit', () => {
  eventLoopProbe?.disable()
  void conversation?.dispose()
  database?.close()
  directoryFiles?.dispose()
})

void bootstrap(databaseFile, migrationsFolder, workspaceStorageRoot).catch(
  async (cause: unknown) => {
    eventLoopProbe?.disable()
    directoryFiles?.dispose()
    const failure = runtimeStartupFailureSchema.parse({
      type: 'runtime.startup-failed.event',
      failureId: randomUUID(),
      stage: cause instanceof DatabaseOpenError ? 'persistence' : 'runtime',
      code: cause instanceof DatabaseOpenError ? cause.code : 'DATABASE_STORAGE_FAILED',
      reason: cause instanceof DatabaseOpenError ? cause.reason : 'runtime-initialization-failed',
      dataFilePath: cause instanceof DatabaseOpenError ? cause.dataFilePath : databaseFile,
      ...(cause instanceof DatabaseOpenError && cause.backupFilePath
        ? { backupFilePath: cause.backupFilePath }
        : {}),
      ...(cause instanceof DatabaseOpenError && cause.partialBackupFilePath
        ? { partialBackupFilePath: cause.partialBackupFilePath }
        : {}),
      ...(cause instanceof DatabaseOpenError && cause.stagingFilePath
        ? { stagingFilePath: cause.stagingFilePath }
        : {}),
    })
    recordDiagnostic({ operation: 'utility', phase: 'failed', level: 'error', code: failure.code })
    await conversation?.dispose()
    database?.close()
    // An explicit bounded ACK prevents an immediate exit from dropping the failure message.
    await new Promise<void>((resolveAck) => {
      const receive = (message: Electron.MessageEvent): void => {
        const ack = runtimeStartupFailureAckSchema.safeParse(message.data)
        if (ack.success && ack.data.failureId === failure.failureId) finish()
      }
      const finish = (): void => {
        clearTimeout(timer)
        parentPort.removeListener('message', receive)
        resolveAck()
      }
      const timer = setTimeout(finish, 3000)
      parentPort.on('message', receive)
      try {
        parentPort.postMessage(failure)
      } catch {
        finish()
      }
    })
    closeDiagnostics()
    process.exit(1)
  },
)
