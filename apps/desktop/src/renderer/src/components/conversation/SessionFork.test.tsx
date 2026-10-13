import type { ComponentProps } from 'react'

// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type {
  ConversationPatch,
  DesktopBridge,
  RpcResult,
  SessionCatalogChange,
  SessionForkOperation,
  SessionForkPrepared,
  SessionForkResult,
} from '@pact/contracts'

import { createRendererQueryClient, sessionWorkspaceQueryKeys } from '../../query-client'
import {
  acceptSessionCatalogChange,
  type SessionCatalogCache,
} from '../workspace/session-catalog-cache'
import { composerBridgeFixture } from './composer.test-helper'
import { windowFromPage } from './conversation-window'
import { ConversationView } from './ConversationView'
import { NativeForkRecovery, SessionForkDialog } from './SessionFork'

const showDescriptor = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal')
const closeDescriptor = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close')
beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    window.setTimeout(() => callback(0), 0),
  )
  vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id))
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.open = true
    },
  })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.open = false
    },
  })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  for (const [name, descriptor] of [
    ['showModal', showDescriptor],
    ['close', closeDescriptor],
  ] as const) {
    if (descriptor) Object.defineProperty(HTMLDialogElement.prototype, name, descriptor)
    else Reflect.deleteProperty(HTMLDialogElement.prototype, name)
  }
})

