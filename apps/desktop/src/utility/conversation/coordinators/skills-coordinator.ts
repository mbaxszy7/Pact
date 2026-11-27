import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute } from 'node:path'

import type {
  ConversationSendInput,
  FrozenSkillInvocation,
  RpcResult,
  RuntimeAgentId,
  SkillBinding,
  SkillCatalogPage,
  SkillCatalogRead,
  SkillDocument,
  SkillDocumentRead,
} from '@pact/contracts'

import {
  agentDisplayName,
  frozenSkillInvocationSchema,
  parseComposerCommandPrefix,
  SKILL_PAGE_BYTES,
  SKILL_PAGE_ITEMS,
  skillArguments,
  skillCatalogPageSchema,
  skillDocumentSchema,
} from '@pact/contracts'
import { RunOperationConflictError } from '@pact/persistence'

import type { ConversationRuntimeCore } from '../conversation-runtime-core'

import {
  AGY_SKILL_DISCOVERY_OPERATION_MS,
  AGY_SKILL_DOCUMENT_OPERATION_MS,
  MAX_AGENT_OPERATIONS,
} from '../conversation-types'

export class SkillsCoordinator {
  constructor(private readonly core: ConversationRuntimeCore) {}

  cancelSkillCatalog(sessionId: string): void {
    for (const owner of this.core.skillDiscoveries.values()) {
      if (owner.sessionId === sessionId)
        for (const reader of owner.readers)
          if (!reader.reserved && !reader.documentRead) reader.cancel()
    }
  }

  cancelSkillDocument(requestId: string): void {
    if (this.core.skillDocumentOwner?.requestId === requestId)
      this.core.skillDocumentOwner.controller.abort()
  }

  async readSkillDocument(input: SkillDocumentRead): Promise<RpcResult<SkillDocument>> {
    if (this.core.gate.nativeQuitSealed()) return this.core.quitPrepared()
    if (this.core.disposed || this.core.skillDocumentOwner)
      return {
        ok: false,
        error: {
          code: 'RUNTIME_UNAVAILABLE',
          message: 'The previous document read is still settling. Try again shortly.',
        },
      }
    const controller = new AbortController()
    const cancelled = Promise.withResolvers<RpcResult<SkillDocument>>()
    const abort = (): void =>
      cancelled.resolve({
        ok: false,
        error: { code: 'TIMEOUT', message: 'Skill document reading was cancelled or timed out.' },
      })
    controller.signal.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(
      () => controller.abort(),
      input.agentId === 'agy' ? AGY_SKILL_DOCUMENT_OPERATION_MS : 10_000,
    )
    const task = (async (): Promise<RpcResult<SkillDocument>> => {
      const catalog = await this.skillBindings(
        input.sessionId,
        input.agentId,
        controller.signal,
        false,
        false,
        true,
      )
      controller.signal.throwIfAborted()
      const binding = catalog.find((entry) => entry.id === input.skillId)
      if (!binding)
        return {
          ok: false,
          error: {
            code: 'CONFLICT',
            message: 'This Skill changed in its native catalog. Select it again.',
          },
        }
      if (!binding.path)
        return {
          ok: true,
          value: skillDocumentSchema.parse({
            status: 'unavailable',
            agentId: input.agentId,
            skillId: input.skillId,
            name: binding.name,
            reason: 'native_document_not_exposed',
            description: binding.description,
            argumentHint: binding.argumentHint,
          }),
        }
      if (!isAbsolute(binding.path) || basename(binding.path).toLowerCase() !== 'skill.md')
        return {
          ok: false,
          error: {
            code: 'VALIDATION',
            message: 'The native runtime did not provide a valid SKILL.md path.',
          },
        }
      const file = await this.core.projectFiles.read({
        sessionId: input.sessionId,
        path: binding.path,
      })
      controller.signal.throwIfAborted()
      if (!file.ok) return file
      return {
        ok: true,
        value: skillDocumentSchema.parse({
          status: 'available',
          agentId: input.agentId,
          skillId: input.skillId,
          name: binding.name,
          content: file.value.content,
          contentHash: file.value.contentHash,
          updatedAt: file.value.updatedAt,
        }),
      }
    })()
      .catch((): RpcResult<SkillDocument> => ({
        ok: false,
        error: {
          code: 'RUNTIME_UNAVAILABLE',
          message: 'The native Skill document could not be read.',
        },
      }))
      .finally(() => {
        clearTimeout(timer)
        controller.signal.removeEventListener('abort', abort)
        if (this.core.skillDocumentOwner?.requestId === input.requestId)
          this.core.skillDocumentOwner = undefined
      })
    // Logical cancellation never releases a still-active filesystem read's physical capacity.
    this.core.skillDocumentOwner = { requestId: input.requestId, controller, task }
    return Promise.race([task, cancelled.promise])
  }

