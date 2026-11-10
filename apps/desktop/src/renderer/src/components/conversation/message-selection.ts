import type { MessageCommentAnchor } from '@pact/contracts'

import { MAX_COMMENT_QUOTE_LENGTH } from '@pact/contracts'

/** A selection in a plan uses that immutable Run/version instead of the answer body. */
export function planSelectionSource(host: HTMLElement): MessageCommentAnchor['plan'] {
  const source = host.closest<HTMLElement>('[data-pact-plan-run-id]')
  const runId = source?.dataset.pactPlanRunId
  const version = Number(source?.dataset.pactPlanVersion)
  return runId && Number.isInteger(version) && version > 0 ? { runId, version } : undefined
}

export function reportSelectionSource(host: HTMLElement): MessageCommentAnchor['report'] {
  const source = host.closest<HTMLElement>('[data-pact-report-run-id]')
  const runId = source?.dataset.pactReportRunId
  const key = source?.dataset.pactReportKey
  if (!runId || !key) return undefined
  return key === 'summary' ? { runId, target: { type: 'summary' } } : undefined
}

export function reportSourceSelector(report: NonNullable<MessageCommentAnchor['report']>): string {
  return `[data-pact-report-run-id="${report.runId}"][data-pact-report-key="summary"]`
}

let ownedHighlight: Range | undefined
let highlightOwner: object | undefined
let pulseOwner: HTMLElement | undefined
let pulseTimer: number | undefined

export function isProjectionHighlightOwned(): boolean {
  const selection = window.getSelection()
  return Boolean(
    selection &&
    ownedHighlight &&
    selection.rangeCount === 1 &&
    selection.getRangeAt(0) === ownedHighlight,
  )
}

export function selectedTextRange(
  container: HTMLElement,
  selection: Selection,
  maxLength = MAX_COMMENT_QUOTE_LENGTH,
): { startOffset: number; endOffset: number; quote: string } | undefined {
  if (selection.rangeCount !== 1 || selection.isCollapsed) return undefined
  const range = selection.getRangeAt(0)
  if (!container.contains(range.commonAncestorContainer)) return undefined
  const start = projectionBoundaryOffset(
    container,
    range.startContainer,
    range.startOffset,
    'start',
  )
  const end = projectionBoundaryOffset(container, range.endContainer, range.endOffset, 'end')
  if (start === undefined || end === undefined || end <= start || end - start > maxLength)
    return undefined
  const quote = projectionText(container, start, end)
  if (!quote) return undefined
  return { startOffset: start, endOffset: end, quote }
}

export function focusProjectionRange(
  container: HTMLElement,
  startOffset: number,
  endOffset: number,
  options: { scroll?: boolean; highlight?: boolean } = {},
): boolean {
  const planSource = container.closest('[data-pact-plan-run-id]')
  const spans = [...container.querySelectorAll<HTMLElement>('[data-pact-projection-start]')].filter(
    (span) => span.closest('[data-pact-plan-run-id]') === planSource,
  )
  const selected = spans.filter((span) => {
    const start = Number(span.dataset.pactProjectionStart)
    const end = Number(span.dataset.pactProjectionEnd)
    return start < endOffset && end > startOffset
  })
  const first = selected[0]
  const last = selected.at(-1)
  let covered = startOffset
  for (const span of selected) {
    const spanStart = Number(span.dataset.pactProjectionStart)
    const spanEnd = Number(span.dataset.pactProjectionEnd)
    if (spanStart > covered || spanEnd <= covered) return false
    covered = spanEnd
  }
  if (covered < endOffset) return false
  const firstText = first?.firstChild
  const lastText = last?.firstChild
  if (first && last && firstText instanceof Text && lastText instanceof Text) {
    const firstStart = Number(first.dataset.pactProjectionStart)
    const lastStart = Number(last.dataset.pactProjectionStart)
    const range = document.createRange()
    range.setStart(firstText, Math.max(0, startOffset - firstStart))
    range.setEnd(lastText, Math.min(lastText.length, endOffset - lastStart))
    setProjectionSelection(range, options.highlight !== false)
    if (options.highlight !== false) pulseCommentTarget(container)
    if (options.scroll !== false) scrollRangeIntoView(container, range)
    return true
  }
  return false
}

export function clearProjectionHighlight(owner?: object): void {
  if (owner && owner !== highlightOwner) return
  if (isProjectionHighlightOwned()) window.getSelection()?.removeAllRanges()
  ownedHighlight = undefined
  highlightOwner = undefined
  clearCommentPulse()
}

