import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { expect, it, vi } from 'vitest'

import {
  decisionCapabilitySchema,
  type DecisionInput,
  type DecisionPhysicalWitness,
} from '@pact/contracts'

import { decisionFixture } from '../../../../../packages/persistence/src/decision-fixture.test-support.js'
import { OwnedProcessGroup } from '../owned-process-group.js'
import {
  ClaudeDecisionRuntime,
  type ClaudeDecisionRuntimeContext,
} from './claude-decision-runtime.js'
import { nativeWorkingMemoryCapacities } from './native-working-memory.js'

// Protocol fixtures replace only OS containment; native tests exercise the real sandbox.
vi.mock('./decision-native-isolation', async (original) => {
  const actual = await original<typeof import('./decision-native-isolation')>()
  return {
    ...actual,
    resolveDecisionNativeExecutable: async (selected: string) => ({
      path: selected,
      fingerprint: 'owned-protocol-fixture',
      current: async () => true,
    }),
    decisionDarwinSandbox: (executable: string) => ({ command: executable, args: [] }),
    retainCodexInstallationId: async (home: string) => ({
      home,
      path: join(home, 'installation_id'),
      current: async () => true,
      close: async () => {},
    }),
  }
})

type CompletionFacts = Parameters<
  NonNullable<ClaudeDecisionRuntimeContext['physicalCompletion']>
>[0]
type RetirementFacts = Parameters<
  NonNullable<ClaudeDecisionRuntimeContext['retirePhysicalReceipts']>
>[0]
const execFileAsync = promisify(execFile)
function groupGone(witness: DecisionPhysicalWitness | null | undefined): boolean {
  if (!witness) return true
  if (witness.platform !== 'darwin')
    throw Error('This owned protocol fixture requires Darwin group observations')
  try {
    process.kill(-witness.root.pgid, 0)
    return false
  } catch (error) {
    return error !== null && typeof error === 'object' && Reflect.get(error, 'code') === 'ESRCH'
  }
}

const MODEL = 'claude-haiku-5-5'
const ANSWER = '{"candidateId":"wait","highlights":[]}'
const event = (type: string, fields: Record<string, unknown> = {}) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`
function response(): string {
  return (
    event('message_start', {
      message: {
        id: 'owned_message',
        type: 'message',
        role: 'assistant',
        model: MODEL,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 12, output_tokens: 0 },
      },
    }) +
    event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) +
    event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: ANSWER } }) +
    event('content_block_stop', { index: 0 }) +
    event('message_delta', {
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 8 },
    }) +
    event('message_stop')
  )
}
const idleContext = (): ClaudeDecisionRuntimeContext => ({
  modelId: MODEL,
  ownerId: randomUUID(),
  executable: '/unused',
  cwd: '/unused',
  current: () => true,
  dispatch: vi.fn<() => void>(),
  reserve: () => 'reserved',
  beginNativeStage: vi.fn<ClaudeDecisionRuntimeContext['beginNativeStage']>(() => {
    throw Error('Unexpected native stage')
  }),
  physicalPrepared: vi.fn<ClaudeDecisionRuntimeContext['physicalPrepared']>(),
  prepared: vi.fn<ClaudeDecisionRuntimeContext['prepared']>(),
  environment: {},
})

async function fixture(
  options: {
    missingModel?: boolean
    literalModel?: boolean
    secureMetadata?: boolean
    projectDrift?: boolean
    badResult?: boolean
    overflow?: boolean
    hang?: boolean
    verificationDrift?: boolean
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'pact-claude-runtime-unit-')),
    cwd = join(root, 'project'),
    commands = join(root, 'commands.jsonl'),
    executable = join(root, 'claude.cjs'),
    drift = join(root, 'verification-drift')
  await mkdir(cwd)
  let requests = 0
  const provider = createServer((incoming, outgoing) => {
    requests++
    if (options.verificationDrift) writeFileSync(drift, 'owned verification change')
    incoming.resume()
    outgoing.writeHead(200, { 'content-type': 'text/event-stream' })
    outgoing.end(response())
  })
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve))
  const address = provider.address()
  if (!address || typeof address === 'string') throw Error('Owned provider unavailable')
  await writeFile(
    executable,
    `#!${process.execPath}
