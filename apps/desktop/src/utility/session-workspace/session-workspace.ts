import {
  resolveActiveAgentPair,
  type ActiveAgentPairInput,
  type DefaultSessionSettingsEditorState,
  type RpcResult,
  SessionArchiveInput,
  SessionSidebarHiddenInput,
  SessionCatalogChange,
  SessionCatalogPage,
  SessionCatalogPageInput,
  SessionCreateInput,
  SessionMarkReadInput,
  SessionRenameInput,
  SessionSettingsEditorState,
  SessionSettingsSaveResult,
  SessionSettingsInput,
  SessionSettingsSaveInput,
  SessionPermissionSaveInput,
  SessionSpeedSaveInput,
  NativeSessionOpenInput,
  NativeJumpListSuppressionInput,
  NativeSessionRow,
  SessionPage,
  SessionPageInput,
  SessionGroupPage,
  SessionGroupPageInput,
  SessionGroupDetail,
  SessionGroupDetailInput,
  SessionMembership,
  SessionMembershipInput,
  LocateSessionNavigationInput,
  LocatedSessionNavigation,
  SessionCreationState,
  SessionCreationStateInput,
  CreateSessionGroupInput,
  UpdateSessionGroupInput,
  MoveSessionGroupInput,
  DissolveSessionGroupInput,
  SetSessionGroupInput,
  SessionGroupMutation,
} from '@pact/contracts'
import {
  OversizedCatalogSessionError,
  ProjectCatalogRepository,
  SessionRepository,
  SessionSettingsConflictError,
  StaleCatalogCursorError,
  StaleSessionGroupError,
} from '@pact/persistence'

import { DefaultSessionSettings } from '../default-session-settings/default-session-settings'

export class SessionWorkspace {
  private pendingCreation: SessionCreationStateInput | undefined

  constructor(
    private readonly projects: ProjectCatalogRepository,
    private readonly sessions: SessionRepository,
    private readonly defaultSettings: DefaultSessionSettings,
    private readonly onTitleChanged?: (sessionId: string) => void,
    private readonly onNativeMetadataChanged?: () => void,
  ) {}

  readQuitRecent(): NativeSessionRow[] {
    return this.sessions.nativeQuitRecent()
  }

  resolveNativeSession(sessionId: string): RpcResult<SessionCatalogChange> {
    try {
      return { ok: true, value: this.sessions.resolveNativeSession(sessionId) }
    } catch {
      return {
        ok: false,
        error: {
          code: 'VALIDATION',
          message: 'This Session or its Project is archived or no longer available.',
        },
      }
    }
  }

  recordNativeSessionOpened(input: NativeSessionOpenInput): RpcResult<{ recorded: true }> {
    try {
      if (this.sessions.recordNativeOpened(input)) this.nativeMetadataChanged()
      return { ok: true, value: { recorded: true } }
    } catch {
      return {
        ok: false,
        error: { code: 'CONFLICT', message: 'This Session opening could not be recorded.' },
      }
    }
  }

  updateNativeJumpListSuppression(
    input: NativeJumpListSuppressionInput,
  ): RpcResult<{ updated: true }> {
    try {
      if (this.sessions.updateNativeJumpListSuppression(input)) this.nativeMetadataChanged()
      return { ok: true, value: { updated: true } }
    } catch {
      return {
        ok: false,
        error: { code: 'INTERNAL', message: 'Taskbar preferences could not be saved.' },
      }
    }
  }

  load(input: SessionCatalogPageInput): RpcResult<SessionCatalogPage> {
    try {
      return { ok: true, value: this.sessions.readPage(input.projectId, input.cursor) }
    } catch (error) {
      if (error instanceof StaleCatalogCursorError) {
        return { ok: false, error: { code: 'CONFLICT', message: error.message } }
      }
      if (error instanceof OversizedCatalogSessionError) {
        return { ok: false, error: { code: 'VALIDATION', message: error.message } }
      }
      return { ok: false, error: { code: 'INTERNAL', message: 'Sessions could not be loaded.' } }
    }
  }

  loadPage(input: SessionPageInput): RpcResult<SessionPage> {
    try {
      return { ok: true, value: this.sessions.readSessionPage(input) }
    } catch (error) {
      if (error instanceof StaleCatalogCursorError) {
        return { ok: false, error: { code: 'CONFLICT', message: error.message } }
      }
      if (error instanceof OversizedCatalogSessionError) {
        return { ok: false, error: { code: 'VALIDATION', message: error.message } }
      }
      return { ok: false, error: { code: 'INTERNAL', message: 'Sessions could not be loaded.' } }
    }
  }

