import { spawn, type ChildProcess, type SpawnOptionsWithoutStdio } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { AgentNativeContextRebuildInput } from '../../packages/agent-runtime/src/index.js'
import type { NativeContextRebuildChunk } from '../../packages/contracts/src/index.js'

import {
  actualSdk,
  boundedNativeText,
  buildAdapters,
  executable,
  hash,
  isolatedEnv,
  LoopbackProvider,
  NativeRpc,
  ownedRoot,
  recordSdkVersion,
  result,
  within,
  type ForkInput,
  type NativeAdapter,
  type NativeThread,
  type SdkQueryInput,
} from './native-harness.js'

let bundle: Awaited<ReturnType<typeof buildAdapters>>
let buildRoot: string
let codexExecutable: string
let claudeExecutable: string
beforeAll(async () => {
  const owned = await ownedRoot()
  buildRoot = owned.root
  // Missing/unrecognized real binaries fail, rather than silently using Fake CLI.
  codexExecutable = await executable('codex', owned)
  claudeExecutable = await executable('claude', owned)
  await recordSdkVersion()
  bundle = await buildAdapters(buildRoot)
})
afterAll(async () => {
  if (buildRoot) await rm(buildRoot, { recursive: true, force: true })
})

describe('real Claude Code / production Adapter zero-prompt Fork settings', () => {
  it.each([
    { model: 'opus', effort: 'high', alias: 'pact-fixture-alpha[1m]', expectedEffort: 'high' },
    { model: 'sonnet', effort: 'medium', alias: 'pact-fixture-beta', expectedEffort: 'medium' },
    { model: null, effort: null, alias: 'pact-fixture-native-default', expectedEffort: 'max' },
  ] as const)(
    'reads back $model/$effort with owned settings.env=max and alias=$alias',
    async ({ model, effort, alias, expectedEffort }) => {
      const owned = await ownedRoot()
      const provider = new LoopbackProvider()
      const sdk = actualSdk()
      const previousConfig = process.env.CLAUDE_CONFIG_DIR
      const children = new Set<ChildProcess>()
      const exits: Promise<void>[] = []
      let adapter: NativeAdapter | undefined
      let cold: NativeAdapter | undefined
      let applied: { model?: string; effort?: string } | undefined
      let queryOptions: SdkQueryInput['options'] | undefined
      let stdoutBytes = 0
      const controller = new AbortController()
      const deadline = setTimeout(() => controller.abort(), 25_000)
      try {
        await provider.start()
        process.env.CLAUDE_CONFIG_DIR = owned.home
        await writeFile(
          join(owned.home, 'settings.json'),
          JSON.stringify({
            env: {
              CLAUDE_CODE_EFFORT_LEVEL: 'max',
              ANTHROPIC_MODEL: alias,
              ANTHROPIC_DEFAULT_OPUS_MODEL: alias,
              ANTHROPIC_DEFAULT_SONNET_MODEL: alias,
            },
          }),
        )
        const id = randomUUID(),
          user = randomUUID(),
          assistant = randomUUID(),
          timestamp = new Date().toISOString()
        const project = join(
          owned.home,
          'projects',
          (await realpath(owned.cwd)).replace(/[^a-zA-Z0-9]/gu, '-'),
        )
        await mkdir(project, { recursive: true })
        const sourcePath = join(project, `${id}.jsonl`)
        await writeFile(
          sourcePath,
          [
            {
              type: 'user',
              uuid: user,
              parentUuid: null,
              sessionId: id,
              timestamp,
              cwd: owned.cwd,
              message: { role: 'user', content: 'NATIVE_OWNED_INPUT' },
            },
            {
              type: 'assistant',
              uuid: assistant,
              parentUuid: user,
              sessionId: id,
              timestamp,
              cwd: owned.cwd,
              message: {
                role: 'assistant',
                id: 'owned_reply',
                content: [{ type: 'text', text: 'NATIVE_OWNED_REPLY' }],
                model: alias,
                stop_reason: 'end_turn',
                usage: { input_tokens: 0, output_tokens: 0 },
              },
            },
          ]
            .map((value) => JSON.stringify(value))
            .join('\n') + '\n',
        )
        const sourceHash = hash(await boundedNativeText(sourcePath, owned.home))
        const dependencies = {
          getSessionInfo: sdk.getSessionInfo,
          query: (input: SdkQueryInput) => {
            queryOptions = input.options
            return sdk.query({
              ...input,
              options: {
                ...input.options,
                env: { ...isolatedEnv(owned.root, owned.home), ANTHROPIC_BASE_URL: provider.url },
              },
            })
          },
          spawn: (command: string, args: string[], options: Parameters<typeof spawn>[2]) => {
            if (children.size >= 4) throw new Error('Owned Claude child capacity exceeded')
            const child = spawn(command, args, options)
            children.add(child)
            const exit = new Promise<void>((resolveExit) => {
              child.once('exit', () => {
                children.delete(child)
                resolveExit()
              })
              child.once('error', () => {
                children.delete(child)
                resolveExit()
              })
            })
            exits.push(exit)
            let pending = ''
            child.stdout?.on('data', (chunk: Buffer) => {
              stdoutBytes += chunk.length
              if (stdoutBytes > 4 * 1024 * 1024) {
                child.kill('SIGTERM')
                return
              }
              pending += chunk.toString()
              if (Buffer.byteLength(pending) > 1024 * 1024) {
                child.kill('SIGTERM')
                return
              }
              for (;;) {
                const end = pending.indexOf('\n')
                if (end < 0) break
                const line = pending.slice(0, end)
                pending = pending.slice(end + 1)
                // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The bounded observer reads the SDK's actual child control reply; exact applied settings are asserted.
                const message = JSON.parse(line) as {
                  type: string
                  response?: {
                    request_id?: string
                    response?: { applied?: { model?: string; effort?: string } }
                  }
                }
                if (
                  message.type === 'control_response' &&
                  message.response?.request_id?.startsWith('pact-fork-settings-')
                )
                  applied = message.response.response?.applied
              }
            })
            return child
          },
        }
        adapter = new bundle.ClaudeAgentAdapter(claudeExecutable, dependencies)
        const source = await adapter.prepareNativeFork(
          {
            cwd: owned.cwd,
            nativeSessionId: id,
            nativeTurnId: user,
            runId: user,
            bindingGeneration: 1,
            throughSequence: 1,
            deliveryCursor: 1,
            responseHash: hash('NATIVE_OWNED_REPLY'),
          },
          controller.signal,
        )
        const candidateIds: string[] = []
        const input: ForkInput = {
          operationId: randomUUID(),
          sessionId: randomUUID(),
          cwd: owned.cwd,
          source,
          model,
          effort,
          permissionMode: 'native',
          onDispatched: async () => {},
          onCandidate: async (candidateId) => {
            candidateIds.push(candidateId)
          },
          reportNativeWork: () => {},
        }
        const fork = await adapter.forkNativeContext(input, controller.signal)
        const initialized = await adapter.initializeNativeFork(
          { ...input, nativeSessionId: fork.nativeSessionId, witness: fork.witness },
          controller.signal,
        )
        expect(applied).toMatchObject({ model: alias, effort: expectedEffort })
        expect(queryOptions?.effort ?? null).toBe(effort)
        expect(queryOptions?.settings?.env?.CLAUDE_CODE_EFFORT_LEVEL ?? null).toBe(effort)
        expect(initialized.witness.initializedAt).toBeTypeOf('string')
        expect(initialized.nativeSessionId).toBe(fork.nativeSessionId)
        expect(candidateIds.every((value) => value === fork.nativeSessionId)).toBe(true)
        expect(initialized.witness.sourcePrefixHash).toBe(source.prefixHash)
        cold = new bundle.ClaudeAgentAdapter(claudeExecutable, dependencies)
        const checked = await cold.inspectNativeFork(
          {
            ...input,
            nativeSessionId: initialized.nativeSessionId,
            witness: initialized.witness,
            lastDispatchedPhase: 'initialize',
          },
          controller.signal,
        )
        expect(checked).toMatchObject({
          kind: 'verified',
          ready: true,
          result: { nativeSessionId: initialized.nativeSessionId },
        })
        expect(hash(await boundedNativeText(sourcePath, owned.home))).toBe(sourceHash)
        expect(adapter.hasActiveBackgroundWork()).toBe(false)
        expect(provider.requests.filter((value) => value.method === 'POST')).toEqual([])
        expect(provider.errors).toEqual([])
        expect(children.size).toBe(0)
      } finally {
        controller.abort()
        clearTimeout(deadline)
        await cold?.dispose()
        await adapter?.dispose()
        for (const child of children) child.kill('SIGTERM')
        await within(Promise.all(exits), 1500, 'Owned Claude termination grace').catch(
          () => undefined,
        )
        for (const child of children) child.kill('SIGKILL')
        await Promise.all(exits)
        if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
        else process.env.CLAUDE_CONFIG_DIR = previousConfig
        await provider.close()
        await rm(owned.root, { recursive: true, force: true })
      }
    },
  )
})

