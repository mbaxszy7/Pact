// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { DesktopBridge, ProjectContext } from '@pact/contracts'

import { ProjectContextMenu } from './ProjectContextMenu'

const hide = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'hidePopover')
beforeEach(() =>
  Object.defineProperty(HTMLElement.prototype, 'hidePopover', {
    configurable: true,
    value: vi.fn<() => void>(),
  }),
)
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  if (hide) Object.defineProperty(HTMLElement.prototype, 'hidePopover', hide)
  else Reflect.deleteProperty(HTMLElement.prototype, 'hidePopover')
})

function fixture() {
  const projectId = crypto.randomUUID()
  const context: ProjectContext = {
    projectId,
    directoryPath: '/workspace/real-folder',
    folderName: 'real-folder',
    git: { state: 'branch', name: 'old-branch' },
  }
  const read = vi
    .fn<DesktopBridge['readProjectContext']>()
    .mockResolvedValue({ ok: true, value: context })
  vi.stubGlobal('pact', { readProjectContext: read })
  const props = {
    projectId,
    visible: true,
    refreshKey: 'initial',
    onNotice: vi.fn<(message: string) => void>(),
  }
  return { context, read, props }
}

it('retains a newer focus refresh behind an in-flight read without publishing the old branch', async () => {
  const f = fixture()
  const old = Promise.withResolvers<Awaited<ReturnType<DesktopBridge['readProjectContext']>>>()
  const fresh = Promise.withResolvers<Awaited<ReturnType<DesktopBridge['readProjectContext']>>>()
  f.read.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise)
  render(<ProjectContextMenu {...f.props} />)
  await waitFor(() => expect(f.read).toHaveBeenCalledOnce())
  act(() => {
    window.dispatchEvent(new Event('focus'))
    window.dispatchEvent(new Event('focus'))
  })
  expect(f.read).toHaveBeenCalledOnce()
  await act(async () => {
    old.resolve({ ok: true, value: f.context })
  })
  await waitFor(() => expect(f.read).toHaveBeenCalledTimes(2))
  expect(screen.queryByRole('button', { name: 'Git branch: old-branch' })).toBeNull()
  await act(async () => {
    fresh.resolve({
      ok: true,
      value: { ...f.context, git: { state: 'branch', name: 'new-branch' } },
    })
  })
  expect(screen.getByRole('button', { name: 'Git branch: new-branch' })).not.toBeNull()
})

it('discards a hidden read and reads current facts once on return', async () => {
  const f = fixture()
  const pending = Promise.withResolvers<Awaited<ReturnType<DesktopBridge['readProjectContext']>>>()
  f.read.mockReturnValueOnce(pending.promise)
  const view = render(<ProjectContextMenu {...f.props} />)
  await waitFor(() => expect(f.read).toHaveBeenCalledOnce())
  view.rerender(<ProjectContextMenu {...f.props} visible={false} />)
  act(() => {
    window.dispatchEvent(new Event('focus'))
  })
  await act(async () => pending.resolve({ ok: true, value: f.context }))
  expect(f.read).toHaveBeenCalledOnce()
  expect(screen.queryByRole('button', { name: 'Git branch: old-branch' })).toBeNull()
  view.rerender(<ProjectContextMenu {...f.props} />)
  await waitFor(() => expect(f.read).toHaveBeenCalledTimes(2))
  expect(screen.getByRole('button', { name: 'Git branch: old-branch' })).not.toBeNull()
})

it('retains a Run completion refresh while reading and does not retry an unchanged failure', async () => {
  const f = fixture()
  const pending = Promise.withResolvers<Awaited<ReturnType<DesktopBridge['readProjectContext']>>>()
  f.read.mockReturnValueOnce(pending.promise).mockRejectedValueOnce(new Error('Unavailable'))
  const view = render(<ProjectContextMenu {...f.props} />)
  await waitFor(() => expect(f.read).toHaveBeenCalledOnce())
  view.rerender(<ProjectContextMenu {...f.props} refreshKey="run:completed" />)
  await act(async () => pending.resolve({ ok: true, value: f.context }))
  await waitFor(() => expect(f.read).toHaveBeenCalledTimes(2))
  expect(screen.getByRole('button', { name: 'Git branch: Branch unavailable' })).not.toBeNull()
  expect(screen.queryByRole('button', { name: 'Git branch: old-branch' })).toBeNull()
  await act(async () => Promise.resolve())
  expect(f.read).toHaveBeenCalledTimes(2)
})

it('fences the previous keyed Project after a Session switch', async () => {
  const f = fixture()
  const pending = Promise.withResolvers<Awaited<ReturnType<DesktopBridge['readProjectContext']>>>()
  const next = { ...f.context, projectId: crypto.randomUUID(), folderName: 'next-folder' }
  f.read.mockReturnValueOnce(pending.promise).mockResolvedValue({ ok: true, value: next })
  const view = render(<ProjectContextMenu key={f.props.projectId} {...f.props} />)
  await waitFor(() => expect(f.read).toHaveBeenCalledOnce())
  view.rerender(<ProjectContextMenu {...f.props} key={next.projectId} projectId={next.projectId} />)
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Project folder: next-folder' })).not.toBeNull(),
  )
  await act(async () => pending.resolve({ ok: true, value: f.context }))
  expect(screen.getByRole('button', { name: 'Project folder: next-folder' })).not.toBeNull()
  expect(screen.queryByRole('button', { name: 'Project folder: real-folder' })).toBeNull()
})
