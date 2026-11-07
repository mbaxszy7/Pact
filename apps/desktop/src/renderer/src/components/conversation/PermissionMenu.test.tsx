// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState, type ComponentProps } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { AgentRun, CollaborationSession, DesktopBridge, Project } from '@pact/contracts'

import { useSessionWorkspace } from '../workspace/useSessionWorkspace'
import { composerBridgeFixture } from './composer.test-helper'
import { ConversationView } from './ConversationView'
import { PermissionMenu } from './PermissionMenu'

type MenuProps = ComponentProps<typeof PermissionMenu>
const popoverDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'hidePopover')
beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  vi.stubGlobal('matchMedia', () => ({
    matches: true,
    addEventListener: vi.fn<() => void>(),
    removeEventListener: vi.fn<() => void>(),
  }))
  vi.stubGlobal('pact', composerBridgeFixture())
  Object.defineProperty(HTMLElement.prototype, 'hidePopover', {
    configurable: true,
    value: vi.fn<(this: HTMLElement) => void>(function (this: HTMLElement) {
      this.style.display = 'none'
    }),
  })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    window.setTimeout(() => callback(0), 0),
  )
  vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  if (popoverDescriptor)
    Object.defineProperty(HTMLElement.prototype, 'hidePopover', popoverDescriptor)
  else Reflect.deleteProperty(HTMLElement.prototype, 'hidePopover')
})

function session(): CollaborationSession {
  const timestamp = new Date().toISOString()
  return {
    id: crypto.randomUUID(),
    projectId: crypto.randomUUID(),
    title: 'Permissions',
    titleSource: 'local',
    status: 'idle',
    activity: { state: 'idle' },
    hasUnread: false,
    settings: {
      primaryAgentId: 'codex',
      agents: {
        codex: { model: null, effort: null },
        claude: { model: 'deepseek-flash', effort: null },
      },
      maxDiscussionRounds: 3,

      maxReviewCycles: 3,
      maxRepairAttempts: 3,
    },
    settingsRevision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}

function menuProps(): MenuProps {
  return {
    session: session(),
    onSave: vi.fn<MenuProps['onSave']>().mockResolvedValue(true),
    onNotice: vi.fn<MenuProps['onNotice']>(),
  }
}

function openMenu(agent: 'codex' | 'claude' = 'codex'): HTMLElement {
  const name = agent === 'codex' ? 'Codex' : 'Claude Code'
  fireEvent.click(
    screen.getByRole('button', {
      name: new RegExp(`^${name} permissions for the next task:`, 'u'),
    }),
  )
  // jsdom has the UA hidden-popover style but not native activation behavior.
  const panel = screen.getByLabelText<HTMLDivElement>(
    `${agent === 'codex' ? 'Codex' : 'Claude Code'} permissions`,
  )
  fireEvent(panel, Object.assign(new Event('beforetoggle'), { newState: 'open' }))
  panel.style.display = 'block'
  return panel
}

it('saves independent Agent choices, including native inheritance and native Auto for Claude', async () => {
  const props = menuProps()
  render(
    <>
      <PermissionMenu {...props} agent="codex" />
      <PermissionMenu {...props} agent="claude" />
    </>,
  )
  const codex = within(openMenu())
  fireEvent.click(codex.getByRole('button', { name: /^Ask for approval/u }))
  await waitFor(() =>
    expect(props.onSave).toHaveBeenCalledWith({
      sessionId: props.session.id,
      agentId: 'codex',
      mode: 'ask',
      expectedRevision: 1,
      confirmedFullAccess: false,
    }),
  )
  const claude = within(openMenu('claude'))
  fireEvent.click(claude.getByRole('button', { name: /^Auto/u }))
  await waitFor(() =>
    expect(props.onSave).toHaveBeenLastCalledWith({
      sessionId: props.session.id,
      agentId: 'claude',
      mode: 'auto',
      expectedRevision: 1,
      confirmedFullAccess: false,
    }),
  )
  openMenu('claude')
  fireEvent.click(claude.getByRole('button', { name: /^Native settings/u }))
  await waitFor(() =>
    expect(props.onSave).toHaveBeenLastCalledWith(
      expect.objectContaining({ agentId: 'claude', mode: 'native' }),
    ),
  )
  openMenu('claude')
  fireEvent.click(claude.getByRole('button', { name: /^Full access/u }))
  expect(claude.getByText('Enable Full access for Claude Code?')).toBeDefined()
  fireEvent.click(claude.getByRole('button', { name: 'Enable Full access' }))
  await waitFor(() =>
    expect(props.onSave).toHaveBeenLastCalledWith({
      sessionId: props.session.id,
      agentId: 'claude',
      mode: 'full',
      expectedRevision: 1,
      confirmedFullAccess: true,
    }),
  )
})

it('Full access requires confirmation, cancellation grants nothing, and duplicate confirmation saves once', async () => {
  const props = menuProps()
  let finish!: (saved: boolean) => void
  props.onSave = vi.fn<MenuProps['onSave']>(
    () =>
      new Promise((done) => {
        finish = done
      }),
  )
  render(<PermissionMenu {...props} />)
  openMenu()
  fireEvent.click(screen.getByRole('button', { name: /^Full access/u }))
  expect(props.onSave).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(props.onSave).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: /^Full access/u }))
  fireEvent.click(screen.getByRole('button', { name: 'Enable Full access' }))
  fireEvent.click(screen.getByRole('button', { name: 'Saving…' }))
  expect(props.onSave).toHaveBeenCalledTimes(1)
  await act(async () => finish(true))
  expect(screen.queryByRole('button', { name: 'Enable Full access' })).toBeNull()
})

