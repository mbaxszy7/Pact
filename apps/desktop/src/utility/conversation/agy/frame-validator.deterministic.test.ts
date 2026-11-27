import { describe, expect, it } from 'vitest'

import {
  buildCompactArgsFingerprint,
  canonicalizeProgressToken,
  compareArgsFingerprints,
  mergeArgsFingerprints,
  parseAgyPromptTerminalReply,
  parseRootProgressToken,
  recheckValidatedFrameAgainstRootBoundary,
  validateAgyFrame,
  validateBackgroundUpdateForRun,
} from './frame-validator'

describe('agy/frame-validator (zero-I/O deterministic suite)', () => {
  it('canonicalizes valid structured progress tokens and rejects leading zeros for root proofs', () => {
    const valid = canonicalizeProgressToken('traj-abc:42')
    expect(valid).toEqual({
      canonical: 'traj-abc:42',
      structured: { trajectoryId: 'traj-abc', stepIdx: 42, hasLeadingZeros: false },
    })
    expect(parseRootProgressToken('traj-abc:42')).toEqual(valid)

    const leadingZero = canonicalizeProgressToken('traj-abc:007')
    expect(leadingZero?.structured?.hasLeadingZeros).toBe(true)
    expect(parseRootProgressToken('traj-abc:007')).toBeUndefined()
  })

  it('merges non-conflicting args fingerprints and detects semantic key conflicts', () => {
    const first = buildCompactArgsFingerprint({ verdict: 'accepted', toolSummary: 'ok' }, true)
    const second = buildCompactArgsFingerprint({ questions: [], toolSummary: 'changed' }, true)
    const conflicting = buildCompactArgsFingerprint({ verdict: 'changes_requested' }, true)

    expect(first).toBeDefined()
    expect(second).toBeDefined()
    expect(conflicting).toBeDefined()

    const merged = mergeArgsFingerprints(first, second)
    expect(merged.kind).toBe('ok')
    const mergedFp = merged.kind === 'ok' ? merged.fingerprint : undefined
    expect(compareArgsFingerprints(mergedFp, first!)).toBe('mismatch')
    expect(compareArgsFingerprints(mergedFp, mergedFp!)).toBe('exact')
    expect(mergeArgsFingerprints(first, conflicting)).toEqual({ kind: 'conflict' })
  })

  it('validates single-pass session, token, and root boundary contradictions', () => {
    const validated = validateAgyFrame(
      {
        kind: 'notification',
        seq: 5,
        message: {
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'sess-1',
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'tc-1',
              name: 'mcp_pact_peer_submit_review',
              status: 'completed',
              progressToken: 'traj-1:10',
              args: { verdict: 'accepted' },
            },
          },
        },
      },
      'sess-1',
      'traj-1',
      8,
    )

    expect(validated.sessionAttribution).toBe('matching')
    expect(validated.rootEvidenceContradicted).toBe(false)
    expect(validated.toolCallId).toBe('tc-1')
    expect(validated.argsEvidence.kind).toBe('present')

    const rechecked = recheckValidatedFrameAgainstRootBoundary(validated, 'traj-1', 12)
    expect(rechecked.rootEvidenceContradicted).toBe(true)
  })

  it('rejects foreign or conflicting prompt terminal replies and accepts clean end_turn', () => {
    const ok = parseAgyPromptTerminalReply(
      { result: { stopReason: 'end_turn', sessionId: 'sess-1', executionId: 'exec-1' } },
      'sess-1',
    )
    expect(ok).toEqual({ ok: true, stopReason: 'end_turn', executionId: 'exec-1' })

    const foreign = parseAgyPromptTerminalReply(
      { result: { stopReason: 'end_turn', sessionId: 'sess-other' } },
      'sess-1',
    )
    expect(foreign.ok).toBe(false)

    const badStop = parseAgyPromptTerminalReply(
      { result: { stopReason: 'bogus_reason', sessionId: 'sess-1' } },
      'sess-1',
    )
    expect(badStop.ok).toBe(false)
  })

  it('rejects background updates carrying foreign execution IDs or below minStepIdx', () => {
    const trackedRun = {
      nativeSessionId: 'sess-1',
      providerExecutionId: 'exec-root',
      knownForeignExecutionIds: new Set(['exec-foreign']),
    }

    expect(
      validateBackgroundUpdateForRun(
        { sessionId: 'sess-1' },
        { executionId: 'exec-foreign', progressToken: 'traj-1:20' },
        trackedRun,
        'traj-1',
        10,
      ),
    ).toEqual({ valid: false })

    expect(
      validateBackgroundUpdateForRun(
        { sessionId: 'sess-1' },
        { executionId: 'exec-root', progressToken: 'traj-1:9' },
        trackedRun,
        'traj-1',
        10,
      ),
    ).toEqual({ valid: false })

    expect(
      validateBackgroundUpdateForRun(
        { sessionId: 'sess-1' },
        { executionId: 'exec-root', progressToken: 'traj-1:12' },
        trackedRun,
        'traj-1',
        10,
      ),
    ).toEqual({ valid: true, executionId: 'exec-root', trajectoryId: 'traj-1', stepIdx: 12 })
  })
})
