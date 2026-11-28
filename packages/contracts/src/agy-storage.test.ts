import { describe, expect, it } from 'vitest'

import {
  AGY_STORAGE_ACTIONS,
  AGY_STORAGE_HISTORY_BYTES,
  AGY_STORAGE_MAX_ERROR_BYTES,
  AGY_STORAGE_MAX_MESSAGE_BYTES,
  AGY_STORAGE_MAX_RECORDS,
  AGY_STORAGE_MAX_WORKING_BYTES,
  AGY_STORAGE_TEXT_BYTES,
  agyRebuildInitializationWitnessSchema,
  agyStorageActionSchema,
  agyStorageCancelRequestSchema,
  agyStorageChildToUtilityMessageSchema,
  agyStorageClosedEventSchema,
  agyStorageControlMessageSchema,
  agyStorageInitMessageSchema,
  agyStorageJobKeySchema,
  agyStorageOpenRequestSchema,
  agyStorageOpenResponseSchema,
  agyStoragePortCandidateCommittedMessageSchema,
  agyStoragePortCandidateMessageSchema,
  agyStoragePortErrorMessageSchema,
  agyStoragePortMessageSchema,
  agyStoragePortRequestMessageSchema,
  agyStoragePortResultAckMessageSchema,
  agyStoragePortResultMessageSchema,
  agyStorageResultSchemaByAction,
  agyStorageUtilityToChildMessageSchema,
  serializedByteLengthWithinLimit,
} from './agy-storage.js'

const uuid = () => crypto.randomUUID()
const hash = (char = 'a') => char.repeat(64)

const jobKey = () => ({
  version: 1 as const,
  generation: uuid(),
  requestId: uuid(),
})

const agyBoundary = (nativeSessionId: string) => ({
  provider: 'agy' as const,
  nativeSessionId,
  nativeCutId: 'exec-cut-1',
  nativeTurnId: 'turn-1',
  agyCut: {
    version: 'pact-agy-fork-cut-v1' as const,
    trajectoryId: 'traj-source-1',
    executionId: 'exec-cut-1',
    cutStepIdx: 4,
  },
  bindingGeneration: 1,
  throughSequence: 3,
  deliveryCursor: 2,
  prefixHash: hash('b'),
  prefixRecords: 5,
  prefixBytes: 1024,
})

const agyWitness = (sourceNativeSessionId: string, candidateNativeSessionId: string) => ({
  version: 'pact-native-fork-v1' as const,
  provider: 'agy' as const,
  sourceNativeSessionId,
  nativeSessionId: candidateNativeSessionId,
  sourceCutId: 'exec-cut-1',
  sourceTrajectoryId: 'traj-source-1',
  candidateTrajectoryId: 'traj-candidate-1',
  cutStepIdx: 4,
  agyCut: {
    version: 'pact-agy-fork-cut-v1' as const,
    trajectoryId: 'traj-candidate-1',
    executionId: 'exec-cut-1',
    cutStepIdx: 4,
  },
  sourcePrefixHash: hash('b'),
  candidatePrefixHash: hash('b'),
  candidatePrefixRecords: 5,
  idMap: [['step-1', 'step-1-copy']],
  model: 'gemini-pro-orchestrator',
  effort: 'high',
  permissionMode: 'ask' as const,
})

const agyForkFileResult = (nativeSessionId: string) => ({
  nativeSessionId,
  nativeCutId: 'exec-cut-1',
  prefixHash: hash('b'),
  prefixBytes: 1024,
  prefixRecords: 5,
  idMap: [['step-1', 'step-1-copy']],
  rawHash: hash('c'),
  rawBytes: 1024,
  rawRecords: 5,
  nativeStorageRoot: '/tmp/agy',
  nativePath: `/tmp/agy/conversations/${nativeSessionId}.db`,
  cutStep: 4,
  trajectoryId: 'traj-candidate-1',
  sourceTrajectoryId: 'traj-source-1',
  agyCut: {
    version: 'pact-agy-fork-cut-v1' as const,
    trajectoryId: 'traj-candidate-1',
    executionId: 'exec-cut-1',
    cutStepIdx: 4,
  },
})