  loadGroups(input: SessionGroupPageInput): RpcResult<SessionGroupPage> {
    try {
      return { ok: true, value: this.sessions.readSessionGroups(input) }
    } catch (error) {
      if (error instanceof StaleSessionGroupError) {
        return { ok: false, error: { code: 'CONFLICT', message: error.message } }
      }
      return {
        ok: false,
        error: { code: 'INTERNAL', message: 'Session groups could not be loaded.' },
      }
    }
  }

  loadGroup(input: SessionGroupDetailInput): RpcResult<SessionGroupDetail> {
    try {
      return { ok: true, value: this.sessions.readSessionGroup(input) }
    } catch {
      return {
        ok: false,
        error: { code: 'INTERNAL', message: 'The Session group could not be loaded.' },
      }
    }
  }

  loadMembership(input: SessionMembershipInput): RpcResult<SessionMembership> {
    try {
      return { ok: true, value: this.sessions.readSessionMembership(input) }
    } catch {
      return {
        ok: false,
        error: { code: 'INTERNAL', message: 'Session membership could not be loaded.' },
      }
    }
  }

  locate(input: LocateSessionNavigationInput): RpcResult<LocatedSessionNavigation> {
    try {
      return { ok: true, value: this.sessions.locateSessionNavigation(input) }
    } catch {
      return {
        ok: false,
        error: { code: 'INTERNAL', message: 'The Session could not be located.' },
      }
    }
  }

  loadCreationState(input: SessionCreationStateInput): RpcResult<SessionCreationState> {
    try {
      const current = this.sessions.readSessionCreationState(input)
      return {
        ok: true,
        value:
          this.pendingCreation?.sessionId === input.sessionId &&
          this.pendingCreation.projectId === input.projectId
            ? {
                state: 'pending',
                revision: current.revision,
                catalogRevision: current.catalogRevision,
              }
            : current,
      }
    } catch {
      return {
        ok: false,
        error: { code: 'INTERNAL', message: 'The Session creation state could not be loaded.' },
      }
    }
  }

  createGroup(input: CreateSessionGroupInput): RpcResult<SessionGroupMutation> {
    try {
      return { ok: true, value: this.sessions.createSessionGroup(input) }
    } catch (error) {
      return SessionWorkspace.groupMutationFailure(error, 'The Session group could not be created.')
    } finally {
      this.nativeMetadataChanged()
    }
  }

  updateGroup(input: UpdateSessionGroupInput): RpcResult<SessionGroupMutation> {
    try {
      return { ok: true, value: this.sessions.updateSessionGroup(input) }
    } catch (error) {
      return SessionWorkspace.groupMutationFailure(error, 'The Session group could not be updated.')
    }
  }

  moveGroup(input: MoveSessionGroupInput): RpcResult<SessionGroupMutation> {
    try {
      return { ok: true, value: this.sessions.moveSessionGroup(input) }
    } catch (error) {
      return SessionWorkspace.groupMutationFailure(error, 'The Session group could not be moved.')
    }
  }

  dissolveGroup(input: DissolveSessionGroupInput): RpcResult<SessionGroupMutation> {
    try {
      return { ok: true, value: this.sessions.dissolveSessionGroup(input) }
    } catch (error) {
      return SessionWorkspace.groupMutationFailure(
        error,
        'The Session group could not be dissolved.',
      )
    } finally {
      this.nativeMetadataChanged()
    }
  }

  setGroup(input: SetSessionGroupInput): RpcResult<SessionGroupMutation> {
    try {
      return { ok: true, value: this.sessions.setSessionGroup(input) }
    } catch (error) {
      return SessionWorkspace.groupMutationFailure(
        error,
        'The Session could not be moved to that group.',
      )
    } finally {
      this.nativeMetadataChanged()
    }
  }

  async prepareCreation(
    projectId: string,
    activePair?: ActiveAgentPairInput,
  ): Promise<RpcResult<DefaultSessionSettingsEditorState>> {
    const project = this.projects.find(projectId)
    if (!project) {
      return { ok: false, error: { code: 'VALIDATION', message: 'Project no longer exists.' } }
    }

    const prepared = await this.defaultSettings.loadEditorState(project.directoryPath, activePair)
    if (!prepared.ok) return prepared
    return prepared.value.current
      ? prepared
      : {
          ok: false,
          error: {
            code: 'CONFLICT',
            message: 'Save App default settings before creating a Session.',
          },
        }
  }

