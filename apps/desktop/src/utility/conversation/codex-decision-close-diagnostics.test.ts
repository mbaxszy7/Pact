import { expect, it } from 'vitest'

import { decisionCloseResult } from './codex-decision-runtime.js'

it('keeps only fixed close classifications without reading private error accessors', () => {
  let reads = 0
  const error = Object.create(null, {
    message: {
      get() {
        reads++
        return 'private native output'
      },
    },
    cause: {
      get() {
        reads++
        throw Error('private path')
      },
    },
  })
  expect(decisionCloseResult({ status: 'rejected', reason: error })).toEqual({
    status: 'rejected',
    reason: 'other',
    code: null,
    killed: false,
    signal: null,
  })
  expect(reads).toBe(0)
  expect(decisionCloseResult({ status: 'fulfilled', value: 'private native output' })).toEqual({
    status: 'fulfilled',
  })
})

it('preserves a bounded OS close failure without exporting its private cause', () => {
  const cause = Object.assign(Error('private native output and path'), {
    code: 'ETIMEDOUT',
    killed: true,
    signal: 'SIGTERM',
    stdout: 'private output',
  })
  const result = decisionCloseResult({
    status: 'rejected',
    reason: Error('Process group identities could not be checked.', { cause }),
  })
  expect(result).toEqual({
    status: 'rejected',
    reason: 'os_observation',
    code: 'ETIMEDOUT',
    killed: true,
    signal: 'SIGTERM',
  })
  expect(JSON.stringify(result)).not.toContain('private')
  expect(
    decisionCloseResult({
      status: 'rejected',
      reason: Object.assign(Error('private'), { code: 'private', signal: 'private' }),
    }),
  ).toEqual({ status: 'rejected', reason: 'other', code: null, killed: false, signal: null })
})
