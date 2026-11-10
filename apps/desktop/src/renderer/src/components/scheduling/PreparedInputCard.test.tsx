// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'

import type { DesktopBridge, PreparedInputContinuation } from '@pact/contracts'

import { PreparedInputCard } from './PreparedInputCard'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})
const sessionId = '11111111-1111-4111-8111-111111111111'
const input: PreparedInputContinuation = {
  batchId: '22222222-2222-4222-8222-222222222222',
  clientMessageId: '33333333-3333-4333-8333-333333333333',
  revision: 0,
  preview: 'Original saved request.',
  body: {
    id: '44444444-4444-4444-8444-444444444444',
    sha256: 'a'.repeat(64),
    chars: 23,
    bytes: 23,
  },
  commentCount: 1,
  hasAnswer: false,
  phase: 'paused',
  agentId: 'codex',
  settingsRevision: 1,
  queueRevision: 0,
  continuationFingerprint: 'b'.repeat(64),
  execution: { model: 'gpt-6-luna', effort: 'low', speed: 'native', permissionMode: 'ask' },
  canContinue: true,
  blockedReason: null,
}

it('a receipt read during preparation cannot trap the next explicit paused Continue in an old nonce', async () => {
  const send = vi
      .fn<DesktopBridge['continuePreparedConversationInput']>()
      .mockResolvedValueOnce({
        ok: false,
        error: { code: 'UNCERTAIN', message: 'Check the original receipt.' },
      })
      .mockResolvedValue({
        ok: false,
        error: { code: 'CONFLICT', message: 'Known unsent preparation failure.' },
      }),
    read = vi
      .fn<DesktopBridge['getRelayDecisionReceipt']>()
      .mockImplementation(async (request) => ({
        ok: true,
        value: { ...request, disposition: 'confirmed', runId: null, rebuildId: null },
      })),
    onChanged = vi.fn<() => void>()
  Object.defineProperty(window, 'pact', {
    configurable: true,
    value: { continuePreparedConversationInput: send, getRelayDecisionReceipt: read },
  })
  const user = userEvent.setup(),
    view = render(
      <PreparedInputCard
        sessionId={sessionId}
        input={input}
        disabled={false}
        onChanged={onChanged}
      />,
    )
  await user.click(screen.getByRole('button', { name: 'Continue original request' }))
  await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
  const first = send.mock.calls[0]![0]
  view.rerender(
    <PreparedInputCard
      sessionId={sessionId}
      input={{
        ...input,
        revision: 1,
        phase: 'preparing',
        canContinue: false,
        blockedReason: 'preparation_active',
      }}
      disabled={false}
      onChanged={onChanged}
    />,
  )
  await user.click(screen.getByRole('button', { name: 'Check Continue' }))
  expect(read).toHaveBeenCalledExactlyOnceWith({
    sessionId,
    decisionId: first.operationId,
    clientOperationId: first.operationId,
  })
  expect(send).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('button', { name: 'Continue original request' })).toHaveProperty(
    'disabled',
    true,
  )
  view.rerender(
    <PreparedInputCard
      sessionId={sessionId}
      input={{
        ...input,
        revision: 2,
        settingsRevision: 2,
        continuationFingerprint: 'c'.repeat(64),
      }}
      disabled={false}
      onChanged={onChanged}
    />,
  )
  await user.click(screen.getByRole('button', { name: 'Continue original request' }))
  expect(send).toHaveBeenCalledTimes(2)
  expect(send.mock.calls[1]![0]).toMatchObject({
    batchId: input.batchId,
    expectedRevision: 2,
    expectedSettingsRevision: 2,
    expectedContinuationFingerprint: 'c'.repeat(64),
  })
  expect(send.mock.calls[1]![0].operationId).not.toBe(first.operationId)
})

it('a newer paused projection keeps an uncertain old action on pure Check until its receipt is known', async () => {
  const send = vi
      .fn<DesktopBridge['continuePreparedConversationInput']>()
      .mockResolvedValue({ ok: false, error: { code: 'TIMEOUT', message: 'Unknown receipt.' } }),
    read = vi.fn<DesktopBridge['getRelayDecisionReceipt']>().mockResolvedValue({
      ok: false,
      error: { code: 'UNCERTAIN', message: 'No confirmed receipt yet.' },
    })
  Object.defineProperty(window, 'pact', {
    configurable: true,
    value: { continuePreparedConversationInput: send, getRelayDecisionReceipt: read },
  })
  const user = userEvent.setup(),
    view = render(
      <PreparedInputCard
        sessionId={sessionId}
        input={input}
        disabled={false}
        onChanged={() => {}}
      />,
    )
  await user.click(screen.getByRole('button', { name: 'Continue original request' }))
  const old = send.mock.calls[0]![0]
  view.rerender(
    <PreparedInputCard
      sessionId={sessionId}
      input={{ ...input, revision: 2 }}
      disabled={false}
      onChanged={() => {}}
    />,
  )
  await user.click(screen.getByRole('button', { name: 'Check Continue' }))
  expect(read).toHaveBeenCalledExactlyOnceWith({
    sessionId,
    decisionId: old.operationId,
    clientOperationId: old.operationId,
  })
  expect(send).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('button', { name: 'Check Continue' })).toHaveProperty('disabled', false)
})
