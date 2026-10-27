/* oxlint-disable no-await-in-loop, vitest/no-conditional-expect -- Table variants assert their distinct native lifecycle/protocol outcomes; history and protocol reads are bounded and sequential. */
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'

import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile, readdir, unlink } from 'node:fs/promises'
import { createServer } from 'node:https'
import { join, resolve as resolvePath } from 'node:path'
import { getCACertificates, setDefaultCACertificates } from 'node:tls'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

import type { AgentRunInput } from '../../packages/agent-runtime/src/index.js'
import type {
  ConfirmedUnsentBoundary,
  FrozenExecutionEnvelope,
  RunEffectiveExecutionSettings,
} from '../../packages/contracts/src/index.js'

import { CodexAppServerConnection } from '../../apps/desktop/src/utility/conversation/codex-app-server-connection.js'
import { CodexDecisionRuntime } from '../../apps/desktop/src/utility/conversation/codex-decision-runtime.js'
import { restoreExecutionInput } from '../../apps/desktop/src/utility/conversation/execution-input.js'
import {
  nativeWorkingMemoryCapacities,
  NativeWorkingMemory,
  NATIVE_OWNER_WORKING_BYTES,
  type NativeMemoryReservation,
} from '../../apps/desktop/src/utility/conversation/native-working-memory.js'
import { OwnedProcessGroup } from '../../apps/desktop/src/utility/owned-process-group.js'
import { serializeAgentPromptEnvelope } from '../../packages/agent-runtime/src/index.js'
import { decisionCapabilitySchema } from '../../packages/contracts/src/index.js'
import {
  decisionFixture,
  decisionEvaluationFacts,
} from '../../packages/persistence/src/decision-fixture.test-support.js'
import { PactDatabase } from '../../packages/persistence/src/pact-database.js'
import {
  agentRuns,
  conversationMessages,
  runReexecutionOperations,
} from '../../packages/persistence/src/schema/index.js'
import {
  buildAdapters,
  cleanupNativeFixture,
  executable,
  isolatedEnv,
  LoopbackProvider,
  ownedRoot,
  type NativeAdapter,
} from './native-harness.js'