function fixture() {
  const sourceSessionId = crypto.randomUUID(),
    messageId = crypto.randomUUID(),
    sessionId = crypto.randomUUID()
  const prepared: SessionForkPrepared = {
    sourceSessionId,
    messageId,
    messageRevision: 2,
    settingsRevision: 3,
    sourceRevision: 'source-revision',
    sequence: 4,
    preview: 'Selected completed reply',
    settings: {
      primaryAgentId: 'claude',
      agents: {
        claude: { model: 'claude-opus', effort: 'high' },
        codex: { model: 'gpt-6.1-sol', effort: 'medium' },
      },
      permissionModes: { claude: 'full', codex: 'ask' },
      maxDiscussionRounds: 3,
      runningMessagePolicy: 'next_round',
      maxReviewCycles: 3,
      maxRepairAttempts: 3,
    },
  }
  const timestamp = new Date().toISOString()
  const change: SessionCatalogChange = {
    kind: 'change',
    revision: 8,
    session: {
      id: sessionId,
      projectId: crypto.randomUUID(),
      title: 'Fork',
      titleSource: 'local',
      status: 'idle',
      activity: { state: 'error' },
      hasUnread: false,
      settings: prepared.settings,
      settingsRevision: 3,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  }
  const createReceipt = Promise.withResolvers<RpcResult<SessionForkResult>>()
  let listener: Parameters<DesktopBridge['onConversationChanged']>[0] | undefined
  const unsubscribe = vi.fn<() => void>(() => {
    listener = undefined
  })
  const forkSession = vi.fn<DesktopBridge['forkSession']>(async (input) => {
    if (input.action === 'prepare') return { ok: true, value: { kind: 'prepared', prepared } }
    if (input.action === 'create') return createReceipt.promise
    return { ok: true, value: { kind: 'state', operation: null } }
  })
  const onConversationChanged: DesktopBridge['onConversationChanged'] = (callback) => {
    listener = callback
    return unsubscribe
  }
  const getSessionSettings = vi.fn<DesktopBridge['getSessionSettings']>(async () => ({
    ok: true,
    value: {
      session: { ...change.session, id: sourceSessionId },
      modelCatalogs: {
        claude: {
          agentId: 'claude',
          status: 'available',
          checkedAt: timestamp,
          models: [
            { id: 'claude-opus', displayName: 'resolved-custom-model', supportedEfforts: ['high'] },
          ],
        },
        codex: {
          agentId: 'codex',
          status: 'available',
          checkedAt: timestamp,
          models: [{ id: 'gpt-6.1-sol', displayName: 'gpt-6.1-sol', supportedEfforts: ['medium'] }],
        },
      },
    },
  }))
  vi.stubGlobal('pact', {
    ...composerBridgeFixture(),
    forkSession,
    onConversationChanged,
    getSessionSettings,
  } satisfies Pick<DesktopBridge, 'forkSession' | 'onConversationChanged' | 'getSessionSettings'>)
  const props = {
    sourceSessionId,
    messageId,
    onClose: vi.fn<() => void>(),
    onCreated: vi.fn<(value: SessionCatalogChange, enter: boolean) => void>(),
  }
  const operation = (ready = false, revision = 1): SessionForkOperation => {
    const request = forkSession.mock.calls.find(([input]) => input.action === 'create')?.[0]
    if (!request || request.action !== 'create') throw new Error('Create request missing')
    return {
      id: request.operationId,
      sourceSessionId,
      sourceMessageId: messageId,
      sourceSequence: 4,
      sessionId,
      revision,
      ready,
      sides: (['claude', 'codex'] as const).map((agentId) => ({
        agentId,
        state: ready ? 'ready' : 'initializing',
        canContinue: false,
        canInitialize: false,
      })),
    }
  }
  const publish = (value: SessionForkOperation) => {
    const patch: ConversationPatch = {
      version: 'conversation-patch-v1',
      sessionId,
      observation: { incarnation: crypto.randomUUID(), sequence: value.revision },
      session: change.session,
      messages: [],
      runs: [],
      activities: [],
      activityStates: [],
      forkOperation: value,
    }
    listener?.(patch)
  }
  const start = async () => {
    const mounted = render(<SessionForkDialog {...props} />)
    await screen.findByRole('button', { name: 'Create fork with Full access' })
    await waitFor(() =>
      expect(
        screen.getByRole<HTMLButtonElement>('button', { name: 'Create fork with Full access' })
          .disabled,
      ).toBe(false),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Create fork with Full access' }))
    return mounted
  }
  const receipt = async (value: SessionForkOperation) =>
    act(async () => {
      createReceipt.resolve({ ok: true, value: { kind: 'created', operation: value, change } })
    })
  return {
    props,
    prepared,
    change,
    operation,
    publish,
    forkSession,
    getSessionSettings,
    createReceipt,
    start,
    receipt,
    unsubscribe,
  }
}

it('shows inherited choices and confirms Full access through the creation command without extra copy', async () => {
  const f = fixture()
  render(<SessionForkDialog {...f.props} />)
  await screen.findByText('resolved-custom-model — claude-opus · high · Full access')
  expect(screen.getByText('gpt-6.1-sol · medium · Ask')).toBeDefined()
  expect(screen.getByText('Claude Code · Primary')).toBeDefined()
  expect(screen.queryByText(/Creating this fork confirms Full access/u)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Create fork with Full access' }))
  expect(f.forkSession).toHaveBeenLastCalledWith(
    expect.objectContaining({
      action: 'create',
      confirmedFullAccessAgents: ['claude'],
      sourceRevision: 'source-revision',
      settingsRevision: 3,
    }),
  )
})

it('shows a missing native history rejection and never offers a creation request', async () => {
  const f = fixture()
  f.forkSession.mockResolvedValueOnce({
    ok: false,
    error: { code: 'VALIDATION', message: 'Both Agents need native history at this reply.' },
  })
  render(<SessionForkDialog {...f.props} />)
  expect((await screen.findByRole('alert')).textContent).toContain(
    'Both Agents need native history',
  )
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Create fork' }).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Create fork' }))
  expect(f.forkSession).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(f.props.onClose).toHaveBeenCalledOnce()
})

it('uses a changed native model mapping rather than a fixed provider name', async () => {
  const f = fixture()
  const settings = await f.getSessionSettings(f.props.sourceSessionId)
  if (!settings.ok) throw new Error('Fixture settings missing')
  settings.value.modelCatalogs.claude.models[0]!.displayName = 'another-native-model[1m]'
  f.getSessionSettings.mockResolvedValue(settings)
  render(<SessionForkDialog {...f.props} />)
  expect(
    await screen.findByText('another-native-model[1m] — claude-opus · high · Full access'),
  ).toBeDefined()
  expect(screen.queryByText(/resolved-custom-model/u)).toBeNull()
  expect(f.forkSession).toHaveBeenCalledTimes(1)
})

