/* oxlint-disable no-await-in-loop -- Each bounded OS observation depends on actual completion of the previous identity check. */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'

import { Conversation } from '../../apps/desktop/src/utility/conversation/conversation.js'
import { OwnedProcessGroup } from '../../apps/desktop/src/utility/owned-process-group.js'
import { ProjectFileReader } from '../../apps/desktop/src/utility/project-file/project-file-reader.js'
import { RuntimePreparation } from '../../apps/desktop/src/utility/runtime-preparation/runtime-preparation.js'
import { decisionPhysicalWitnessSchema } from '../../packages/contracts/src/decision-runtime.js'
import {
  decisionFixture,
  decisionEvaluationFacts,
} from '../../packages/persistence/src/decision-fixture.test-support.js'
import { PactDatabase } from '../../packages/persistence/src/pact-database.js'

it.runIf(process.platform === 'darwin')(
  'keeps a live old owner and an orphaned native group occupied, then recovers only exact stored identity after actual process release without replay',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pact-decision-proof-'))
    const script = join(directory, 'owner.mts'),
      nonce = 'owned-proof-close',
      oldTZ = process.env.TZ
    const loader = createRequire(resolvePath('packages/persistence/package.json')).resolve(
      'tsx/esm',
    )
    const groupModule = pathToFileURL(
      resolvePath('apps/desktop/src/utility/owned-process-group.ts'),
    ).href
    const childScript = `const net=require('node:net');const server=net.createServer(socket=>socket.on('data',chunk=>{if(chunk.toString()===${JSON.stringify(nonce)})server.close(()=>process.exit(0));socket.end()}));server.listen(0,'127.0.0.1',()=>console.log(server.address().port));setTimeout(()=>{server.close();process.exit(0)},10000).unref();`
    await writeFile(
      script,
      `import {randomUUID} from 'node:crypto';import {OwnedProcessGroup} from ${JSON.stringify(groupModule)};const group=new OwnedProcessGroup();const child=group.spawn(process.execPath,['-e',${JSON.stringify(childScript)}],{});let text='';child.stdout.on('data',async chunk=>{text+=chunk;if(!text.includes('\\n'))return;const witness=await group.physicalWitness(randomUUID());process.send({witness,port:Number(text.trim())});});process.on('message',message=>{if(message==='exit')process.exit(0)});`,
    )
    const owner = spawn(process.execPath, ['--import', loader, script], {
      cwd: directory,
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: { ...process.env, TZ: 'Asia/Shanghai' },
    })
    const ownerExit = new Promise<void>((resolve) => owner.once('exit', () => resolve()))
    let port = 0
    let flow: Conversation | undefined
    let f: Awaited<ReturnType<typeof decisionFixture>> | undefined
    try {
      const observed = await new Promise<{ witness: unknown; port: number }>((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('Owned witness deadline')), 4000)
        owner.once('error', reject)
        owner.once('message', (message) => {
          clearTimeout(timer)
          if (
            !message ||
            typeof message !== 'object' ||
            !('port' in message) ||
            typeof message.port !== 'number' ||
            !('witness' in message)
          ) {
            reject(Error('Invalid owned witness'))
            return
          }
          resolve({ witness: message.witness, port: message.port })
        })
      })
      port = observed.port
      const witness = decisionPhysicalWitnessSchema.parse(observed.witness)
      process.env.TZ = 'UTC'
      expect(await OwnedProcessGroup.provePhysicalRelease(witness)).toBe(false)
      process.env.TZ = 'Asia/Shanghai'
      expect(await OwnedProcessGroup.provePhysicalRelease(witness)).toBe(false)
      f = await decisionFixture(join(directory, 'pact.sqlite'))
      const reservation = f.repo.reserveEvaluation({
        handoff: f.input.handoff,
        provider: 'codex',
        model: 'gpt-6-luna',
        configurationFingerprint: 'a'.repeat(64),
      })
      if (reservation.status !== 'reserved') throw Error('Owned receipt unavailable')
      const id = reservation.evaluation.id
      f.repo.recordEvaluationPhysicalWitness(id, {
        witness,
        configurationFingerprint: 'b'.repeat(64),
      })
      f.repo.dispatchEvaluation(id)
      f.repo.settleEvaluation(id, {
        outcome: 'failed',
        physicalReleased: false,
        usage: { inputTokens: 17, outputTokens: 5 },
      })
      const before = decisionEvaluationFacts(f.db)
      expect(Buffer.byteLength(JSON.stringify(before))).toBeLessThan(4096)
      owner.send('exit')
      await ownerExit
      f.db.close()
      f.db = await PactDatabase.open({
        filePath: join(directory, 'pact.sqlite'),
        migrationsFolder: resolvePath('packages/persistence/drizzle'),
      })
      f.repo = f.db.conversationRepository
      flow = new Conversation(
        f.repo,
        f.db.sessionRepository,
        f.db.projectCatalogRepository,
        new RuntimePreparation(f.db.runtimePreparationRepository),
        new ProjectFileReader(f.db.sessionRepository, f.db.projectCatalogRepository),
      )
      expect(flow.prepareNativeQuit({ operationId: randomUUID() })).toMatchObject({
        ok: true,
        value: {
          state: 'confirmation_required',
          activeCount: 1,
          sessions: [{ sessionId: f.sessionId }],
        },
      })
      const blocked = flow.prepareWorkspaceArchive({
        operationId: randomUUID(),
        scope: { kind: 'project', projectId: f.projectId },
      })
      expect(blocked).toMatchObject({ ok: true, value: { blockedReason: expect.any(String) } })
      expect(await flow.evaluateDecision(f.input, new AbortController().signal)).toEqual({
        kind: 'unavailable',
        reason: 'duplicate',
      })
      expect(await OwnedProcessGroup.provePhysicalRelease(witness)).toBe(false)
      expect(f.repo.activeEvaluation()).toMatchObject({ id, called: true })
      await new Promise<void>((resolve, reject) => {
        const socket = connect(port, '127.0.0.1', () => socket.end(nonce))
        socket.once('error', reject)
        socket.once('close', () => resolve())
      })
      let released = false
      const deadline = Date.now() + 3000
      while (!released && Date.now() < deadline) {
        released = await OwnedProcessGroup.provePhysicalRelease(witness)
        if (!released) await new Promise((resolve) => setTimeout(resolve, 25))
      }
      expect(released).toBe(true)
      expect(
        f.repo.settleEvaluationAfterPhysicalProof(id, before.physical_witness_json + ' '),
      ).toBe(false)
      expect(await flow.evaluateDecision(f.input, new AbortController().signal)).toEqual({
        kind: 'unavailable',
        reason: 'duplicate',
      })
      expect(f.repo.activeEvaluation()).toBeUndefined()
      expect(decisionEvaluationFacts(f.db)).toMatchObject({
        called: 1,
        active: 0,
        outcome: 'failed',
        usage_json: '{"inputTokens":17,"outputTokens":5}',
      })
      expect(f.repo.schedulingBudget(f.input.handoff.budgetSubjectId)?.evaluationCalls).toBe(1)
      expect(
        f.repo.reserveEvaluation({
          handoff: f.input.handoff,
          provider: 'codex',
          model: 'gpt-6-luna',
          configurationFingerprint: 'c'.repeat(64),
        }).status,
      ).toBe('duplicate')
      await new Promise<void>((resolve) => setImmediate(resolve))
      const ready = flow.prepareWorkspaceArchive({
        operationId: randomUUID(),
        scope: { kind: 'project', projectId: f.projectId },
      })
      if (!ready.ok) throw new Error('Missing released archive preview')
      expect(ready.value.blockedReason).toBeUndefined()
      expect(flow.prepareNativeQuit({ operationId: randomUUID() })).toMatchObject({
        ok: true,
        value: { state: 'idle_prepared', activeCount: 0 },
      })
      console.info(
        'Owned restart physical proof',
        JSON.stringify({
          oldOwnerAliveHeld: true,
          orphanGroupHeld: true,
          released,
          metadataBytes: Buffer.byteLength(JSON.stringify(before)),
          replay: false,
          calls: 1,
        }),
      )
    } finally {
      if (oldTZ === undefined) delete process.env.TZ
      else process.env.TZ = oldTZ
      if (owner.exitCode === null) {
        owner.send('exit')
        await ownerExit
      }
      if (port)
        await new Promise<void>((resolve) => {
          const socket = connect(port, '127.0.0.1', () => socket.end(nonce))
          socket.once('error', () => resolve())
          socket.once('close', () => resolve())
        })
      await flow?.dispose()
      f?.db.close()
      await rm(directory, { recursive: true, force: true })
    }
  },
  15000,
)
