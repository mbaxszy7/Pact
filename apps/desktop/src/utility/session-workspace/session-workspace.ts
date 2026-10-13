import { randomUUID } from 'node:crypto'

import type {
  DefaultSessionSettingsEditorState,
  RpcResult,
  SessionArchiveInput,
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
} from '@pact/contracts'

import {
  OversizedCatalogSessionError,
  ProjectCatalogRepository,
  SessionRepository,
  StaleCatalogCursorError,
} from '@pact/persistence'

import { DefaultSessionSettings } from '../default-session-settings/default-session-settings'

export class SessionWorkspace {
  constructor(
    private readonly projects: ProjectCatalogRepository,
    private readonly sessions: SessionRepository,
    private readonly defaultSettings: DefaultSessionSettings,
    private readonly onTitleChanged?: (sessionId: string) => void,
  ) {}

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

  async prepareCreation(projectId: string): Promise<RpcResult<DefaultSessionSettingsEditorState>> {
    const project = this.projects.find(projectId)
    if (!project) {
      return { ok: false, error: { code: 'VALIDATION', message: 'Project no longer exists.' } }
    }

    const prepared = await this.defaultSettings.loadEditorState(project.directoryPath)
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

    const validation = await this.defaultSettings.validateSettings(
      input.settings,
      project.directoryPath,
    )
    if (!validation.ok) return validation

    try {
      const createdAt = new Date().toISOString()
      return {
        ok: true,
        value: this.sessions.create(
          {
            id: randomUUID(),
            projectId: input.projectId,
            title: 'New session',
            createdAt,
          },
          input.settings,
        ),
      }
    } catch (error) {
      return SessionWorkspace.catalogMutationFailure(error, 'Session could not be created.')
    }
  }

  archive(input: SessionArchiveInput): RpcResult<SessionCatalogChange> {
    try {
      return { ok: true, value: this.sessions.archive(input.sessionId) }
    } catch (error) {
      return SessionWorkspace.catalogMutationFailure(error, 'Session could not be deleted.')
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
    }
  }

  restore(input: SessionArchiveInput): RpcResult<SessionCatalogChange> {
    try {
      return { ok: true, value: this.sessions.restore(input.sessionId) }
    } catch (error) {
      return SessionWorkspace.catalogMutationFailure(error, 'Session could not be restored.')
    }
  }

  async loadSettings(input: SessionSettingsInput): Promise<RpcResult<SessionSettingsEditorState>> {
    const context = this.findContext(input.sessionId)
    if (!context.ok) return context

    const prepared = await this.defaultSettings.loadEditorState(context.value.projectDirectory)
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

    const validation = await this.defaultSettings.validateSettings(
      input.settings,
      context.value.projectDirectory,
    )
    if (!validation.ok) return validation

    try {
      return {
        ok: true,
        value: {
          catalogChange: this.sessions.saveSettings(input.sessionId, {
            ...input.settings,
            permissionModes: this.sessions.find(input.sessionId)?.settings.permissionModes,
          }),
          modelCatalogs: validation.value.modelCatalogs,
        },
      }
    } catch (error) {
      return SessionWorkspace.catalogMutationFailure(error, 'Session settings could not be saved.')
    }
  }

  savePermission(input: SessionPermissionSaveInput): RpcResult<SessionCatalogChange> {
    try {
      return { ok: true, value: this.sessions.savePermission(input) }
    } catch (error) {
      return {
        ok: false,
        error: {
          code: 'CONFLICT',
          message: error instanceof Error ? error.message : 'Permissions could not be saved.',
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
  ): { ok: false; error: { code: 'INTERNAL' | 'UNCERTAIN'; message: string } } {
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
}