const {appendFileSync}=require('node:fs');const readline=require('node:readline');
const arg=(name)=>process.argv[process.argv.indexOf(name)+1];
const settings=JSON.parse(arg('--settings'));const session=arg('--session-id');const model=arg('--model');
const credentialVariableName='ANTHROPIC_API_KEY';
const send=(value)=>process.stdout.write(JSON.stringify(value)+'\\n');
readline.createInterface({input:process.stdin}).on('line',async(line)=>{
 const value=JSON.parse(line);
 appendFileSync(process.env.OWNED_COMMANDS,JSON.stringify({type:value.type,subtype:value.request?.subtype,cwd:process.cwd(),sources:arg('--setting-sources'),session})+'\\n');
 if(value.type==='control_request'){
  let result={};const type=value.request.subtype;
  if(type==='initialize')result={models:[{value:'haiku',resolvedModel:process.env.OWNED_MISSING_MODEL?'claude-haiku-4-5':model},...(process.env.OWNED_LITERAL_MODEL?[{value:model,resolvedModel:model}]:[])],account:{apiProvider:'firstParty',tokenSource:'none',apiKeySource:credentialVariableName}};
  if(type==='initialize'&&process.env.OWNED_HANG)return;
  if(type==='get_settings'){
   const env={ANTHROPIC_BASE_URL:process.env.ANTHROPIC_BASE_URL,...settings.env};
   if(process.env.OWNED_PROJECT_DRIFT&&arg('--setting-sources').includes('project'))env.ANTHROPIC_BASE_URL+='/changed';
   if(process.env.OWNED_VERIFICATION_DRIFT&&require('node:fs').existsSync(process.env.OWNED_VERIFICATION_DRIFT)&&arg('--setting-sources').includes('project'))env.OWNED_VERIFIED_POLICY='changed';
   result={effective:{...settings,env},applied:{model,effort:'high'},remote_control_policy_lock_reason:null};
  }
  if(type==='get_hooks_listing')result={hooks:[],policy:{allDisabled:true,policyHookCount:0}};
  if(process.env.OWNED_OVERFLOW&&type==='initialize'){process.stdout.write('x'.repeat(262145));return;}
  send({type:'control_response',response:{subtype:'success',request_id:value.request_id,response:result}});return;
 }
 if(value.type==='user'){
  send({type:'command_lifecycle',command_uuid:value.uuid,state:'queued',uuid:require('node:crypto').randomUUID(),session_id:session});
  send({type:'command_lifecycle',command_uuid:value.uuid,state:'started',uuid:require('node:crypto').randomUUID(),session_id:session});
  send({type:'system',subtype:'init',session_id:session,model,tools:[],mcp_servers:[]});
  const base=settings.env.ANTHROPIC_BASE_URL;
  const request={model,stream:true,messages:[value.message],system:[{type:'text',text:'Owned global context'}],tools:[],max_tokens:128};
  const response=await fetch(base+'/v1/messages',{method:'POST',headers:{'x-api-key':'OWNED_LOOPBACK_ONLY','content-type':'application/json'},body:JSON.stringify(request)});
  await response.text();
  const text=${JSON.stringify(ANSWER)};
  send({type:'assistant',session_id:session,user_message_uuid:value.uuid,user_message_uuids:[value.uuid],parent_tool_use_id:null,message:{model,content:[{type:'text',text}]}});
  send({type:'result',session_id:session,user_message_uuid:value.uuid,user_message_uuids:[value.uuid],queued_turn_count:0,result_index:0,subtype:'success',is_error:!!process.env.OWNED_BAD_RESULT,num_turns:1,result:text});
  send({type:'command_lifecycle',command_uuid:value.uuid,state:'completed',uuid:require('node:crypto').randomUUID(),session_id:session});
 }
});
`,
    { mode: 0o700 },
  )
  const stages: string[] = [],
    witnesses: DecisionPhysicalWitness[] = [],
    dispatch = vi.fn<() => void>(),
    prepared = vi.fn<ClaudeDecisionRuntimeContext['prepared']>()
  let generation = 0,
    last: DecisionPhysicalWitness | null = null
  const context: ClaudeDecisionRuntimeContext = {
    modelId: MODEL,
    ownerId: randomUUID(),
    executable,
    cwd,
    current: () => true,
    dispatch,
    prepared,
    reserve: () => 'reserved',
    environment: {
      PATH: process.env.PATH,
      HOME: root,
      CLAUDE_CONFIG_DIR: root,
      ANTHROPIC_BASE_URL: options.secureMetadata
        ? 'https://owned.invalid'
        : `http://127.0.0.1:${address.port}`,
      ANTHROPIC_API_KEY: 'OWNED_LOOPBACK_ONLY',
      OWNED_COMMANDS: commands,
      ...(options.missingModel ? { OWNED_MISSING_MODEL: '1' } : {}),
      ...(options.literalModel ? { OWNED_LITERAL_MODEL: '1' } : {}),
      ...(options.projectDrift ? { OWNED_PROJECT_DRIFT: '1' } : {}),
      ...(options.badResult ? { OWNED_BAD_RESULT: '1' } : {}),
      ...(options.overflow ? { OWNED_OVERFLOW: '1' } : {}),
      ...(options.hang ? { OWNED_HANG: '1' } : {}),
      ...(options.verificationDrift ? { OWNED_VERIFICATION_DRIFT: drift } : {}),
    },
    beginNativeStage(facts) {
      expect(facts.expectedGeneration).toBe(generation)
      expect(facts.previousWitness).toEqual(last)
      expect(facts.previousPhysicalReleased).toBe(true)
      const previous = last
      const released =
        previous?.platform !== 'darwin' ||
        (() => {
          try {
            process.kill(-previous.root.pgid, 0)
            return false
          } catch {
            return true
          }
        })()
      expect(released).toBe(true)
      stages.push(facts.stage)
      return ++generation
    },
    physicalPrepared(facts) {
      expect(facts.nativeGeneration).toBe(generation)
      expect(facts.witness.ownerId).toBe(context.ownerId)
      last = facts.witness
      witnesses.push(facts.witness)
    },
  }
  return {
    context,
    stages,
    witnesses,
    dispatch,
    prepared,
    commands,
    get requests() {
      return requests
    },
    async close() {
      provider.closeAllConnections()
      await new Promise<void>((resolve) => provider.close(() => resolve()))
      await rm(root, { recursive: true, force: true })
    },
  }
}

