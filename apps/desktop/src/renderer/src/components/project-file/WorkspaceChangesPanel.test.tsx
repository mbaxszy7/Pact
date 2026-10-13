// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import type { DesktopBridge, WorkspaceChangeFilePreview } from '@pact/contracts'

import { WorkspaceChangesPanel, type WorkspaceChangesPanelState } from './WorkspaceChangesPanel'

vi.mock('./ProjectCodeViewer', () => ({
  ProjectCodeViewer: ({ content }: { content: string }) => <pre>{content}</pre>,
  ProjectDiffViewer: ({ before, after }: { before: string; after: string }) => (
    <pre>
      {before} → {after}
    </pre>
  ),
}))
vi.mock('./RecordedPatchViewer', () => ({
  RecordedPatchViewer: ({ contents }: { contents: string[] }) => <pre>{contents.join('\n')}</pre>,
}))

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function fixture() {
  const state: WorkspaceChangesPanelState = {
    sessionId: crypto.randomUUID(),
    changeSetId: crypto.randomUUID(),
    path: 'src/main.ts',
    revision: 1,
  }
  const onExpandedChange = vi.fn<(expanded: boolean) => void>()
  const props = { state, expanded: true, onClose: vi.fn<() => void>(), onExpandedChange }
  const preview = (
    side: WorkspaceChangeFilePreview['side'],
    content: string,
    patchIndex?: number,
  ): WorkspaceChangeFilePreview => ({
    status: 'available',
    changeSetId: state.changeSetId,
    side,
    ...(patchIndex !== undefined ? { patchIndex } : {}),
    patchCount: side === 'patch' ? 1 : 0,
    file: {
      sessionId: state.sessionId,
      relativePath: state.path,
      absolutePath: `/fixture/${state.path}`,
      content,
      contentHash: 'a'.repeat(64),
      lineCount: 1,
      updatedAt: new Date().toISOString(),
    },
  })
  const missing = (side: 'before' | 'after'): WorkspaceChangeFilePreview => ({
    status: 'unavailable',
    changeSetId: state.changeSetId,
    sessionId: state.sessionId,
    relativePath: state.path,
    side,
    patchCount: 1,
    reason: side === 'after' ? 'not_final' : 'not_recorded',
  })
  return { props, preview, missing }
}

it('refreshes unchanged path/counts A to B, preserves After/expanded, and refreshes again when recording becomes ready', async () => {
  const f = fixture()
  let version = 'A'
  const read = vi.fn<DesktopBridge['readWorkspaceChangeFile']>(async (input) => ({
    ok: true,
    value: f.preview(input.side, `${input.side} ${version}`),
  }))
  vi.stubGlobal('pact', { readWorkspaceChangeFile: read })
  const rendered = render(<WorkspaceChangesPanel {...f.props} />)
  await screen.findByText('before A → after A')
  fireEvent.click(screen.getByRole('button', { name: 'After' }))
  await screen.findByText('after A')
  version = 'B'
  rendered.rerender(
    <WorkspaceChangesPanel {...f.props} state={{ ...f.props.state, revision: 2 }} />,
  )
  expect(screen.queryByText('after A')).toBeNull()
  await screen.findByText('after B')
  expect(screen.getByRole('button', { name: 'After' }).getAttribute('aria-pressed')).toBe('true')
  expect(screen.getByRole('button', { name: 'Restore changes preview' })).toBeDefined()
  expect(f.props.onExpandedChange).not.toHaveBeenCalled()
  // Native recording finalization increments the same authoritative set revision.
  version = 'Final B'
  rendered.rerender(
    <WorkspaceChangesPanel {...f.props} state={{ ...f.props.state, revision: 3 }} />,
  )
  await screen.findByText('after Final B')
  expect(screen.getByRole('button', { name: 'After' }).getAttribute('aria-pressed')).toBe('true')
  expect(read).toHaveBeenCalledTimes(6)
  expect(read.mock.calls.every(([input]) => input.path === f.props.state.path)).toBe(true)
})

it('retires delayed before/after replies from an older revision without showing A after B', async () => {
  const f = fixture()
  const old = {
    before: Promise.withResolvers<Awaited<ReturnType<DesktopBridge['readWorkspaceChangeFile']>>>(),
    after: Promise.withResolvers<Awaited<ReturnType<DesktopBridge['readWorkspaceChangeFile']>>>(),
  }
  let version = 1
  const read = vi.fn<DesktopBridge['readWorkspaceChangeFile']>((input) =>
    version === 1 && input.side !== 'patch'
      ? old[input.side].promise
      : Promise.resolve({ ok: true, value: f.preview(input.side, `${input.side} B`) }),
  )
  vi.stubGlobal('pact', { readWorkspaceChangeFile: read })
  const rendered = render(<WorkspaceChangesPanel {...f.props} />)
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2))
  version = 2
  rendered.rerender(
    <WorkspaceChangesPanel {...f.props} state={{ ...f.props.state, revision: 2 }} />,
  )
  await screen.findByText('before B → after B')
  await act(async () => {
    old.before.resolve({ ok: true, value: f.preview('before', 'before A') })
    old.after.resolve({ ok: true, value: f.preview('after', 'after A') })
  })
  expect(screen.queryByText(/before A|after A/u)).toBeNull()
  expect(screen.getByText('before B → after B')).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: 'After' }))
  expect(screen.getByText('after B')).toBeDefined()
  expect(read).toHaveBeenCalledTimes(4)
})

it('retires delayed recorded-patch replies and upgrades to final versions without resetting Diff mode', async () => {
  const f = fixture()
  const oldPatch =
    Promise.withResolvers<Awaited<ReturnType<DesktopBridge['readWorkspaceChangeFile']>>>()
  let version = 1
  const read = vi.fn<DesktopBridge['readWorkspaceChangeFile']>(async (input) => {
    if (version < 3) {
      if (input.side !== 'patch') return { ok: true, value: f.missing(input.side) }
      if (version === 1) return oldPatch.promise
      return { ok: true, value: f.preview('patch', 'recorded patch B', input.patchIndex) }
    }
    return { ok: true, value: f.preview(input.side, `${input.side} Final B`, input.patchIndex) }
  })
  vi.stubGlobal('pact', { readWorkspaceChangeFile: read })
  const rendered = render(<WorkspaceChangesPanel {...f.props} />)
  await waitFor(() => expect(read).toHaveBeenCalledTimes(3))
  version = 2
  rendered.rerender(
    <WorkspaceChangesPanel {...f.props} state={{ ...f.props.state, revision: 2 }} />,
  )
  await screen.findByText('recorded patch B')
  await act(async () =>
    oldPatch.resolve({ ok: true, value: f.preview('patch', 'recorded patch A', 0) }),
  )
  expect(screen.queryByText('recorded patch A')).toBeNull()
  version = 3
  rendered.rerender(
    <WorkspaceChangesPanel {...f.props} state={{ ...f.props.state, revision: 3 }} />,
  )
  await screen.findByText('before Final B → after Final B')
  expect(screen.getByRole('button', { name: 'Diff' }).getAttribute('aria-pressed')).toBe('true')
  expect(screen.queryByText('recorded patch B')).toBeNull()
})