it('revoking Full access and enabling it again needs a fresh confirmation at the current revision', async () => {
  const props = menuProps()
  props.session.settings.permissionModes = { codex: 'full', claude: 'ask' }
  function Controlled() {
    const [current, setCurrent] = useState(props.session)
    return (
      <PermissionMenu
        {...props}
        session={current}
        onSave={async (input) => {
          await props.onSave(input)
          setCurrent({
            ...current,
            settingsRevision: current.settingsRevision + 1,
            settings: {
              ...current.settings,
              permissionModes: {
                ...current.settings.permissionModes!,
                [input.agentId]: input.mode,
              },
            },
          })
          return true
        }}
      />
    )
  }
  render(<Controlled />)
  openMenu()
  fireEvent.click(screen.getByRole('button', { name: /^Ask for approval/u }))
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Codex permissions for the next task: Ask for approval' }),
    ).toBeDefined(),
  )
  expect(props.onSave).toHaveBeenCalledWith(
    expect.objectContaining({ mode: 'ask', expectedRevision: 1, confirmedFullAccess: false }),
  )
  openMenu()
  fireEvent.click(screen.getByRole('button', { name: /^Full access/u }))
  expect(props.onSave).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: 'Enable Full access' }))
  await waitFor(() =>
    expect(props.onSave).toHaveBeenLastCalledWith(
      expect.objectContaining({ mode: 'full', expectedRevision: 2, confirmedFullAccess: true }),
    ),
  )
})

it('shows next-task pending without answering the current native approval', async () => {
  const props = menuProps()
  props.session.settings.permissionModes = { codex: 'full', claude: 'ask' }
  const run: AgentRun = {
    id: crypto.randomUUID(),
    sessionId: props.session.id,
    userMessageId: crypto.randomUUID(),
    agentId: 'codex',
    status: 'running',
    permissionMode: 'ask',
    attemptCount: 1,
    settingsRevision: 1,
    model: null,
    effort: null,
    createdAt: props.session.createdAt,
    updatedAt: props.session.updatedAt,
  }
  const respond = vi.fn<DesktopBridge['respondNativePermission']>()
  vi.stubGlobal('pact', { respondNativePermission: respond })
  render(<PermissionMenu {...props} run={run} busy />)
  openMenu()
  expect(screen.getByText('Pending · next task')).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: /^Auto/u }))
  await waitFor(() =>
    expect(props.onSave).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'codex', mode: 'auto' }),
    ),
  )
  expect(respond).not.toHaveBeenCalled()
})