const sse = (type: string, payload: object) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`

const openssl = async (args: string[]) => {
  await promisify(execFile)('/usr/bin/openssl', args, {
    timeout: 4_000,
    maxBuffer: 16 * 1024,
  })
}

it
  .runIf(process.platform === 'darwin')
  .each([
    'message',
    'custom_api_key',
    'missing_mime',
    'mcp',
    'builtin',
    'auth',
    'changed_account',
    'changed_subject',
    'over_context',
    'cancel',
    'timeout',
  ] as const)(
  'runs the production native ChatGPT/builtin OpenAI/HTTPS entry with %s output',
  async (kind) => {
    const owned = await ownedRoot(),
      sockets = new Set<Duplex>(),
      roots = getCACertificates('default')
    let runtime: CodexDecisionRuntime | undefined
    let database: Awaited<ReturnType<typeof decisionFixture>> | undefined
    const business: NativeMemoryReservation[] = []
    let helperPost: (() => void) | undefined,
      lateResponse: ServerResponse | undefined,
      refreshPosts = 0
    const keyPath = join(owned.root, 'owned-key.pem'),
      certPath = join(owned.root, 'owned-ca.pem')
    const fixtureFailures: string[] = []
    let priming = true,
      primePosts = 0,
      primeSessionId = '',
      globalInherited = false,
      projectInherited = false,
      historyInherited = false
    let tlsConnections = 0
    const tlsErrorCodes: string[] = []
    let modelPosts = 0,
      accountChecks = 0,
      receipts = 0,
      reservations = 0,
      unknownRequests = 0,
      authMatched = true,
      contextIsolated = true
    const claims = {
      sub: 'owned-user',
      email: 'owned@example.test',
      exp: Math.floor(Date.now() / 1000) + 3600,
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'owned-account',
        chatgpt_user_id: 'owned-user',
        chatgpt_plan_type: 'plus',
      },
    }
    const token = `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.owned-signature`
    const refreshedClaims = {
      ...claims,
      nonce: 'refreshed',
      ...(kind === 'changed_account' ? { email: 'other-owned@example.test' } : {}),
      ...(kind === 'changed_subject'
        ? {
            sub: 'other-owned-user',
            'https://api.openai.com/auth': {
              ...claims['https://api.openai.com/auth'],
              chatgpt_user_id: 'other-owned-user',
            },
          }
        : {}),
    }
    if (kind === 'changed_subject') {
      const control = {
        subChanged: refreshedClaims.sub !== claims.sub,
        userChanged:
          refreshedClaims['https://api.openai.com/auth'].chatgpt_user_id !==
          claims['https://api.openai.com/auth'].chatgpt_user_id,
        emailSame: refreshedClaims.email === claims.email,
        accountSame:
          refreshedClaims['https://api.openai.com/auth'].chatgpt_account_id ===
          claims['https://api.openai.com/auth'].chatgpt_account_id,
        planSame:
          refreshedClaims['https://api.openai.com/auth'].chatgpt_plan_type ===
          claims['https://api.openai.com/auth'].chatgpt_plan_type,
      }
      console.info('Owned UID-only control', JSON.stringify(control))
      expect(control).toEqual({
        subChanged: true,
        userChanged: true,
        emailSame: true,
        accountSame: true,
        planSame: true,
      })
    }
    const refreshed = `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify(refreshedClaims)).toString('base64url')}.owned-signature`
    const marker = join(owned.cwd, 'tool-marker'),
      mcpFacts = join(owned.root, 'mcp-calls.jsonl'),
      mcpScript = join(owned.root, 'mcp.cjs')
    const rootKey = join(owned.root, 'owned-root-key.pem'),
      leafPath = join(owned.root, 'owned-server.pem'),
      csr = join(owned.root, 'owned-server.csr'),
      extensions = join(owned.root, 'owned-extensions.cnf')
    const rootConfig = join(owned.root, 'owned-root.cnf')
    await writeFile(
      rootConfig,
      '[req]\ndistinguished_name=dn\nx509_extensions=v3_ca\nprompt=no\n[dn]\nCN=PactOwnedRoot\n[v3_ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\n',
    )
    await openssl([
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-sha256',
      '-days',
      '1',
      '-nodes',
      '-keyout',
      rootKey,
      '-out',
      certPath,
      '-config',
      rootConfig,
    ])
    await openssl([
      'req',
      '-new',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      csr,
      '-subj',
      '/CN=PactOwnedServer',
    ])
    await writeFile(
      extensions,
      'subjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n',
    )
    await openssl([
      'x509',
      '-req',
      '-in',
      csr,
      '-CA',
      certPath,
      '-CAkey',
      rootKey,
      '-CAcreateserial',
      '-out',
      leafPath,
      '-days',
      '1',
      '-sha256',
      '-extfile',
      extensions,
    ])
    const certificate = await readFile(certPath, 'utf8')
    setDefaultCACertificates([...roots, certificate])
    const upstream = createServer(
      { key: await readFile(keyPath), cert: await readFile(leafPath) },
      (request, response) => {
        let stage = 'route'
        void (async () => {
          if (request.url === '/oauth/token' && request.method === 'POST') {
            const chunks: Buffer[] = []
            for await (const chunk of request) {
              chunks.push(chunk)
              if (chunks.length > 8) throw Error('Refresh fixture capacity')
            }
            const refresh = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            expect(refresh.refresh_token).toBe('owned-refresh')
            refreshPosts++
            response.writeHead(200, { 'content-type': 'application/json' })
            response.end(
              JSON.stringify({
                access_token: refreshed,
                id_token: ['changed_account', 'changed_subject'].includes(kind) ? refreshed : token,
                refresh_token: 'owned-refresh-next',
              }),
            )
            return
          }
          if (request.url?.startsWith('/backend-api/wham/accounts/check')) {
            accountChecks++
            response.writeHead(200, { 'content-type': 'application/json' })
            response.end(
              JSON.stringify({
                accounts: [
                  {
                    id: 'owned-account',
                    workspace_backend_origin: origin,
                    account_routing_override: 'NO_CONSTRAINT',
                  },
                ],
              }),
            )
            return
          }
          if (request.method !== 'POST' || request.url !== '/backend-api/codex/responses') {
            unknownRequests++
            response.writeHead(404)
            response.end()
            return
          }
          if (priming) primePosts++
          else modelPosts++
          authMatched &&=
            request.headers.authorization ===
              `Bearer ${!priming && ['auth', 'changed_account', 'changed_subject'].includes(kind) && modelPosts > 1 ? refreshed : token}` &&
            request.headers['chatgpt-account-id'] ===
              (kind === 'custom_api_key' ? undefined : 'owned-account')
          const data = Buffer.allocUnsafe(256 * 1024)
          let length = 0
          for await (const chunk of request) {
            if (length + chunk.length > data.length) throw Error('Owned model request overflow')
            chunk.copy(data, length)
            length += chunk.length
          }
          stage = 'encoding'
          if (request.headers['content-encoding'])
            throw Error('Owned fixture requires uncompressed protocol')
          stage = 'json'
          const body = JSON.parse(data.toString('utf8', 0, length))
          stage = 'model'
          expect(body.model).toBe('gpt-6-luna')
          const wire = data.toString('utf8', 0, length)
          if (!priming) {
            globalInherited ||= wire.includes('GLOBAL_CONTEXT_CANARY')
            projectInherited ||= wire.includes('PROJECT_CONTEXT_CANARY')
            historyInherited ||=
              wire.includes('OLD_DEV_CONTEXT_CANARY') ||
              Boolean(primeSessionId && wire.includes(primeSessionId))
            contextIsolated &&= !projectInherited && !historyInherited
          }
          if (
            !priming &&
            ['auth', 'changed_account', 'changed_subject'].includes(kind) &&
            modelPosts === 1
          ) {
            response.writeHead(401, { 'content-type': 'application/json' })
            response.end('{}')
            return
          }
          if (!priming && (kind === 'cancel' || kind === 'timeout')) {
            lateResponse = response
            helperPost?.()
            return
          }
          const item = (priming ? primePosts === 1 : kind === 'mcp' || kind === 'builtin')
            ? {
                id: 'owned-call',
                type: 'function_call',
                ...(!priming && kind === 'builtin' ? {} : { namespace: 'mcp__canary' }),
                name: !priming && kind === 'builtin' ? 'exec_command' : 'mark',
                call_id: 'owned-call',
                arguments: '{}',
              }
            : {
                id: 'owned-answer',
                type: 'message',
                role: 'assistant',
                status: 'completed',
                phase: 'final_answer',
                content: [
                  {
                    type: 'output_text',
                    text: '{"candidateId":"wait","highlights":[]}',
                    annotations: [],
                  },
                ],
              }
          response.writeHead(
            200,
            !priming && kind === 'missing_mime' ? {} : { 'content-type': 'text/event-stream' },
          )
          response.write(
            sse('response.created', {
              response: { id: 'owned-response', status: 'in_progress', output: [] },
            }),
          )
          response.write(
            sse('response.output_item.added', {
              item:
                item.type === 'function_call'
                  ? { ...item, arguments: '' }
                  : { ...item, status: 'in_progress', content: [] },
              output_index: 0,
            }),
          )
          if (item.type === 'function_call') {
            response.write(
              sse('response.function_call_arguments.delta', {
                item_id: item.id,
                output_index: 0,
                delta: '{}',
              }),
            )
            response.write(
              sse('response.function_call_arguments.done', {
                item_id: item.id,
                output_index: 0,
                arguments: '{}',
              }),
            )
          }
          response.write(sse('response.output_item.done', { item, output_index: 0 }))
          response.end(
            sse('response.completed', {
              response: {
                id: 'owned-response',
                status: 'completed',
                output: [item],
                usage: { input_tokens: 17, output_tokens: 5, total_tokens: 22 },
              },
            }),
          )
        })().catch(() => {
          fixtureFailures.push(stage)
          response.writeHead(500)
          response.end()
        })
      },
    )
    upstream.on('tlsClientError', (error) => {
      tlsErrorCodes.push(String(Reflect.get(error, 'code') ?? 'unknown'))
    })
    upstream.on('connection', (socket) => {
      tlsConnections++
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
    })
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    const address = upstream.address()
    if (!address || typeof address === 'string') throw Error('Owned HTTPS unavailable')
    const origin = `https://127.0.0.1:${address.port}`
    try {
      await writeFile(
        mcpScript,
        `const fs=require('node:fs'),rl=require('node:readline').createInterface({input:process.stdin});const record=x=>fs.appendFileSync(${JSON.stringify(mcpFacts)},JSON.stringify(x)+'\\n');record({type:'startup'});rl.on('line',l=>{const r=JSON.parse(l);record({type:r.method});const send=result=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n');if(r.method==='initialize')send({protocolVersion:r.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'owned',version:'1'}});else if(r.method==='tools/list')send({tools:[{name:'mark',description:'Owned harmless marker',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true}}]});else if(r.method==='tools/call'){fs.writeFileSync(${JSON.stringify(marker)},'called');send({content:[{type:'text',text:'Owned marker'}]})}else if(r.id!==undefined)send({})});`,
      )
      const nativeProvider = kind === 'custom_api_key' ? 'owned_custom' : 'openai'
      const customProvider =
        kind === 'custom_api_key'
          ? `\n[model_providers.owned_custom]\nname="Owned custom"\nbase_url="${origin}/backend-api/codex"\nwire_api="responses"\nrequires_openai_auth=true\nsupports_websockets=false\n`
          : ''
      const config = `model="gpt-6-luna"\nmodel_provider="${nativeProvider}"\nopenai_base_url="${origin}/backend-api/codex"\nchatgpt_base_url="${origin}/backend-api"\ncli_auth_credentials_store="file"\n[features]\nuse_agent_identity=false\n[mcp_servers.canary]\nrequired=true\ncommand=${JSON.stringify(process.execPath)}\nargs=[${JSON.stringify(mcpScript)}]\n${customProvider}`
      const auth = JSON.stringify(
        kind === 'custom_api_key'
          ? { OPENAI_API_KEY: token }
          : {
              auth_mode: 'chatgpt',
              OPENAI_API_KEY: null,
              tokens: {
                id_token: token,
                access_token: token,
                refresh_token: 'owned-refresh',
                account_id: 'owned-account',
              },
              last_refresh: new Date().toISOString(),
            },
      )
      await writeFile(join(owned.home, 'config.toml'), config)
      await writeFile(join(owned.home, 'auth.json'), auth)
      await writeFile(join(owned.home, 'AGENTS.md'), 'GLOBAL_CONTEXT_CANARY')
      await writeFile(join(owned.cwd, 'AGENTS.md'), 'PROJECT_CONTEXT_CANARY')
      await mkdir(join(owned.home, 'sessions'))
      await writeFile(
        join(owned.home, 'sessions', 'owned-existing.jsonl'),
        'Owned existing history stays exact.\n',
      )
      const env = isolatedEnv(owned.root, owned.home)
      env.CODEX_CA_CERTIFICATE = certPath
      if (['auth', 'changed_account', 'changed_subject'].includes(kind))
        env.CODEX_REFRESH_TOKEN_URL_OVERRIDE = origin + '/oauth/token'
      // Establish a genuine persistent, unrelated native Session and a positive
      // tools/call control using this exact registered readOnlyHint tool.
      const binary = await executable('codex', owned),
        primeGroup = new OwnedProcessGroup({ startupObservationMs: 2_000 })
      const prime = new CodexAppServerConnection(
        primeGroup.spawn(binary, ['app-server', '--disable', 'enable_request_compression'], {
          cwd: owned.cwd,
          env,
        }),
        undefined,
        () => primeGroup.close(),
      )
      try {
        await prime.request(
          'initialize',
          {
            clientInfo: { name: 'pact', version: '0.0.0' },
            capabilities: { experimentalApi: true },
          },
          { timeoutMs: 5_000 },
        )
        await prime.notify('initialized', {})
        const started = await prime.request(
          'thread/start',
          {
            cwd: owned.cwd,
            model: 'gpt-6-luna',
            modelProvider: 'owned_positive',
            approvalPolicy: 'never',
            sandbox: 'read-only',
            allowProviderModelFallback: false,
            config: {
              'model_providers.owned_positive': {
                name: 'OpenAI',
                base_url: `${origin}/backend-api/codex`,
                wire_api: 'responses',
                requires_openai_auth: true,
                supports_websockets: false,
                request_max_retries: 0,
                stream_max_retries: 0,
              },
            },
          },
          { timeoutMs: 5_000 },
        )
        const thread = Reflect.get(Reflect.get(started, 'result') ?? {}, 'thread')
        primeSessionId = String(Reflect.get(thread ?? {}, 'id') ?? '')
        expect(primeSessionId.length).toBeGreaterThan(0)
        await prime.request(
          'turn/start',
          {
            threadId: primeSessionId,
            model: 'gpt-6-luna',
            effort: 'low',
            input: [
              {
                type: 'text',
                text: 'OLD_DEV_CONTEXT_CANARY. Controlled positive marker request.',
                text_elements: [],
              },
            ],
          },
          { timeoutMs: 5_000 },
        )
        let completed = false
        const primeItems: string[] = []
        let primeStatus: unknown
        let primeError: unknown
        for (let count = 0; count < 128 && !completed; count++) {
          const event = await prime.nextNotification(5_000)
          const params = Reflect.get(event, 'params') ?? {}
          if (Reflect.get(event, 'method') === 'item/started')
            primeItems.push(String(Reflect.get(Reflect.get(params, 'item') ?? {}, 'type')))
          if (Reflect.get(event, 'method') === 'turn/completed') {
            completed = true
            primeStatus = Reflect.get(Reflect.get(params, 'turn') ?? {}, 'status')
            primeError = Reflect.get(Reflect.get(params, 'turn') ?? {}, 'error')
          }
        }
        console.info(
          'Owned original-session control',
          JSON.stringify({
            primePosts,
            primeStatus,
            primeItems,
            fixtureFailures,
            errorInfo: primeError && Reflect.get(primeError, 'codexErrorInfo'),
            errorMessage:
              primeError &&
              String(Reflect.get(primeError, 'message'))
                .replaceAll(owned.root, '<owned-root>')
                .replace(/https?:\/\/[^\s"')]+/gu, '<endpoint>')
                .replace(/Bearer\s+\S+/giu, 'Bearer <redacted>')
                .slice(0, 512),
            methods: existsSync(mcpFacts)
              ? (await readFile(mcpFacts, 'utf8'))
                  .trim()
                  .split('\n')
                  .map((line) => JSON.parse(line).type)
              : [],
          }),
        )
        expect(completed).toBe(true)
        expect(existsSync(marker)).toBe(true)
      } finally {
        await prime.close()
        await primeGroup.close()
      }
      await unlink(marker)
      const nativeFactsBefore = (await readFile(mcpFacts, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line).type)
      expect(nativeFactsBefore.filter((type) => type === 'tools/call')).toHaveLength(1)
      const history = async () => {
        const digests: Record<string, string> = {}
        const visit = async (directory: string) => {
          for (const entry of await readdir(directory, { withFileTypes: true })) {
            const path = join(directory, entry.name)
            if (entry.isDirectory()) await visit(path)
            else if (entry.isFile())
              digests[path] = createHash('sha256')
                .update(await readFile(path))
                .digest('hex')
            if (Object.keys(digests).length > 32) throw Error('Owned history fixture capacity')
          }
        }
        await visit(join(owned.home, 'sessions'))
        return digests
      }
      const historyBefore = await history()
      expect(Object.keys(historyBefore).length).toBeGreaterThan(1)
      priming = false
      // The runtime must own exact guard loopback proxy exclusions itself.
      delete env.NO_PROXY
      delete env.no_proxy
      if (kind === 'message') {
        // This uses the installed native CLI's actual model/list metadata. The
        // owned account/provider is loopback; catalog compatibility is not a
        // claim about paid account entitlement or live model output quality.
        for (const scope of ['host', 'project'] as const) {
          let witnesses = 0
          const probe = new CodexDecisionRuntime({
            executable: binary,
            ...(scope === 'project' ? { cwd: owned.cwd } : {}),
            environment: env,
            current: () => true,
            probePrepared: ({ witness }) => {
              expect(witness.platform).toBe('darwin')
              expect(witness.owner.pid).toBe(process.pid)
              witnesses++
            },
            dispatch: () => {
              throw Error('A capability probe cannot dispatch inference')
            },
          })
          try {
            const capability = decisionCapabilitySchema.parse(await probe.probeAdmission())
            console.info('Containment capability diagnostics', JSON.stringify(probe.diagnostics()))
            expect(capability).toMatchObject({
              provider: 'codex',
              modelId: 'gpt-6-luna',
              status: 'supported',
              reason: 'supported',
              supported: true,
              physicalReleased: true,
            })
            expect(await probe.settlement()).toBe(true)
            expect(witnesses).toBe(2)
            expect(probe.invoked).toBe(false)
            expect(probe.usage).toBeUndefined()
            expect(modelPosts).toBe(0)
            expect(refreshPosts).toBe(0)
            expect(existsSync(marker)).toBe(false)
            expect(await history()).toEqual(historyBefore)
            expect(nativeWorkingMemoryCapacities().decision.chargedBytes).toBe(0)
            console.info(
              'Native zero-inference capability',
              JSON.stringify({
                scope,
                modelPosts,
                refreshPosts,
                physicalReleased: capability.physicalReleased,
                provider: capability.provider,
                modelId: capability.modelId,
                status: capability.status,
              }),
            )
          } finally {
            await probe.dispose()
          }
        }
      }
      database = await decisionFixture(join(owned.root, 'pact.sqlite'), owned.cwd)
      const f = database
      let evaluationId = ''
      if (kind === 'over_context') {
        const text = 'x'.repeat(122 * 1024)
        f.input.sources[0]!.text = text
        f.input.sources[0]!.digest = createHash('sha256').update(text).digest('hex')
      }
      const controller = new AbortController()
      let cancelledAt: number | undefined
      let physicalPreparations = 0
      let physicalCompletions = 0
      let receiptRetirements = 0
      helperPost = () => {
        for (let index = 0; index < 4; index++)
          business.push(new NativeWorkingMemory().reserve(NATIVE_OWNER_WORKING_BYTES))
        expect(nativeWorkingMemoryCapacities().chargedBytes).toBe(528 * 1024 * 1024)
        if (kind === 'cancel') {
          cancelledAt = performance.now()
          controller.abort()
        }
      }
      runtime = new CodexDecisionRuntime({
        executable: binary,
        cwd: owned.cwd,
        environment: env,
        current: () => f.repo.evaluationIsCurrent(f.input.handoff),
        reserve: (admitted) => {
          const result = f.repo.reserveEvaluation({
            handoff: admitted.handoff,
            provider: 'codex',
            model: 'gpt-6-luna',
            configurationFingerprint: 'c'.repeat(64),
          })
          if (result.status !== 'reserved')
            return result.status === 'duplicate' ? 'duplicate' : 'busy'
          evaluationId = result.evaluation.id
          reservations++
          return 'reserved'
        },
        beginNativeStage: (facts) => f.repo.beginSchedulingNativeStage(evaluationId, facts),
        prepared: (facts) => f.repo.recordEvaluationPhysicalWitness(evaluationId, facts),
        physicalPrepared: (facts) => {
          expect(modelPosts).toBe(facts.nativeGeneration === 3 ? 1 : 0)
          f.repo.recordSchedulingRuntimeWitness(evaluationId, facts)
          physicalPreparations++
        },
        retirePhysicalReceipts: async () => {
          expect(nativeWorkingMemoryCapacities().decision.chargedBytes).toBe(16 * 1024 * 1024)
          receiptRetirements++
          return f.repo.schedulingPhysicalReceiptCapacityAvailable()
        },
        physicalCompletion: async (facts) => {
          expect(nativeWorkingMemoryCapacities().decision.chargedBytes).toBe(16 * 1024 * 1024)
          expect(facts.nativeGeneration).toBe(
            ['message', 'custom_api_key', 'missing_mime'].includes(kind) ? 3 : 2,
          )
          expect(facts.witness?.platform).toBe('darwin')
          f.repo.completeSchedulingRuntimePhysical(evaluationId, {
            nativeGeneration: facts.nativeGeneration,
            witness: facts.witness,
            completed: facts.outcome?.kind === 'recommendation',
            candidateId:
              facts.outcome?.kind === 'recommendation'
                ? facts.outcome.recommendation.candidateId
                : null,
            ...(facts.usage ? { usage: facts.usage } : {}),
          })
          expect(f.repo.activeSchedulingRuntimeOwner()).toBeUndefined()
          physicalCompletions++
        },
        dispatch: () => {
          expect(f.repo.dispatchEvaluation(evaluationId).created).toBe(true)
          receipts++
        },
      })
      const began = performance.now()
      const outcome = await runtime.evaluateDecision(f.input, controller.signal)
      const elapsedMs = performance.now() - began
      console.info(
        'Native result before durable settlement',
        JSON.stringify({ outcome, diagnostics: runtime.diagnostics() }),
      )
      const sent = runtime.invoked
      if (kind === 'cancel') {
        expect(cancelledAt).toBeDefined()
        expect(performance.now() - cancelledAt!).toBeLessThan(2000)
        expect(elapsedMs).toBeLessThan(15500)
      }
      if (kind === 'timeout') {
        expect(outcome).toEqual({ kind: 'unavailable', reason: 'timeout' })
        expect(elapsedMs).toBeLessThan(15500)
      }
      f.repo.settleEvaluation(evaluationId, {
        outcome: !sent ? 'not_sent' : outcome.kind === 'recommendation' ? 'completed' : 'failed',
        physicalReleased: false,
        selectedCandidateId:
          outcome.kind === 'recommendation' ? outcome.recommendation.candidateId : null,
        ...(runtime.usage ? { usage: runtime.usage } : {}),
      })
      const cleanupBegan = performance.now()
      const physicalReleased = await runtime.settlement()
      expect({ physicalPreparations, physicalCompletions, receiptRetirements }).toEqual({
        physicalPreparations: ['message', 'custom_api_key', 'missing_mime'].includes(kind) ? 3 : 2,
        physicalCompletions: 1,
        receiptRetirements: 1,
      })
      expect(performance.now() - cleanupBegan).toBeLessThan(4000)
      lateResponse?.end('late response must never reach native')
      business.splice(0).forEach((reservation) => reservation.release())
      f.repo.settleEvaluation(evaluationId, {
        outcome: !sent ? 'not_sent' : outcome.kind === 'recommendation' ? 'completed' : 'failed',
        physicalReleased,
        selectedCandidateId:
          outcome.kind === 'recommendation' ? outcome.recommendation.candidateId : null,
        ...(runtime.usage ? { usage: runtime.usage } : {}),
      })
      expect(f.repo.schedulingBudget(f.input.handoff.budgetSubjectId)?.evaluationCalls ?? 0).toBe(
        sent ? 1 : 0,
      )
      console.info(
        'Production outcome before settlement assertions',
        JSON.stringify({
          kind,
          outcome: outcome.kind,
          refreshPosts,
          modelPosts,
          receipts,
          usage: runtime.usage,
          diagnostics: runtime.diagnostics(),
        }),
      )
      const persisted = decisionEvaluationFacts(f.db)
      expect(persisted).toMatchObject({
        called: sent ? 1 : 0,
        active: 0,
        usage_json: [
          'cancel',
          'timeout',
          'over_context',
          'auth',
          'changed_account',
          'changed_subject',
        ].includes(kind)
          ? null
          : '{"inputTokens":17,"outputTokens":5}',
      })
      if (sent)
        expect(JSON.parse(persisted.physical_witness_json)).toMatchObject({ platform: 'darwin' })
      else expect(persisted.physical_witness_json).toBeNull()
      expect(Buffer.byteLength(JSON.stringify(decisionEvaluationFacts(f.db)))).toBeLessThan(4096)
      const methods = existsSync(mcpFacts)
        ? (await readFile(mcpFacts, 'utf8'))
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line).type)
        : []
      console.info(
        'Production decision native evidence',
        JSON.stringify({
          kind,
          elapsedMs,
          refreshPosts,
          outcome: outcome.kind,
          reason: outcome.kind === 'unavailable' ? outcome.reason : undefined,
          modelPosts,
          accountChecks,
          receipts,
          reservations,
          authMatched,
          contextIsolated,
          physicalReleased,
          mcpStartup: methods.filter((type) => type === 'startup').length,
          mcpCalls: methods.filter((type) => type === 'tools/call').length,
          marker: existsSync(marker),
          usage: runtime.usage,
          unknownRequests,
          fixtureFailures,
          primePosts,
          globalInherited,
          projectInherited,
          historyInherited,
          tlsConnections,
          tlsErrorCodes,
          memory: nativeWorkingMemoryCapacities().chargedBytes,
          diagnostics: runtime.diagnostics(),
        }),
      )
      expect(outcome.kind).toBe(
        ['message', 'custom_api_key', 'missing_mime'].includes(kind)
          ? 'recommendation'
          : 'unavailable',
      )
      if (kind === 'missing_mime')
        expect(runtime.diagnostics().guard).toMatchObject({
          upstreamStatus: 200,
          upstreamContentType: 'absent',
          acceptedResponses: 1,
          rejectedResponses: 0,
        })
      expect({
        modelPosts,
        receipts,
        reservations,
        authMatched,
        contextIsolated,
        physicalReleased,
        marker: existsSync(marker),
      }).toEqual({
        modelPosts: kind === 'over_context' ? 0 : 1,
        receipts: sent ? 1 : 0,
        reservations: 1,
        authMatched: true,
        contextIsolated: true,
        physicalReleased: true,
        marker: false,
      })
      expect(methods).toEqual(nativeFactsBefore)
      expect(methods).toContain('startup')
      expect(methods.filter((type) => type === 'tools/call')).toHaveLength(1)
      expect({ globalInherited, projectInherited, historyInherited }).toEqual({
        globalInherited: kind !== 'over_context',
        projectInherited: false,
        historyInherited: false,
      })
      expect(await history()).toEqual(historyBefore)
      expect(runtime.usage).toEqual(
        [
          'cancel',
          'timeout',
          'over_context',
          'auth',
          'changed_account',
          'changed_subject',
        ].includes(kind)
          ? undefined
          : { inputTokens: 17, outputTokens: 5 },
      )
      expect(refreshPosts).toBe(0)
      expect(await readFile(join(owned.home, 'config.toml'), 'utf8')).toBe(config)
      if (['auth', 'changed_account', 'changed_subject'].includes(kind))
        expect(
          JSON.parse(await readFile(join(owned.home, 'auth.json'), 'utf8')).tokens,
        ).toMatchObject({
          access_token: token,
          refresh_token: 'owned-refresh',
          account_id: 'owned-account',
        })
      else expect(await readFile(join(owned.home, 'auth.json'), 'utf8')).toBe(auth)
      expect(await readFile(join(owned.home, 'sessions', 'owned-existing.jsonl'), 'utf8')).toBe(
        'Owned existing history stays exact.\n',
      )
      expect(nativeWorkingMemoryCapacities().chargedBytes).toBe(0)
    } finally {
      await runtime?.dispose()
      database?.db.close()
      business.splice(0).forEach((reservation) => reservation.release())
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => upstream.close(() => resolve()))
      setDefaultCACertificates(roots)
      await cleanupNativeFixture(owned)
    }
  },
  40_000,
)

