// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import type { CollaborationSession, NativeSkill, SkillSelection } from '@pact/contracts'

import { composerBridgeFixture } from './composer.test-helper'
import { useSkillComposer } from './useSkillComposer'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
const session: CollaborationSession = {
  id: '856996b7-77f1-4230-9dc9-f94ca3016c47',
  projectId: 'cf26f7e3-b469-438c-b0cb-708ff23e0297',
  title: 'Owned Composer',
  titleSource: 'local',
  status: 'idle',
  activity: { state: 'idle' },
  hasUnread: false,
  settingsRevision: 1,
  createdAt: '2026-10-07T00:00:00.000Z',
  updatedAt: '2026-10-07T00:00:00.000Z',
  settings: {
    primaryAgentId: 'codex',
    agents: { codex: { model: null, effort: null }, claude: { model: null, effort: null } },
    maxDiscussionRounds: 3,

    maxReviewCycles: 3,
    maxRepairAttempts: 3,
  },
}

it('keeps a dismissed query closed across cursor events until the command changes', () => {
  vi.stubGlobal('pact', composerBridgeFixture())
  const hook = renderHook(
    ({ text }) => useSkillComposer({ session, text, selections: [], disabled: false }),
    { initialProps: { text: '/' } },
  )
  act(() => hook.result.current.update('/', 1, []))
  expect(hook.result.current.query?.text).toBe('')
  act(() => hook.result.current.close())
  act(() => hook.result.current.update('/', 1, []))
  expect(hook.result.current.query).toBeUndefined()
  hook.rerender({ text: '/p' })
  act(() => hook.result.current.update('/p', 2, []))
  expect(hook.result.current.query?.text).toBe('p')
  act(() => hook.result.current.close())
  act(() => hook.result.current.update('', 0, []))
  hook.rerender({ text: '/' })
  act(() => hook.result.current.update('/', 1, []))
  expect(hook.result.current.query?.text).toBe('')
})

it('More Skills advances the visible window, crosses native pages and permits reverse navigation', async () => {
  const bridge = composerBridgeFixture()
  const skills: NativeSkill[] = Array.from({ length: 55 }, (_, index) => ({
    id: index.toString(16).padStart(64, '0'),
    agentId: 'codex',
    name: `skill-${String(index).padStart(2, '0')}`,
    description: 'Owned Skill',
    argumentHint: '',
    source: 'user',
  }))
  bridge.readSkillCatalog.mockImplementation(async (input) => {
    const matches = input.agentId === 'codex' ? skills : []
    const page = matches.slice(input.offset, input.offset + 50)
    return {
      ok: true,
      value: {
        agentId: input.agentId,
        generation: '4e02f5e7-0c7e-44c6-8da0-8a3c7f5cf342',
        checkedAt: session.updatedAt,
        skills: page,
        total: matches.length,
        nextOffset: input.offset + page.length < matches.length ? input.offset + page.length : null,
      },
    }
  })
  vi.stubGlobal('pact', bridge)
  const hook = renderHook(() =>
    useSkillComposer({ session, text: '/', selections: [], disabled: false }),
  )
  act(() => hook.result.current.update('/', 1, []))
  await waitFor(() =>
    expect(
      hook.result.current.visibleOptions.filter((entry) => entry.agentId === 'codex'),
    ).toHaveLength(18),
  )
  expect(hook.result.current.visibleOptions.find((entry) => entry.agentId === 'codex')?.name).toBe(
    'skill-00',
  )
  expect(hook.result.current.pactOptions.map((entry) => entry.name)).toEqual([
    'plan',
    'build',
    'review',
    'btw',
  ])
  expect(
    hook.result.current.visibleOptions.length + hook.result.current.pactOptions.length,
  ).toBeLessThanOrEqual(40)
  const initialRequests = bridge.readSkillCatalog.mock.calls.length
  await act(async () => hook.result.current.more('codex'))
  expect(hook.result.current.visibleOptions.find((entry) => entry.agentId === 'codex')?.name).toBe(
    'skill-18',
  )
  expect(bridge.readSkillCatalog).toHaveBeenCalledTimes(initialRequests)
  await act(async () => hook.result.current.more('codex'))
  expect(hook.result.current.visibleOptions.find((entry) => entry.agentId === 'codex')?.name).toBe(
    'skill-36',
  )
  await act(async () => hook.result.current.more('codex'))
  expect(
    hook.result.current.visibleOptions
      .filter((entry) => entry.agentId === 'codex')
      .map((entry) => entry.name),
  ).toEqual(['skill-50', 'skill-51', 'skill-52', 'skill-53', 'skill-54'])
  expect(
    bridge.readSkillCatalog.mock.calls.some(
      ([input]) => input.agentId === 'codex' && input.offset === 50,
    ),
  ).toBe(true)
  await act(async () => hook.result.current.more('codex', true))
  expect(hook.result.current.visibleOptions.find((entry) => entry.agentId === 'codex')?.name).toBe(
    'skill-32',
  )
  hook.unmount()
  expect(bridge.cancelSkillCatalog).toHaveBeenCalledWith(session.id)
})

