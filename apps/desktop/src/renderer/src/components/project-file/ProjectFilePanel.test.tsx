// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ProjectFile } from '@pact/contracts'

import { ProjectFilePanel } from './ProjectFilePanel'

vi.mock('./ProjectCodeViewer', () => ({
  ProjectCodeViewer: () => {
    throw new Error('Code view unavailable in this fixture.')
  },
}))

afterEach(cleanup)

describe('Project File Panel', () => {
  it('keeps a small plain file selectable and offers wrapping without a navigation toolbar', () => {
    const file = projectFile(
      'notes.unknown',
      'First paragraph is long enough to wrap.\nSecond line.',
    )
    const { container } = renderPanel(file)
    const source = screen.getByRole('textbox', { name: 'notes.unknown source' })
    if (!(source instanceof HTMLTextAreaElement)) throw new Error('Plain source is not a textarea.')

    expect(source.value).toBe(file.content)
    expect(container.querySelectorAll('[data-pact-plain-line]')).toHaveLength(2)
    expect(screen.queryByRole('navigation', { name: 'File pages' })).toBeNull()
    expect(screen.queryByRole('form', { name: 'Go to file location' })).toBeNull()

    source.setSelectionRange(0, 5)
    fireEvent.click(screen.getByRole('button', { name: 'Wrap lines and hide line numbers' }))
    expect(source.wrap).toBe('soft')
    expect(container.querySelectorAll('[data-pact-plain-line]')).toHaveLength(0)
    expect(source.value.slice(source.selectionStart, source.selectionEnd)).toBe('First')

    fireEvent.click(screen.getByRole('button', { name: 'Show line numbers and stop wrapping' }))
    expect(source.wrap).toBe('off')
    expect(container.querySelectorAll('[data-pact-plain-line]')).toHaveLength(2)
  })

  it('paginates a large file after Monaco fails and preserves a cross-page linked range', async () => {
    const content = Array.from({ length: 250 }, (_, index) => `line ${index + 1}`).join('\n')
    const file = projectFile('source.unknown', content, { lineStart: 95, lineEnd: 105 })
    const { container } = renderPanel(file)
    const pages = await screen.findByRole('navigation', { name: 'File pages' })
    const source = screen.getByRole('textbox', { name: 'source.unknown source' })
    if (!(source instanceof HTMLTextAreaElement)) throw new Error('Fallback is not a textarea.')

    expect(pages.textContent).toContain('Lines 1–100 of 250')
    expect(container.querySelectorAll('[data-pact-plain-line]')).toHaveLength(0)
    expect(source.value).toContain('line 100')
    expect(source.value).not.toContain('line 101')
    expect(source.value.slice(source.selectionStart, source.selectionEnd)).toContain('line 95')

    fireEvent.click(screen.getByRole('button', { name: 'Next 100 lines' }))
    expect(pages.textContent).toContain('Lines 101–200 of 250')
    expect(source.value.startsWith('line 101')).toBe(true)
    expect(source.value.slice(source.selectionStart, source.selectionEnd)).toContain('line 105')
    expect(container.querySelectorAll('[data-pact-plain-line]')).toHaveLength(0)

    fireEvent.click(screen.getByRole('button', { name: 'Next 100 lines' }))
    expect(pages.textContent).toContain('Lines 201–250 of 250')
    expect(source.value.startsWith('line 201')).toBe(true)
    expect(source.value.includes('line 250')).toBe(true)
  })
})

function projectFile(
  relativePath: string,
  content: string,
  range?: { lineStart: number; lineEnd: number },
): ProjectFile {
  return {
    sessionId: '00000000-0000-4000-8000-000000000001',
    relativePath,
    absolutePath: `/project/${relativePath}`,
    content,
    contentHash: 'a'.repeat(64),
    lineCount: content.split('\n').length,
    lineStart: range?.lineStart,
    lineEnd: range?.lineEnd,
    updatedAt: '2026-09-24T00:00:00.000Z',
  }
}

function renderPanel(file: ProjectFile): ReturnType<typeof render> {
  return render(
    <ProjectFilePanel
      state={{
        target: {
          path: file.relativePath,
          ...(file.lineStart === undefined ? {} : { lineStart: file.lineStart }),
          ...(file.lineEnd === undefined ? {} : { lineEnd: file.lineEnd }),
        },
        file,
        loading: false,
      }}
      expanded={false}
      onClose={() => undefined}
      onExpandedChange={() => undefined}
      onRetry={() => undefined}
      onCreateComment={async () => true}
    />,
  )
}
