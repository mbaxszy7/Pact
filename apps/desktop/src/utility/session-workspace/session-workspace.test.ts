import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentModelCatalog, DefaultSessionSettings as SettingsModel } from '@pact/contracts'

import { PactDatabase } from '@pact/persistence'

import type { DefaultSessionSettings } from '../default-session-settings/default-session-settings'

import { SessionWorkspace } from './session-workspace'

const migrationsFolder = resolve(import.meta.dirname, '../../../../../packages/persistence/drizzle')

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function makeCatalog(agentId: 'claude' | 'codex' | 'agy'): AgentModelCatalog {
  return {
    agentId,
    status: 'available',
    models: [],
    checkedAt: '2026-11-19T00:00:00.000Z',
  }
}

describe('SessionWorkspace 2-of-3 active pair settings', () => {
  it('swaps in the 3rd agent when idle, resets retiring Full access to Ask, and returns CONFLICT when blocked by an active run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pact-session-workspace-'))
    tempDirs.push(dir)
    const db = await PactDatabase.open({
      filePath: join(dir, 'pact.sqlite'),
      migrationsFolder,
    })

    try {
      const projectId = randomUUID()
      const now = '2026-11-19T06:00:00.000Z'
      db.projectCatalogRepository.add({
        id: projectId,
        name: 'Workspace Project',
        directoryPath: dir,
        kind: 'directory',
        createdAt: now,
      })

      const baseSettings: SettingsModel = {
        primaryAgentId: 'claude',
        secondaryAgentId: 'codex',
        agents: {
          claude: { model: null, effort: null, speed: 'fast' },
          codex: { model: null, effort: null, speed: 'native' },
          agy: { model: null, effort: null, speed: 'native' },
        },
        maxDiscussionRounds: 6,
        maxReviewCycles: 3,
        maxRepairAttempts: 3,
      }

      const created = db.sessionRepository.create(
        {
          id: randomUUID(),
          projectId,
          title: 'Main Session',
          createdAt: now,
        },
        baseSettings,
      )
      const sessionId = created.session.id

      db.sessionRepository.savePermission({
        sessionId,
        agentId: 'codex',
        mode: 'full',
        expectedRevision: 1,
        confirmedFullAccess: true,
      })
      db.sessionRepository.saveSpeed({
        sessionId,
        agentId: 'claude',
        speed: 'fast',
        expectedRevision: 2,
      })

      const nativeMetadataChanged = vi.fn<() => void>()
      const validator: Pick<DefaultSessionSettings, 'validateSettings'> = {
        validateSettings: async () => ({
          ok: true,
          value: {
            modelCatalogs: {
              claude: makeCatalog('claude'),
              codex: makeCatalog('codex'),
              agy: makeCatalog('agy'),
            },
          },
        }),
      }
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Minimal validated DefaultSessionSettings double for SessionWorkspace unit test.
      const defaultSettings = validator as DefaultSessionSettings

      const workspace = new SessionWorkspace(
        db.projectCatalogRepository,
        db.sessionRepository,
        defaultSettings,
        undefined,
        nativeMetadataChanged,
      )

      const swapToAgy: SettingsModel = {
        ...baseSettings,
        primaryAgentId: 'claude',
        secondaryAgentId: 'agy',
      }
      const saved = await workspace.saveSettings({ sessionId, settings: swapToAgy })
      expect(saved.ok).toBe(true)
      if (!saved.ok) throw new Error(saved.error.message)
      expect(saved.value.catalogChange.session.settings.primaryAgentId).toBe('claude')
      expect(saved.value.catalogChange.session.settings.secondaryAgentId).toBe('agy')
      expect(saved.value.catalogChange.session.settings.agents.claude.speed).toBe('fast')
      expect(saved.value.catalogChange.session.settings.agents.agy.speed).toBe('native')
      expect(saved.value.catalogChange.session.settings.permissionModes?.codex).toBe('ask')
      expect(nativeMetadataChanged).toHaveBeenCalledTimes(1)

      // Start an active run and verify replacing a pair member returns CONFLICT instead of INTERNAL.
      const draftPage = db.conversationRepository.readPage({ scope: 'drafts', sessionId })
      if (draftPage.scope !== 'drafts') throw new Error('Expected drafts page')
      const started = db.conversationRepository.beginRun({
        sessionId,
        clientMessageId: randomUUID(),
        content: 'Run active work',
        expectedCommentsRevision: draftPage.commentsRevision,
        commentIds: [],
        agentId: 'claude',
        settingsRevision: saved.value.catalogChange.session.settingsRevision,
        model: null,
        effort: null,
      })
      expect(started.run.status).toBe('starting')

      const blocked = await workspace.saveSettings({
        sessionId,
        settings: { ...baseSettings, primaryAgentId: 'claude', secondaryAgentId: 'codex' },
      })
      expect(blocked.ok).toBe(false)
      if (blocked.ok) throw new Error('Expected CONFLICT')
      expect(blocked.error.code).toBe('CONFLICT')
      expect(blocked.error.message).toBe(
        'Wait until the current Agent turn finishes before replacing an Agent in this Session.',
      )
    } finally {
      db.close()
    }
  })

  it('forwards the Session activePair (or explicit activePair override) to DefaultSessionSettings.loadEditorState', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pact-session-workspace-load-'))
    tempDirs.push(dir)
    const db = await PactDatabase.open({
      filePath: join(dir, 'pact.sqlite'),
      migrationsFolder,
    })

    try {
      const projectId = randomUUID()
      const now = '2026-11-19T06:00:00.000Z'
      db.projectCatalogRepository.add({
        id: projectId,
        name: 'Catalog Pair Project',
        directoryPath: dir,
        kind: 'directory',
        createdAt: now,
      })

      const created = db.sessionRepository.create(
        {
          id: randomUUID(),
          projectId,
          title: 'Claude + Agy Session',
          createdAt: now,
        },
        {
          primaryAgentId: 'claude',
          secondaryAgentId: 'agy',
          agents: {
            claude: { model: null, effort: null, speed: 'native' },
            codex: { model: null, effort: null, speed: 'native' },
            agy: { model: null, effort: null, speed: 'native' },
          },
          maxDiscussionRounds: 6,
          maxReviewCycles: 3,
          maxRepairAttempts: 3,
        },
      )

      const loadEditorState = vi.fn<DefaultSessionSettings['loadEditorState']>(
        async (_workingDirectory, activePair) => ({
          ok: true,
          value: {
            current: {
              settings: created.session.settings,
              updatedAt: now,
            },
            modelCatalogs: {
              claude: makeCatalog('claude'),
              codex:
                activePair?.primaryAgentId === 'codex' || activePair?.secondaryAgentId === 'codex'
                  ? makeCatalog('codex')
                  : {
                      agentId: 'codex',
                      status: 'unavailable',
                      models: [],
                      checkedAt: now,
                      detail: 'Select Codex in the active pair to load its models.',
                    },
              agy:
                activePair?.primaryAgentId === 'agy' || activePair?.secondaryAgentId === 'agy'
                  ? makeCatalog('agy')
                  : {
                      agentId: 'agy',
                      status: 'unavailable',
                      models: [],
                      checkedAt: now,
                      detail: 'Select Antigravity in the active pair to load its models.',
                    },
            },
          },
        }),
      )
      const loader: Pick<DefaultSessionSettings, 'loadEditorState'> = { loadEditorState }
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Minimal loadEditorState double for SessionWorkspace unit test.
      const defaultSettings = loader as DefaultSessionSettings

      const workspace = new SessionWorkspace(
        db.projectCatalogRepository,
        db.sessionRepository,
        defaultSettings,
      )

      // 1. Opening Session settings without explicit activePair passes the Session's own (claude, agy) pair
      const loadedSession = await workspace.loadSettings({ sessionId: created.session.id })
      expect(loadedSession.ok).toBe(true)
      if (!loadedSession.ok) throw new Error(loadedSession.error.message)
      expect(loadEditorState).toHaveBeenLastCalledWith(dir, {
        primaryAgentId: 'claude',
        secondaryAgentId: 'agy',
      })
      expect(loadedSession.value.modelCatalogs.agy?.status).toBe('available')

      // 2. Switching pairs in Session settings passes the explicit activePair override
      const loadedOverride = await workspace.loadSettings({
        sessionId: created.session.id,
        activePair: { primaryAgentId: 'claude', secondaryAgentId: 'codex' },
      })
      expect(loadedOverride.ok).toBe(true)
      if (!loadedOverride.ok) throw new Error(loadedOverride.error.message)
      expect(loadEditorState).toHaveBeenLastCalledWith(dir, {
        primaryAgentId: 'claude',
        secondaryAgentId: 'codex',
      })
      expect(loadedOverride.value.modelCatalogs.codex.status).toBe('available')

      // 3. Preparing Session creation forwards optional activePair
      const prepared = await workspace.prepareCreation(projectId, {
        primaryAgentId: 'codex',
        secondaryAgentId: 'agy',
      })
      expect(prepared.ok).toBe(true)
      expect(loadEditorState).toHaveBeenLastCalledWith(dir, {
        primaryAgentId: 'codex',
        secondaryAgentId: 'agy',
      })
    } finally {
      db.close()
    }
  })

  it('preserves unselected 3rd-agent model/effort/speed verbatim and allows pure Primary <-> Secondary role swap when an existing member is offline', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pact-session-workspace-preserve-'))
    tempDirs.push(dir)
    const db = await PactDatabase.open({
      filePath: join(dir, 'pact.sqlite'),
      migrationsFolder,
    })

    try {
      const projectId = randomUUID()
      const now = '2026-11-19T06:00:00.000Z'
      db.projectCatalogRepository.add({
        id: projectId,
        name: 'Preserve 3rd Agent Project',
        directoryPath: dir,
        kind: 'directory',
        createdAt: now,
      })

      const initialSettings: SettingsModel = {
        primaryAgentId: 'claude',
        secondaryAgentId: 'agy',
        agents: {
          claude: { model: 'claude-sonnet-4-6', effort: 'high', speed: 'native' },
          codex: { model: 'gpt-5.4', effort: 'xhigh', speed: 'native' },
          agy: { model: 'gemini-4-carbon', effort: 'medium', speed: 'native' },
        },
        maxDiscussionRounds: 6,
        maxReviewCycles: 3,
        maxRepairAttempts: 3,
      }
      const created = db.sessionRepository.create(
        { id: randomUUID(), projectId, title: 'Role Swap Session', createdAt: now },
        initialSettings,
      )
      const sessionId = created.session.id
      db.sessionRepository.saveSpeed({
        sessionId,
        agentId: 'claude',
        speed: 'fast',
        expectedRevision: 1,
      })
      db.sessionRepository.saveSpeed({
        sessionId,
        agentId: 'agy',
        speed: 'fast',
        expectedRevision: 2,
      })
      db.sessionRepository.saveSettings(sessionId, {
        ...initialSettings,
        primaryAgentId: 'claude',
        secondaryAgentId: 'codex',
        agents: {
          claude: { model: 'claude-sonnet-4-6', effort: 'high', speed: 'fast' },
          codex: { model: 'gpt-5.4', effort: 'xhigh', speed: 'native' },
          agy: { model: 'gemini-4-carbon', effort: 'medium', speed: 'fast' },
        },
      })

      const validateSettings = vi.fn<DefaultSessionSettings['validateSettings']>(async () => ({
        ok: false,
        error: { code: 'RUNTIME_UNAVAILABLE', message: 'Both selected Agents must be ready.' },
      }))
      const loadSessionEditorState = vi.fn<DefaultSessionSettings['loadSessionEditorState']>(
        async () => ({
          ok: true,
          value: {
            current: { settings: initialSettings, updatedAt: now },
            modelCatalogs: {
              claude: {
                agentId: 'claude',
                status: 'unavailable',
                models: [],
                checkedAt: now,
                detail: 'Claude is temporarily signed out.',
              },
              codex: makeCatalog('codex'),
              agy: {
                agentId: 'agy',
                status: 'unavailable',
                models: [],
                checkedAt: now,
              },
            },
          },
        }),
      )
      const settingsDouble: Pick<
        DefaultSessionSettings,
        'validateSettings' | 'loadSessionEditorState'
      > = {
        validateSettings,
        loadSessionEditorState,
      }
      const workspace = new SessionWorkspace(
        db.projectCatalogRepository,
        db.sessionRepository,
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Focused DefaultSessionSettings double for role-swap and 3rd-member preservation test.
        settingsDouble as DefaultSessionSettings,
      )

      // 1. Pure Primary <-> Secondary swap succeeds even though claude is offline, and preserves unselected agy verbatim!
      const pureSwapAttempt: SettingsModel = {
        primaryAgentId: 'codex',
        secondaryAgentId: 'claude',
        agents: {
          claude: { model: 'claude-sonnet-4-6', effort: 'high', speed: 'native' },
          codex: { model: 'gpt-5.4', effort: 'xhigh', speed: 'native' },
          // Caller payload tries to wipe unselected agy settings; SessionWorkspace must preserve persisted agy verbatim!
          agy: { model: null, effort: null, speed: 'native' },
        },
        maxDiscussionRounds: 6,
        maxReviewCycles: 3,
        maxRepairAttempts: 3,
      }
      const pureSwapped = await workspace.saveSettings({ sessionId, settings: pureSwapAttempt })
      expect(pureSwapped.ok).toBe(true)
      if (!pureSwapped.ok) throw new Error(pureSwapped.error.message)
      expect(validateSettings).not.toHaveBeenCalled()
      expect(loadSessionEditorState).not.toHaveBeenCalled()
      expect(pureSwapped.value.catalogChange.session.settings.primaryAgentId).toBe('codex')
      expect(pureSwapped.value.catalogChange.session.settings.secondaryAgentId).toBe('claude')
      expect(pureSwapped.value.catalogChange.session.settings.agents.claude.speed).toBe('fast')
      expect(pureSwapped.value.catalogChange.session.settings.agents.agy).toEqual({
        model: 'gemini-4-carbon',
        effort: 'medium',
        speed: 'fast',
      })

      // 2. Non-pure change (changing codex effort while claude is offline) still runs validateSettings and fails RUNTIME_UNAVAILABLE!
      const nonPureAttempt: SettingsModel = {
        ...pureSwapAttempt,
        primaryAgentId: 'claude',
        secondaryAgentId: 'codex',
        agents: {
          ...pureSwapAttempt.agents,
          codex: { model: 'gpt-5.4', effort: 'high', speed: 'native' },
        },
      }
      const rejected = await workspace.saveSettings({ sessionId, settings: nonPureAttempt })
      expect(rejected).toEqual({
        ok: false,
        error: { code: 'RUNTIME_UNAVAILABLE', message: 'Both selected Agents must be ready.' },
      })
      expect(validateSettings).toHaveBeenCalledTimes(1)
    } finally {
      db.close()
    }
  })

  it('delivers session-settings.save.response and reconciles retired Full access even on UNCERTAIN save or throwing reconcileSessionSettingsChanged', async () => {
    const { EventEmitter } = await import('node:events')
    const memoryWorkspaceDir = mkdtempSync(join(tmpdir(), `pact-workspace-memory-${randomUUID()}`))
    // Ensure exact UUID suffix format expected by utility/index.ts ':memory:' guard
    const exactDir = join(tmpdir(), `pact-workspace-memory-${randomUUID()}`)
    rmSync(memoryWorkspaceDir, { recursive: true, force: true })
    const { mkdirSync } = await import('node:fs')
    mkdirSync(exactDir, { recursive: true })
    tempDirs.push(exactDir)

    const prevArgv = [...process.argv]
    const prevParentPort = Reflect.get(process, 'parentPort')
    const posted: Array<Record<string, unknown>> = []

    class FakeParentPort extends EventEmitter {
      postMessage(message: Record<string, unknown>): void {
        posted.push(message)
      }
    }
    const fakePort = new FakeParentPort()

    vi.resetModules()
    try {
      process.argv = [
        process.argv[0] ?? 'node',
        process.argv[1] ?? 'index.ts',
        ':memory:',
        migrationsFolder,
        '0',
        exactDir,
      ]
      Reflect.set(process, 'parentPort', fakePort)

      const { Conversation } = await import('../conversation/conversation')
      const { SessionWorkspace: FreshSessionWorkspace } = await import('./session-workspace')

      const reconcileCalls: string[] = []
      let shouldThrowReconcile = false
      const reconcileSpy = vi
        .spyOn(Conversation.prototype, 'reconcileSessionSettingsChanged')
        .mockImplementation(async (sessionId: string) => {
          reconcileCalls.push(sessionId)
          if (shouldThrowReconcile) {
            throw new Error('Simulated executor teardown failure')
          }
        })
      const saveSpy = vi.spyOn(FreshSessionWorkspace.prototype, 'saveSettings')

      await import('../index')
      await vi.waitFor(() => {
        expect(posted.some((m) => m.type === 'runtime.ready.event')).toBe(true)
      })

      const dummySettings: SettingsModel = {
        primaryAgentId: 'claude',
        secondaryAgentId: 'agy',
        agents: {
          claude: { model: null, effort: null },
          codex: { model: null, effort: null },
          agy: { model: null, effort: null },
        },
        maxDiscussionRounds: 6,
        maxReviewCycles: 3,
        maxRepairAttempts: 3,
      }
      const targetSessionId = randomUUID()

      // Case A: saveSettings returns UNCERTAIN (DB committed, catalog projection exceeded cap) -> still reconciles AND responds!
      saveSpy.mockResolvedValueOnce({
        ok: false,
        error: { code: 'UNCERTAIN', message: 'Committed but catalog projection exceeded cap.' },
      })
      const uncertainReqId = randomUUID()
      fakePort.emit('message', {
        data: {
          type: 'session-settings.save.request',
          requestId: uncertainReqId,
          input: { sessionId: targetSessionId, settings: dummySettings },
        },
      })
      await vi.waitFor(() => {
        expect(
          posted.find(
            (m) => m.type === 'session-settings.save.response' && m.requestId === uncertainReqId,
          ),
        ).toMatchObject({
          result: { ok: false, error: { code: 'UNCERTAIN' } },
        })
      })
      expect(reconcileCalls).toEqual([targetSessionId])

      // Case B: saveSettings returns ok: true, then reconcileSessionSettingsChanged rejects -> converts response to typed UNCERTAIN!
      shouldThrowReconcile = true
      const nowIso = new Date().toISOString()
      saveSpy.mockResolvedValueOnce({
        ok: true,
        value: {
          catalogChange: {
            kind: 'change' as const,
            revision: 2,
            session: {
              id: targetSessionId,
              projectId: randomUUID(),
              title: 'Saved Session',
              titleSource: 'placeholder',
              status: 'idle',
              activity: { state: 'idle' },
              hasUnread: false,
              settingsRevision: 2,
              settings: dummySettings,
              createdAt: nowIso,
              updatedAt: nowIso,
            },
          },
          modelCatalogs: {
            claude: { agentId: 'claude', status: 'unavailable', models: [], checkedAt: nowIso },
            codex: { agentId: 'codex', status: 'unavailable', models: [], checkedAt: nowIso },
            agy: { agentId: 'agy', status: 'unavailable', models: [], checkedAt: nowIso },
          },
        },
      })
      const throwReqId = randomUUID()
      fakePort.emit('message', {
        data: {
          type: 'session-settings.save.request',
          requestId: throwReqId,
          input: { sessionId: targetSessionId, settings: dummySettings },
        },
      })
      await vi.waitFor(() => {
        expect(
          posted.find(
            (m) => m.type === 'session-settings.save.response' && m.requestId === throwReqId,
          ),
        ).toMatchObject({
          result: {
            ok: false,
            error: {
              code: 'UNCERTAIN',
              message: expect.stringContaining('Full access'),
            },
          },
        })
      })
      expect(reconcileCalls).toEqual([targetSessionId, targetSessionId])

      reconcileSpy.mockRestore()
      saveSpy.mockRestore()

      const shutdownReqId = randomUUID()
      fakePort.emit('message', {
        data: {
          type: 'runtime.shutdown.request',
          requestId: shutdownReqId,
        },
      })
      await vi.waitFor(() => {
        expect(
          posted.find(
            (m) => m.type === 'runtime.shutdown.response' && m.requestId === shutdownReqId,
          ),
        ).toBeDefined()
      })
    } finally {
      process.argv = prevArgv
      Reflect.set(process, 'parentPort', prevParentPort)
      vi.resetModules()
    }
  })
})