it('does not apply model names from a different Source revision', async () => {
  const f = fixture()
  const settings = await f.getSessionSettings(f.props.sourceSessionId)
  if (!settings.ok) throw new Error('Fixture settings missing')
  settings.value.session.settingsRevision += 1
  f.getSessionSettings.mockResolvedValue(settings)
  render(<SessionForkDialog {...f.props} />)
  expect(await screen.findByText('claude-opus · high · Full access')).toBeDefined()
  expect(screen.queryByText(/resolved-custom-model/u)).toBeNull()
})

it('keeps the same dialog open and blocks duplicate creation, Cancel and Escape until creation settles', async () => {
  const f = fixture()
  await f.start()
  const dialog = screen.getByRole('dialog')
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Creating…' }).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Creating…' }))
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  const cancel = new Event('cancel', { cancelable: true })
  fireEvent(dialog, cancel)
  expect(cancel.defaultPrevented).toBe(true)
  expect(f.props.onClose).not.toHaveBeenCalled()
  expect(f.forkSession.mock.calls.filter(([input]) => input.action === 'create')).toHaveLength(1)
  await f.receipt(f.operation())
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Close' }).disabled).toBe(true)
  expect(screen.getByRole<HTMLDialogElement>('dialog').open).toBe(true)
})

it('waits for the creation receipt when both Ready facts arrive first and enters that child once', async () => {
  const f = fixture()
  await f.start()
  const ready = f.operation(true, 2)
  act(() => f.publish(ready))
  expect(f.props.onCreated).not.toHaveBeenCalled()
  f.forkSession.mockResolvedValueOnce({ ok: true, value: { kind: 'state', operation: ready } })
  await f.receipt(f.operation(false, 1))
  await waitFor(() => expect(f.props.onCreated).toHaveBeenCalledWith(f.change, true))
  act(() => {
    f.publish(ready)
    f.publish(f.operation(false, 1))
  })
  expect(f.props.onCreated.mock.calls.filter(([, enter]) => enter)).toEqual([[f.change, true]])
  expect(f.props.onCreated).toHaveBeenCalledWith(f.change, false)
})

it('publishes a failed committed branch then closes its creation modal without entering', async () => {
  const f = fixture()
  await f.start()
  const failed = f.operation()
  failed.sides[0]!.state = 'ready'
  failed.sides[1] = {
    agentId: 'codex',
    state: 'error',
    reason: 'Candidate needs confirmation',
    canInitialize: true,
    canContinue: false,
  }
  await f.receipt(failed)
  expect(screen.getByText('Ready')).toBeDefined()
  expect(screen.getByText('Candidate needs confirmation')).toBeDefined()
  expect(screen.queryByRole('button', { name: 'Check original candidate' })).toBeNull()
  expect(f.props.onCreated).toHaveBeenCalledWith(f.change, false)
  expect(f.props.onClose).toHaveBeenCalledOnce()
  expect(f.props.onCreated.mock.calls.filter(([, enter]) => enter)).toEqual([])
})

