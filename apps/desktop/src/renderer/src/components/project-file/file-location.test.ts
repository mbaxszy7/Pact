import { describe, expect, it } from 'vitest'

import { resolveFileLocation } from './file-location'

const maxColumn = (line: number): number => (line === 1 ? 6 : 3)

describe('file location Interface', () => {
  it('keeps a linked line range and UTF-16 column positions for either viewer', () => {
    expect(
      resolveFileLocation({ lineStart: 1, lineEnd: 2, startColumn: 2, endColumn: 3 }, 2, maxColumn),
    ).toEqual({ lineStart: 1, lineEnd: 2, startColumn: 2, endColumn: 3 })
  })

  it('clamps stale positions instead of asking a viewer to reveal a nonexistent line', () => {
    expect(
      resolveFileLocation(
        { lineStart: 2, lineEnd: 9, startColumn: 99, endColumn: 99 },
        2,
        maxColumn,
      ),
    ).toEqual({ lineStart: 2, lineEnd: 2, startColumn: 3, endColumn: 3 })
    expect(resolveFileLocation({ lineStart: 1 }, 0, maxColumn)).toBeUndefined()
  })
})