  async create(input: SessionCreateInput): Promise<RpcResult<SessionCatalogChange>> {
    const project = this.projects.find(input.projectId)
    if (!project) {
      return { ok: false, error: { code: 'VALIDATION', message: 'Project no longer exists.' } }
    }
    if (this.pendingCreation !== undefined) {
      return {
        ok: false,
        error: { code: 'CONFLICT', message: 'Another Session is still being created.' },
      }
    }
    this.pendingCreation = { sessionId: input.sessionId, projectId: input.projectId }
    try {
      if (this.sessions.find(input.sessionId)) {
        return {
          ok: false,
          error: {
            code: 'CONFLICT',
            message: 'This Session already exists. Read its current state before retrying.',
          },
        }
      }
      const validation = await this.defaultSettings.validateSettings(
        input.settings,
        project.directoryPath,
      )
      if (!validation.ok) return validation
      const createdAt = new Date().toISOString()
      return {
        ok: true,
        value: this.sessions.create(
          {
            id: input.sessionId,
            projectId: input.projectId,
            title: 'New session',
            createdAt,
          },
          input.settings,
          input.groupId ?? null,
          input.expectedGroupRevision,
        ),
      }
    } catch (error) {
      return SessionWorkspace.catalogMutationFailure(error, 'Session could not be created.')
    } finally {
      this.pendingCreation = undefined
      this.nativeMetadataChanged()
    }
  }

  archive(input: SessionArchiveInput): RpcResult<SessionCatalogChange> {
    try {
      return { ok: true, value: this.sessions.archive(input.sessionId, input.operationId) }
    } catch (error) {
      return SessionWorkspace.catalogMutationFailure(error, 'Session could not be deleted.')
    } finally {
      this.nativeMetadataChanged()
    }
  }

  archiveReceipt(sessionId: string): RpcResult<SessionCatalogChange> {
    try {
      return { ok: true, value: this.sessions.change(sessionId) }
    } catch (error) {
      return SessionWorkspace.catalogMutationFailure(error, 'The archive result could not be read.')
    }
  }

  rename(input: SessionRenameInput): RpcResult<SessionCatalogChange> {
    try {
      return { ok: true, value: this.sessions.rename(input.sessionId, input.title) }
    } catch (error) {
      return SessionWorkspace.catalogMutationFailure(error, 'Session could not be renamed.')
    } finally {
      // Catalog projection can be uncertain after the title committed. The
      // Native owner re-reads durable metadata; its I/O never gates this ACK.
      try {
        this.onTitleChanged?.(input.sessionId)
      } catch {
        /* Cosmetic sync cannot fail a saved rename. */
      }
      this.nativeMetadataChanged()
    }
  }

  markRead(input: SessionMarkReadInput): RpcResult<SessionCatalogChange> {
    try {
      return {
        ok: true,
        value: this.sessions.markRead(input.sessionId, input.throughSequence),
      }
    } catch (error) {
      return SessionWorkspace.catalogMutationFailure(error, 'Session could not be marked read.')
    } finally {
      this.nativeMetadataChanged()
    }
  }

  restore(input: SessionArchiveInput): RpcResult<SessionCatalogChange> {
    try {
      return { ok: true, value: this.sessions.restore(input.sessionId) }
    } catch (error) {
      return SessionWorkspace.catalogMutationFailure(error, 'Session could not be restored.')
    } finally {
      this.nativeMetadataChanged()
    }
  }

  setSidebarHidden(input: SessionSidebarHiddenInput): RpcResult<SessionCatalogChange> {
    try {
      return { ok: true, value: this.sessions.setSidebarHidden(input) }
    } catch (error) {
      return SessionWorkspace.catalogMutationFailure(
        error,
        'Sidebar visibility could not be saved.',
      )
    }
  }