it('retries a lost creation acknowledgement with the same operation identity', async () => {
  const f = fixture()
  await f.start()
  await act(async () => f.createReceipt.reject(new Error('Lost ACK')))
  expect((await screen.findByRole('alert')).textContent).toContain('same operation')
  const first = f.forkSession.mock.calls.find(([input]) => input.action === 'create')![0]
  f.forkSession.mockResolvedValueOnce({
    ok: true,
    value: { kind: 'created', operation: f.operation(), change: f.change },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Create fork with Full access' }))
  expect(
    f.forkSession.mock.calls.filter(([input]) => input.action === 'create').map(([input]) => input),
  ).toEqual([first, first])
  await waitFor(() => expect(f.props.onCreated).toHaveBeenCalledWith(f.change, false))
})

it('reconciles a known committed branch after lost ACK and installs Sidebar before closing', async () => {
  const f = fixture()
  const queryClient = createRendererQueryClient()
  queryClient.setQueryData<SessionCatalogCache>(sessionWorkspaceQueryKeys.catalog, {
    sessions: [{ ...f.change.session, id: f.props.sourceSessionId, title: 'Source' }],
    projectPages: { [f.change.session.projectId]: { revision: 1 } },
  })
  f.props.onCreated.mockImplementation((change) => acceptSessionCatalogChange(queryClient, change))
  f.props.onClose.mockImplementation(() => {
    expect(
      queryClient
        .getQueryData<SessionCatalogCache>(sessionWorkspaceQueryKeys.catalog)
        ?.sessions.some((session) => session.id === f.change.session.id),
    ).toBe(true)
  })
  try {
    await f.start()
    const failed = f.operation(false, 2)
    failed.sides[0]!.state = 'ready'
    failed.sides[1]!.state = 'error'
    act(() => f.publish(failed))
    f.forkSession.mockResolvedValueOnce({
      ok: true,
      value: { kind: 'created', change: f.change, operation: failed },
    })
    await act(async () => f.createReceipt.reject(new Error('Lost committed ACK')))
    await waitFor(() => expect(f.props.onClose).toHaveBeenCalledOnce())
    const calls = f.forkSession.mock.calls.filter(([input]) => input.action === 'create')
    expect(calls).toHaveLength(2)
    expect(calls[1]![0]).toEqual(calls[0]![0])
    expect(f.props.onCreated).toHaveBeenCalledWith(f.change, false)
    expect(f.props.onCreated.mock.calls.some(([, enter]) => enter)).toBe(false)
  } finally {
    queryClient.clear()
  }
})

it('keeps the creation receipt recovery visible when reconciliation belongs to another child', async () => {
  const f = fixture()
  await f.start()
  const failed = f.operation(false, 2)
  failed.sides[0]!.state = 'ready'
  failed.sides[1]!.state = 'error'
  act(() => f.publish(failed))
  f.forkSession.mockResolvedValueOnce({
    ok: true,
    value: {
      kind: 'created',
      change: f.change,
      operation: { ...failed, sessionId: crypto.randomUUID() },
    },
  })
  await act(async () => f.createReceipt.reject(new Error('Lost committed ACK')))
  expect((await screen.findByRole('alert')).textContent).toContain('sidebar receipt')
  expect(f.props.onClose).not.toHaveBeenCalled()
  expect(f.props.onCreated).not.toHaveBeenCalled()
})

it('disposes the old Source subscription and ignores its late receipt after keyed Source replacement', async () => {
  const f = fixture()
  const mounted = await f.start()
  const oldReady = f.operation(true)
  mounted.unmount()
  expect(f.unsubscribe).toHaveBeenCalledOnce()
  const next = fixture()
  render(<SessionForkDialog key={next.props.sourceSessionId} {...next.props} />)
  await screen.findByRole('button', { name: 'Create fork with Full access' })
  await f.receipt(oldReady)
  expect(f.props.onCreated).not.toHaveBeenCalled()
  expect(next.props.onCreated).not.toHaveBeenCalled()
})

it('makes recovery explicit for the failed Agent and keeps readiness controlled by durable state', async () => {
  const f = fixture()
  await f.start()
  const value = f.operation()
  value.sides[0]!.state = 'ready'
  value.sides[1] = {
    agentId: 'codex',
    state: 'unconfirmed',
    canInitialize: true,
    canContinue: false,
  }
  cleanup()
  const mounted = render(<NativeForkRecovery operation={value} />)
  expect(
    screen.getByText(/Sending becomes available when both Native sessions are ready/u),
  ).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: 'Continue initialization' }))
  await waitFor(() =>
    expect(f.forkSession).toHaveBeenLastCalledWith({
      action: 'initialize',
      sessionId: value.sessionId,
      operationId: value.id,
      agentId: 'codex',
    }),
  )
  expect(screen.getByRole('region', { name: 'Native fork confirmation' })).toBeDefined()
  mounted.rerender(<NativeForkRecovery operation={{ ...value, ready: true }} />)
  expect(screen.queryByRole('region', { name: 'Native fork confirmation' })).toBeNull()
})

