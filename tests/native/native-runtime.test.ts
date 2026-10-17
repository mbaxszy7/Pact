import type { spawn, ChildProcess, SpawnOptionsWithoutStdio } from 'node:child_process'

import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { appendFile, lstat, mkdir, realpath, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { AgentNativeContextRebuildInput } from '../../packages/agent-runtime/src/index.js'
import type { NativeContextRebuildChunk } from '../../packages/contracts/src/index.js'

import {
  actualSdk,
  boundedNativeText,
  cleanupNativeFixture,
  CODEX_SHUTDOWN_LOG_FILTER,
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
let buildOwned: Awaited<ReturnType<typeof ownedRoot>> | undefined
let fixtureOwnersReleased = true
async function finishFixture(
  owned: Awaited<ReturnType<typeof ownedRoot>>,
  options: Parameters<typeof cleanupNativeFixture>[1] = {},
): Promise<void> {
  try {
    await cleanupNativeFixture(owned, options)
  } catch (error) {
    fixtureOwnersReleased = false
    throw error
  }
}
let codexExecutable: string
let claudeExecutable: string
async function observeSdkProjectKey(
  sdk: ReturnType<typeof actualSdk>,
  sessionId: string,
  cwd: string,
): Promise<string> {
  let calls = 0
  let projectKey: string | undefined
  const messages = await sdk.getSessionMessages(sessionId, {
    dir: cwd,
    includeSystemMessages: true,
    sessionStore: {
      load: async (key) => {
        calls += 1
        if (
          calls !== 1 ||
          key.sessionId !== sessionId ||
          key.subpath !== undefined ||
          !/^[a-z0-9-]{1,256}$/iu.test(key.projectKey)
        )
          throw new Error('Read-only SDK namespace observer contract invalid')
        projectKey = key.projectKey
        return []
      },
      append: async () => {
        throw new Error('Read-only SDK namespace observer cannot append')
      },
    },
  })
  if (calls !== 1 || projectKey === undefined || messages.length !== 0)
    throw new Error('Read-only SDK namespace observer did not complete one empty lookup')
  return projectKey
}

async function sourceIdentity(path: string): Promise<object> {
  try {
    const info = await lstat(path, { bigint: true })
    return {
      exists: true,
      regularFile: info.isFile(),
      symlink: info.isSymbolicLink(),
      dev: String(info.dev),
      ino: String(info.ino),
      size: String(info.size),
    }
  } catch (error) {
    if (error instanceof Error && Reflect.get(error, 'code') === 'ENOENT') return { exists: false }
    throw error
  }
}

function nativeMessageContentHashes(text: string): string[] {
  return text
    .trimEnd()
    .split('\n')
    .flatMap((line) => {
      const record: unknown = JSON.parse(line)
      if (!record || typeof record !== 'object') return []
      const message: unknown = Reflect.get(record, 'message')
      if (!message || typeof message !== 'object') return []
      const content: unknown = Reflect.get(message, 'content')
      return content === undefined ? [] : [hash(JSON.stringify(content))]
    })
}

beforeAll(async () => {
  const setupDeadlineAt = performance.now() + 60_000
  const owned = await ownedRoot()
  buildRoot = owned.root
  buildOwned = owned
  // Missing/unrecognized real binaries fail, rather than silently using Fake CLI.
  codexExecutable = await executable('codex', owned, setupDeadlineAt)
  claudeExecutable = await executable('claude', owned, setupDeadlineAt)
  await recordSdkVersion()
  bundle = await buildAdapters(buildRoot)
}, 60_000)
afterAll(async () => {
  if (!fixtureOwnersReleased)
    throw new Error('Native adapter bundle retained while fixture cleanup is unconfirmed')
  if (buildOwned) await finishFixture(buildOwned)
})

describe('real Claude Code / production Adapter zero-prompt Fork settings', () => {
  it.each([
    {
      model: 'opus',
      effort: 'high',
      alias: 'pact-fixture-alpha[1m]',
      expectedEffort: 'high',
      longCwd: false,
    },
    {
      model: 'sonnet',
      effort: 'medium',
      alias: 'pact-fixture-beta',
      expectedEffort: 'medium',
      longCwd: false,
    },
    {
      model: null,
      effort: null,
      alias: 'pact-fixture-native-default',
      expectedEffort: 'max',
      longCwd: false,
    },
    {
      model: 'opus',
      effort: 'high',
      alias: 'pact-fixture-long-path',
      expectedEffort: 'high',
      longCwd: true,
    },
  ] as const)(
    'reads back $model/$effort with owned settings.env=max and alias=$alias',
    async ({ model, effort, alias, expectedEffort, longCwd }) => {
      const owned = await ownedRoot()
      const provider = new LoopbackProvider()
      const sdk = actualSdk()
      const previousConfig = process.env.CLAUDE_CONFIG_DIR
      const children = new Set<ChildProcess>()
      let adapter: NativeAdapter | undefined
      let cold: NativeAdapter | undefined
      let applied: { model?: string; effort?: string } | undefined
      let queryOptions: SdkQueryInput['options'] | undefined
      let stdoutBytes = 0
      type InitializationMoment =
        | 'queryEntered'
        | 'queryReturned'
        | 'childSpawn'
        | 'firstStdout'
        | 'stdoutEnd'
        | 'childExit'
        | 'childClose'
        | 'initializationReply'
        | 'settingsReply'
        | 'workUnknown'
        | 'workSettled'
        | 'initializedCandidate'
        | 'rejected'
      let initializationStartedAt: number | undefined
      const initializationMoments: Partial<Record<InitializationMoment, number>> = {}
      const initializationCounts = { queries: 0, spawns: 0, success: 0, error: 0, other: 0 }
      let initializationOverflow = false
      let settingsReply: 'unobserved' | 'success' | 'error' | 'other' = 'unobserved'
      const markInitialization = (moment: InitializationMoment): void => {
        if (initializationStartedAt !== undefined && initializationMoments[moment] === undefined)
          initializationMoments[moment] = Math.floor(performance.now() - initializationStartedAt)
      }
      const countInitialization = (counter: keyof typeof initializationCounts): void => {
        if (initializationStartedAt === undefined) return
        if (initializationCounts[counter] === 65_535) initializationOverflow = true
        else initializationCounts[counter] += 1
      }
      const controller = new AbortController()
      const deadlineAt = performance.now() + 25_000
      const deadline = setTimeout(() => controller.abort(), 25_000)
      try {
        if (longCwd) {
          const directory = join(
            owned.cwd,
            'native-long-namespace-' + 'x'.repeat(Math.max(1, 220 - owned.cwd.length - 22)),
          )
          await mkdir(directory, { recursive: true })
          owned.cwd = await realpath(directory)
          if (owned.cwd.length <= 200)
            throw new Error('Long native namespace fixture was not admitted')
        }
        await provider.start()
        await owned.processes.prepare(claudeExecutable, 4, deadlineAt)
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
        const fixtureKey = await observeSdkProjectKey(sdk, id, owned.cwd)
        const project = join(owned.home, 'projects', fixtureKey)
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
        const canonicalCwd = await realpath(owned.cwd)
        const sdkKey = await observeSdkProjectKey(sdk, id, owned.cwd)
        const canonicalSdkKey = await observeSdkProjectKey(sdk, id, canonicalCwd)
        console.info(
          '[native namespace]',
          JSON.stringify({
            phase: 'source-written-before-prepare',
            platform: process.platform,
            arch: process.arch,
            node: process.version,
            cwdHash: hash(owned.cwd),
            syncCanonicalHash: hash(realpathSync(owned.cwd)),
            promiseCanonicalHash: hash(canonicalCwd),
            fixtureKeyHash: hash(fixtureKey),
            sdkKeyHash: hash(sdkKey),
            canonicalSdkKeyHash: hash(canonicalSdkKey),
            sdkMatchesFixture: sdkKey === fixtureKey,
            canonicalSdkMatchesFixture: canonicalSdkKey === fixtureKey,
            sourceHash,
            fixtureSource: await sourceIdentity(sourcePath),
            sdkSource: await sourceIdentity(join(owned.home, 'projects', sdkKey, `${id}.jsonl`)),
            canonicalSdkSource: await sourceIdentity(
              join(owned.home, 'projects', canonicalSdkKey, `${id}.jsonl`),
            ),
          }),
        )
        const dependencies = {
          getSessionInfo: sdk.getSessionInfo,
          query: (input: SdkQueryInput) => {
            queryOptions = input.options
            countInitialization('queries')
            markInitialization('queryEntered')
            const query = sdk.query({
              ...input,
              options: {
                ...input.options,
                env: { ...isolatedEnv(owned.root, owned.home), ANTHROPIC_BASE_URL: provider.url },
              },
            })
            markInitialization('queryReturned')
            return query
          },
          spawn: (command: string, args: string[], options: Parameters<typeof spawn>[2]) => {
            if (children.size >= 4) throw new Error('Owned Claude child capacity exceeded')
            const child = owned.processes.spawn(command, args, options ?? {})
            countInitialization('spawns')
            children.add(child)
            child.once('spawn', () => markInitialization('childSpawn'))
            child.once('exit', () => markInitialization('childExit'))
            child.once('close', () => {
              markInitialization('childClose')
              children.delete(child)
            })
            child.stdout?.once('end', () => markInitialization('stdoutEnd'))
            let pending = ''
            child.stdout?.on('data', (chunk: Buffer) => {
              markInitialization('firstStdout')
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
                    subtype?: string
                    response?: {
                      applied?: { model?: string; effort?: string }
                      models?: unknown
                      current_permission_mode?: unknown
                    }
                  }
                }
                if (message.type === 'control_response') {
                  countInitialization(
                    message.response?.subtype === 'success'
                      ? 'success'
                      : message.response?.subtype === 'error'
                        ? 'error'
                        : 'other',
                  )
                  if (
                    message.response?.subtype === 'success' &&
                    Array.isArray(message.response.response?.models) &&
                    typeof message.response.response.current_permission_mode === 'string'
                  )
                    markInitialization('initializationReply')
                }
                if (
                  message.type === 'control_response' &&
                  message.response?.request_id?.startsWith('pact-fork-settings-')
                ) {
                  if (settingsReply === 'unobserved') {
                    markInitialization('settingsReply')
                    settingsReply =
                      message.response.subtype === 'success'
                        ? 'success'
                        : message.response.subtype === 'error'
                          ? 'error'
                          : 'other'
                  }
                  applied = message.response.response?.applied
                }
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
          onCandidate: async (candidateId, witness) => {
            candidateIds.push(candidateId)
            if (witness?.initializedAt) markInitialization('initializedCandidate')
          },
          reportNativeWork: (fact) => {
            if (fact.state === 'unknown') markInitialization('workUnknown')
            else if (fact.state === 'settled') markInitialization('workSettled')
          },
        }
        const fork = await adapter.forkNativeContext(input, controller.signal)
        initializationStartedAt = performance.now()
        let initialized: Awaited<ReturnType<NativeAdapter['initializeNativeFork']>>
        try {
          initialized = await adapter.initializeNativeFork(
            { ...input, nativeSessionId: fork.nativeSessionId, witness: fork.witness },
            controller.signal,
          )
        } catch (error) {
          markInitialization('rejected')
          try {
            const snapshot = JSON.stringify({
              schemaVersion: 1,
              momentsMs: initializationMoments,
              counts: initializationCounts,
              settingsReply,
              stdoutBytes,
              activeChildren: children.size,
              overflow: initializationOverflow,
            })
            console.info(
              '[native fork initialization]',
              Buffer.byteLength(snapshot) <= 4 * 1024
                ? snapshot
                : JSON.stringify({ schemaVersion: 1, overflow: true }),
            )
          } catch {
            // Optional fixed facts cannot replace the original initialization failure.
          }
          throw error
        }
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
        if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
        else process.env.CLAUDE_CONFIG_DIR = previousConfig
        await finishFixture(owned, {
          adapters: [cold, adapter].filter((value): value is NativeAdapter => Boolean(value)),
          provider,
        })
      }
    },
  )
})

it.each([{ longCwd: false }, { longCwd: true }])(
  'real Claude CLI resumes the selected Fork prefix and appends into its original witness; long cwd=$longCwd',
  async ({ longCwd }) => {
    const owned = await ownedRoot()
    const sdk = actualSdk()
    const historicalUser = 'NATIVE_RESUME_ORIGINAL_USER_COMPLETE'
    const historicalAssistant = 'NATIVE_RESUME_ORIGINAL_ASSISTANT_COMPLETE'
    const cutoffCanary = 'NATIVE_RESUME_EXCLUDED_LATER_CANARY'
    const promptUuid = randomUUID()
    const prompt = `NATIVE_RESUME_NEW_PROMPT_${promptUuid}`
    const reply = 'NATIVE_RESUME_LOOPBACK_ASSISTANT_COMPLETE'
    const sourceContentHashes: string[] = [],
      candidateContentHashes: string[] = []
    const provider = new LoopbackProvider([reply], {
      mode: 'claude',
      historicalUser,
      historicalAssistant,
      prompt,
      cutoffCanary,
      sourceContentHashes,
      candidateContentHashes,
    })
    const previousConfig = process.env.CLAUDE_CONFIG_DIR
    const children = new Set<ChildProcess>()
    const closed: Array<Promise<void>> = []
    const admitted: ChildProcess[] = []
    const adapters: NativeAdapter[] = []
    let session: ReturnType<ReturnType<typeof actualSdk>['query']> | undefined
    let verified = false
    const controller = new AbortController()
    const deadlineAt = performance.now() + 25_000
    const deadline = setTimeout(() => controller.abort(), 25_000)
    try {
      if (longCwd) {
        const directory = join(
          owned.cwd,
          'native-resume-namespace-' + 'x'.repeat(Math.max(1, 220 - owned.cwd.length - 24)),
        )
        await mkdir(directory, { recursive: true })
        owned.cwd = await realpath(directory)
        if (owned.cwd.length <= 200)
          throw new Error('Long Claude resume namespace fixture was not admitted')
      }
      await provider.start()
      await owned.processes.prepare(claudeExecutable, 4, deadlineAt)
      process.env.CLAUDE_CONFIG_DIR = owned.home
      const env = { ...isolatedEnv(owned.root, owned.home), ANTHROPIC_BASE_URL: provider.url }
      const spawnOwned = (
        command: string,
        args: string[],
        options: Parameters<typeof spawn>[2],
      ) => {
        if (children.size >= 4) throw new Error('Owned Claude child capacity exceeded')
        const child = owned.processes.spawn(command, args, options ?? {})
        children.add(child)
        admitted.push(child)
        closed.push(
          new Promise<void>((done) => {
            child.once('close', () => {
              children.delete(child)
              done()
            })
          }),
        )
        return child
      }
      const dependencies = {
        getSessionInfo: sdk.getSessionInfo,
        query: (input: SdkQueryInput) =>
          sdk.query({ ...input, options: { ...input.options, env } }),
        spawn: spawnOwned,
      }
      const sourceId = randomUUID()
      const user = randomUUID(),
        assistant = randomUUID(),
        laterUser = randomUUID(),
        laterAssistant = randomUUID(),
        timestamp = new Date().toISOString()
      const projectKey = await observeSdkProjectKey(sdk, sourceId, owned.cwd)
      const project = join(owned.home, 'projects', projectKey)
      await mkdir(project, { recursive: true })
      const sourcePath = join(project, `${sourceId}.jsonl`)
      await writeFile(
        sourcePath,
        [
          {
            type: 'user',
            uuid: user,
            parentUuid: null,
            sessionId: sourceId,
            timestamp,
            cwd: owned.cwd,
            message: { role: 'user', content: historicalUser },
          },
          {
            type: 'assistant',
            uuid: assistant,
            parentUuid: user,
            sessionId: sourceId,
            timestamp,
            cwd: owned.cwd,
            message: {
              role: 'assistant',
              id: 'msg_pact_native_historical_1',
              content: [{ type: 'text', text: historicalAssistant }],
              model: 'claude-sonnet-4-6',
              stop_reason: 'end_turn',
              usage: { input_tokens: 0, output_tokens: 0 },
            },
          },
          {
            type: 'user',
            uuid: laterUser,
            parentUuid: assistant,
            sessionId: sourceId,
            timestamp,
            cwd: owned.cwd,
            message: { role: 'user', content: cutoffCanary },
          },
          {
            type: 'assistant',
            uuid: laterAssistant,
            parentUuid: laterUser,
            sessionId: sourceId,
            timestamp,
            cwd: owned.cwd,
            message: {
              role: 'assistant',
              id: 'msg_pact_native_excluded_1',
              content: [{ type: 'text', text: cutoffCanary }],
              model: 'claude-sonnet-4-6',
              stop_reason: 'end_turn',
              usage: { input_tokens: 0, output_tokens: 0 },
            },
          },
        ]
          .map((value) => JSON.stringify(value))
          .join('\n') + '\n',
      )
      const sourceHash = hash(await boundedNativeText(sourcePath, owned.home))
      sourceContentHashes.push(
        ...nativeMessageContentHashes(await boundedNativeText(sourcePath, owned.home)),
      )
      const adapter = new bundle.ClaudeAgentAdapter(claudeExecutable, dependencies)
      adapters.push(adapter)
      const source = await adapter.prepareNativeFork(
        {
          cwd: owned.cwd,
          nativeSessionId: sourceId,
          nativeTurnId: user,
          runId: user,
          bindingGeneration: 1,
          throughSequence: 1,
          deliveryCursor: 1,
          responseHash: hash(historicalAssistant),
        },
        controller.signal,
      )
      const input: ForkInput = {
        operationId: randomUUID(),
        sessionId: randomUUID(),
        cwd: owned.cwd,
        source,
        model: 'sonnet',
        effort: 'low',
        permissionMode: 'native',
        onDispatched: async () => {},
        onCandidate: async () => {},
        reportNativeWork: () => {},
      }
      const fork = await adapter.forkNativeContext(input, controller.signal)
      const initialized = await adapter.initializeNativeFork(
        { ...input, nativeSessionId: fork.nativeSessionId, witness: fork.witness },
        controller.signal,
      )
      const cold = new bundle.ClaudeAgentAdapter(claudeExecutable, dependencies)
      adapters.push(cold)
      expect(
        await cold.inspectNativeFork(
          {
            ...input,
            nativeSessionId: initialized.nativeSessionId,
            witness: initialized.witness,
            lastDispatchedPhase: 'initialize',
          },
          controller.signal,
        ),
      ).toMatchObject({
        kind: 'verified',
        ready: true,
        result: { nativeSessionId: initialized.nativeSessionId },
      })
      expect(provider.requests.filter((request) => request.method === 'POST')).toHaveLength(0)
      const nativePath = initialized.witness.nativePath
      if (!nativePath) throw new Error('Initialized Claude Fork lacks its original witness path')
      const prefix = await boundedNativeText(nativePath, owned.home)
      expect(hash(prefix)).toBe(initialized.witness.initializedPrefixHash)
      expect(Buffer.byteLength(prefix)).toBe(initialized.witness.initializedPrefixBytes)
      expect(prefix).toContain(historicalUser)
      expect(prefix).toContain(historicalAssistant)
      expect(prefix).not.toContain(cutoffCanary)
      candidateContentHashes.push(...nativeMessageContentHashes(prefix))
      console.info(
        '[native Claude candidate schema]',
        JSON.stringify({
          sourceMessages: sourceContentHashes.length,
          candidateMessages: candidateContentHashes.length,
          sourceContentHashes,
          candidateContentHashes,
          pactMarkerPresent: /pactContext|pact-native-fork|pact-fork-settings-/u.test(prefix),
          forkMarkerPresent: /forkedFrom|fork_summary|fork-summary/u.test(prefix),
        }),
      )
      const directory = dirname(nativePath)
      const directoryBefore = await lstat(directory, { bigint: true })
      const rootBefore = await lstat(owned.root, { bigint: true })
      expect(directoryBefore.isDirectory() && !directoryBefore.isSymbolicLink()).toBe(true)
      expect(await realpath(directory)).toBe(directory)
      expect(await realpath(owned.root)).toBe(owned.root)
      session = sdk.query({
        prompt: (async function* () {
          yield {
            type: 'user',
            uuid: promptUuid,
            session_id: initialized.nativeSessionId,
            parent_tool_use_id: null,
            message: { role: 'user', content: prompt },
          }
        })(),
        options: {
          cwd: owned.cwd,
          resume: initialized.nativeSessionId,
          persistSession: true,
          abortController: controller,
          pathToClaudeCodeExecutable: claudeExecutable,
          settingSources: ['user', 'project', 'local'],
          systemPrompt: { type: 'preset', preset: 'claude_code' },
          model: 'sonnet',
          effort: 'low',
          env,
          spawnClaudeCodeProcess: (specification: {
            command: string
            args: string[]
            cwd?: string
            env: NodeJS.ProcessEnv
            signal: AbortSignal
          }) =>
            spawnOwned(specification.command, specification.args, {
              cwd: specification.cwd,
              env: specification.env,
              signal: specification.signal,
              stdio: ['pipe', 'pipe', 'pipe'],
              shell: false,
            }),
        },
      })
      let messages = 0,
        bytes = 0,
        assistantReplies = 0,
        successfulResults = 0
      const query = session
      await within(
        (async () => {
          for await (const message of query) {
            messages += 1
            bytes += Buffer.byteLength(JSON.stringify(message))
            if (messages > 128 || bytes > 4 * 1024 * 1024)
              throw new Error('Claude resume SDK result exceeds its fixture bound')
            if (!message || typeof message !== 'object' || Array.isArray(message))
              throw new Error('Malformed Claude resume SDK result')
            if (Reflect.get(message, 'type') === 'assistant') {
              const body: unknown = Reflect.get(message, 'message')
              const content: unknown =
                body && typeof body === 'object' ? Reflect.get(body, 'content') : undefined
              if (
                Array.isArray(content) &&
                content.some(
                  (block: unknown) =>
                    block &&
                    typeof block === 'object' &&
                    Reflect.get(block, 'type') === 'text' &&
                    Reflect.get(block, 'text') === reply,
                )
              )
                assistantReplies += 1
            }
            if (Reflect.get(message, 'type') === 'result') {
              console.info(
                '[native Claude resume terminal]',
                JSON.stringify({
                  successSubtype: Reflect.get(message, 'subtype') === 'success',
                  isError: Reflect.get(message, 'is_error') === true,
                  candidateMatches:
                    Reflect.get(message, 'session_id') === initialized.nativeSessionId,
                  replyMatches: Reflect.get(message, 'result') === reply,
                  modelPosts: provider.requests.filter((request) => request.method === 'POST')
                    .length,
                  requestFacts: provider.requests.map((request) => ({
                    inputHash: request.inputHash,
                    ...request.claude,
                  })),
                  providerErrors: provider.errors.length,
                  unexpectedRole: provider.errors.some(
                    (error) => error.message === 'Unexpected Claude loopback message role',
                  ),
                  compressedInput: provider.errors.some(
                    (error) =>
                      error.message === 'Compressed Claude loopback request is unsupported',
                  ),
                  historyRejected: provider.errors.some(
                    (error) =>
                      error.message === 'Claude resume did not supply the exact selected history',
                  ),
                }),
              )
              if (
                Reflect.get(message, 'subtype') !== 'success' ||
                Reflect.get(message, 'is_error') !== false ||
                Reflect.get(message, 'session_id') !== initialized.nativeSessionId ||
                Reflect.get(message, 'result') !== reply
              )
                throw new Error(
                  'Claude resume did not produce its expected successful terminal reply',
                )
              successfulResults += 1
            }
          }
        })(),
        Math.max(1, deadlineAt - performance.now()),
        'Claude resume did not complete within its original fixture deadline',
      )
      expect(assistantReplies).toBe(1)
      expect(successfulResults).toBe(1)
      await within(
        Promise.all(closed),
        Math.max(1, deadlineAt - performance.now()),
        'Claude resume native process did not close naturally',
      )
      expect(admitted.every((child) => child.exitCode === 0 && child.signalCode === null)).toBe(
        true,
      )
      expect(children.size).toBe(0)
      const posts = provider.requests.filter((request) => request.method === 'POST')
      expect(posts).toHaveLength(1)
      expect(posts[0]?.claude).toMatchObject({
        historicalUserPresent: true,
        historicalAssistantPresent: true,
        historyRolesInOrder: true,
        promptAfterHistory: true,
        cutoffCanaryAbsent: true,
      })
      expect(provider.errors).toEqual([])
      const appended = await boundedNativeText(nativePath, owned.home)
      expect(appended.startsWith(prefix)).toBe(true)
      expect(appended).toContain(promptUuid)
      expect(appended).toContain(reply)
      expect(appended).not.toContain(cutoffCanary)
      expect(hash(await boundedNativeText(sourcePath, owned.home))).toBe(sourceHash)
      const directoryAfter = await lstat(directory, { bigint: true })
      const rootAfter = await lstat(owned.root, { bigint: true })
      expect([directoryAfter.dev, directoryAfter.ino]).toEqual([
        directoryBefore.dev,
        directoryBefore.ino,
      ])
      expect([rootAfter.dev, rootAfter.ino]).toEqual([rootBefore.dev, rootBefore.ino])
      expect(await realpath(directory)).toBe(directory)
      expect(await realpath(owned.root)).toBe(owned.root)
      console.info(
        '[native Claude resume]',
        JSON.stringify({
          longCwd,
          originalPrefixRetained: appended.startsWith(prefix),
          promptPersisted: appended.includes(promptUuid),
          assistantPersisted: appended.includes(reply),
          sourceUnchanged: hash(await boundedNativeText(sourcePath, owned.home)) === sourceHash,
          prefixHash: hash(prefix),
          finalHash: hash(appended),
          requests: posts.length,
          ...posts[0]?.claude,
        }),
      )
      verified = true
    } finally {
      session?.close()
      controller.abort()
      clearTimeout(deadline)
      if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previousConfig
      await finishFixture(owned, { adapters, provider, retainRoot: !verified })
    }
  },
)

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
    const adapters: NativeAdapter[] = []
    const clients: NativeRpc[] = []
    const controller = new AbortController()
    const deadlineAt = performance.now() + 25_000
    const deadline = setTimeout(() => controller.abort(), 25_000)
    try {
      await provider.start()
      await provider.configureCodex(owned.home)
      if (agent === 'claude') await owned.processes.prepare(claudeExecutable, 4, deadlineAt)
      if (workspace)
        await appendFile(
          join(owned.home, 'config.toml'),
          '\n[sandbox_workspace_write]\nwritable_roots = []\nnetwork_access = false\n',
        )
      process.env.CLAUDE_CONFIG_DIR = owned.home
      const env = { ...isolatedEnv(owned.root, owned.home), ANTHROPIC_BASE_URL: provider.url }
      const configReader = await NativeRpc.create(codexExecutable, owned.cwd, env, {
        deadlineAt,
        processes: owned.processes,
      })
      clients.push(configReader)
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
      const startOwned = (
        command: string,
        args: readonly string[],
        options: SpawnOptionsWithoutStdio,
      ) => {
        if (children.size >= 4) throw new Error('Owned empty Rebuild child capacity exceeded')
        const handle = owned.processes.spawnOwned(command, args, options)
        const child = handle.child
        children.add(child)
        child.once('close', () => children.delete(child))
        return handle
      }
      const sdk = actualSdk()
      const makeAdapter = (): NativeAdapter => {
        const adapter =
          agent === 'claude'
            ? new bundle.ClaudeAgentAdapter(claudeExecutable, {
                getSessionInfo: sdk.getSessionInfo,
                query: (input: SdkQueryInput) =>
                  sdk.query({ ...input, options: { ...input.options, env } }),
                spawn: (
                  command: string,
                  args: readonly string[],
                  options: SpawnOptionsWithoutStdio,
                ) => startOwned(command, args, options).child,
              })
            : new bundle.CodexAgentAdapter(
                codexExecutable,
                (cwd) =>
                  owned.processes.spawnOwnedAsync(
                    codexExecutable,
                    ['app-server'],
                    { cwd, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] },
                    deadlineAt,
                  ),
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
      const probe = async () => {
        if (agent === 'claude') await owned.processes.prepare(claudeExecutable, 4, deadlineAt)
        return cold.probeNativeStatus(
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
      }
      await expect(probe()).resolves.toMatchObject({
        kind: 'binding_ready',
        source: 'completed_initialization_readback',
      })
      const path =
        agent === 'claude'
          ? join(
              owned.home,
              'projects',
              await observeSdkProjectKey(sdk, initialized.nativeSessionId, owned.cwd),
              `${initialized.nativeSessionId}.jsonl`,
            )
          : result(
              await (async () => {
                const reader = await NativeRpc.create(codexExecutable, owned.cwd, env, {
                  deadlineAt,
                  processes: owned.processes,
                })
                clients.push(reader)
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
      if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previousConfig
      await finishFixture(owned, { adapters, clients, provider })
    }
  },
)

it('real default paginated Codex writer → production selected true Fork → cold verification → Fork of Fork', async () => {
  const owned = await ownedRoot()
  const provider = new LoopbackProvider(['NATIVE_FIRST_REPLY', 'NATIVE_LATER_REPLY'])
  const clients: NativeRpc[] = []
  const adapters: NativeAdapter[] = []
  const children = new Set<ChildProcess>()
  const controller = new AbortController()
  const deadlineAt = performance.now() + 45_000
  const deadline = setTimeout(() => controller.abort(), 45_000)
  try {
    await provider.start()
    await provider.configureCodex(owned.home)
    const env = isolatedEnv(owned.root, owned.home)
    const writer = await NativeRpc.create(codexExecutable, owned.cwd, env, {
      deadlineAt,
      processes: owned.processes,
    })
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
    const factory = async (cwd: string) => {
      if (children.size >= 4) throw new Error('Owned Codex child capacity exceeded')
      const handle = await owned.processes.spawnOwnedAsync(
        codexExecutable,
        ['app-server'],
        { cwd, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] },
        deadlineAt,
      )
      const child = handle.child
      children.add(child)
      child.once('close', () => children.delete(child))
      return handle
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
    const metadataReader = await NativeRpc.create(codexExecutable, owned.cwd, env, {
      deadlineAt,
      processes: owned.processes,
    })
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
    await finishFixture(owned, { adapters, clients, provider })
  }
})

it('real Codex read-only Desktop client does not own a writer; competing live idle writer rejects and natural exit releases it', async () => {
  const owned = await ownedRoot()
  const provider = new LoopbackProvider(['NATIVE_WRITER_REPLY'])
  const clients: NativeRpc[] = []
  const naturalTakeover = async (
    writer: NativeRpc,
    reader: NativeRpc,
    owner: 'pact' | 'desktop',
    threadId: string,
  ) => {
    await writer.endInputNaturally()
    const began = performance.now(),
      deadline = began + 5000
    const remaining = () => {
      const milliseconds = deadline - performance.now()
      if (milliseconds <= 0) throw new Error('Owned EOF deadline already expired')
      return milliseconds
    }
    let takeover: 'pending' | 'accepted' | 'rejected' = 'pending'
    const results = await Promise.allSettled([
      within(
        writer.exited,
        remaining(),
        `Owned ${owner === 'desktop' ? 'Desktop writer' : 'writer'} did not exit naturally`,
      ),
      (async () => {
        const root = await within(
          writer.rootExited(),
          remaining(),
          'Owned protocol root did not exit naturally',
        )
        if (!root.natural || root.exitCode !== 0)
          throw new Error('Owned protocol root was forced or failed')
        // One request after OS-confirmed root exit; no retry after unknown delivery.
        const takeoverDeadline = remaining()
        const resumed = result(
          await within(
            reader.request<{ thread: NativeThread }>('thread/resume', {
              threadId,
              excludeTurns: true,
              cwd: owned.cwd,
            }),
            takeoverDeadline,
            'Owned writer takeover exceeded the original EOF deadline',
          ),
        )
        takeover = 'accepted'
        return resumed.thread
      })().catch((error: unknown) => {
        takeover = 'rejected'
        throw error
      }),
    ])
    console.info(
      '[native natural EOF]',
      JSON.stringify({
        owner,
        elapsedMs: Math.round(performance.now() - began),
        stdinEnded: writer.child.stdin.writableEnded,
        stdinFinished: writer.child.stdin.writableFinished,
        helperExitCode: writer.child.exitCode,
        takeover,
        shutdownBoundaries: writer.stopShutdownObservation(),
        facts: writer.cleanupFacts(),
      }),
    )
    for (const outcome of results) if (outcome.status === 'rejected') throw outcome.reason
    const resumed = results[1]
    if (resumed.status !== 'fulfilled') throw new Error('Owned writer takeover is unconfirmed')
    return resumed.value
  }
  try {
    await provider.start()
    await provider.configureCodex(owned.home)
    const env = isolatedEnv(owned.root, owned.home)
    const observedEnv = { ...env, LOG_FORMAT: 'json', RUST_LOG: CODEX_SHUTDOWN_LOG_FILTER }
    const creator = await NativeRpc.create(codexExecutable, owned.cwd, env, {
      processes: owned.processes,
    })
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
    const desktop = await NativeRpc.create(
      codexExecutable,
      owned.cwd,
      {
        ...observedEnv,
        CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'Codex Desktop',
      },
      { processes: owned.processes, observeShutdownStages: true },
    )
    clients.push(desktop)
    await desktop.initialize()
    result(
      await desktop.request('thread/list', { useStateDbOnly: true, sourceKinds: [], limit: 25 }),
    )
    result(await desktop.request('thread/read', { threadId: thread.id, includeTurns: false }))
    result(await desktop.request('thread/read', { threadId: thread.id, includeTurns: true }))
    result(await desktop.request('thread/turns/list', { threadId: thread.id, limit: 25 }))
    const pact = await NativeRpc.create(codexExecutable, owned.cwd, observedEnv, {
      processes: owned.processes,
      observeShutdownStages: true,
    })
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
    const afterExit = await naturalTakeover(pact, desktop, 'pact', thread.id)
    expect(pact.child.exitCode).toBe(0)
    expect(afterExit.id).toBe(thread.id)
    expect(afterExit.status.type).toBe('idle')
    // Match the reported direction too: Desktop owns the now-resumed writer,
    // and a fresh Pact client must preserve that ownership rather than steal it.
    const nextPact = await NativeRpc.create(codexExecutable, owned.cwd, env, {
      processes: owned.processes,
    })
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
    const pactAfterExit = await naturalTakeover(desktop, nextPact, 'desktop', thread.id)
    expect(desktop.child.exitCode).toBe(0)
    expect(pactAfterExit.id).toBe(thread.id)
    expect(pactAfterExit.status.type).toBe('idle')
    expect(provider.requests).toHaveLength(1)
    expect(provider.errors).toEqual([])
  } finally {
    await finishFixture(owned, { clients, provider })
  }
})