  async loadSettings(input: SessionSettingsInput): Promise<RpcResult<SessionSettingsEditorState>> {
    const context = this.findContext(input.sessionId)
    if (!context.ok) return context

    const [sessionPrimary, sessionSecondary] = resolveActiveAgentPair(
      context.value.session.settings,
    )
    const effectivePair: ActiveAgentPairInput = input.activePair ?? {
      primaryAgentId: sessionPrimary,
      secondaryAgentId: sessionSecondary,
    }
    const prepared =
      typeof this.defaultSettings.loadSessionEditorState === 'function'
        ? await this.defaultSettings.loadSessionEditorState(
            input.sessionId,
            context.value.projectDirectory,
            effectivePair,
          )
        : await this.defaultSettings.loadEditorState(context.value.projectDirectory, effectivePair)
    if (!prepared.ok) return prepared
    return {
      ok: true,
      value: { session: context.value.session, modelCatalogs: prepared.value.modelCatalogs },
    }
  }

  async saveSettings(
    input: SessionSettingsSaveInput,
  ): Promise<RpcResult<SessionSettingsSaveResult>> {
    const context = this.findContext(input.sessionId)
    if (!context.ok) return context
    if (context.value.session.parentSessionId) {
      return {
        ok: false,
        error: {
          code: 'CONFLICT',
          message: 'Side chat settings are read-only and inherit from the main chat.',
        },
      }
    }

    const initialPureRoleSwap = SessionWorkspace.isPureActivePairRoleSwap(
      context.value.session.settings,
      input.settings,
    )
    const nextPair = resolveActiveAgentPair(input.settings)
    const pairInput: ActiveAgentPairInput = {
      primaryAgentId: nextPair[0],
      secondaryAgentId: nextPair[1],
    }
    let resolvedCatalogs: SessionSettingsSaveResult['modelCatalogs']
    if (initialPureRoleSwap) {
      resolvedCatalogs = this.resolvePureRoleSwapCatalogs(context.value.projectDirectory, pairInput)
    } else {
      const validation = await this.defaultSettings.validateSettings(
        input.settings,
        context.value.projectDirectory,
      )
      if (!validation.ok) return validation
      resolvedCatalogs = validation.value.modelCatalogs
    }

    try {
      const current = this.sessions.find(input.sessionId)
      if (!current || current.status === 'archived')
        throw new Error('This Session is no longer available.')
      if (
        initialPureRoleSwap &&
        !SessionWorkspace.isPureActivePairRoleSwap(current.settings, input.settings)
      ) {
        throw new SessionSettingsConflictError(
          'Session settings changed while saving. Reload the Session settings before retrying.',
        )
      }
      const mergeMemberSettings = (agentId: 'claude' | 'codex' | 'agy') => {
        const persisted = current.settings.agents[agentId]
        if (!nextPair.includes(agentId)) {
          return {
            model: persisted.model,
            effort: persisted.effort,
            speed: persisted.speed ?? 'native',
          }
        }
        return {
          ...input.settings.agents[agentId],
          speed: persisted.speed ?? 'native',
        }
      }
      return {
        ok: true,
        value: {
          catalogChange: this.sessions.saveSettings(input.sessionId, {
            ...input.settings,
            permissionModes: current.settings.permissionModes,
            agents: {
              claude: mergeMemberSettings('claude'),
              codex: mergeMemberSettings('codex'),
              agy: mergeMemberSettings('agy'),
            },
          }),
          modelCatalogs: resolvedCatalogs,
        },
      }
    } catch (error) {
      return SessionWorkspace.catalogMutationFailure(error, 'Session settings could not be saved.')
    } finally {
      this.nativeMetadataChanged()
    }
  }

  private resolvePureRoleSwapCatalogs(
    projectDirectory: string,
    pairInput: ActiveAgentPairInput,
  ): SessionSettingsSaveResult['modelCatalogs'] {
    if (typeof this.defaultSettings.readCachedOrFallbackModelCatalogs === 'function') {
      return this.defaultSettings.readCachedOrFallbackModelCatalogs(projectDirectory, pairInput)
    }
    const activeMembers = new Set([pairInput.primaryAgentId, pairInput.secondaryAgentId])
    const checkedAt = new Date().toISOString()
    const fallback = (agentId: 'claude' | 'codex' | 'agy') => ({
      agentId,
      status: 'unavailable' as const,
      models: [],
      detail: activeMembers.has(agentId)
        ? 'Model list was not reloaded during role swap. Saved model selection is preserved.'
        : 'Select this Agent in the active pair to load its models.',
      checkedAt,
    })
    return {
      claude: fallback('claude'),
      codex: fallback('codex'),
      agy: fallback('agy'),
    }
  }