  async readSkillCatalog(input: SkillCatalogRead): Promise<RpcResult<SkillCatalogPage>> {
    if (this.core.gate.nativeQuitSealed()) return this.core.quitPrepared()
    try {
      const entries = await this.skillBindings(
        input.sessionId,
        input.agentId,
        undefined,
        input.refresh,
      )
      const snapshot = this.core.skillCatalogs.get(`${input.sessionId}:${input.agentId}`)!
      if (input.generation && input.generation !== snapshot.generation)
        return {
          ok: false,
          error: { code: 'CONFLICT', message: 'The native Skill catalog changed. Search again.' },
        }
      const query = input.query.toLocaleLowerCase()
      const names = input.names ? new Set(input.names) : undefined
      const filtered = entries.filter((entry) =>
        names
          ? names.has(entry.name)
          : `${entry.name} ${entry.description}`.toLocaleLowerCase().includes(query),
      )
      const page: SkillCatalogPage = {
        agentId: input.agentId,
        generation: snapshot.generation,
        checkedAt: snapshot.checkedAt,
        skills: [],
        total: filtered.length,
        nextOffset: null,
      }
      for (const entry of filtered.slice(input.offset, input.offset + SKILL_PAGE_ITEMS)) {
        const { path: _path, ...projection } = entry
        page.skills.push(projection)
        if (Buffer.byteLength(JSON.stringify(page)) > SKILL_PAGE_BYTES - 128) {
          page.skills.pop()
          break
        }
      }
      if (input.offset + page.skills.length < filtered.length)
        page.nextOffset = input.offset + page.skills.length
      return { ok: true, value: skillCatalogPageSchema.parse(page) }
    } catch (error) {
      return {
        ok: false,
        error: {
          code: 'RUNTIME_UNAVAILABLE',
          message:
            error instanceof RunOperationConflictError
              ? error.message
              : 'Native Skill discovery is unavailable. Open / again to refresh its catalog.',
        },
      }
    }
  }

