import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useLayoutEffect, useMemo, useRef, useState } from 'react'

import type { ProjectFile } from '@pact/contracts'

import { resolveFileLocation, type FileLocation } from './file-location'

const LINE_HEIGHT = 24
export const NATIVE_PLAIN_LINE_LIMIT = 100

export function PlainFileViewer({
  file,
  location,
  wrapLines,
}: {
  file: ProjectFile
  location?: FileLocation | undefined
  wrapLines: boolean
}): React.JSX.Element {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const gutterRef = useRef<HTMLDivElement>(null)
  const source = useMemo(() => {
    const content = file.content.replace(/\r\n?/gu, '\n')
    const lineStarts = [0]
    for (let index = 0; index < content.length; index += 1) {
      if (content.charCodeAt(index) === 10) lineStarts.push(index + 1)
    }
    return { content, lineStarts }
  }, [file.content])
  const [pageStartLine, setPageStartLine] = useState(() => {
    const line = Math.min(Math.max(location?.lineStart ?? 1, 1), source.lineStarts.length)
    return Math.floor((line - 1) / NATIVE_PLAIN_LINE_LIMIT) * NATIVE_PLAIN_LINE_LIMIT + 1
  })
  const page = useMemo(() => {
    const endLine = Math.min(pageStartLine + NATIVE_PLAIN_LINE_LIMIT - 1, source.lineStarts.length)
    const startOffset = source.lineStarts[pageStartLine - 1] ?? 0
    const nextStart = source.lineStarts[endLine]
    const endOffset = nextStart === undefined ? source.content.length : nextStart - 1
    return {
      startLine: pageStartLine,
      endLine,
      startOffset,
      content: source.content.slice(startOffset, endOffset),
    }
  }, [pageStartLine, source])

  useLayoutEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.setSelectionRange(0, 0)
    textarea.scrollTop = 0
    textarea.scrollLeft = 0
    if (gutterRef.current) gutterRef.current.scrollTop = 0
    const maxColumn = (lineNumber: number): number => {
      const start = source.lineStarts[lineNumber - 1] ?? 0
      const next = source.lineStarts[lineNumber]
      return (next === undefined ? source.content.length : next - 1) - start + 1
    }
    const resolved = resolveFileLocation(location, source.lineStarts.length, maxColumn)
    if (!resolved || resolved.lineEnd < page.startLine || resolved.lineStart > page.endLine) return
    const firstLine = Math.max(resolved.lineStart, page.startLine)
    const lastLine = Math.min(resolved.lineEnd, page.endLine)
    const firstColumn = firstLine === resolved.lineStart ? resolved.startColumn : 1
    const lastColumn = lastLine === resolved.lineEnd ? resolved.endColumn : maxColumn(lastLine)
    const start = (source.lineStarts[firstLine - 1] ?? 0) + firstColumn - 1 - page.startOffset
    const end = Math.min(
      (source.lineStarts[lastLine - 1] ?? 0) + lastColumn - 1 - page.startOffset,
      page.content.length,
    )
    // Chromium reveals a collapsed caret but not a pre-existing range on focus. Stage the
    // source position first, then restore the linked selection without losing horizontal scroll.
    textarea.setSelectionRange(start, start)
    textarea.focus({ preventScroll: true })
    textarea.setSelectionRange(start, end, 'backward')
    if (textarea.wrap === 'off') {
      textarea.scrollTop = Math.max(
        0,
        (firstLine - page.startLine) * LINE_HEIGHT - (textarea.clientHeight - LINE_HEIGHT) / 2,
      )
      if (gutterRef.current) gutterRef.current.scrollTop = textarea.scrollTop
    }
  }, [location, page, source])

  const gutterDigits = String(source.lineStarts.length).length
  useLayoutEffect(() => {
    if (!wrapLines && gutterRef.current && textareaRef.current) {
      gutterRef.current.scrollTop = textareaRef.current.scrollTop
    }
  }, [wrapLines])

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden bg-surface" data-pact-surface>
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {!wrapLines ? (
          <div
            ref={gutterRef}
            className="shrink-0 overflow-hidden border-r border-border bg-surface font-mono text-code leading-6 text-tertiary"
            aria-hidden="true"
            style={{ width: `max(3.25rem, calc(${gutterDigits}ch + 1rem))` }}
          >
            <div
              className="relative"
              style={{ height: (page.endLine - page.startLine + 1) * LINE_HEIGHT }}
            >
              {Array.from({ length: page.endLine - page.startLine + 1 }, (_, index) => (
                <span
                  key={page.startLine + index}
                  className="absolute left-0 w-full select-none px-2 text-right"
                  style={{ top: index * LINE_HEIGHT }}
                  data-pact-plain-line={page.startLine + index}
                >
                  {page.startLine + index}
                </span>
              ))}
            </div>
          </div>
        ) : null}
        <textarea
          ref={textareaRef}
          className="min-h-0 min-w-0 flex-1 resize-none overflow-auto border-0 bg-surface p-0 font-mono text-code leading-6 text-primary outline-none focus-visible:outline-2 focus-visible:outline-focus"
          aria-label={`${file.relativePath} source`}
          readOnly
          spellCheck={false}
          wrap={wrapLines ? 'soft' : 'off'}
          style={{ tabSize: 4 }}
          value={page.content}
          onScroll={(event) => {
            if (gutterRef.current) gutterRef.current.scrollTop = event.currentTarget.scrollTop
          }}
        />
      </div>
      {source.lineStarts.length > NATIVE_PLAIN_LINE_LIMIT ? (
        <nav
          className="flex shrink-0 items-center gap-2 border-t border-border px-3 py-1.5 text-caption text-secondary"
          aria-label="File pages"
        >
          <button
            className="grid size-7 place-items-center rounded-control hover:bg-surface-muted disabled:opacity-40"
            type="button"
            aria-label="Previous 100 lines"
            disabled={page.startLine === 1}
            onClick={() =>
              setPageStartLine((current) => Math.max(1, current - NATIVE_PLAIN_LINE_LIMIT))
            }
          >
            <ChevronLeft aria-hidden="true" className="size-4" strokeWidth={1.75} />
          </button>
          <output className="min-w-0 flex-1 truncate text-center" aria-live="polite">
            Lines {page.startLine}–{page.endLine} of {source.lineStarts.length}
          </output>
          <button
            className="grid size-7 place-items-center rounded-control hover:bg-surface-muted disabled:opacity-40"
            type="button"
            aria-label="Next 100 lines"
            disabled={page.endLine >= source.lineStarts.length}
            onClick={() => setPageStartLine((current) => current + NATIVE_PLAIN_LINE_LIMIT)}
          >
            <ChevronRight aria-hidden="true" className="size-4" strokeWidth={1.75} />
          </button>
        </nav>
      ) : null}
    </section>
  )
}