it('mounts the permission control after the Composer, outside its input surface', () => {
  const props = menuProps()
  const noop = vi.fn<() => void>()
  const complete = vi.fn<() => Promise<boolean>>().mockResolvedValue(true)
  const load = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
  render(
    <ConversationView
      session={props.session}
      visible
      composer=""
      loading={false}
      sending={false}
      stopping={false}
      agentActionsEnabled
      onSaveSessionPermission={props.onSave}
      onNotice={props.onNotice}
      history={{
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
      }}
      onComposerChange={noop}
      onComposerMentionChange={noop}
      onSend={complete}
      onSaveCommentDraft={complete}
      onRemoveCommentDraft={complete}
      onStop={complete}
      onRebuildNativeContext={complete}
      onCheckNativeContext={complete}
      onAcceptPeerProposal={complete}
      onDismissPeerProposal={complete}
      onUndoWorkspaceChanges={complete}
      onRespondNativeInput={complete}
      nativeInputDrafts={{}}
      onNativeInputDraftChange={noop}
      onRespondNativePermission={complete}
      onOpenWorkspaceChanges={noop}
      onPrepareWorkspaceChanges={() => 1}
      onOpenProjectFile={noop}
      onOpenComment={noop}
    />,
  )
  const composer = screen.getByRole('combobox', { name: 'Message' })
  const permission = screen.getByRole('button', {
    name: 'Codex permissions for the next task: Native settings',
  })
  expect(composer.compareDocumentPosition(permission) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
    Node.DOCUMENT_POSITION_FOLLOWING,
  )
  expect(composer.parentElement?.contains(permission)).toBe(false)
})

it.each([true, false])(
  'reads back a lost permission reply without repeating the grant (readback succeeds: %s)',
  async (readbackSucceeds) => {
    const initial = session()
    const project: Project = {
      id: initial.projectId,
      name: 'Fixture',
      directoryPath: '/fixture',
      kind: 'git',
      createdAt: initial.createdAt,
    }
    let stored = initial
    const getSessionCatalog = vi.fn<DesktopBridge['getSessionCatalog']>(async () => ({
      ok: true,
      value: {
        kind: 'page',
        projectId: project.id,
        revision: stored.settingsRevision,
        sessions: [stored],
      },
    }))
    const saveSessionPermission = vi.fn<DesktopBridge['saveSessionPermission']>(async () => {
      stored = {
        ...initial,
        settingsRevision: 2,
        settings: { ...initial.settings, permissionModes: { codex: 'full', claude: 'ask' } },
      }
      throw new Error('Committed reply was lost')
    })
    const getSessionSettings = vi.fn<DesktopBridge['getSessionSettings']>(async () =>
      readbackSucceeds
        ? {
            ok: true,
            value: {
              session: { ...stored, status: 'paused', activity: { state: 'error' } },
              modelCatalogs: {
                codex: {
                  agentId: 'codex',
                  status: 'unavailable',
                  models: [],
                  checkedAt: initial.updatedAt,
                },
                claude: {
                  agentId: 'claude',
                  status: 'unavailable',
                  models: [],
                  checkedAt: initial.updatedAt,
                },
              },
            },
          }
        : { ok: false, error: { code: 'TIMEOUT', message: 'Readback unavailable' } },
    )
    const notice = vi.fn<MenuProps['onNotice']>()
    vi.stubGlobal('pact', { getSessionCatalog, saveSessionPermission, getSessionSettings })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const projects = [project]
    function Connected() {
      const owner = useSessionWorkspace(true, projects)
      const current = owner.catalog?.sessions[0]
      return current ? (
        <>
          <PermissionMenu
            session={current}
            onSave={(input) => owner.savePermission(input)}
            onNotice={notice}
          />
          <output aria-label="Session activity">
            {current.status}:{current.activity.state}
          </output>
        </>
      ) : null
    }
    render(
      <QueryClientProvider client={client}>
        <Connected />
      </QueryClientProvider>,
    )
    await screen.findByRole('button', {
      name: 'Codex permissions for the next task: Native settings',
    })
    openMenu()
    fireEvent.click(screen.getByRole('button', { name: /^Full access/u }))
    fireEvent.click(screen.getByRole('button', { name: 'Enable Full access' }))
    await waitFor(() =>
      expect(notice).toHaveBeenCalledWith(
        'Permission change was not confirmed. Check the refreshed selection before trying again.',
      ),
    )
    expect(
      screen.getByRole('button', {
        name: readbackSucceeds
          ? 'Codex permissions for the next task: Full access'
          : 'Codex permissions for the next task: Native settings',
      }),
    ).toBeDefined()
    expect(getSessionCatalog).toHaveBeenCalledTimes(1)
    expect(getSessionSettings).toHaveBeenCalledExactlyOnceWith(initial.id)
    expect(screen.getByLabelText('Session activity').textContent).toBe('idle:idle')
    expect(saveSessionPermission).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    if (readbackSucceeds) fireEvent.click(screen.getByRole('button', { name: /^Full access/u }))
    expect(saveSessionPermission).toHaveBeenCalledTimes(1)
    client.clear()
  },
)