type Identity = { executorId: string; nativeSessionId: string }
type RootFrame = {
  id: number
  params: Record<string, unknown>
}

/** Observe the real pipe, forwarding every byte and overload argument unchanged. */
function observeRootWrites(child: ChildProcessWithoutNullStreams, roots: RootFrame[]): void {
  const write = child.stdin.write.bind(child.stdin),
    decoder = new TextDecoder('utf-8', { fatal: true })
  let pending = '',
    bytes = 0,
    frames = 0
  child.stdin.write = (
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ): boolean => {
    const encoded = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    bytes += encoded.byteLength
    if (bytes > 1024 * 1024) throw new Error('Owned RPC observation exceeds 1 MiB')
    pending += decoder.decode(encoded, { stream: true })
    if (pending.length > 256 * 1024) throw new Error('Owned RPC frame exceeds 256 KiB')
    for (let end = pending.indexOf('\n'); end !== -1; end = pending.indexOf('\n')) {
      const line = pending.slice(0, end)
      pending = pending.slice(end + 1)
      if (++frames > 128) throw new Error('Owned RPC observation exceeds 128 frames')
      const frame: unknown = JSON.parse(line)
      if (!frame || typeof frame !== 'object' || Reflect.get(frame, 'method') !== 'turn/start')
        continue
      const id: unknown = Reflect.get(frame, 'id'),
        params: unknown = Reflect.get(frame, 'params')
      if (typeof id !== 'number' || !params || typeof params !== 'object' || Array.isArray(params))
        throw new Error('The observed native root frame has no exact request identity')
      if (roots.length >= 2) throw new Error('Owned root write observation exceeds two attempts')
      roots.push({ id, params: Object.fromEntries(Object.entries(params)) })
    }
    return typeof encodingOrCallback === 'string'
      ? write(chunk, encodingOrCallback, callback)
      : write(chunk, encodingOrCallback)
  }
}