  async skillBindings(
    sessionId: string,
    agentId: RuntimeAgentId,
    signal?: AbortSignal,
    refresh = false,
    reserved = false,
    documentRead = false,
  ): Promise<SkillBinding[]> {
    const key = `${sessionId}:${agentId}`
    signal?.throwIfAborted()
    const existing = this.core.skillDiscoveries.get(key)
    if (existing) {
      if (refresh && existing.usedCache) {
        await this.waitForSkillDiscovery(key, existing, signal, reserved, documentRead)
        return this.skillBindings(sessionId, agentId, signal, true, reserved, documentRead)
      }
      if (refresh) existing.refresh = true
      return this.waitForSkillDiscovery(key, existing, signal, reserved, documentRead)
    }
    if (
      this.core.skillDiscoveries.size >= 2 ||
      (!reserved && this.core.gate.operationCount() >= MAX_AGENT_OPERATIONS)
    )
      throw new Error('Native Skill discovery is busy. Try again when current work settles.')
    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(),
      agentId === 'agy' ? AGY_SKILL_DISCOVERY_OPERATION_MS : 10_000,
    )
    let currentKey = ''
    const task = (async () => {
      const executablePath = await this.core.runtimePreparation.findRecoveryExecutable(
        agentId,
        controller.signal,
      )
      controller.signal.throwIfAborted()
      const executable = executablePath ? await realpath(executablePath) : undefined
      controller.signal.throwIfAborted()
      const executableInfo = executable ? await stat(executable) : undefined
      controller.signal.throwIfAborted()
      const executableGeneration = [executable, executableInfo?.size, executableInfo?.mtimeMs]
      const currentSession = this.core.sessions.find(sessionId)
      const binding = this.core.conversations.nativeContext(sessionId, agentId)
      const adapterEntry = this.core.adapters.get(key)
      currentKey = JSON.stringify([
        executableGeneration,
        currentSession?.projectId,
        currentSession?.settingsRevision,
        binding?.bindingGeneration,
        adapterEntry?.executablePath,
        adapterEntry?.cwd,
        adapterEntry?.adapter.executorId,
      ])
      const cached = this.core.skillCatalogs.get(key)
      if (
        !this.core.skillDiscoveries.get(key)?.refresh &&
        cached &&
        cached.key === currentKey &&
        cached.expiresAt > Date.now()
      ) {
        if (cached.failure)
          throw new Error('Native Skill discovery is temporarily unavailable. Try again shortly.')
        const owner = this.core.skillDiscoveries.get(key)
        if (owner) owner.usedCache = true
        return cached.entries
      }

      const context = await this.core.prepareSession(sessionId, controller.signal, [agentId])
      if (!context.ok) throw new Error(context.error.message)
      const adapter = await this.core.adapterFor(
        sessionId,
        agentId,
        context.value.executablePaths[agentId],
        controller.signal,
        context.value.projectDirectory,
      )
      if (!adapter.discoverSkills) throw new Error('This runtime cannot discover native Skills.')
      const entries = await adapter.discoverSkills(
        context.value.projectDirectory,
        controller.signal,
      )
      controller.signal.throwIfAborted()
      if (this.core.skillDiscoveries.get(key)?.invalidated)
        throw new Error('The native Skill catalog changed during discovery.')
      const refreshedKey = JSON.stringify([
        executableGeneration,
        currentSession?.projectId,
        currentSession?.settingsRevision,
        binding?.bindingGeneration,
        context.value.executablePaths[agentId],
        context.value.projectDirectory,
        adapter.executorId,
      ])
      // A verified identical refresh must not invalidate an open reader's pagination token.
      // Native invalidation, environment changes or any effective binding change still replace it.
      const unchanged =
        cached &&
        !cached.failure &&
        this.core.skillCatalogs.get(key) === cached &&
        cached.key === refreshedKey &&
        cached.entries.length === entries.length &&
        cached.entries.every((entry, index) => entry.id === entries[index]?.id)
      this.core.skillCatalogs.delete(key)
      while (this.core.skillCatalogs.size >= 4)
        this.core.skillCatalogs.delete(this.core.skillCatalogs.keys().next().value!)
      this.core.skillCatalogs.set(key, {
        key: refreshedKey,
        generation: unchanged ? cached.generation : randomUUID(),
        checkedAt: new Date().toISOString(),
        expiresAt: Date.now() + 30_000,
        entries,
      })
      return entries
    })()
      .catch((error: unknown) => {
        while (this.core.skillCatalogs.size >= 4 && !this.core.skillCatalogs.has(key))
          this.core.skillCatalogs.delete(this.core.skillCatalogs.keys().next().value!)
        if (!controller.signal.aborted && !this.core.disposed)
          this.core.skillCatalogs.set(key, {
            generation: randomUUID(),
            key: currentKey,
            checkedAt: new Date().toISOString(),
            expiresAt: Date.now() + 5_000,
            entries: [],
            failure: true,
          })
        throw error
      })
      .finally(() => {
        clearTimeout(timer)
        this.core.skillDiscoveries.delete(key)
      })
    const owner = {
      sessionId,
      agentId,
      controller,
      refresh,
      readers: new Set<{ reserved: boolean; documentRead: boolean; cancel: () => void }>(),
      task,
    }
    this.core.skillDiscoveries.set(key, owner)
    controller.signal.addEventListener(
      'abort',
      () => {
        for (const reader of owner.readers) reader.cancel()
      },
      { once: true },
    )
    return this.waitForSkillDiscovery(key, owner, signal, reserved, documentRead)
  }

  private waitForSkillDiscovery(
    key: string,
    owner: {
      controller: AbortController
      readers: Set<{ reserved: boolean; documentRead: boolean; cancel: () => void }>
      task: Promise<SkillBinding[]>
    },
    signal: AbortSignal | undefined,
    reserved: boolean,
    documentRead = false,
  ): Promise<SkillBinding[]> {
    if (owner.controller.signal.aborted)
      return Promise.reject(
        new Error(
          'The native Skill reader is still releasing its previous actor. Try again after it settles.',
        ),
      )
    if (owner.readers.size >= 4)
      return Promise.reject(
        new Error('Too many readers are waiting for this native Skill catalog.'),
      )
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (error: unknown, value?: SkillBinding[]): void => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', reader.cancel)
        owner.readers.delete(reader)
        if (!owner.readers.size && this.core.skillDiscoveries.get(key) === owner)
          owner.controller.abort()
        if (error) reject(error)
        else resolve(value!)
      }
      const reader = {
        reserved,
        documentRead,
        cancel: () => finish(new Error('Native Skill reading was cancelled.')),
      }
      owner.readers.add(reader)
      signal?.addEventListener('abort', reader.cancel, { once: true })
      if (signal?.aborted || owner.controller.signal.aborted) reader.cancel()
      void owner.task.then(
        (value) => finish(undefined, value),
        (error: unknown) => finish(error),
      )
    })
  }

  async prepareSkillInvocation(
    input: Pick<ConversationSendInput, 'sessionId' | 'content' | 'skills'>,
    targets: RuntimeAgentId[],
    signal: AbortSignal,
  ): Promise<FrozenSkillInvocation | undefined> {
    const prefix = parseComposerCommandPrefix(input.content, input.skills)
    if (prefix.error) throw new RunOperationConflictError(prefix.error)
    if (prefix.btw)
      throw new RunOperationConflictError(
        '/btw opens a side chat instead of sending a regular message.',
      )
    const selections = input.skills ?? []
    const names = [
      ...new Set([
        ...prefix.skills.map((entry) => entry.name),
        ...selections.map((entry) => entry.name),
      ]),
    ]
    if (!names.length) return undefined
    for (const selection of selections) {
      if (input.content.slice(selection.start, selection.end) !== `/${selection.name}`)
        throw new RunOperationConflictError('The selected Skill token changed. Select it again.')
      if (!targets.includes(selection.agentId))
        throw new RunOperationConflictError(
          `/${selection.name} belongs to ${agentDisplayName(selection.agentId)}, not the message target.`,
        )
    }
    const bindings: SkillBinding[] = []
    for (const target of targets) {
      // Serial cold reads respect the shared finite Native-operation capacity.
      // oxlint-disable-next-line no-await-in-loop -- The routed Send reuses one reservation for serial Native preparation.
      const catalog = await this.skillBindings(input.sessionId, target, signal, true, true)
      for (const name of names) {
        const entry = catalog.find((candidate) => candidate.name === name)
        if (!entry)
          throw new RunOperationConflictError(
            `/${name} is unavailable for ${agentDisplayName(target)}.`,
          )
        if (
          selections.some(
            (item) => item.name === name && item.agentId === target && item.id !== entry.id,
          )
        )
          throw new RunOperationConflictError(
            `/${name} changed in its native catalog. Select it again.`,
          )
        bindings.push(entry)
      }
    }
    return frozenSkillInvocationSchema.parse({
      version: 'pact-skills-v1',
      arguments: skillArguments(input.content, selections),
      selections,
      bindings,
    })
  }
}