it('runs four serial physical stages under one lease, one owner and one actual dispatch', async () => {
  const f = await fixture(),
    source = await decisionFixture(),
    runtime = new ClaudeDecisionRuntime(f.context)
  try {
    expect(await runtime.evaluateDecision(source.input, new AbortController().signal)).toEqual({
      kind: 'recommendation',
      recommendation: { candidateId: 'wait', highlights: [] },
    })
    expect(await runtime.settlement()).toBe(true)
    expect(f.stages).toEqual([
      'host_metadata',
      'project_metadata',
      'guarded_context',
      'project_verification',
    ])
    expect(f.requests).toBe(1)
    expect(f.dispatch).toHaveBeenCalledOnce()
    expect(f.prepared).toHaveBeenCalledOnce()
    expect(runtime.invoked).toBe(true)
    expect(runtime.usage).toEqual({ inputTokens: 12, outputTokens: 8 })
    expect(runtime.diagnostics().working.highWaterBytes).toBeLessThanOrEqual(16 * 1024 * 1024)
    expect(new Set(f.witnesses.map((witness) => witness.ownerId))).toEqual(
      new Set([f.context.ownerId]),
    )
    const commands = (await readFile(f.commands, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => {
        const value: unknown = JSON.parse(line)
        if (!value || typeof value !== 'object' || Array.isArray(value))
          throw Error('Invalid owned command')
        return Object.fromEntries(Object.entries(value))
      })
    expect(commands.filter((command) => command.type === 'user')).toHaveLength(1)
    expect(commands.some((command) => command.subtype === 'set_model')).toBe(false)
    expect(commands.find((command) => command.type === 'user')?.cwd).not.toBe(f.context.cwd)
  } finally {
    await runtime.dispose()
    source.db.close()
    await f.close()
  }
})

it('retires prior receipts after durable stage advance and completes physical ownership before releasing the same lease', async () => {
  const f = await fixture(),
    source = await decisionFixture(),
    events: string[] = [],
    spawn = vi.spyOn(OwnedProcessGroup.prototype, 'spawn')
  let generation = 0,
    memory: RetirementFacts['memory'] | undefined,
    completions = 0
  const runtime = new ClaudeDecisionRuntime({
    ...f.context,
    beginNativeStage(facts) {
      generation = f.context.beginNativeStage(facts)
      events.push(`begin:${generation}`)
      return generation
    },
    async retirePhysicalReceipts(facts) {
      events.push(`retire:${generation}`)
      expect(spawn).toHaveBeenCalledTimes(generation - 1)
      memory ??= facts.memory
      expect(facts.memory).toBe(memory)
      expect(f.witnesses.every(groupGone)).toBe(true)
      expect(facts.signal?.aborted).toBe(false)
      expect(facts.deadlineAt).toBeGreaterThan(Date.now())
      expect(facts.deadlineAt).toBeLessThanOrEqual(Date.now() + 4000)
      const reservation = facts.memory.reserve(64 * 1024)
      await Promise.resolve()
      reservation.release()
      return true
    },
    physicalPrepared(facts) {
      events.push(`witness:${facts.nativeGeneration}`)
      return f.context.physicalPrepared(facts)
    },
    async physicalCompletion(facts) {
      completions++
      events.push(`complete:${facts.nativeGeneration}`)
      expect(facts.memory).toBe(memory)
      expect(facts.witness).toEqual(f.witnesses.at(-1))
      expect(f.witnesses.every(groupGone)).toBe(true)
      expect(runtime.diagnostics().guard?.physicalReleased).toBe(true)
      expect(runtime.diagnostics().working.released).toBe(false)
      expect(nativeWorkingMemoryCapacities().decision.chargedBytes).toBe(16 * 1024 * 1024)
      expect(facts.outcome).toEqual({
        kind: 'recommendation',
        recommendation: { candidateId: 'wait', highlights: [] },
      })
      expect(facts.usage).toEqual({ inputTokens: 12, outputTokens: 8 })
      const first: unknown = JSON.parse((await readFile(f.commands, 'utf8')).split('\n')[0]!)
      const cwd: unknown =
        first && typeof first === 'object' ? Reflect.get(first, 'cwd') : undefined
      if (typeof cwd !== 'string') throw Error('Missing owned working directory')
      // The native temporary directory itself is already removed before the host commit.
      expect(
        await access(cwd).then(
          () => true,
          () => false,
        ),
      ).toBe(false)
      const reservation = facts.memory.reserve(64 * 1024)
      await Promise.resolve()
      reservation.release()
    },
  })
  try {
    expect((await runtime.evaluateDecision(source.input, new AbortController().signal)).kind).toBe(
      'recommendation',
    )
    expect(await runtime.settlement()).toBe(true)
    expect(events).toEqual([
      'begin:1',
      'retire:1',
      'witness:1',
      'begin:2',
      'retire:2',
      'witness:2',
      'begin:3',
      'retire:3',
      'witness:3',
      'begin:4',
      'retire:4',
      'witness:4',
      'complete:4',
    ])
    expect(await runtime.dispose()).toBe(true)
    expect(completions).toBe(1)
    expect(spawn).toHaveBeenCalledTimes(4)
  } finally {
    await runtime.dispose()
    spawn.mockRestore()
    source.db.close()
    await f.close()
  }
})

it('joins a pending stage retirement after cancellation without starting the next native process', async () => {
  const f = await fixture(),
    source = await decisionFixture(),
    entered = Promise.withResolvers<RetirementFacts>(),
    released = Promise.withResolvers<void>(),
    cancel = new AbortController(),
    spawn = vi.spyOn(OwnedProcessGroup.prototype, 'spawn')
  const completed = vi.fn<NonNullable<ClaudeDecisionRuntimeContext['physicalCompletion']>>(
    async (facts) => {
      expect(facts.witness).toBeNull()
      expect(facts.nativeGeneration).toBe(1)
      expect(facts.outcome).toEqual({ kind: 'unavailable', reason: 'cancelled' })
    },
  )
  const deadlineAt = Date.now() + 2000,
    runtime = new ClaudeDecisionRuntime({
      ...f.context,
      deadlineAt,
      physicalCompletion: completed,
      async retirePhysicalReceipts(facts) {
        const reservation = facts.memory.reserve(64 * 1024)
        entered.resolve(facts)
        await released.promise
        reservation.release()
        return true
      },
    })
  try {
    const logical = runtime.evaluateDecision(source.input, cancel.signal)
    let physicalDone = false
    const physical = runtime.settlement().then((value) => {
      physicalDone = true
      return value
    })
    const facts = await entered.promise
    expect(facts.deadlineAt).toBe(deadlineAt)
    expect(f.stages).toEqual(['host_metadata'])
    expect(spawn).not.toHaveBeenCalled()
    expect(
      await readFile(f.commands).then(
        () => true,
        () => false,
      ),
    ).toBe(false)
    cancel.abort()
    expect(await logical).toEqual({ kind: 'unavailable', reason: 'cancelled' })
    expect(facts.signal?.aborted).toBe(true)
    expect(physicalDone).toBe(false)
    expect(nativeWorkingMemoryCapacities().decision.chargedBytes).toBe(16 * 1024 * 1024)
    expect(completed).not.toHaveBeenCalled()
    released.resolve()
    expect(await physical).toBe(true)
    expect(completed).toHaveBeenCalledOnce()
    expect(f.witnesses).toEqual([])
    expect(f.requests).toBe(0)
    expect(spawn).not.toHaveBeenCalled()
  } finally {
    released.resolve()
    await runtime.dispose()
    spawn.mockRestore()
    source.db.close()
    await f.close()
  }
})

it('treats a joined full receipt backlog as unavailable and does not reuse the prior generation witness', async () => {
  const f = await fixture()
  let retirements = 0
  const complete = vi.fn<NonNullable<ClaudeDecisionRuntimeContext['physicalCompletion']>>(
    async (facts) => {
      expect(facts.nativeGeneration).toBe(2)
      expect(facts.witness).toBeNull()
      expect(Object.hasOwn(facts, 'outcome')).toBe(false)
      expect(f.witnesses.every(groupGone)).toBe(true)
    },
  )
  const runtime = new ClaudeDecisionRuntime({
    ...f.context,
    retirePhysicalReceipts: async () => ++retirements === 1,
    physicalCompletion: complete,
  })
  try {
    expect(await runtime.probeAdmission()).toMatchObject({
      supported: false,
      reason: 'unavailable',
      physicalReleased: true,
    })
    expect(f.stages).toEqual(['host_metadata', 'project_metadata'])
    expect(f.witnesses).toHaveLength(1)
    expect(complete).toHaveBeenCalledOnce()
    expect(await runtime.settlement()).toBe(true)
    expect(nativeWorkingMemoryCapacities().decision.chargedBytes).toBe(0)
  } finally {
    await runtime.dispose()
    await f.close()
  }
})

it('retains an observed witness when durable preparation fails and returns it only after real group closure', async () => {
  const f = await fixture()
  let observed: DecisionPhysicalWitness | null = null
  const complete = vi.fn<NonNullable<ClaudeDecisionRuntimeContext['physicalCompletion']>>(
    async (facts) => {
      expect(facts.nativeGeneration).toBe(1)
      expect(facts.witness).toEqual(observed)
      expect(groupGone(facts.witness)).toBe(true)
      expect(Object.hasOwn(facts, 'outcome')).toBe(false)
    },
  )
  const runtime = new ClaudeDecisionRuntime({
    ...f.context,
    physicalPrepared: async ({ witness }) => {
      observed = witness
      throw Error('Owned transient receipt persistence failure')
    },
    physicalCompletion: complete,
  })
  try {
    expect(await runtime.probeAdmission()).toMatchObject({
      supported: false,
      reason: 'unavailable',
      physicalReleased: true,
    })
    expect(observed).not.toBeNull()
    expect(complete).toHaveBeenCalledOnce()
    expect(f.requests).toBe(0)
  } finally {
    await runtime.dispose()
    await f.close()
  }
})

it('returns the logical deadline while completion I/O stays joined, without renewing its cleanup deadline', async () => {
  const entered = Promise.withResolvers<CompletionFacts>(),
    closed = Promise.withResolvers<void>()
  vi.useFakeTimers()
  const startedAt = Date.now(),
    completed = vi.fn<NonNullable<ClaudeDecisionRuntimeContext['physicalCompletion']>>(
      async (facts) => {
        const reservation = facts.memory.reserve(64 * 1024)
        entered.resolve(facts)
        await closed.promise
        reservation.release()
      },
    )
  const runtime = new ClaudeDecisionRuntime({ ...idleContext(), physicalCompletion: completed })
  try {
    const logical = runtime.evaluateDecision({}, new AbortController().signal)
    let physicallyClosed = false
    const physical = runtime.settlement().then((value) => {
      physicallyClosed = true
      return value
    })
    await vi.advanceTimersByTimeAsync(0)
    const facts = await entered.promise
    expect(facts.outcome).toEqual({ kind: 'unavailable', reason: 'invalid_input' })
    expect(facts.deadlineAt).toBe(startedAt + 4000)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(await logical).toEqual({ kind: 'unavailable', reason: 'timeout' })
    expect(facts.outcome).toEqual({ kind: 'unavailable', reason: 'timeout' })
    expect(facts.deadlineAt).toBe(startedAt + 4000)
    expect(physicallyClosed).toBe(false)
    expect(nativeWorkingMemoryCapacities().decision.chargedBytes).toBe(16 * 1024 * 1024)
    closed.resolve()
    expect(await physical).toBe(true)
    expect(completed).toHaveBeenCalledOnce()
    expect(await runtime.dispose()).toBe(true)
    expect(completed).toHaveBeenCalledOnce()
  } finally {
    closed.resolve()
    await runtime.dispose()
    vi.useRealTimers()
  }
})

it.each(['retirement', 'completion'] as const)(
  'keeps an uncertain %s callback reservation until its isolated Utility process exits',
  async (failure) => {
    // Failure intentionally leaves the App lease held. A separate real Node owner
    // exits after assertions, rather than resetting a live shared admission counter.
    const root = await mkdtemp(join(tmpdir(), 'pact-claude-receipt-failure-')),
      script = join(root, 'failure.mjs')
    const persistenceRequire = createRequire(
      resolvePath(import.meta.dirname, '../../../../../packages/persistence/package.json'),
    )
    await writeFile(
      script,
      `
import { randomUUID } from 'node:crypto';
import { ClaudeDecisionRuntime } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, 'claude-decision-runtime.ts')).href)};
import { nativeWorkingMemoryCapacities } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, 'native-working-memory.ts')).href)};
let completed=0, retired=0;
const context={modelId:'claude-haiku-5-5',ownerId:randomUUID(),executable:process.execPath,cwd:${JSON.stringify(root)},current:()=>true,startupPolicyAdmission:()=>true,dispatch:()=>{},reserve:()=> 'reserved',beginNativeStage:()=>1,physicalPrepared:()=>{},prepared:()=>{},environment:{}};
context.retirePhysicalReceipts=async()=>{retired++;if(${JSON.stringify(failure)}==='retirement')throw Error('Owned retirement uncertainty');return true;};
context.physicalCompletion=async({memory})=>{completed++;memory.reserve(4096);throw Error('Owned final receipt uncertainty');};
const runtime=new ClaudeDecisionRuntime(context);
const outcome=${JSON.stringify(failure)}==='retirement'?await runtime.probeAdmission():await runtime.evaluateDecision({},new AbortController().signal);
const released=await runtime.settlement();await runtime.dispose();let replacementRefused=false;
try{new ClaudeDecisionRuntime(context);}catch{replacementRefused=true;}
process.stdout.write(JSON.stringify({outcome,released,completed,retired,replacementRefused,phase:runtime.diagnostics().phase,failure:runtime.diagnostics().failureReason,chargedBytes:nativeWorkingMemoryCapacities().decision.chargedBytes}));
`,
    )
    try {
      const result = await execFileAsync(
        process.execPath,
        ['--import', persistenceRequire.resolve('tsx'), script],
        {
          cwd: root,
          env: {
            PATH: process.env.PATH,
            HOME: root,
            USERPROFILE: root,
            TMPDIR: root,
            TMP: root,
            TEMP: root,
          },
          timeout: 10_000,
          maxBuffer: 8192,
          shell: false,
        },
      )
      const observed: unknown = JSON.parse(result.stdout)
      expect(observed).toMatchObject({
        released: false,
        completed: failure === 'completion' ? 1 : 0,
        retired: failure === 'retirement' ? 1 : 0,
        replacementRefused: true,
        phase: 'cleanup_unconfirmed',
        failure: 'cleanup_unconfirmed',
        chargedBytes: 16 * 1024 * 1024,
      })
      expect(nativeWorkingMemoryCapacities().decision.chargedBytes).toBe(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
)

it.each([false, true])(
  'probes without user input using at most three stages (project=%s)',
  async (project) => {
    const f = await fixture(),
      runtime = new ClaudeDecisionRuntime({
        ...f.context,
        cwd: project ? f.context.cwd : undefined,
      })
    try {
      const capability = await runtime.probeAdmission()
      expect(capability).toMatchObject({
        provider: 'claude',
        modelId: MODEL,
        supported: true,
        physicalReleased: true,
      })
      expect(decisionCapabilitySchema.safeParse(capability).success).toBe(true)
      expect(f.stages).toEqual(
        project
          ? ['host_metadata', 'project_metadata', 'guarded_context']
          : ['host_metadata', 'guarded_context'],
      )
      expect(f.requests).toBe(0)
      expect(f.dispatch).not.toHaveBeenCalled()
      expect(runtime.invoked).toBe(false)
      expect(runtime.usage).toBeUndefined()
    } finally {
      await runtime.dispose()
      await f.close()
    }
  },
)

it.each([
  ['missing exact catalog model', { missingModel: true }, 'model_unavailable'],
  ['different project authority', { projectDrift: true }, 'project_authentication_differs'],
  ['oversized raw native frame', { overflow: true }, 'unsupported_protocol'],
] as const)(
  'refuses %s without dispatch and physically releases',
  async (_name, options, reason) => {
    const f = await fixture(options),
      runtime = new ClaudeDecisionRuntime(f.context)
    try {
      expect(await runtime.probeAdmission()).toMatchObject({
        supported: false,
        reason,
        physicalReleased: true,
      })
      expect(f.requests).toBe(0)
      expect(f.dispatch).not.toHaveBeenCalled()
      expect(await runtime.settlement()).toBe(true)
    } finally {
      await runtime.dispose()
      await f.close()
    }
  },
)

it('rejects native success subtype when is_error is true and retains observed usage', async () => {
  const f = await fixture({ badResult: true }),
    source = await decisionFixture(),
    completed = vi.fn<NonNullable<ClaudeDecisionRuntimeContext['physicalCompletion']>>(
      async () => undefined,
    ),
    runtime = new ClaudeDecisionRuntime({ ...f.context, physicalCompletion: completed })
  try {
    expect(await runtime.evaluateDecision(source.input, new AbortController().signal)).toEqual({
      kind: 'unavailable',
      reason: 'runtime_unavailable',
    })
    expect(runtime.invoked).toBe(true)
    expect(runtime.usage).toEqual({ inputTokens: 12, outputTokens: 8 })
    expect(f.stages).toEqual(['host_metadata', 'project_metadata', 'guarded_context'])
    expect(await runtime.settlement()).toBe(true)
    expect(completed).toHaveBeenCalledOnce()
    expect(completed.mock.calls[0]?.[0]).toMatchObject({
      nativeGeneration: 3,
      witness: f.witnesses.at(-1),
      outcome: { kind: 'unavailable', reason: 'runtime_unavailable' },
      usage: { inputTokens: 12, outputTokens: 8 },
    })
  } finally {
    await runtime.dispose()
    source.db.close()
    await f.close()
  }
})

it('discards a validated answer when the final project authority changed and retains actual usage', async () => {
  const f = await fixture({ verificationDrift: true }),
    source = await decisionFixture(),
    runtime = new ClaudeDecisionRuntime(f.context)
  try {
    expect(await runtime.evaluateDecision(source.input, new AbortController().signal)).toEqual({
      kind: 'unavailable',
      reason: 'stale',
    })
    expect(runtime.invoked).toBe(true)
    expect(runtime.usage).toEqual({ inputTokens: 12, outputTokens: 8 })
    expect(f.stages).toEqual([
      'host_metadata',
      'project_metadata',
      'guarded_context',
      'project_verification',
    ])
    expect(await runtime.settlement()).toBe(true)
  } finally {
    await runtime.dispose()
    source.db.close()
    await f.close()
  }
})

it('does not dispatch after host freshness changes at final preparation', async () => {
  const f = await fixture(),
    source = await decisionFixture()
  let current = true
  const runtime = new ClaudeDecisionRuntime({
    ...f.context,
    current: () => current,
    prepared: () => {
      current = false
    },
  })
  try {
    expect(await runtime.evaluateDecision(source.input, new AbortController().signal)).toEqual({
      kind: 'unavailable',
      reason: 'stale',
    })
    expect(runtime.invoked).toBe(false)
    expect(f.requests).toBe(0)
    expect(f.dispatch).not.toHaveBeenCalled()
    expect(await runtime.settlement()).toBe(true)
  } finally {
    await runtime.dispose()
    source.db.close()
    await f.close()
  }
})

it('cancels a pending native control promptly and joins the real process before releasing its lease', async () => {
  const f = await fixture({ hang: true }),
    cancel = new AbortController(),
    runtime = new ClaudeDecisionRuntime(f.context)
  try {
    const logical = runtime.probeAdmission(cancel.signal)
    await vi.waitFor(async () => expect(await readFile(f.commands, 'utf8')).toContain('initialize'))
    cancel.abort()
    expect(await logical).toMatchObject({
      reason: 'cancelled',
      supported: false,
      physicalReleased: false,
    })
    expect(f.requests).toBe(0)
    expect(await runtime.settlement()).toBe(true)
    expect(nativeWorkingMemoryCapacities().decision.chargedBytes).toBe(0)
  } finally {
    await runtime.dispose()
    await f.close()
  }
})

it('does not begin a native stage for a duplicate evaluation', async () => {
  const source = await decisionFixture(),
    context = { ...idleContext(), reserve: () => 'duplicate' as const },
    runtime = new ClaudeDecisionRuntime(context)
  try {
    expect(await runtime.evaluateDecision(source.input, new AbortController().signal)).toEqual({
      kind: 'unavailable',
      reason: 'duplicate',
    })
    expect(context.beginNativeStage).not.toHaveBeenCalled()
    expect(await runtime.settlement()).toBe(true)
  } finally {
    await runtime.dispose()
    source.db.close()
  }
})

it.each(['refused', 'failed'] as const)(
  'honors an additional host policy veto before every native spawn (%s)',
  async (kind) => {
    const f = await fixture(),
      runtime = new ClaudeDecisionRuntime({
        ...f.context,
        startupPolicyAdmission: () => {
          if (kind === 'failed') throw Error('Owned unavailable policy source')
          return false
        },
      })
    try {
      expect(await runtime.probeAdmission()).toMatchObject({
        supported: false,
        reason: 'unsupported_protocol',
        physicalReleased: true,
      })
      expect(runtime.diagnostics()).toMatchObject({
        failureDetail: 'startup_policy_unverified',
        nativeGeneration: 0,
      })
      expect(f.stages).toEqual([])
      expect(f.requests).toBe(0)
      expect(
        await readFile(f.commands).then(
          () => true,
          () => false,
        ),
      ).toBe(false)
    } finally {
      await runtime.dispose()
      await f.close()
    }
  },
)

it('rechecks startup policy before the next stage while retaining the same invocation lease', async () => {
  const f = await fixture(),
    policy = vi
      .fn<NonNullable<ClaudeDecisionRuntimeContext['startupPolicyAdmission']>>()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false),
    runtime = new ClaudeDecisionRuntime({ ...f.context, startupPolicyAdmission: policy })
  try {
    expect(await runtime.probeAdmission()).toMatchObject({
      supported: false,
      reason: 'unsupported_protocol',
      physicalReleased: true,
    })
    expect(f.stages).toEqual(['host_metadata'])
    expect(policy).toHaveBeenCalledTimes(2)
    expect(f.requests).toBe(0)
  } finally {
    await runtime.dispose()
    await f.close()
  }
})

it('refuses excessive inherited environment before retaining an uncharged copy', () => {
  expect(
    () =>
      new ClaudeDecisionRuntime({
        ...idleContext(),
        environment: { OWNED: 'x'.repeat(128 * 1024) },
      }),
  ).toThrow('unsupported_protocol')
  expect(nativeWorkingMemoryCapacities().decision.chargedBytes).toBe(0)
})

it('returns invalid_input for hostile input structure without starting native work', async () => {
  const context = idleContext(),
    runtime = new ClaudeDecisionRuntime(context),
    value: { cycle?: unknown } = {}
  value.cycle = value
  try {
    expect(await runtime.evaluateDecision(value, new AbortController().signal)).toEqual({
      kind: 'unavailable',
      reason: 'invalid_input',
    })
    expect(context.beginNativeStage).not.toHaveBeenCalled()
    expect(await runtime.settlement()).toBe(true)
  } finally {
    await runtime.dispose()
  }
})

it('holds the independent lease through a noncooperative loader after logical timeout', async () => {
  const source = await decisionFixture(),
    pending = Promise.withResolvers<DecisionInput>(),
    context = idleContext()
  vi.useFakeTimers()
  const runtime = new ClaudeDecisionRuntime(context)
  let signal: AbortSignal | undefined
  try {
    const logical = runtime.evaluateDecision(
      (input: { signal: AbortSignal; deadlineAt: number }) => {
        signal = input.signal
        expect(input.deadlineAt).toBe(Date.now() + 15_000)
        return pending.promise
      },
      new AbortController().signal,
    )
    let released = false
    const physical = runtime.settlement().then((value) => {
      released = true
      return value
    })
    await vi.advanceTimersByTimeAsync(15_000)
    expect(await logical).toEqual({ kind: 'unavailable', reason: 'timeout' })
    expect(signal?.aborted).toBe(true)
    expect(released).toBe(false)
    expect(nativeWorkingMemoryCapacities().decision.chargedBytes).toBe(16 * 1024 * 1024)
    expect(nativeWorkingMemoryCapacities().business.chargedBytes).toBe(0)
    expect(() => new ClaudeDecisionRuntime(idleContext())).toThrow('capacity is full')
    pending.resolve(source.input)
    expect(await physical).toBe(true)
    expect(context.beginNativeStage).not.toHaveBeenCalled()
  } finally {
    pending.resolve(source.input)
    await runtime.dispose()
    vi.useRealTimers()
    source.db.close()
  }
})

it('uses the original host deadline and cancels without releasing a live loader', async () => {
  const source = await decisionFixture(),
    pending = Promise.withResolvers<DecisionInput>(),
    context = idleContext(),
    cancel = new AbortController()
  vi.useFakeTimers()
  const deadlineAt = Date.now() + 700,
    runtime = new ClaudeDecisionRuntime({ ...context, deadlineAt })
  try {
    const logical = runtime.evaluateDecision((input: { deadlineAt: number }) => {
      expect(input.deadlineAt).toBe(deadlineAt)
      return pending.promise
    }, cancel.signal)
    await vi.advanceTimersByTimeAsync(100)
    cancel.abort()
    expect(await logical).toEqual({ kind: 'unavailable', reason: 'cancelled' })
    expect(runtime.diagnostics().working.released).toBe(false)
    pending.resolve(source.input)
    expect(await runtime.settlement()).toBe(true)
    expect(context.dispatch).not.toHaveBeenCalled()
  } finally {
    pending.resolve(source.input)
    await runtime.dispose()
    vi.useRealTimers()
    source.db.close()
  }
})

it.each(['linux'] as const)(
  'keeps unverified %s isolation unavailable before executable discovery or dispatch',
  async (platform) => {
    const source = await decisionFixture(),
      descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
    const executable = vi.fn<() => Promise<string>>(async () => '/unused'),
      dispatch = vi.fn<() => void>()
    try {
      Object.defineProperty(process, 'platform', { ...descriptor, value: platform })
      const context = { ...idleContext(), executable, dispatch }
      const probe = new ClaudeDecisionRuntime(context)
      expect(await probe.probeAdmission()).toMatchObject({
        supported: false,
        reason: 'unsupported_platform',
        physicalReleased: true,
      })
      expect(await probe.settlement()).toBe(true)
      const evaluation = new ClaudeDecisionRuntime(context)
      expect(await evaluation.evaluateDecision(source.input, new AbortController().signal)).toEqual(
        { kind: 'unavailable', reason: 'runtime_unavailable' },
      )
      expect(await evaluation.settlement()).toBe(true)
      expect(executable).not.toHaveBeenCalled()
      expect(dispatch).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(process, 'platform', descriptor)
      source.db.close()
    }
  },
)

it('uses an exact native literal Haiku catalog entry independently of the unselected Haiku alias', async () => {
  const f = await fixture({ missingModel: true, literalModel: true }),
    runtime = new ClaudeDecisionRuntime(f.context)
  try {
    expect(await runtime.probeAdmission()).toMatchObject({
      supported: true,
      reason: 'supported',
      physicalReleased: true,
    })
    expect(f.requests).toBe(0)
    expect(f.dispatch).not.toHaveBeenCalled()
  } finally {
    await runtime.dispose()
    await f.close()
  }
})
it('admits the original exact native alias configuration without a test-only environment bypass', async () => {
  const f = await fixture({ secureMetadata: true })
  try {
    for (const [key, value] of Object.entries(f.context.environment!))
      if (value !== undefined) vi.stubEnv(key, value)
    vi.stubEnv('ANTHROPIC_DEFAULT_HAIKU_MODEL', MODEL)
    for (const key of [
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'ALL_PROXY',
      'http_proxy',
      'https_proxy',
      'all_proxy',
      'NODE_EXTRA_CA_CERTS',
      'NODE_TLS_REJECT_UNAUTHORIZED',
    ])
      vi.stubEnv(key, undefined)
    const runtime = new ClaudeDecisionRuntime({ ...f.context, environment: undefined })
    try {
      expect(await runtime.probeAdmission()).toMatchObject({
        supported: true,
        reason: 'supported',
        physicalReleased: true,
      })
      expect(f.requests).toBe(0)
    } finally {
      await runtime.dispose()
    }
  } finally {
    vi.unstubAllEnvs()
    await f.close()
  }
})