const agyRebuildSeedResult = (nativeSessionId: string) => ({
  nativeSessionId,
  trajectoryId: 'traj-seed-1',
  seedHash: hash('d'),
  chunkCount: 1,
  stepCount: 2 as const,
  pbSha256: hash('e'),
  pbBytes: 2048,
  verifiedPrefixBytes: 1024,
  verifiedPrefixSha256: hash('f'),
  recordCount: 2,
  nativeStorageRoot: '/tmp/agy',
  nativePath: `/tmp/agy/conversations/${nativeSessionId}.db`,
})

const agyColdLoadWitness = (nativeSessionId: string) => ({
  kind: 'agy_rebuild_v1' as const,
  nativeSessionId,
  pbSha256: hash('e'),
  pbBytes: 2048,
  stepCount: 2 as const,
  sourceHash: hash('a'),
  coldLoadVerifiedAt: '2026-11-21T03:45:00.000Z',
})

describe('Antigravity isolated storage wire contracts', () => {
  it('validates all 10 storage actions and strict jobKey envelopes', () => {
    expect(AGY_STORAGE_ACTIONS).toHaveLength(10)
    for (const action of AGY_STORAGE_ACTIONS) {
      expect(agyStorageActionSchema.parse(action)).toBe(action)
    }
    expect(agyStorageActionSchema.safeParse('read-answer').success).toBe(false)
    expect(agyStorageActionSchema.safeParse('verify-seed').success).toBe(false)

    const key = jobKey()
    expect(agyStorageJobKeySchema.parse(key)).toEqual(key)
    expect(agyStorageJobKeySchema.safeParse({ ...key, version: 2 }).success).toBe(false)
    expect(agyStorageJobKeySchema.safeParse({ ...key, extra: true }).success).toBe(false)
    expect(agyStorageJobKeySchema.safeParse({ ...key, generation: 'not-a-uuid' }).success).toBe(
      false,
    )
  })

  it('validates Main <-> Utility control packets and enforces workingBytes/deadline bounds', () => {
    const key = jobKey()
    const openReq = {
      type: 'agy-storage.open.request' as const,
      jobKey: key,
      action: 'inspect-agy-run' as const,
      deadlineAt: Date.now() + 10_000,
      workingBytes: 16 * 1024 * 1024,
    }
    expect(agyStorageOpenRequestSchema.parse(openReq)).toEqual(openReq)
    expect(agyStorageControlMessageSchema.parse(openReq)).toEqual(openReq)

    expect(
      agyStorageOpenRequestSchema.safeParse({
        ...openReq,
        workingBytes: AGY_STORAGE_MAX_WORKING_BYTES + 1,
      }).success,
    ).toBe(false)
    expect(agyStorageOpenRequestSchema.safeParse({ ...openReq, deadlineAt: 0 }).success).toBe(false)

    const openOk = {
      type: 'agy-storage.open.response' as const,
      ok: true as const,
      jobKey: key,
    }
    const openErr = {
      type: 'agy-storage.open.response' as const,
      ok: false as const,
      jobKey: key,
      code: 'CAPACITY_EXCEEDED' as const,
      message: 'Working memory limit exceeded.',
    }
    expect(agyStorageOpenResponseSchema.parse(openOk)).toEqual(openOk)
    expect(agyStorageOpenResponseSchema.parse(openErr)).toEqual(openErr)
    expect(agyStorageControlMessageSchema.parse(openOk)).toEqual(openOk)
    expect(agyStorageControlMessageSchema.parse(openErr)).toEqual(openErr)

    const cancelReq = {
      type: 'agy-storage.cancel.request' as const,
      jobKey: key,
      reason: 'timeout' as const,
    }
    expect(agyStorageCancelRequestSchema.parse(cancelReq)).toEqual(cancelReq)
    expect(agyStorageControlMessageSchema.parse(cancelReq)).toEqual(cancelReq)

    const closedEvent = {
      type: 'agy-storage.closed.event' as const,
      jobKey: key,
      exitCode: 0,
      signal: null,
      timedOut: false,
      cancelled: false,
    }
    expect(agyStorageClosedEventSchema.parse(closedEvent)).toEqual(closedEvent)
    expect(agyStorageControlMessageSchema.parse(closedEvent)).toEqual(closedEvent)
    expect(agyStorageClosedEventSchema.safeParse({ ...closedEvent, extra: 1 }).success).toBe(false)
  })

  it('validates Utility <-> Child MessagePort requests and action-matched results for all 10 actions', () => {
    const key = jobKey()
    const deadlineAt = Date.now() + 10_000
    const sourceSessionId = uuid()
    const candidateSessionId = uuid()
    const messageId = uuid()
    const rebuildId = uuid()

    const pairs = [
      {
        input: {
          action: 'read-agy-trajectory-identity' as const,
          cwd: '/tmp/workspace',
          nativeSessionId: sourceSessionId,
        },
        result: {
          nativeSessionId: sourceSessionId,
          status: 'ok' as const,
          trajectoryId: 'traj-1',
          stepCount: 3,
        },
      },
      {
        input: {
          action: 'inspect-agy-run' as const,
          cwd: '/tmp/workspace',
          nativeSessionId: sourceSessionId,
          nativeTurnId: 'exec-1',
          includePlan: true,
        },
        result: {
          exists: true,
          nativeSessionId: sourceSessionId,
          trajectoryId: 'traj-1',
          nativeStorageRoot: '/tmp/agy',
          nativePath: `/tmp/agy/conversations/${sourceSessionId}.db`,
          stepCount: 3,
          terminalState: {
            executionId: 'exec-1',
            status: 'completed' as const,
            consumedInputStepIds: ['step-0'],
            consumedInputs: [{ stepIndex: 0, textSha256: hash('a') }],
            answer: 'Done.',
            responseHash: hash('b'),
            plan: { nativeId: 'plan-1', text: '# Plan' },
            hasCompletedPactPublishPlan: true,
            completedPactPublishPlanTokens: ['tok-1', 'tok-2'],
          },
        },
      },
      {
        input: {
          action: 'exists' as const,
          cwd: '/tmp/workspace',
          nativeSessionId: sourceSessionId,
        },
        result: {
          nativeSessionId: sourceSessionId,
          exists: true,
        },
      },
      {
        input: {
          action: 'prepare' as const,
          cwd: '/tmp/workspace',
          nativeSessionId: sourceSessionId,
          nativeTurnId: 'turn-1',
          responseHash: hash('b'),
        },
        result: agyForkFileResult(sourceSessionId),
      },
      {
        input: {
          action: 'read' as const,
          cwd: '/tmp/workspace',
          nativeSessionId: sourceSessionId,
          source: agyBoundary(sourceSessionId),
        },
        result: agyForkFileResult(sourceSessionId),
      },
      {
        input: {
          action: 'inspect' as const,
          cwd: '/tmp/workspace',
          nativeSessionId: candidateSessionId,
          witness: agyWitness(sourceSessionId, candidateSessionId),
        },
        result: agyForkFileResult(candidateSessionId),
      },
      {
        input: {
          action: 'fork' as const,
          cwd: '/tmp/workspace',
          nativeSessionId: sourceSessionId,
          candidateNativeSessionId: candidateSessionId,
          source: agyBoundary(sourceSessionId),
          awaitCandidateCommit: true,
          model: 'gemini-pro-orchestrator',
          effort: 'high',
          permissionMode: 'ask' as const,
        },
        result: agyForkFileResult(candidateSessionId),
      },
      {
        input: {
          action: 'rebuild_seed' as const,
          cwd: '/tmp/workspace',
          nativeSessionId: candidateSessionId,
          rebuildId,
          sourceHash: hash('a'),
          rebuildChunks: [
            {
              kind: 'message' as const,
              messageId,
              sequence: 1,
              speaker: 'user' as const,
              state: 'complete' as const,
              part: 0,
              final: true,
              content: 'Hello',
            },
          ],
        },
        result: agyRebuildSeedResult(candidateSessionId),
      },
      {
        input: {
          action: 'verify-agy-seed' as const,
          cwd: '/tmp/workspace',
          nativeSessionId: candidateSessionId,
          rebuildId,
          rebuildChunks: [
            {
              kind: 'message' as const,
              messageId,
              sequence: 1,
              speaker: 'agy' as const,
              state: 'complete' as const,
              part: 0,
              final: true,
              content: 'Ack',
            },
          ],
          rejectAdditionalWork: true,
        },
        result: agyRebuildSeedResult(candidateSessionId),
      },
      {
        input: {
          action: 'confirm-agy-rebuild-cold-load' as const,
          cwd: '/tmp/workspace',
          nativeSessionId: candidateSessionId,
          sourceHash: hash('a'),
          pbSha256: hash('e'),
          pbBytes: 2048,
          stepCount: 2 as const,
        },
        result: agyColdLoadWitness(candidateSessionId),
      },
    ]

    for (const { input, result } of pairs) {
      const reqMsg = { type: 'request' as const, jobKey: key, deadlineAt, input }
      expect(agyStoragePortRequestMessageSchema.parse(reqMsg)).toEqual(reqMsg)
      expect(agyStorageUtilityToChildMessageSchema.parse(reqMsg)).toEqual(reqMsg)
      expect(agyStoragePortMessageSchema.parse(reqMsg)).toEqual(reqMsg)

      expect(agyStorageResultSchemaByAction[input.action].parse(result)).toEqual(result)
      const resMsg = { type: 'result' as const, jobKey: key, action: input.action, result }
      expect(agyStoragePortResultMessageSchema.parse(resMsg)).toEqual(resMsg)
      expect(agyStorageChildToUtilityMessageSchema.parse(resMsg)).toEqual(resMsg)
      expect(agyStoragePortMessageSchema.parse(resMsg)).toEqual(resMsg)
    }

    // Mismatched action/result payload is rejected.
    expect(
      agyStoragePortResultMessageSchema.safeParse({
        type: 'result',
        jobKey: key,
        action: 'exists',
        result: agyColdLoadWitness(candidateSessionId),
      }).success,
    ).toBe(false)
    expect(
      agyRebuildInitializationWitnessSchema.parse(agyColdLoadWitness(candidateSessionId)),
    ).toEqual(agyColdLoadWitness(candidateSessionId))
  })

  it('enforces Fork candidate commit handshake invariants and rejects mismatched witness identity', () => {
    const key = jobKey()
    const sourceSessionId = uuid()
    const candidateSessionId = uuid()
    const witness = agyWitness(sourceSessionId, candidateSessionId)
    const witnessDigest = hash('9')

    const candidateMsg = {
      type: 'candidate' as const,
      jobKey: key,
      candidateNativeSessionId: candidateSessionId,
      witnessDigest,
      witness,
    }
    expect(agyStoragePortCandidateMessageSchema.parse(candidateMsg)).toEqual(candidateMsg)
    expect(agyStorageChildToUtilityMessageSchema.parse(candidateMsg)).toEqual(candidateMsg)

    const committedAck = {
      type: 'candidate_committed' as const,
      jobKey: key,
      candidateNativeSessionId: candidateSessionId,
      witnessDigest,
      committed: true,
    }
    const rejectedAck = {
      ...committedAck,
      committed: false,
    }
    expect(agyStoragePortCandidateCommittedMessageSchema.parse(committedAck)).toEqual(committedAck)
    expect(agyStoragePortCandidateCommittedMessageSchema.parse(rejectedAck)).toEqual(rejectedAck)
    expect(agyStorageUtilityToChildMessageSchema.parse(committedAck)).toEqual(committedAck)

    // Mismatched candidateNativeSessionId vs witness.nativeSessionId must fail.
    expect(
      agyStoragePortCandidateMessageSchema.safeParse({
        ...candidateMsg,
        candidateNativeSessionId: uuid(),
      }).success,
    ).toBe(false)

    // Non-agy witness must fail candidate handshake.
    expect(
      agyStoragePortCandidateMessageSchema.safeParse({
        ...candidateMsg,
        witness: {
          version: 'pact-native-fork-v1',
          provider: 'claude',
          sourceNativeSessionId: sourceSessionId,
          nativeSessionId: candidateSessionId,
          sourceCutId: 'exec-cut-1',
          sourcePrefixHash: hash('b'),
          candidatePrefixHash: hash('b'),
          idMap: [],
          model: null,
          effort: null,
          permissionMode: 'ask',
        },
      }).success,
    ).toBe(false)
  })

  it('enforces text, history, record, error, conflict, and 16 MiB message safety caps', () => {
    const key = jobKey()
    const sessionId = uuid()

    // Error envelope cap.
    expect(
      agyStoragePortErrorMessageSchema.safeParse({
        type: 'error',
        jobKey: key,
        message: 'x'.repeat(AGY_STORAGE_MAX_ERROR_BYTES + 1),
      }).success,
    ).toBe(false)

    // Conflicting plan + planUnavailable in cold inspection.
    expect(
      agyStorageResultSchemaByAction['inspect-agy-run'].safeParse({
        exists: true,
        nativeSessionId: sessionId,
        nativeStorageRoot: '/tmp/agy',
        nativePath: `/tmp/agy/conversations/${sessionId}.db`,
        stepCount: 2,
        terminalState: {
          executionId: 'exec-1',
          status: 'completed',
          consumedInputStepIds: [],
          consumedInputs: [],
          answer: 'ok',
          responseHash: hash('a'),
          plan: { nativeId: 'p1', text: '# Plan' },
          planUnavailable: true,
        },
      }).success,
    ).toBe(false)

    // Answer exceeding 8 MiB text budget fails.
    expect(
      agyStorageResultSchemaByAction['inspect-agy-run'].safeParse({
        exists: true,
        nativeSessionId: sessionId,
        nativeStorageRoot: '/tmp/agy',
        nativePath: `/tmp/agy/conversations/${sessionId}.db`,
        stepCount: 2,
        terminalState: {
          executionId: 'exec-1',
          status: 'completed',
          consumedInputStepIds: [],
          consumedInputs: [],
          answer: 'a'.repeat(AGY_STORAGE_TEXT_BYTES + 1),
          responseHash: hash('a'),
        },
      }).success,
    ).toBe(false)

    // Combined answer + plan exceeding 16 MiB message safety cap fails even when each is <= 8 MiB.
    const almostEightMiB = 'a'.repeat(AGY_STORAGE_TEXT_BYTES - 10)
    expect(
      agyStoragePortResultMessageSchema.safeParse({
        type: 'result',
        jobKey: key,
        action: 'inspect-agy-run',
        result: {
          exists: true,
          nativeSessionId: sessionId,
          nativeStorageRoot: '/tmp/agy',
          nativePath: `/tmp/agy/conversations/${sessionId}.db`,
          stepCount: 2,
          terminalState: {
            executionId: 'exec-1',
            status: 'completed',
            consumedInputStepIds: [],
            consumedInputs: [],
            answer: almostEightMiB,
            responseHash: hash('a'),
            plan: { nativeId: 'p1', text: almostEightMiB },
          },
        },
      }).success,
    ).toBe(false)
    expect(AGY_STORAGE_MAX_MESSAGE_BYTES).toBe(16 * 1024 * 1024)

    // Fork history bytes and record count bounds.
    expect(
      agyStorageResultSchemaByAction.prepare.safeParse({
        ...agyForkFileResult(sessionId),
        prefixBytes: AGY_STORAGE_HISTORY_BYTES + 1,
      }).success,
    ).toBe(false)
    expect(
      agyStorageResultSchemaByAction.prepare.safeParse({
        ...agyForkFileResult(sessionId),
        prefixRecords: AGY_STORAGE_MAX_RECORDS + 1,
      }).success,
    ).toBe(false)
    expect(
      agyStorageResultSchemaByAction.prepare.safeParse({
        ...agyForkFileResult(sessionId),
        idMap: [
          ['dup', 'a'],
          ['dup', 'b'],
        ],
      }).success,
    ).toBe(false)

    // completedPactPublishPlanTokens bound (>256 rejected).
    expect(
      agyStorageResultSchemaByAction['inspect-agy-run'].safeParse({
        exists: true,
        nativeSessionId: sessionId,
        nativeStorageRoot: '/tmp/agy',
        nativePath: `/tmp/agy/conversations/${sessionId}.db`,
        stepCount: 2,
        terminalState: {
          executionId: 'exec-1',
          status: 'completed',
          consumedInputStepIds: [],
          consumedInputs: [],
          answer: 'ok',
          responseHash: hash('a'),
          hasCompletedPactPublishPlan: true,
          completedPactPublishPlanTokens: Array.from({ length: 257 }, (_, i) => `tok-${i}`),
        },
      }).success,
    ).toBe(false)

    // Candidate payload with mismatched candidate.nativeSessionId is rejected.
    const candidateId = uuid()
    const sourceId = uuid()
    const validCandidate = {
      type: 'candidate' as const,
      jobKey: key,
      candidateNativeSessionId: candidateId,
      witnessDigest: hash('7'),
      witness: agyWitness(sourceId, candidateId),
      candidate: agyForkFileResult(candidateId),
    }
    expect(agyStoragePortCandidateMessageSchema.parse(validCandidate)).toEqual(validCandidate)
    expect(
      agyStoragePortCandidateMessageSchema.safeParse({
        ...validCandidate,
        candidate: agyForkFileResult(uuid()),
      }).success,
    ).toBe(false)

    // Optional measure flag and errorKind preserve strict validation.
    expect(
      agyStoragePortRequestMessageSchema.parse({
        type: 'request',
        jobKey: key,
        deadlineAt: Date.now() + 5_000,
        measure: true,
        input: {
          action: 'confirm-agy-rebuild-cold-load',
          cwd: '/tmp/workspace',
          nativeSessionId: candidateId,
          appDataDir: '/tmp/agy',
          sourceHash: hash('a'),
          pbSha256: hash('e'),
          pbBytes: 2048,
          stepCount: 2,
        },
      }).measure,
    ).toBe(true)
    expect(
      agyStoragePortErrorMessageSchema.parse({
        type: 'error',
        jobKey: key,
        message: 'Too large.',
        code: 'E2BIG',
        errorKind: 'response_too_large',
      }).errorKind,
    ).toBe('response_too_large')
  })

  it('decouples O(log N) identity stepCount from AGY_STORAGE_MAX_RECORDS, validates stagingLeafName, and validates result_ack', () => {
    const key = jobKey()
    const sourceSessionId = uuid()
    const candidateSessionId = uuid()
    const rebuildId = uuid()

    // Identity lookup may report a safe boundary stepCount larger than AGY_STORAGE_MAX_RECORDS.
    expect(
      agyStorageResultSchemaByAction['read-agy-trajectory-identity'].parse({
        nativeSessionId: sourceSessionId,
        status: 'ok',
        trajectoryId: 'traj-large',
        stepCount: AGY_STORAGE_MAX_RECORDS + 50_000,
      }),
    ).toMatchObject({ stepCount: AGY_STORAGE_MAX_RECORDS + 50_000 })
    expect(
      agyStorageResultSchemaByAction['read-agy-trajectory-identity'].safeParse({
        nativeSessionId: sourceSessionId,
        status: 'ok',
        trajectoryId: 'traj-max',
        stepCount: Number.MAX_SAFE_INTEGER,
      }).success,
    ).toBe(true)
    expect(
      agyStorageResultSchemaByAction['read-agy-trajectory-identity'].safeParse({
        nativeSessionId: sourceSessionId,
        status: 'ok',
        trajectoryId: 'traj-neg',
        stepCount: -1,
      }).success,
    ).toBe(false)

    // Fork and rebuild_seed accept strict .pact-stage-*.db stagingLeafName and reject traversal.
    const validStage = `.pact-stage-${uuid()}.db`
    expect(
      agyStoragePortRequestMessageSchema.parse({
        type: 'request',
        jobKey: key,
        deadlineAt: Date.now() + 10_000,
        input: {
          action: 'fork',
          cwd: '/tmp/workspace',
          nativeSessionId: sourceSessionId,
          candidateNativeSessionId: candidateSessionId,
          source: agyBoundary(sourceSessionId),
          stagingLeafName: validStage,
        },
      }).input,
    ).toMatchObject({ stagingLeafName: validStage })

    expect(
      agyStoragePortRequestMessageSchema.parse({
        type: 'request',
        jobKey: key,
        deadlineAt: Date.now() + 10_000,
        input: {
          action: 'rebuild_seed',
          cwd: '/tmp/workspace',
          nativeSessionId: candidateSessionId,
          rebuildId,
          rebuildChunks: [],
          stagingLeafName: validStage,
        },
      }).input,
    ).toMatchObject({ stagingLeafName: validStage })

    for (const invalidStage of [
      '../escape.db',
      '.pact-stage-.db',
      'stage.db',
      '.pact-stage-a/b.db',
    ]) {
      expect(
        agyStoragePortRequestMessageSchema.safeParse({
          type: 'request',
          jobKey: key,
          deadlineAt: Date.now() + 10_000,
          input: {
            action: 'rebuild_seed',
            cwd: '/tmp/workspace',
            nativeSessionId: candidateSessionId,
            rebuildId,
            rebuildChunks: [],
            stagingLeafName: invalidStage,
          },
        }).success,
      ).toBe(false)
    }

    // result_ack handshake message is validated on Utility -> Child port lane.
    const resultAck = { type: 'result_ack' as const, jobKey: key }
    expect(agyStoragePortResultAckMessageSchema.parse(resultAck)).toEqual(resultAck)
    expect(agyStorageUtilityToChildMessageSchema.parse(resultAck)).toEqual(resultAck)
    expect(agyStoragePortMessageSchema.parse(resultAck)).toEqual(resultAck)
  })

  it('validates completedPactPublishPlanCalls, enforces UUID candidate/rebuild IDs, validates init binding, and short-circuits oversized JSON byte counting', () => {
    const key = jobKey()
    const sourceSessionId = uuid()
    const candidateSessionId = uuid()
    const rebuildId = uuid()
    const messageId = uuid()

    // 1. completedPactPublishPlanCalls on cold inspection terminalState.
    expect(
      agyStorageResultSchemaByAction['inspect-agy-run'].parse({
        exists: true,
        nativeSessionId: sourceSessionId,
        nativeStorageRoot: '/tmp/agy',
        nativePath: `/tmp/agy/conversations/${sourceSessionId}.db`,
        stepCount: 2,
        terminalState: {
          executionId: 'exec-1',
          status: 'completed',
          consumedInputStepIds: [],
          consumedInputs: [],
          answer: 'ok',
          responseHash: hash('a'),
          hasCompletedPactPublishPlan: true,
          completedPactPublishPlanTokens: ['tok-1'],
          completedPactPublishPlanCalls: [
            {
              serverName: 'pact',
              callId: 'call-1',
              progressToken: 'tok-1',
              stepId: 'step-1',
            },
          ],
        },
      }),
    ).toBeTruthy()

    expect(
      agyStorageResultSchemaByAction['inspect-agy-run'].safeParse({
        exists: true,
        nativeSessionId: sourceSessionId,
        nativeStorageRoot: '/tmp/agy',
        nativePath: `/tmp/agy/conversations/${sourceSessionId}.db`,
        stepCount: 2,
        terminalState: {
          executionId: 'exec-1',
          status: 'completed',
          consumedInputStepIds: [],
          consumedInputs: [],
          answer: 'ok',
          responseHash: hash('a'),
          completedPactPublishPlanCalls: [{ serverName: 'pact', extra: true }],
        },
      }).success,
    ).toBe(false)

    // 2. rebuild_seed nativeSessionId and fork candidateNativeSessionId MUST be UUIDs.
    expect(
      agyStoragePortRequestMessageSchema.safeParse({
        type: 'request',
        jobKey: key,
        deadlineAt: Date.now() + 10_000,
        input: {
          action: 'rebuild_seed',
          cwd: '/tmp/workspace',
          nativeSessionId: '../escape',
          rebuildId,
          rebuildChunks: [],
        },
      }).success,
    ).toBe(false)

    expect(
      agyStoragePortRequestMessageSchema.safeParse({
        type: 'request',
        jobKey: key,
        deadlineAt: Date.now() + 10_000,
        input: {
          action: 'fork',
          cwd: '/tmp/workspace',
          nativeSessionId: sourceSessionId,
          candidateNativeSessionId: '../escape',
          source: agyBoundary(sourceSessionId),
        },
      }).success,
    ).toBe(false)

    // 3. Init message binds jobKey, action, and deadlineAt.
    const validInit = {
      type: 'init' as const,
      jobKey: key,
      action: 'inspect-agy-run' as const,
      deadlineAt: Date.now() + 5_000,
    }
    expect(agyStorageInitMessageSchema.parse(validInit)).toEqual(validInit)
    expect(agyStorageInitMessageSchema.safeParse({ type: 'init', jobKey: key }).success).toBe(false)

    // 4. Incremental JSON UTF-8 byte counter matches JSON.stringify byte length exactly.
    const samples: unknown[] = [
      { a: 'hello "world" \\ \n\t\r\b\f \u0000\u001f' },
      { utf8: 'café 日本語 🚀', loneHigh: '\ud800', loneLow: '\udc00' },
      { arr: [1, -42.5, true, false, null, undefined, { nested: [0] }] },
    ]
    const encoder = new TextEncoder()
    for (const sample of samples) {
      const exact = encoder.encode(JSON.stringify(sample)).byteLength
      expect(serializedByteLengthWithinLimit(sample, exact)).toBe(true)
      expect(serializedByteLengthWithinLimit(sample, exact - 1)).toBe(false)
    }

    // 5. Oversized 4096 x 64 KiB rebuildChunks (256 MiB) is rejected via short-circuiting.
    const maxChunk = 'a'.repeat(64 * 1024)
    const hugeChunks = Array.from({ length: 4096 }, (_, index) => ({
      kind: 'message' as const,
      messageId,
      sequence: index,
      speaker: 'user' as const,
      state: 'complete' as const,
      part: 0,
      final: true,
      content: maxChunk,
    }))
    expect(
      agyStoragePortRequestMessageSchema.safeParse({
        type: 'request',
        jobKey: key,
        deadlineAt: Date.now() + 10_000,
        input: {
          action: 'rebuild_seed',
          cwd: '/tmp/workspace',
          nativeSessionId: candidateSessionId,
          rebuildId,
          rebuildChunks: hugeChunks,
        },
      }).success,
    ).toBe(false)
  })
})