async function writeTurn(client: NativeRpc, threadId: string, text: string): Promise<string> {
  const turn = result(
    await client.request<{ turn: { id: string } }>('turn/start', {
      threadId,
      input: [{ type: 'text', text, text_elements: [] }],
    }),
  ).turn
  await client.completed(threadId, turn.id)
  return turn.id
}

async function* emptySource(): AsyncGenerator<NativeContextRebuildChunk> {
  const chunks: NativeContextRebuildChunk[] = []
  yield* chunks
}

it.each([
  { agent: 'claude', workspace: false },
  { agent: 'codex', workspace: false },
  { agent: 'codex', workspace: true },
] as const)(
  'real $agent production Adapter initializes an empty Rebuild; explicit workspace=$workspace',
  async ({ agent, workspace }) => {
    const owned = await ownedRoot()
    const provider = new LoopbackProvider()
    const previousConfig = process.env.CLAUDE_CONFIG_DIR
    const children = new Set<ChildProcess>()
    const exits: Promise<void>[] = []
    const adapters: NativeAdapter[] = []
    const controller = new AbortController()
    const deadline = setTimeout(() => controller.abort(), 25_000)
    try {
      await provider.start()
      await provider.configureCodex(owned.home)
      if (workspace)
        await appendFile(
          join(owned.home, 'config.toml'),
          '\n[sandbox_workspace_write]\nwritable_roots = []\nnetwork_access = false\n',
        )
      process.env.CLAUDE_CONFIG_DIR = owned.home
      const env = { ...isolatedEnv(owned.root, owned.home), ANTHROPIC_BASE_URL: provider.url }
      const configReader = new NativeRpc(codexExecutable, owned.cwd, env)
      try {
        await configReader.initialize()
        const config = result(
          await configReader.request<{ config: { sandbox_workspace_write: unknown } }>(
            'config/read',
            { cwd: owned.cwd, includeLayers: false },
          ),
        ).config
        const explicitWorkspace = expect.objectContaining({
          writable_roots: [],
          network_access: false,
        })
        expect(config.sandbox_workspace_write).toEqual(workspace ? explicitWorkspace : null)
      } finally {
        await configReader.close()
      }
      const start = (
        command: string,
        args: readonly string[],
        options: SpawnOptionsWithoutStdio,
      ) => {
        if (children.size >= 4) throw new Error('Owned empty Rebuild child capacity exceeded')
        const child = spawn(command, args, options)
        children.add(child)
        exits.push(
          new Promise<void>((resolveExit) => {
            const end = () => {
              children.delete(child)
              resolveExit()
            }
            child.once('exit', end)
            child.once('error', end)
          }),
        )
        return child
      }
      const sdk = actualSdk()
      const makeAdapter = (): NativeAdapter => {
        const adapter =
          agent === 'claude'
            ? new bundle.ClaudeAgentAdapter(claudeExecutable, {
                getSessionInfo: sdk.getSessionInfo,
                query: (input: SdkQueryInput) =>
                  sdk.query({ ...input, options: { ...input.options, env } }),
                spawn: start,
              })
            : new bundle.CodexAgentAdapter(
                codexExecutable,
                (cwd) =>
                  start(codexExecutable, ['app-server'], {
                    cwd,
                    env,
                    shell: false,
                    stdio: ['pipe', 'pipe', 'pipe'],
                  }),
                { storageRoot: owned.home },
              )
        adapters.push(adapter)
        return adapter
      }
      const input: AgentNativeContextRebuildInput = {
        rebuildId: randomUUID(),
        sessionId: randomUUID(),
        cwd: owned.cwd,
        model: null,
        effort: null,
        permissionMode: 'ask',
        sourceHash: hash('[]'),
        ...(agent === 'claude' ? { nativeSessionId: randomUUID() } : {}),
      }
      const adapter = makeAdapter()
      const initialized = await adapter.rebuildNativeContext(
        input,
        emptySource(),
        controller.signal,
      )
      expect(initialized.nativeSessionId).toBeTruthy()
      expect(adapter.hasActiveBackgroundWork()).toBe(false)
      await adapter.dispose()
      const cold = makeAdapter()
      const probe = () =>
        cold.probeNativeStatus(
          {
            target: 'initialized_binding',
            sessionId: input.sessionId,
            agentId: agent,
            requestId: randomUUID(),
            nativeSessionId: initialized.nativeSessionId,
            bindingGeneration: 2,
            cwd: owned.cwd,
            model: null,
            effort: null,
            confirmedInitialization: {
              rebuildId: input.rebuildId,
              sourceHash: input.sourceHash!,
              ...(initialized.initializationWitness
                ? { witness: initialized.initializationWitness }
                : {}),
            },
            source: emptySource(),
          },
          controller.signal,
        )
      await expect(probe()).resolves.toMatchObject({
        kind: 'binding_ready',
        source: 'completed_initialization_readback',
      })
      const path =
        agent === 'claude'
          ? join(
              owned.home,
              'projects',
              (await realpath(owned.cwd)).replace(/[^a-zA-Z0-9]/gu, '-'),
              `${initialized.nativeSessionId}.jsonl`,
            )
          : result(
              await (async () => {
                const reader = new NativeRpc(codexExecutable, owned.cwd, env)
                try {
                  await reader.initialize()
                  return await reader.request<{ thread: NativeThread }>('thread/read', {
                    threadId: initialized.nativeSessionId,
                    includeTurns: false,
                  })
                } finally {
                  await reader.close()
                }
              })(),
            ).thread.path
      const original = await boundedNativeText(path, owned.home)
      expect(original).toContain('pactContext')
      expect(original).toContain(input.rebuildId)
      expect(original).toContain(input.sourceHash!)
      // oxlint-disable no-await-in-loop -- Mutate and read one owned manifest at a time; parallel reads would observe another mutation.
      for (const changed of [
        original.replaceAll(input.sourceHash!, 'b'.repeat(64)),
        original.replaceAll(input.rebuildId, randomUUID()),
        original
          .split('\n')
          .filter((line) => !line.includes('pactContext'))
          .join('\n'),
      ]) {
        expect(changed).not.toBe(original)
        await writeFile(path, changed)
        await expect(probe()).resolves.toMatchObject({ kind: 'no_evidence' })
      }
      // oxlint-enable no-await-in-loop
      await writeFile(path, original)
      await expect(probe()).resolves.toMatchObject({ kind: 'binding_ready' })
      expect(provider.requests.filter((request) => request.method === 'POST')).toHaveLength(0)
      expect(provider.errors).toEqual([])
      expect(cold.hasActiveBackgroundWork()).toBe(false)
    } finally {
      controller.abort()
      clearTimeout(deadline)
      // oxlint-disable-next-line no-await-in-loop -- Release each owned Native writer before disposing the next owner.
      for (const adapter of adapters) await adapter.dispose()
      for (const child of children) child.kill('SIGTERM')
      await within(Promise.all(exits), 1500, 'Owned empty Rebuild termination grace').catch(
        () => undefined,
      )
      for (const child of children) child.kill('SIGKILL')
      await Promise.all(exits)
      if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previousConfig
      await provider.close()
      await rm(owned.root, { recursive: true, force: true })
    }
  },
)

