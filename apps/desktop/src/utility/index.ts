import { realpath, rm } from 'node:fs/promises'
import { basename, isAbsolute } from 'node:path'

import {
  utilityEventSchema,
  utilityRequestSchema,
  utilityResponseSchema,
  workspaceStorageRootSchema,
} from '@pact/contracts'
import { PactDatabase } from '@pact/persistence'

import { closeDiagnostics, receiveDiagnostic, recordDiagnostic } from '../diagnostics/utility-log'
import { handleAppearanceRequest } from './appearance/handler'
import { Conversation } from './conversation/conversation'
import { ConversationImages } from './conversation/conversation-images'
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

async function bootstrap(
  runtimeDatabaseFile: string,
  runtimeMigrationsFolder: string,
  runtimeWorkspaceStorageRoot: string,
): Promise<void> {
  recordDiagnostic({ operation: 'utility', phase: 'started' })
  const openedDatabase = await PactDatabase.open({
    filePath: runtimeDatabaseFile,
    migrationsFolder: runtimeMigrationsFolder,
  })
  database = openedDatabase
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
  )
  const images = new ConversationImages(
    openedDatabase.conversationRepository,
    runtimeWorkspaceStorageRoot,
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
  )
  conversation.subscribe((patch, progress) => {
    parentPort.postMessage(
      utilityEventSchema.parse({ type: 'conversation.patch.event', patch, progress }),
    )
  })
  const shouldFailAppearanceWrites = process.argv[4] === '1'
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
          } finally {
            directoryOwner.dispose()
            openedDatabase.close()
            database = undefined
            if (runtimeDatabaseFile === ':memory:')
              await rm(runtimeWorkspaceStorageRoot, { recursive: true, force: true })
          }
          if (results.some((result) => result.status === 'rejected'))
            throw new Error('Conversation cleanup did not finish successfully.')
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

      case 'project-catalog.add.request': {
        const { input, requestId } = request.data
        runRequest(async () => {
          const result = await projectCatalog.add(input)
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
        parentPort.postMessage(
          utilityResponseSchema.parse({
            type: 'project-catalog.response',
            requestId,
            result: projectCatalog.archive(input),
          }),
        )
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
        parentPort.postMessage(
          utilityResponseSchema.parse({
            type: 'session-catalog.response',
            requestId,
            result: sessionWorkspace.archive(input),
          }),
        )
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
  void conversation?.dispose()
  database?.close()
  directoryFiles?.dispose()
})

void bootstrap(databaseFile, migrationsFolder, workspaceStorageRoot).catch(() => {
  directoryFiles?.dispose()
  recordDiagnostic({ operation: 'utility', phase: 'failed', level: 'error', code: 'INTERNAL' })
  console.error('Failed to initialize Pact persistence.')
  // ParentPort listeners keep a failed bootstrap alive even with exitCode set.
  // Exit so Main settles outstanding requests and the exit handler closes storage.
  closeDiagnostics()
  process.exit(1)
})