/** Paint only the mounted part of an already tracked logical range; this is not range verification. */
export function drawMountedProjectionIntersection(
  container: HTMLElement,
  start: number,
  end: number,
  owner: object,
  source = false,
): void {
  const spans = [
    ...container.querySelectorAll<HTMLElement>(
      source
        ? '[data-pact-projection-start], [data-pact-source-start]'
        : '[data-pact-projection-start]',
    ),
  ].filter((span) => {
    const from = Number(span.dataset.pactProjectionStart ?? span.dataset.pactSourceStart)
    const to = Number(span.dataset.pactProjectionEnd ?? span.dataset.pactSourceEnd)
    return from < end && to > start
  })
  const first = spans[0]
  const last = spans.at(-1)
  if (!(first?.firstChild instanceof Text) || !(last?.firstChild instanceof Text)) {
    clearProjectionHighlight(owner)
    return
  }
  const range = document.createRange()
  const from = first.dataset.pactProjectionStart
  const to = last.dataset.pactProjectionStart
  range.setStart(first.firstChild, from === undefined ? 0 : Math.max(0, start - Number(from)))
  range.setEnd(
    last.firstChild,
    to === undefined ? last.firstChild.length : Math.min(last.firstChild.length, end - Number(to)),
  )
  setProjectionSelection(range, true)
  highlightOwner = owner
}

function pulseCommentTarget(container: HTMLElement): void {
  clearCommentPulse()
  pulseOwner = container
  container.setAttribute('data-pact-comment-pulse', 'true')
  pulseTimer = window.setTimeout(() => clearCommentPulse(), 2_300)
}

function clearCommentPulse(): void {
  if (pulseTimer !== undefined) window.clearTimeout(pulseTimer)
  pulseOwner?.removeAttribute('data-pact-comment-pulse')
  pulseTimer = undefined
  pulseOwner = undefined
}

export function projectionBoundaryOffset(
  container: HTMLElement,
  node: Node,
  offset: number,
  edge: 'start' | 'end',
): number | undefined {
  const text = node instanceof Text ? node : undefined
  const span = text?.parentElement?.closest<HTMLElement>('[data-pact-projection-start]')
  if (span && container.contains(span) && text) {
    const start = Number(span.dataset.pactProjectionStart)
    if (!Number.isInteger(start)) return undefined
    return start + offset
  }
  const step = edge === 'start' ? 1 : -1
  for (
    let index = edge === 'start' ? offset : offset - 1;
    index >= 0 && index < node.childNodes.length;
    index += step
  ) {
    const child = node.childNodes[index]!
    const boundary = edge === 'start' ? firstProjectionSpan(child) : lastProjectionSpan(child)
    if (boundary) {
      const value = Number(
        edge === 'start'
          ? boundary.dataset.pactProjectionStart
          : boundary.dataset.pactProjectionEnd,
      )
      return Number.isInteger(value) ? value : undefined
    }
    // Textless icons do not consume a durable text offset. Do not skip unprojected text.
    if (child.textContent) return undefined
  }
  return undefined
}

function firstProjectionSpan(node: Node): HTMLElement | undefined {
  if (node instanceof HTMLElement && node.dataset.pactProjectionStart !== undefined) return node
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT)
  for (let current = walker.nextNode(); current; current = walker.nextNode()) {
    if (current instanceof HTMLElement && current.dataset.pactProjectionStart !== undefined) {
      return current
    }
  }
  return undefined
}

function lastProjectionSpan(node: Node): HTMLElement | undefined {
  if (node instanceof HTMLElement && node.dataset.pactProjectionEnd !== undefined) return node
  const spans: HTMLElement[] = []
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT)
  for (let current = walker.nextNode(); current; current = walker.nextNode()) {
    if (current instanceof HTMLElement && current.dataset.pactProjectionEnd !== undefined) {
      spans.push(current)
    }
  }
  return spans.at(-1)
}

function projectionText(
  container: HTMLElement,
  startOffset: number,
  endOffset: number,
): string | undefined {
  const spans = [...container.querySelectorAll<HTMLElement>('[data-pact-projection-start]')]
  let projection = ''
  let position = startOffset
  for (const span of spans) {
    const start = Number(span.dataset.pactProjectionStart)
    const end = Number(span.dataset.pactProjectionEnd)
    if (!Number.isInteger(start) || !Number.isInteger(end)) return undefined
    const text = span.textContent ?? ''
    if (start + text.length !== end) return undefined
    if (end <= position) continue
    if (start > position) return undefined
    const next = Math.min(end, endOffset)
    projection += text.slice(position - start, next - start)
    position = next
    if (position === endOffset) return projection
  }
  return undefined
}

function setProjectionSelection(range: Range, owned: boolean): void {
  clearProjectionHighlight()
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
  ownedHighlight = owned && selection?.rangeCount === 1 ? selection.getRangeAt(0) : undefined
}

function scrollRangeIntoView(container: HTMLElement, range: Range): void {
  const scroller = container.closest<HTMLElement>('[data-pact-transcript]')
  const rangeRect = range.getBoundingClientRect()
  if (!scroller || rangeRect.height === 0) {
    range.startContainer.parentElement?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    return
  }
  const scrollerRect = scroller.getBoundingClientRect()
  scroller.scrollTo({
    top:
      scroller.scrollTop +
      rangeRect.top -
      scrollerRect.top -
      scroller.clientHeight / 2 +
      rangeRect.height / 2,
    behavior: 'smooth',
  })
}