it('real default paginated Codex writer → production selected true Fork → cold verification → Fork of Fork', async () => {
  const owned = await ownedRoot()
  const provider = new LoopbackProvider(['NATIVE_FIRST_REPLY', 'NATIVE_LATER_REPLY'])
  const clients: NativeRpc[] = []
  const adapters: NativeAdapter[] = []
  const children = new Set<ChildProcess>()
  const exits: Promise<void>[] = []
  const controller = new AbortController()
  const deadline = setTimeout(() => controller.abort(), 45_000)
  try {
    await provider.start()
    await provider.configureCodex(owned.home)
    const env = isolatedEnv(owned.root, owned.home)
    const writer = new NativeRpc(codexExecutable, owned.cwd, env)
    clients.push(writer)
    await writer.initialize()
    const sourceThread = result(
      await writer.request<{ thread: NativeThread }>('thread/start', {
        cwd: owned.cwd,
        ephemeral: false,
        model: 'gpt-5.4',
        baseInstructions: 'Owned loopback fixture; never use tools or read files.',
      }),
    ).thread
    const firstTurn = await writeTurn(writer, sourceThread.id, 'NATIVE_FIRST_INPUT')
    const firstFile = await boundedNativeText(sourceThread.path, owned.home)
    const laterTurn = await writeTurn(writer, sourceThread.id, 'NATIVE_LATER_INPUT')
    const sourceRead = result(
      await writer.request<{ thread: NativeThread }>('thread/read', {
        threadId: sourceThread.id,
        includeTurns: false,
      }),
    ).thread
    expect(sourceRead.historyMode).toBe('paginated')
    expect(await boundedNativeText(sourceRead.path, owned.home)).toContain('NATIVE_OPAQUE_1')
    const sourceText = await boundedNativeText(sourceRead.path, owned.home)
    const sourceHash = hash(sourceText)
    await writer.close()
    const factory = (cwd: string) => {
      if (children.size >= 4) throw new Error('Owned Codex child capacity exceeded')
      const child = spawn(codexExecutable, ['app-server'], {
        cwd,
        env,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      children.add(child)
      exits.push(
        new Promise<void>((resolveExit) => {
          child.once('exit', () => {
            children.delete(child)
            resolveExit()
          })
          child.once('error', () => {
            children.delete(child)
            resolveExit()
          })
        }),
      )
      return child
    }
    const adapter = new bundle.CodexAgentAdapter(codexExecutable, factory, {
      storageRoot: owned.home,
    })
    adapters.push(adapter)
    const source = await adapter.prepareNativeFork(
      {
        cwd: owned.cwd,
        nativeSessionId: sourceThread.id,
        nativeTurnId: firstTurn,
        runId: randomUUID(),
        bindingGeneration: 1,
        throughSequence: 1,
        deliveryCursor: 1,
        responseHash: hash('NATIVE_FIRST_REPLY'),
      },
      controller.signal,
    )
    expect(source.prefixHash).toMatch(/^[a-f0-9]{64}$/u)
    expect(source.prefixBytes).toBe(Buffer.byteLength(firstFile))
    const candidates: string[] = []
    const input: ForkInput = {
      operationId: randomUUID(),
      sessionId: randomUUID(),
      cwd: owned.cwd,
      source,
      model: 'gpt-5.4',
      effort: 'high',
      permissionMode: 'ask',
      onDispatched: async () => {},
      onCandidate: async (id) => {
        candidates.push(id)
      },
      reportNativeWork: () => {},
    }
    const fork = await adapter.forkNativeContext(input, controller.signal)
    expect(fork.nativeSessionId).not.toBe(sourceThread.id)
    expect(fork.witness.initializedAt).toBeTypeOf('string')
    expect(fork.witness.candidatePrefixHash).toBe(source.prefixHash)
    expect(fork.witness.idMap).toEqual([[firstTurn, firstTurn]])
    const childFile = await boundedNativeText(fork.witness.nativePath!, owned.home)
    const childHeader: unknown = JSON.parse(childFile.split('\n')[0]!)
    expect(childHeader).toMatchObject({
      type: 'session_meta',
      payload: {
        history_base: {
          thread_id: sourceThread.id,
          end_byte_offset: Buffer.byteLength(firstFile),
          end_ordinal_exclusive: firstFile.trimEnd().split('\n').length,
        },
      },
    })
    expect(candidates.every((id) => id === fork.nativeSessionId)).toBe(true)
    expect(hash(await boundedNativeText(sourceRead.path, owned.home))).toBe(sourceHash)
    // Production cosmetic metadata while the original Fork creator owns its
    // writer: no resume, model request, lineage or physical-prefix mutation.
    if (!adapter.setNativeTitle) throw new Error('Production Codex metadata Interface is absent')
    const label = {
      nativeSessionId: fork.nativeSessionId,
      cwd: owned.cwd,
      title: '[Pact] Owned project · Native fork (fork)',
      isCurrent: () => true,
    }
    expect(await adapter.setNativeTitle(label, controller.signal)).toBe('synchronized')
    expect(await adapter.setNativeTitle(label, controller.signal)).toBe('synchronized')
    const metadataReader = new NativeRpc(codexExecutable, owned.cwd, env)
    clients.push(metadataReader)
    await metadataReader.initialize()
    const named = result(
      await metadataReader.request<{ thread: NativeThread }>('thread/read', {
        threadId: fork.nativeSessionId,
        includeTurns: false,
      }),
    ).thread
    expect(named.name).toBe(label.title)
    expect(hash(await boundedNativeText(fork.witness.nativePath!, owned.home))).toBe(
      hash(childFile),
    )
    const competing = await metadataReader.request('thread/resume', {
      threadId: fork.nativeSessionId,
      excludeTurns: true,
      cwd: owned.cwd,
    })
    expect(competing.error).toMatchObject({
      message: `thread ${fork.nativeSessionId} already has an active writer`,
    })
    expect(provider.requests).toHaveLength(2)
    await adapter.dispose()
    const cold = new bundle.CodexAgentAdapter(codexExecutable, factory, { storageRoot: owned.home })
    adapters.push(cold)
    // A matching visible reply is insufficient: a same-size encrypted-context
    // mutation in inherited physical bytes must revoke cold readiness.
    await writeFile(sourceRead.path, sourceText.replace('NATIVE_OPAQUE_1', 'NATIVE_OPAQUE_X'))
    try {
      const changedOpaque = await cold.inspectNativeFork(
        {
          ...input,
          nativeSessionId: fork.nativeSessionId,
          witness: fork.witness,
          lastDispatchedPhase: 'initialize',
        },
        controller.signal,
      )
      expect(changedOpaque).toMatchObject({ kind: 'unconfirmed' })
    } finally {
      await writeFile(sourceRead.path, sourceText)
    }
    const checked = await cold.inspectNativeFork(
      {
        ...input,
        nativeSessionId: fork.nativeSessionId,
        witness: fork.witness,
        lastDispatchedPhase: 'initialize',
      },
      controller.signal,
    )
    expect(checked).toMatchObject({
      kind: 'verified',
      ready: true,
      result: { nativeSessionId: fork.nativeSessionId },
    })
    if (!cold.setNativeTitle) throw new Error('Cold production Codex metadata Interface is absent')
    expect(
      await cold.setNativeTitle(
        { ...label, title: '[Pact] Owned project · Renamed fork' },
        controller.signal,
      ),
    ).toBe('synchronized')
    const coldNamed = result(
      await metadataReader.request<{ thread: NativeThread }>('thread/read', {
        threadId: fork.nativeSessionId,
        includeTurns: false,
      }),
    ).thread
    expect(coldNamed.name).toBe('[Pact] Owned project · Renamed fork')
    expect(hash(await boundedNativeText(fork.witness.nativePath!, owned.home))).toBe(
      hash(childFile),
    )
    const childSource = await cold.prepareNativeFork(
      {
        cwd: owned.cwd,
        nativeSessionId: fork.nativeSessionId,
        nativeTurnId: firstTurn,
        runId: randomUUID(),
        bindingGeneration: 1,
        throughSequence: 1,
        deliveryCursor: 1,
        responseHash: hash('NATIVE_FIRST_REPLY'),
      },
      controller.signal,
    )
    const grandchild = await cold.forkNativeContext(
      { ...input, operationId: randomUUID(), source: childSource },
      controller.signal,
    )
    expect(grandchild.nativeSessionId).not.toBe(fork.nativeSessionId)
    expect(grandchild.witness.sourceNativeSessionId).toBe(fork.nativeSessionId)
    expect(grandchild.witness.candidatePrefixHash).toBe(source.prefixHash)
    expect(grandchild.witness.idMap).toEqual([[firstTurn, firstTurn]])
    expect(grandchild.witness.idMap.some(([id]) => id === laterTurn)).toBe(false)
    expect(provider.requests).toHaveLength(2)
    expect(provider.errors).toEqual([])
    expect(cold.hasActiveBackgroundWork()).toBe(false)
  } finally {
    controller.abort()
    clearTimeout(deadline)
    // oxlint-disable no-await-in-loop -- Each owner releases its Native writer before the next owner is disposed.
    for (const adapter of adapters) await adapter.dispose()
    for (const client of clients) await client.close()
    // oxlint-enable no-await-in-loop
    for (const child of children) child.kill('SIGTERM')
    await within(Promise.all(exits), 1500, 'Owned Codex termination grace').catch(() => undefined)
    for (const child of children) child.kill('SIGKILL')
    await Promise.all(exits)
    await provider.close()
    await rm(owned.root, { recursive: true, force: true })
  }
})

it('real Codex read-only Desktop client does not own a writer; competing live idle writer rejects and natural exit releases it', async () => {
  const owned = await ownedRoot()
  const provider = new LoopbackProvider(['NATIVE_WRITER_REPLY'])
  const clients: NativeRpc[] = []
  try {
    await provider.start()
    await provider.configureCodex(owned.home)
    const env = isolatedEnv(owned.root, owned.home)
    const creator = new NativeRpc(codexExecutable, owned.cwd, env)
    clients.push(creator)
    await creator.initialize()
    const thread = result(
      await creator.request<{ thread: NativeThread }>('thread/start', {
        cwd: owned.cwd,
        ephemeral: false,
        model: 'gpt-5.4',
        baseInstructions: 'Owned loopback fixture; never use tools.',
      }),
    ).thread
    await writeTurn(creator, thread.id, 'NATIVE_WRITER_INPUT')
    await creator.close()
    const desktop = new NativeRpc(codexExecutable, owned.cwd, {
      ...env,
      CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'Codex Desktop',
    })
    clients.push(desktop)
    await desktop.initialize()
    result(
      await desktop.request('thread/list', { useStateDbOnly: true, sourceKinds: [], limit: 25 }),
    )
    result(await desktop.request('thread/read', { threadId: thread.id, includeTurns: false }))
    result(await desktop.request('thread/read', { threadId: thread.id, includeTurns: true }))
    result(await desktop.request('thread/turns/list', { threadId: thread.id, limit: 25 }))
    const pact = new NativeRpc(codexExecutable, owned.cwd, env)
    clients.push(pact)
    await pact.initialize()
    const resumed = result(
      await pact.request<{ thread: NativeThread }>('thread/resume', {
        threadId: thread.id,
        excludeTurns: true,
        cwd: owned.cwd,
      }),
    ).thread
    expect(resumed.status.type).toBe('idle')
    expect(desktop.child.exitCode).toBeNull()
    const rejected = await desktop.request('thread/resume', {
      threadId: thread.id,
      excludeTurns: true,
      cwd: owned.cwd,
    })
    expect(rejected.error).toEqual({
      code: -32600,
      message: `thread ${thread.id} already has an active writer`,
    })
    expect(pact.child.exitCode).toBeNull()
    // stdin EOF is natural shutdown, not lock removal or forcibly stealing ownership.
    pact.child.stdin.end()
    await within(pact.exited, 5000, 'Owned writer did not exit naturally')
    expect(pact.child.exitCode).toBe(0)
    const afterExit = result(
      await desktop.request<{ thread: NativeThread }>('thread/resume', {
        threadId: thread.id,
        excludeTurns: true,
        cwd: owned.cwd,
      }),
    ).thread
    expect(afterExit.id).toBe(thread.id)
    expect(afterExit.status.type).toBe('idle')
    // Match the reported direction too: Desktop owns the now-resumed writer,
    // and a fresh Pact client must preserve that ownership rather than steal it.
    const nextPact = new NativeRpc(codexExecutable, owned.cwd, env)
    clients.push(nextPact)
    await nextPact.initialize()
    const pactRejected = await nextPact.request('thread/resume', {
      threadId: thread.id,
      excludeTurns: true,
      cwd: owned.cwd,
    })
    expect(pactRejected.error).toEqual({
      code: -32600,
      message: `thread ${thread.id} already has an active writer`,
    })
    expect(desktop.child.exitCode).toBeNull()
    desktop.child.stdin.end()
    await within(desktop.exited, 5000, 'Owned Desktop writer did not exit naturally')
    expect(desktop.child.exitCode).toBe(0)
    const pactAfterExit = result(
      await nextPact.request<{ thread: NativeThread }>('thread/resume', {
        threadId: thread.id,
        excludeTurns: true,
        cwd: owned.cwd,
      }),
    ).thread
    expect(pactAfterExit.id).toBe(thread.id)
    expect(pactAfterExit.status.type).toBe('idle')
    expect(provider.requests).toHaveLength(1)
    expect(provider.errors).toEqual([])
  } finally {
    // oxlint-disable-next-line no-await-in-loop -- Owned clients must release their writers sequentially.
    for (const client of clients) await client.close()
    await provider.close()
    await rm(owned.root, { recursive: true, force: true })
  }
})