it('distinguishes a primary mismatch from an explicit target even when the Agent is unchanged', async () => {
  vi.stubGlobal('pact', composerBridgeFixture())
  const selection: SkillSelection = {
    id: 'a'.repeat(64),
    agentId: 'claude',
    name: 'x',
    start: 0,
    end: 2,
  }
  const hook = renderHook(
    ({ text }) => useSkillComposer({ session, text, selections: [selection], disabled: false }),
    { initialProps: { text: '/x' } },
  )
  expect(hook.result.current.warning).toContain('your primary Agent (Codex)')
  hook.rerender({ text: '/x @codex task' })
  expect(hook.result.current.warning).toContain('your selected Agent @codex (Codex)')
})

it('hides Pact slash options and rejects /plan, /build, /review, and /btw in a side chat', () => {
  vi.stubGlobal('pact', composerBridgeFixture())
  const sideChatSession: CollaborationSession = {
    ...session,
    id: '256996b7-77f1-4230-9dc9-f94ca3016c47',
    parentSessionId: session.id,
    sideChatOrigin: 'btw',
  }

  const hook = renderHook(
    ({ text }) =>
      useSkillComposer({
        session: sideChatSession,
        text,
        selections: [],
        disabled: false,
      }),
    { initialProps: { text: '/' } },
  )

  act(() => hook.result.current.update('/', 1, []))
  expect(hook.result.current.pactOptions).toEqual([])

  for (const command of ['/plan ', '/build ', '/review ', '/btw ']) {
    hook.rerender({ text: `${command}follow up` })
    expect(hook.result.current.warning).toBe(
      'Pact commands (/plan, /build, /review, /btw) can only be used in the main chat.',
    )
    expect(hook.result.current.checking).toBe(false)
  }
})

it('keeps main-chat /btw handoff unblocked and routes side-chat @Main validation to mainTargetAgentId', () => {
  vi.stubGlobal('pact', composerBridgeFixture())
  const claudeSkill: SkillSelection = {
    id: 'b'.repeat(64),
    agentId: 'claude',
    name: 'audit',
    start: 5,
    end: 11,
  }
  const btwHook = renderHook(() =>
    useSkillComposer({
      session,
      text: '/btw /audit check auth',
      selections: [claudeSkill],
      disabled: false,
    }),
  )
  expect(btwHook.result.current.warning).toBeUndefined()
  expect(btwHook.result.current.checking).toBe(false)

  const sideChatSession: CollaborationSession = {
    ...session,
    id: '356996b7-77f1-4230-9dc9-f94ca3016c47',
    parentSessionId: session.id,
    sideChatOrigin: 'btw',
  }
  const codexSkill: SkillSelection = {
    id: 'c'.repeat(64),
    agentId: 'codex',
    name: 'lint',
    start: 6,
    end: 11,
  }
  const mainHook = renderHook(() =>
    useSkillComposer({
      session: sideChatSession,
      text: '@Main /lint fix warnings',
      selections: [codexSkill],
      mainTargetAgentId: 'claude',
      disabled: false,
    }),
  )
  expect(mainHook.result.current.warning).toBe(
    '/lint belongs to Codex. It does not match the main chat target (Claude Code).',
  )
})
