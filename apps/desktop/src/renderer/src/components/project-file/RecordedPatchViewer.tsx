/* oxlint-disable jsx-a11y/no-noninteractive-tabindex -- The scrollable read-only diff region must accept keyboard scrolling. */
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual'
import gitDiffParser, { type Change } from 'gitdiff-parser'
import { useMemo, useRef } from 'react'

import { WORKSPACE_PREVIEW_BYTES } from '@pact/contracts'

type PatchRow = { kind: 'hunk'; content: string } | { kind: 'change'; change: Change }

/** Ordered saved changes in one viewport; no matching/merging or historical reconstruction. */
export function RecordedPatchViewer({
  contents,
  path,
}: {
  contents: string[]
  path: string
}): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const rows = useMemo(() => {
    if (
      contents.reduce((bytes, content) => bytes + new TextEncoder().encode(content).byteLength, 0) >
      WORKSPACE_PREVIEW_BYTES
    )
      throw new Error('Recorded patch exceeds its preview limit.')
    const result: PatchRow[] = []
    for (const content of contents) {
      const source = content.startsWith('--- ') ? `diff --git a/file b/file\n${content}` : content
      const files = gitDiffParser.parse(source)
      if (files.length !== 1 || files[0]!.isBinary || !files[0]!.hunks.length)
        throw new Error('This recorded patch has no supported text changes.')
      for (const hunk of files[0]!.hunks) {
        result.push({ kind: 'hunk', content: hunk.content })
        for (const change of hunk.changes) result.push({ kind: 'change', change })
      }
    }
    return result
  }, [contents])
  // oxlint-disable-next-line react/incompatible-library -- The viewport owner consumes this mutable instance directly, never through memoized props.
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => host.current,
    estimateSize: () => 22,
    overscan: 8,
    rangeExtractor: (range) => {
      const indices = defaultRangeExtractor(range)
      const start = Math.min(range.startIndex, Math.max(0, range.endIndex - 99))
      return indices.length <= 100
        ? indices
        : indices.filter((index) => index >= start && index < start + 100)
    },
  })
  return (
    <section
      ref={host}
      className="h-full min-h-0 overflow-auto bg-surface font-mono text-code leading-[22px] text-primary"
      tabIndex={0}
      aria-label={`${path} recorded diff`}
      data-pact-recorded-diff
    >
      <div className="relative w-full" style={{ height: virtual.getTotalSize() }}>
        {virtual.getVirtualItems().map((item) => {
          const row = rows[item.index]!
          if (row.kind === 'hunk')
            return (
              <div
                key={item.key}
                ref={virtual.measureElement}
                data-index={item.index}
                className="absolute left-0 top-0 w-full border-y border-border bg-surface-muted px-3 py-1 text-secondary"
                style={{ transform: `translateY(${item.start}px)` }}
              >
                {row.content}
              </div>
            )
          const change = row.change,
            oldLine =
              change.type === 'insert'
                ? undefined
                : change.type === 'normal'
                  ? change.oldLineNumber
                  : change.lineNumber,
            newLine =
              change.type === 'delete'
                ? undefined
                : change.type === 'normal'
                  ? change.newLineNumber
                  : change.lineNumber
          return (
            <div
              key={item.key}
              ref={virtual.measureElement}
              data-index={item.index}
              data-pact-diff-line={change.type}
              className={`absolute left-0 top-0 grid w-full grid-cols-[3rem_3rem_1.25rem_minmax(0,1fr)] ${change.type === 'insert' ? 'bg-diff-added' : change.type === 'delete' ? 'bg-diff-removed' : ''}`}
              style={{ transform: `translateY(${item.start}px)` }}
            >
              <span
                className="select-none pr-2 text-right tabular-nums text-secondary"
                aria-hidden="true"
              >
                {oldLine}
              </span>
              <span
                className="select-none pr-2 text-right tabular-nums text-secondary"
                aria-hidden="true"
              >
                {newLine}
              </span>
              <span
                className={`select-none text-center ${change.type === 'insert' ? 'text-diff-added-foreground' : change.type === 'delete' ? 'text-diff-removed-foreground' : 'text-secondary'}`}
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
              <code className="min-w-0 whitespace-pre-wrap break-all pr-3 font-mono">
                {change.content || ' '}
              </code>
            </div>
          )
        })}
      </div>
    </section>
  )
}
