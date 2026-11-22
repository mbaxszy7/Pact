/* oxlint-disable jsx-a11y/no-noninteractive-tabindex -- The scrollable read-only diff region must accept keyboard scrolling. */
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual'
import gitDiffParser, { type Change } from 'gitdiff-parser'
import { useCallback, useLayoutEffect, useMemo, useRef } from 'react'

import { WORKSPACE_PREVIEW_BYTES } from '@pact/contracts'

type PatchRow = { kind: 'hunk'; content: string } | { kind: 'change'; change: Change }

const CODE_ROW_HEIGHT = 22
const HUNK_ROW_HEIGHT = 28

/** Ordered saved changes in one unified scroll viewport; no matching/merging or historical reconstruction. */
export function RecordedPatchViewer({
  contents,
  path,
}: {
  contents: string[]
  path: string
}): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const { rows, longestLine } = useMemo(() => {
    if (
      contents.reduce((bytes, content) => bytes + new TextEncoder().encode(content).byteLength, 0) >
      WORKSPACE_PREVIEW_BYTES
    )
      throw new Error('This patch is too large to preview.')
    const result: PatchRow[] = []
    let widest = ''
    for (const content of contents) {
      const source = content.startsWith('--- ') ? `diff --git a/file b/file\n${content}` : content
      const files = gitDiffParser.parse(source)
      if (files.length !== 1 || files[0]!.isBinary || !files[0]!.hunks.length)
        throw new Error('This patch doesn’t contain previewable text changes.')
      for (const hunk of files[0]!.hunks) {
        result.push({ kind: 'hunk', content: hunk.content })
        if (hunk.content.length > widest.length) widest = hunk.content
        for (const change of hunk.changes) {
          result.push({ kind: 'change', change })
          if (change.content.length > widest.length) widest = change.content
        }
      }
    }
    return { rows: result, longestLine: widest }
  }, [contents])

  const getScrollElement = useCallback(() => host.current, [])
  const getItemKey = useCallback(
    (index: number) => `${index}:${rows[index]?.kind ?? 'row'}`,
    [rows],
  )
  const estimateSize = useCallback(
    (index: number) => (rows[index]?.kind === 'hunk' ? HUNK_ROW_HEIGHT : CODE_ROW_HEIGHT),
    [rows],
  )
  const rangeExtractor = useCallback((range: Parameters<typeof defaultRangeExtractor>[0]) => {
    const indices = defaultRangeExtractor(range)
    const start = Math.min(range.startIndex, Math.max(0, range.endIndex - 99))
    return indices.length <= 100
      ? indices
      : indices.filter((index) => index >= start && index < start + 100)
  }, [])

  // oxlint-disable-next-line react/incompatible-library -- The viewport owner consumes this mutable instance directly, never through memoized props.
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement,
    getItemKey,
    estimateSize,
    overscan: 8,
    rangeExtractor,
  })

  const virtualRef = useRef(virtual)
  useLayoutEffect(() => {
    virtualRef.current = virtual
  })
  useLayoutEffect(() => {
    virtualRef.current.measure()
  }, [rows])

  const virtualItems = virtual.getVirtualItems()
  const totalHeight = virtual.getTotalSize()
  const topSpacer = virtualItems[0]?.start ?? 0
  const bottomSpacer =
    virtualItems.length > 0
      ? Math.max(0, totalHeight - virtualItems[virtualItems.length - 1]!.end)
      : totalHeight

  return (
    <section
      ref={host}
      className="h-full min-h-0 overflow-auto bg-surface font-mono text-code leading-[22px] text-primary select-text"
      tabIndex={0}
      aria-label={`${path} recorded diff`}
      data-pact-recorded-diff
    >
      <div
        className="w-full min-w-max py-2"
        style={{ paddingTop: topSpacer + 8, paddingBottom: bottomSpacer + 8 }}
      >
        {/* Zero-height intrinsic width anchor keeps horizontal scrollbar stable while virtualizing vertically. */}
        {longestLine ? (
          <div
            aria-hidden="true"
            className="pointer-events-none flex h-0 overflow-hidden opacity-0 select-none"
          >
            <span className="inline-block w-[7.25rem] shrink-0" />
            <span className="whitespace-pre pr-6">{longestLine}</span>
          </div>
        ) : null}
        {virtualItems.map((item) => {
          const row = rows[item.index]!
          if (row.kind === 'hunk') {
            return (
              <div
                key={item.key}
                data-index={item.index}
                className="flex h-[28px] w-full items-center border-y border-border bg-surface-muted text-secondary"
              >
                <span className="sticky left-0 z-10 inline-flex items-center bg-surface-muted px-3 whitespace-pre">
                  {row.content}
                </span>
              </div>
            )
          }
          const { change } = row
          const oldLine =
            change.type === 'insert'
              ? undefined
              : change.type === 'normal'
                ? change.oldLineNumber
                : change.lineNumber
          const newLine =
            change.type === 'delete'
              ? undefined
              : change.type === 'normal'
                ? change.newLineNumber
                : change.lineNumber
          const rowBg =
            change.type === 'insert'
              ? 'bg-diff-added'
              : change.type === 'delete'
                ? 'bg-diff-removed'
                : ''
          const gutterBg =
            change.type === 'insert'
              ? 'bg-diff-added-gutter'
              : change.type === 'delete'
                ? 'bg-diff-removed-gutter'
                : 'bg-surface'
          const signClass =
            change.type === 'insert'
              ? 'text-diff-added-foreground'
              : change.type === 'delete'
                ? 'text-diff-removed-foreground'
                : 'text-tertiary'
          return (
            <div
              key={item.key}
              data-index={item.index}
              data-pact-diff-line={change.type}
              className={`flex h-[22px] w-full items-baseline ${rowBg}`}
            >
              <span
                className={`sticky left-0 z-10 inline-flex shrink-0 items-baseline select-none ${gutterBg}`}
              >
                <span
                  className="inline-block w-12 pr-2 text-right tabular-nums text-tertiary"
                  aria-hidden="true"
                >
                  {oldLine}
                </span>
                <span
                  className="inline-block w-12 pr-2 text-right tabular-nums text-tertiary"
                  aria-hidden="true"
                >
                  {newLine}
                </span>
                <span
                  className={`inline-block w-5 text-center ${signClass}`}
                  aria-label={
                    change.type === 'insert'
                      ? 'Added'
                      : change.type === 'delete'
                        ? 'Removed'
                        : 'Unchanged'
                  }
                >
                  {change.type === 'insert' ? '+' : change.type === 'delete' ? '−' : ' '}
                </span>
              </span>
              <code className="whitespace-pre pl-1.5 pr-6 font-mono">{change.content || ' '}</code>
            </div>
          )
        })}
      </div>
    </section>
  )
}