async function* executionBytes(envelope: FrozenExecutionEnvelope) {
  yield new TextEncoder().encode(JSON.stringify(envelope))
}

// oxlint-disable vitest/no-conditional-expect -- Materialized and fresh real native Sessions have different supported boundaries.
async function verifyNativeReplacement(materialized: boolean): Promise<void> {
  const owned = await ownedRoot(),
    provider = new LoopbackProvider([
      ...(materialized ? ['NATIVE_PRIOR_COMPLETED_BASELINE_REPLY'] : []),
      'NATIVE_CONFIRMED_UNSENT_REPLACEMENT_REPLY',
    ]),
    adapters: NativeAdapter[] = [],
    roots: RootFrame[] = [],
    effectiveReceipts: Array<{
      runId: string
      settings: RunEffectiveExecutionSettings
      identity: Identity
    }> = [],
    unsentReceipts: Array<{
      runId: string
      boundary: ConfirmedUnsentBoundary
      identity: Identity
    }> = []
  const controller = new AbortController(),
    deadlineAt = performance.now() + 45_000,
    deadline = setTimeout(() => controller.abort(), 45_000)
  let db: PactDatabase | undefined,
    spawns = 0,
    nativeClosed = false,
    originalDispatchAttempts = 0,
    replacementDispatchAttempts = 0
  try {
    await provider.start()
    await provider.configureCodex(owned.home)
    const binary = await executable('codex', owned, deadlineAt),
      bundle = await buildAdapters(owned.root),
      env = isolatedEnv(owned.root, owned.home)
    const adapter = new bundle.CodexAgentAdapter(
      binary,
      async (cwd) => {
        if (++spawns !== 1)
          throw new Error('Replacement attempted to create another native executor')
        const handle = await owned.processes.spawnOwnedAsync(
          binary,
          ['app-server'],
          { cwd, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] },
          deadlineAt,
        )
        observeRootWrites(handle.child, roots)
        handle.child.once('close', () => {
          nativeClosed = true
        })
        return handle
      },
      { storageRoot: owned.home },
    )
    adapters.push(adapter)
    db = await PactDatabase.open({
      filePath: join(owned.root, 'confirmed-unsent.sqlite'),
      migrationsFolder: resolvePath(import.meta.dirname, '../../packages/persistence/drizzle'),
    })
    const repo = db.conversationRepository,
      sessionId = randomUUID(),
      projectId = randomUUID(),
      nativeGeneration = randomUUID(),
      createdAt = new Date().toISOString()
    db.projectCatalogRepository.add({
      id: projectId,
      name: 'Owned native unsent fixture',
      directoryPath: owned.cwd,
      kind: 'directory',
      createdAt,
    })
    db.sessionRepository.create(
      { id: sessionId, projectId, title: 'Owned native unsent fixture', createdAt },
      {
        primaryAgentId: 'codex',
        agents: {
          codex: { model: null, effort: null, speed: 'standard' },
          claude: { model: null, effort: null },
        },
        maxDiscussionRounds: 6,
        maxReviewCycles: 3,
        maxRepairAttempts: 3,
      },
    )
    db.sessionRepository.savePermission({
      sessionId,
      agentId: 'codex',
      mode: 'full',
      expectedRevision: 1,
      confirmedFullAccess: true,
    })
    db.sessionRepository.saveSpeed({
      sessionId,
      agentId: 'codex',
      speed: 'standard',
      expectedRevision: 2,
    })
    repo.saveSchedulingSettings({
      expectedRevision: 0,
      enabled: true,
      selection: { target: 'codex_luna', provider: 'codex', modelId: 'gpt-6-luna' },
    })
    repo.beginSchedulingRecoveryEpoch(randomUUID())
    const settingsRevision = db.sessionRepository.find(sessionId)!.settingsRevision,
      baselineTurns = materialized ? 1 : 0
    if (materialized) {
      const prior = repo.beginRun({
          sessionId,
          clientMessageId: randomUUID(),
          content: 'Materialize this owned baseline Session. Do not use tools.',
          commentIds: [],
          expectedCommentsRevision: 0,
          agentId: 'codex',
          settingsRevision,
          model: null,
          effort: null,
        }).run,
        priorGeneration = randomUUID()
      for await (const event of adapter.run(
        {
          runId: prior.id,
          sessionId,
          cwd: owned.cwd,
          model: null,
          effort: null,
          speed: 'standard',
          permissionMode: 'full',
          nativeGeneration: priorGeneration,
          bindingGeneration: prior.bindingGeneration ?? 1,
          peerAssistanceAllowed: false,
          promptEnvelope: {
            version: 'pact-agent-prompt-v1',
            sessionId,
            message: {
              id: prior.userMessageId,
              content: 'Materialize this owned baseline Session. Do not use tools.',
            },
            comments: [],
          },
          recordExecutor: (executorId) => repo.recordExecutor(prior.id, executorId),
          recordDispatch: (phase, nativeSessionId, executorId) =>
            repo.recordDispatch(prior.id, phase, nativeSessionId, executorId),
          recordNativeEvidence: (evidence) => repo.recordNativeEvidence(evidence),
          reportNativeEffects: (report) =>
            repo.recordNativeEffects(prior.id, report.state, report.reason),
        },
        controller.signal,
      ))
        repo.applyEvent(sessionId, prior.id, event)
      expect(repo.findRun(prior.id)).toMatchObject({
        status: 'completed',
        nativeEffectsState: 'settled',
      })
      expect(repo.nativeContext(sessionId, 'codex')?.continuationState).toBe('ready')
      expect(roots).toHaveLength(1)
      expect(provider.requests).toHaveLength(1)
      expect(adapter.hasActiveBackgroundWork()).toBe(false)
    }
    const originalNativeSessionId = repo.nativeContext(sessionId, 'codex')?.nativeSessionId,
      drafts = repo.readPage({ scope: 'drafts', sessionId })
    if (drafts.scope !== 'drafts') throw new Error('Expected authoritative draft revision')
    const content =
        'Exact frozen user input 🧭\nReturn only the owned fixture answer. Do not use tools.',
      original = repo.beginRun({
        sessionId,
        clientMessageId: randomUUID(),
        content,
        commentIds: [],
        expectedCommentsRevision: drafts.commentsRevision,
        agentId: 'codex',
        settingsRevision,
        model: null,
        effort: null,
      }).run,
      envelope: FrozenExecutionEnvelope = {
        version: 'pact-agent-prompt-v1',
        sessionId,
        message: { id: original.userMessageId, content },
        comments: [],
        inputBatchRef: repo.inputBatchForRun(original.id)!,
      },
      captured = await repo.captureExecutionInput({
        runId: original.id,
        nativeGeneration,
        requested: {
          provider: 'codex',
          model: null,
          effort: null,
          permissionMode: 'full',
          speed: 'standard',
        },
        source: executionBytes(envelope),
        signal: controller.signal,
      })
    if (!captured) throw new Error('The authoritative immutable input was not admitted')

    const recovery = (runId: string): NonNullable<AgentRunInput['recovery']> => ({
      inputSha256: captured.inputSha256,
      recordEffectiveSettings: (settings, identity) => {
        effectiveReceipts.push({ runId, settings, identity })
        // A replacement compares against the original immutable receipt. It does
        // not capture a second mutable description of that original input.
        if (runId === original.id)
          repo.recordEffectiveExecutionSettings(runId, nativeGeneration, settings, identity)
      },
      recordConfirmedUnsent: (boundary, identity) => {
        unsentReceipts.push({ runId, boundary, identity })
        repo.recordConfirmedUnsent(runId, nativeGeneration, boundary, identity)
      },
    })
    const input = (runId: string): AgentRunInput => ({
      runId,
      sessionId,
      cwd: owned.cwd,
      model: null,
      effort: null,
      permissionMode: 'full',
      speed: 'standard',
      nativeGeneration,
      bindingGeneration: original.bindingGeneration ?? 1,
      ...(originalNativeSessionId ? { nativeSessionId: originalNativeSessionId } : {}),
      peerAssistanceAllowed: false,
      promptEnvelope: restoreExecutionInput(
        repo.frozenExecutionEnvelope(original.id),
        () => {
          throw new Error('This ordinary native fixture contains no image capability')
        },
        undefined,
      ),
      recordExecutor: (executorId) => repo.recordExecutor(runId, executorId),
      recordNativeEvidence: (evidence) => repo.recordNativeEvidence(evidence),
      reportNativeEffects: (report) => {
        expect(report.runId).toBe(runId)
        expect(report.generation).toBe(nativeGeneration)
        repo.recordNativeEffects(runId, report.state, report.reason)
      },
    })
    const run = async (value: AgentRunInput) => {
      for await (const event of adapter.run(value, controller.signal))
        repo.applyEvent(sessionId, value.runId, event)
    }
    await expect(
      run({
        ...input(original.id),
        recovery: recovery(original.id),
        recordDispatch: (phase, nativeSessionId, executorId) => {
          repo.recordDispatch(original.id, phase, nativeSessionId, executorId)
          if (phase !== 'possibly_sent') return
          originalDispatchAttempts++
          expect(roots).toHaveLength(baselineTurns)
          expect(provider.requests).toHaveLength(baselineTurns)
          // The genuine writer invokes this durable callback before sink.write.
          // No native reply or native file is changed by this controlled fault.
          repo.recordDispatch(original.id, 'rejected', nativeSessionId, executorId)
          throw new Error('Injected owned pre-write transport interruption')
        },
      }),
    ).rejects.toMatchObject({ kind: 'protocol_error' })
    expect(effectiveReceipts).toHaveLength(1)
    const actual = effectiveReceipts[0]!
    expect(actual.settings).toMatchObject({
      provider: 'codex',
      model: 'gpt-5.4',
      effort: { known: true, value: 'high' },
      permissionMode: 'full',
      speed: 'standard',
      provenance: 'codex_thread_configuration',
    })
    expect(unsentReceipts).toHaveLength(1)
    expect(unsentReceipts[0]).toMatchObject({
      runId: original.id,
      boundary: { kind: 'codex_root_frame_not_written', requestId: expect.any(Number) },
      identity: actual.identity,
    })
    expect(repo.executionInput(original.id)?.proof).toMatchObject({
      ...actual.identity,
      inputSha256: captured.inputSha256,
      boundary: unsentReceipts[0]!.boundary,
    })
    expect(roots).toHaveLength(baselineTurns)
    expect(provider.requests).toHaveLength(baselineTurns)
    expect(adapter.hasActiveBackgroundWork()).toBe(false)
    expect(nativeClosed).toBe(false)
    expect(repo.findRun(original.id)).toMatchObject({
      dispatchPhase: 'rejected',
      nativeEffectsState: 'settled',
    })
    repo.failRun(original.id, 'protocol_error', 'Injected owned pre-write transport interruption')
    repo.setContinuation(sessionId, 'codex', 'ready', undefined, original.bindingGeneration ?? 1)
    repo.armSchedulingRecoveryFaults(sessionId)
    const candidate = repo
      .takeSchedulingRecoveryFaults()
      .find((row) => row.fault.runId === original.id)
    if (!candidate) throw new Error('The physical-unsent original fault was not retained')
    const operation = {
        operationId: randomUUID(),
        faultId: candidate.fault.id,
        handoff: repo.recoveryHandoff({ kind: 'run', id: original.id }),
      },
      admitted = repo.beginConfirmedUnsentReexecution(operation),
      replacement = admitted.run
    expect(admitted.created).toBe(true)
    expect(replacement.id).not.toBe(original.id)
    expect(replacement).toMatchObject({
      userMessageId: original.userMessageId,
      reexecutedFromRunId: original.id,
      nativeSessionId: actual.identity.nativeSessionId,
      permissionMode: 'full',
      speed: 'standard',
    })
    expect(repo.beginConfirmedUnsentReexecution(operation)).toMatchObject({
      created: false,
      run: { id: replacement.id },
    })
    expect(repo.schedulingBudget(`input:${original.userMessageId}`)?.automaticResends).toBe(1)
    expect(repo.canDispatchReexecution(replacement.id)).toBe(true)
    const replacementAttempt = run({
      ...input(replacement.id),
      nativeSessionId: actual.identity.nativeSessionId,
      recovery: {
        ...recovery(replacement.id),
        expected: { settings: actual.settings, ...actual.identity },
        canDispatch: () => repo.canDispatchReexecution(replacement.id),
      },
      recordDispatch: (phase, nativeSessionId, executorId) => {
        if (phase === 'possibly_sent') replacementDispatchAttempts++
        repo.recordDispatch(replacement.id, phase, nativeSessionId, executorId)
      },
    })
    if (!materialized) {
      await expect(replacementAttempt).rejects.toMatchObject({
        kind: 'context_resume_failed',
        message: expect.stringContaining('no rollout found for thread id'),
      })
      repo.failRun(
        replacement.id,
        'context_resume_failed',
        'The genuine fresh native Thread has no rollout',
      )
      expect(effectiveReceipts).toHaveLength(1)
      expect(roots).toHaveLength(0)
      expect(provider.requests).toHaveLength(0)
      expect(provider.errors).toEqual([])
      expect(replacementDispatchAttempts).toBe(0)
      expect(originalDispatchAttempts).toBe(1)
      expect(unsentReceipts).toHaveLength(1)
      expect(spawns).toBe(1)
      expect(nativeClosed).toBe(false)
      expect(adapter.hasActiveBackgroundWork()).toBe(false)
      expect(repo.findRun(replacement.id)).toMatchObject({
        status: 'failed',
        failureKind: 'context_resume_failed',
        dispatchPhase: 'rejected',
      })
      expect(repo.canDispatchReexecution(replacement.id)).toBe(false)
      expect(repo.schedulingBudget(`input:${original.userMessageId}`)?.automaticResends).toBe(1)
      expect(() =>
        repo.beginConfirmedUnsentReexecution({ ...operation, operationId: randomUUID() }),
      ).toThrow(/one replacement/u)
      console.info(
        '[native fresh-thread limitation]',
        JSON.stringify({
          originalRootWrites: 0,
          replacementRootWrites: 0,
          modelRequests: 0,
          nativeRejection: 'no rollout found',
          executorCount: spawns,
          automaticResends: 1,
        }),
      )
      return
    }
    await replacementAttempt
    expect(effectiveReceipts).toHaveLength(2)
    expect(effectiveReceipts[1]).toEqual({
      runId: replacement.id,
      settings: actual.settings,
      identity: actual.identity,
    })
    expect(roots).toHaveLength(baselineTurns + 1)
    const boundary = unsentReceipts[0]!.boundary
    if (boundary.kind !== 'codex_root_frame_not_written')
      throw new Error('Expected genuine Codex root proof')
    expect(roots[baselineTurns]!.id).not.toBe(boundary.requestId)
    expect(roots[baselineTurns]!.params).toMatchObject({
      threadId: actual.identity.nativeSessionId,
      clientUserMessageId: replacement.id,
      input: [
        {
          type: 'text',
          text: serializeAgentPromptEnvelope(input(original.id).promptEnvelope),
          text_elements: [],
        },
      ],
      serviceTierForTurn: 'default',
      collaborationMode: {
        mode: 'default',
        settings: { model: 'gpt-5.4', reasoning_effort: 'high' },
      },
    })
    expect(provider.requests).toHaveLength(baselineTurns + 1)
    expect(provider.requests[baselineTurns]).toMatchObject({
      method: 'POST',
      path: '/v1/responses',
    })
    expect(provider.errors).toEqual([])
    expect(originalDispatchAttempts).toBe(1)
    expect(replacementDispatchAttempts).toBe(1)
    expect(unsentReceipts).toHaveLength(1)
    expect(spawns).toBe(1)
    expect(nativeClosed).toBe(false)
    expect(adapter.hasActiveBackgroundWork()).toBe(false)
    expect(repo.findRun(replacement.id)).toMatchObject({
      status: 'completed',
      dispatchPhase: 'ended',
      nativeEffectsState: 'settled',
      executorId: actual.identity.executorId,
      nativeSessionId: actual.identity.nativeSessionId,
      userMessageId: original.userMessageId,
    })
    expect(repo.frozenExecutionEnvelope(original.id)).toEqual(envelope)
    expect(db.drizzle.select().from(agentRuns).all()).toHaveLength(baselineTurns + 2)
    expect(
      db.drizzle
        .select()
        .from(conversationMessages)
        .all()
        .filter((row) => row.role === 'user'),
    ).toHaveLength(baselineTurns + 1)
    expect(db.drizzle.select().from(runReexecutionOperations).all()).toHaveLength(1)
    expect(repo.schedulingBudget(`input:${original.userMessageId}`)?.automaticResends).toBe(1)
    expect(() =>
      repo.beginConfirmedUnsentReexecution({ ...operation, operationId: randomUUID() }),
    ).toThrow(/one replacement/u)
    console.info(
      '[native confirmed-unsent]',
      JSON.stringify({
        originalRootWrites: 0,
        originalModelRequests: 0,
        priorCompletedNativeTurns: baselineTurns,
        replacementRootWrites: roots.length - baselineTurns,
        replacementModelRequests: provider.requests.length - baselineTurns,
        sameExecutor: true,
        sameNativeSession: true,
        sameFrozenInput: true,
        sameEffectiveSettings: true,
        automaticResends: 1,
        fault: 'controlled_host_writer_callback_before_first_byte',
      }),
    )
  } finally {
    controller.abort()
    clearTimeout(deadline)
    try {
      for (const adapter of adapters) {
        // oxlint-disable-next-line no-await-in-loop -- SQLite stays open through actual native callback settlement.
        await adapter.dispose()
      }
    } finally {
      db?.close()
      await cleanupNativeFixture(owned, { adapters, provider })
    }
  }
}
// oxlint-enable vitest/no-conditional-expect

it('real Codex preserves one executor and exact frozen settings across one physically unsent replacement of an existing Session', async () => {
  await expect(verifyNativeReplacement(true)).resolves.toBeUndefined()
}, 60_000)

it('real Codex withholds a fresh unmaterialized Thread replacement after native resume rejection without a second executor or model call', async () => {
  await expect(verifyNativeReplacement(false)).resolves.toBeUndefined()
}, 60_000)