  private static isPureActivePairRoleSwap(
    currentSettings: SessionSettingsSaveInput['settings'],
    nextSettings: SessionSettingsSaveInput['settings'],
  ): boolean {
    if (nextSettings.primaryAgentId === nextSettings.secondaryAgentId) {
      return false
    }
    const currentPair = resolveActiveAgentPair(currentSettings)
    const nextPair = resolveActiveAgentPair(nextSettings)
    if (currentPair[0] !== nextPair[1] || currentPair[1] !== nextPair[0]) {
      return false
    }
    return nextPair.every((agentId) => {
      const currentMember = currentSettings.agents[agentId]
      const nextMember = nextSettings.agents[agentId]
      return currentMember.model === nextMember.model && currentMember.effort === nextMember.effort
    })
  }

  savePermission(input: SessionPermissionSaveInput): RpcResult<SessionCatalogChange> {
    if (this.sessions.find(input.sessionId)?.parentSessionId) {
      return {
        ok: false,
        error: {
          code: 'CONFLICT',
          message: 'Side chat permissions are read-only and inherit from the main chat.',
        },
      }
    }
    try {
      return { ok: true, value: this.sessions.savePermission(input) }
    } catch (error) {
      if (error instanceof OversizedCatalogSessionError) {
        return SessionWorkspace.catalogMutationFailure(error, 'Permissions could not be saved.')
      }
      return {
        ok: false,
        error: {
          code: 'CONFLICT',
          message: error instanceof Error ? error.message : 'Permissions could not be saved.',
        },
      }
    }
  }

  saveSpeed(input: SessionSpeedSaveInput): RpcResult<SessionCatalogChange> {
    if (this.sessions.find(input.sessionId)?.parentSessionId) {
      return {
        ok: false,
        error: {
          code: 'CONFLICT',
          message: 'Side chat speed is read-only and inherit from the main chat.',
        },
      }
    }
    try {
      return { ok: true, value: this.sessions.saveSpeed(input) }
    } catch (error) {
      return {
        ok: false,
        error: {
          code: 'CONFLICT',
          message: error instanceof Error ? error.message : 'Speed could not be saved.',
        },
      }
    }
  }

  private findContext(sessionId: string):
    | {
        ok: true
        value: {
          session: NonNullable<ReturnType<SessionRepository['find']>>
          projectDirectory: string
        }
      }
    | { ok: false; error: { code: 'VALIDATION'; message: string } } {
    const session = this.sessions.find(sessionId)
    if (!session) {
      return { ok: false, error: { code: 'VALIDATION', message: 'Session no longer exists.' } }
    }
    const project = this.projects.find(session.projectId)
    if (!project) {
      return { ok: false, error: { code: 'VALIDATION', message: 'Project no longer exists.' } }
    }
    return { ok: true, value: { session, projectDirectory: project.directoryPath } }
  }

  private static catalogMutationFailure(
    error: unknown,
    fallback: string,
  ): {
    ok: false
    error: { code: 'CONFLICT' | 'INTERNAL' | 'UNCERTAIN'; message: string }
  } {
    if (error instanceof SessionSettingsConflictError || error instanceof StaleSessionGroupError) {
      return { ok: false, error: { code: 'CONFLICT', message: error.message } }
    }
    return error instanceof OversizedCatalogSessionError
      ? {
          ok: false,
          error: {
            code: 'UNCERTAIN',
            message: `${error.message} The change may have been saved; refresh the Catalog before retrying.`,
          },
        }
      : { ok: false, error: { code: 'INTERNAL', message: fallback } }
  }

  private static groupMutationFailure(
    error: unknown,
    fallback: string,
  ): {
    ok: false
    error: { code: 'CONFLICT' | 'INTERNAL' | 'UNCERTAIN'; message: string }
  } {
    if (error instanceof SessionSettingsConflictError || error instanceof StaleSessionGroupError) {
      return { ok: false, error: { code: 'CONFLICT', message: error.message } }
    }
    return error instanceof OversizedCatalogSessionError
      ? {
          ok: false,
          error: {
            code: 'UNCERTAIN',
            message: `${error.message} The change may have been saved; reload before retrying.`,
          },
        }
      : { ok: false, error: { code: 'INTERNAL', message: fallback } }
  }

  private nativeMetadataChanged(): void {
    try {
      this.onNativeMetadataChanged?.()
    } catch {
      /* Metadata invalidation cannot invalidate a durable mutation receipt. */
    }
  }
}
