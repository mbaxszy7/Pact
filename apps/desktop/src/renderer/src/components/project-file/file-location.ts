export interface FileLocation {
  lineStart: number
  lineEnd?: number | undefined
  startColumn?: number | undefined
  endColumn?: number | undefined
}

export interface ResolvedFileLocation {
  lineStart: number
  lineEnd: number
  startColumn: number
  endColumn: number
}

export function resolveFileLocation(
  location: FileLocation | undefined,
  lineCount: number,
  maxColumn: (lineNumber: number) => number,
): ResolvedFileLocation | undefined {
  if (!location || lineCount < 1) return undefined
  const lineStart = Math.min(Math.max(Math.trunc(location.lineStart), 1), lineCount)
  const lineEnd = Math.min(
    Math.max(Math.trunc(location.lineEnd ?? lineStart), lineStart),
    lineCount,
  )
  const startColumn = Math.min(
    Math.max(Math.trunc(location.startColumn ?? 1), 1),
    maxColumn(lineStart),
  )
  const endColumn = Math.min(
    Math.max(Math.trunc(location.endColumn ?? maxColumn(lineEnd)), 1),
    maxColumn(lineEnd),
  )
  return {
    lineStart,
    lineEnd,
    startColumn,
    endColumn: lineEnd === lineStart ? Math.max(endColumn, startColumn) : endColumn,
  }
}