it('keeps the actual recovered conversation Composer read-only until both native sides are ready', async () => {
  const f = fixture()
  await f.start()
  const operation = f.operation()
  operation.sides[0]!.state = 'ready'
  operation.sides[1]!.state = 'error'
  cleanup()
  const window = windowFromPage({
    scope: 'messages',
    sessionId: f.change.session.id,
    observation: { incarnation: crypto.randomUUID(), sequence: 1 },
    header: {
      session: f.change.session,
      commentsRevision: 0,
      forkOperation: operation,
      forkBlocked: true,
      sessionIssues: { sessionId: f.change.session.id, inputGate: 'read_only', agents: [] },
    },
    messages: [],
    runs: [],
    hasOlder: false,
    hasNewer: false,
  })
  const noop = vi.fn<() => void>()
  const load = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
  const complete = vi.fn<() => Promise<boolean>>().mockResolvedValue(true)
  const props: ComponentProps<typeof ConversationView> = {
    session: f.change.session,
    snapshot: window.view,
    visible: true,
    composer: 'Preserved child draft',
    loading: false,
    sending: false,
    stopping: false,
    agentActionsEnabled: true,
    history: {
      window,
      protectReading: noop,
      readingPositionLost: false,
      loadingPage: false,
      gapRecoveryPending: false,
      draftLimitExceeded: false,
      draftsLoading: false,
      draftError: false,
      retryDrafts: noop,
      retryComments: noop,
      retryRead: noop,
      oversizedActivities: {},
      loadOlder: load,
      loadLatest: load,
      recoverFromGap: load,
      historyResyncToken: 0,
      ensureMessage: load,
      loadActivities: load,
      loadRunArtifacts: load,
      closeRunArtifacts: noop,
      loadMoreActivityBody: noop,
    },
    onComposerChange: noop,
    onComposerMentionChange: noop,
    onSend: complete,
    onSaveCommentDraft: complete,
    onRemoveCommentDraft: complete,
    onStop: complete,
    onRebuildNativeContext: complete,
    onCheckNativeContext: complete,
    onAcceptPeerProposal: complete,
    onDismissPeerProposal: complete,
    onUndoWorkspaceChanges: complete,
    onRespondNativeInput: complete,
    nativeInputDrafts: {},
    onNativeInputDraftChange: noop,
    onRespondNativePermission: complete,
    onOpenWorkspaceChanges: noop,
    onPrepareWorkspaceChanges: () => 1,
    onOpenProjectFile: noop,
    onOpenComment: noop,
    onNotice: noop,
  }
  const mounted = render(<ConversationView {...props} />)
  expect(screen.getByRole('combobox', { name: 'Message' }).getAttribute('aria-disabled')).toBe(
    'true',
  )
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Send message' }).disabled).toBe(
    true,
  )
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
  expect(complete).not.toHaveBeenCalled()
  const ready = {
    ...operation,
    ready: true,
    sides: operation.sides.map((side) => ({ ...side, state: 'ready' as const })),
  }
  mounted.rerender(
    <ConversationView
      {...props}
      snapshot={{
        ...window.view,
        forkOperation: ready,
        forkBlocked: false,
        sessionIssues: { sessionId: operation.sessionId, inputGate: 'open', agents: [] },
      }}
    />,
  )
  expect(screen.getByRole('combobox', { name: 'Message' }).getAttribute('aria-disabled')).toBe(
    'false',
  )
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Send message' }).disabled).toBe(
    false,
  )
  expect(screen.getByRole('combobox', { name: 'Message' }).textContent).toBe(
    'Preserved child draft',
  )
})
