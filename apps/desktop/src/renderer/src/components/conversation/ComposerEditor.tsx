/* oxlint-disable jsx-a11y/prefer-tag-over-role -- A rich editable combobox needs native DOM atoms, which input/select cannot contain. */
import { BookOpen } from 'lucide-react'
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type Ref,
} from 'react'
import { createPortal } from 'react-dom'

import { skillSelectionsSchema, type SkillSelection } from '@pact/contracts'

import {
  assertComposerEditCapacity,
  assertComposerEditLengths,
  assertComposerInverseCapacity,
  assertComposerReplacementCapacity,
  COMPOSER_HISTORY_BYTES,
} from './composer-capacity'
import { composerClipboardDigest } from './composer-clipboard-digest'
import {
  composerDifference,
  composerListCommand,
  formatComposerLists,
  indexComposerLists,
  replaceComposerDocument,
  sameComposerDocument,
  wholeComposerAtoms,
  type ComposerDocument,
  type ComposerRange,
  type ComposerReplacement,
  type ComposerListIndex,
} from './composer-document'

export interface ComposerEditorHandle {
  focus(): void
  selection(): ComposerRange
  select(start: number, end?: number): void
  document(): ComposerDocument
  refuseEdit(message: string): void
  apply(
    value: ComposerDocument,
    selection: ComposerRange,
    replacements?: ComposerReplacement[],
  ): void
}
interface HistoryEntry {
  start: number
  deleted: string
  inserted: string
  beforeSkills?: SkillSelection[]
  afterSkills?: SkillSelection[]
  beforeMention: ComposerDocument['mention']
  afterMention: ComposerDocument['mention']
  beforeRoute: ComposerDocument['route']
  afterRoute: ComposerDocument['route']
  beforeRange: ComposerRange
  afterRange: ComposerRange
  bytes: number
}
interface Atom {
  host: HTMLSpanElement
  skill: SkillSelection
  key: string
}
class ComposerAdmissionRefused extends Error {}
const encoder = new TextEncoder()
const HISTORY_ITEMS = 100
const CLIPBOARD_TYPE = 'application/x-pact-composer-skills-v1'
const CLIPBOARD_V2_TYPE = 'application/x-pact-composer-skills-v2'
const CLIPBOARD_METADATA_BYTES = 64 * 1024

/** The DOM is an editing projection. Canonical drafts and atom identities remain typed facts. */
export function ComposerEditor({
  value,
  disabled,
  placeholder,
  onChange,
  admitEdit,
  onCursor,
  onKeyDown,
  onSkillOpen,
  onImages,
  onNotice,
  editorRef,
  controls,
  activeDescendant,
  describedBy,
  expanded,
}: {
  value: ComposerDocument
  disabled: boolean
  placeholder: string
  onChange: (value: ComposerDocument, cursor: number, composing: boolean) => boolean | void
  admitEdit?: ((nextChars: number) => boolean) | undefined
  onCursor: (cursor: number) => void
  onKeyDown: (event: KeyboardEvent) => void
  onImages?: ((files: readonly File[]) => void) | undefined
  onSkillOpen: (skill: SkillSelection) => void
  onNotice: (message: string) => void
  editorRef: Ref<ComposerEditorHandle>
  controls?: string | undefined
  activeDescendant?: string | undefined
  describedBy?: string | undefined
  expanded: boolean
}): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const model = useRef(value)
  const callbacks = useRef({
    onChange,
    admitEdit,
    onCursor,
    onKeyDown,
    onSkillOpen,
    onImages,
    onNotice,
    disabled,
  })
  const ownedAtoms = useRef(new Map<Node, SkillSelection>())
  const ownedMarkers = useRef(new Map<Node, string>())
  const ownedRows = useRef(new Map<Node, boolean>())
  const ownedTailBreak = useRef<HTMLBRElement | undefined>(undefined)
  const listIndex = useRef<ComposerListIndex | undefined>(undefined)
  const capacityNotice = useRef(false)
  const editFailureNotified = useRef(false)
  const pendingFormatting = useRef(false)
  const notifyEditingFailure = useCallback((message: string): void => {
    if (editFailureNotified.current) return
    editFailureNotified.current = true
    callbacks.current.onNotice(message)
  }, [])
  const [atoms, setAtoms] = useState<Atom[]>([])
  const atomNodes = useRef<Atom[]>([])
  const beforeRange = useRef<ComposerRange | undefined>(undefined)
  const composing = useRef(false)
  const compositionBefore = useRef<
    { document: ComposerDocument; range: ComposerRange } | undefined
  >(undefined)
  const lastRange = useRef<ComposerRange>({ start: value.text.length, end: value.text.length })
  const reportedCursor = useRef(value.text.length)
  const history = useRef<HistoryEntry[]>([])
  const historyIndex = useRef(0)
  const published = useRef<ComposerDocument | undefined>(undefined)
  const selectAfterCommit = useRef<ComposerRange | undefined>(undefined)
  const [historyRevision, setHistoryRevision] = useState(0)
  const [ownerId] = useState(() => crypto.randomUUID())
  const lastEditingState = useRef('')
  const publishEditingState = useCallback((): void => {
    const state = {
      ownerId,
      focused: Boolean(hostRef.current?.contains(document.activeElement)),
      editable: !callbacks.current.disabled,
      composing: composing.current,
      canUndo: historyIndex.current > 0,
      canRedo: historyIndex.current < history.current.length,
    }
    const key = JSON.stringify(state)
    if (lastEditingState.current === key) return
    lastEditingState.current = key
    void window.pact.setComposerEditingState(state).catch(() => undefined)
  }, [ownerId])

  const isPlaceholderBreak = useCallback((node: HTMLBRElement): boolean => {
    if (node === ownedTailBreak.current) return true
    const parent = node.parentElement
    // Native clearing may retain zero-length Text fragments beside its empty-container BR.
    // Stop at the nearest meaningful sibling; real LF/space and owned elements remain content.
    let previous = node.previousSibling,
      next = node.nextSibling
    while (previous instanceof Text && previous.data.length === 0)
      previous = previous.previousSibling
    while (next instanceof Text && next.data.length === 0) next = next.nextSibling
    if (parent && !previous && !next) return true
    const ownedBody =
      parent?.parentElement &&
      ownedRows.current.has(parent.parentElement) &&
      parent === parent.parentElement.lastElementChild
    return Boolean(
      (parent === hostRef.current || ownedBody) &&
      !node.nextSibling &&
      node.previousSibling &&
      ownedAtoms.current.has(node.previousSibling),
    )
  }, [])
  const nodeLength = useCallback(
    function length(node: Node): number {
      const marker = ownedMarkers.current.get(node)
      if (marker !== undefined) return marker.length
      const atom = ownedAtoms.current.get(node)
      if (atom) return atom.name.length + 1
      if (node instanceof Text) return node.data.length
      if (node instanceof HTMLBRElement) return isPlaceholderBreak(node) ? 0 : 1
      return (
        (ownedRows.current.get(node) ? 1 : 0) +
        [...node.childNodes].reduce((sum, child) => sum + length(child), 0)
      )
    },
    [isPlaceholderBreak],
  )
  const offsetAt = useCallback(
    (node: Node, offset: number, edge: 'start' | 'end'): number => {
      const host = hostRef.current
      if (!host || !host.contains(node)) return lastRange.current[edge]
      let current: Node | null = node
      while (
        current &&
        current !== host &&
        !ownedAtoms.current.has(current) &&
        !ownedMarkers.current.has(current)
      )
        current = current.parentNode
      let total = 0
      if (current && (ownedAtoms.current.has(current) || ownedMarkers.current.has(current))) {
        node = current
        total = edge === 'end' ? nodeLength(current) : 0
      } else
        total =
          node instanceof Text
            ? Math.min(offset, node.data.length)
            : [...node.childNodes]
                .slice(0, offset)
                .reduce((sum, child) => sum + nodeLength(child), 0)
      while (node !== host && node.parentNode) {
        if (ownedRows.current.get(node)) total++
        for (let sibling = node.previousSibling; sibling; sibling = sibling.previousSibling)
          total += nodeLength(sibling)
        node = node.parentNode
      }
      return total
    },
    [nodeLength],
  )
  const selection = useCallback((): ComposerRange => {
    const selected = window.getSelection()
    const host = hostRef.current
    if (
      !selected ||
      !host ||
      selected.rangeCount !== 1 ||
      !host.contains(selected.getRangeAt(0).commonAncestorContainer)
    )
      return lastRange.current
    const range = selected.getRangeAt(0)
    const result = {
      start: offsetAt(range.startContainer, range.startOffset, 'start'),
      end: offsetAt(range.endContainer, range.endOffset, 'end'),
    }
    if (selected.isCollapsed) {
      let node: Node | null = range.startContainer
      while (node && node !== host && !ownedMarkers.current.has(node)) node = node.parentNode
      if (node && ownedMarkers.current.has(node)) result.start = result.end
    }
    lastRange.current = result
    return result
  }, [offsetAt])
  const select = useCallback(
    (start: number, end = start): void => {
      const host = hostRef.current
      if (!host) return
      if (start === end) {
        for (const [node, marker] of ownedMarkers.current) {
          const beginning = offsetAt(node, 0, 'start')
          if (start >= beginning && start < beginning + marker.length)
            start = end = beginning + marker.length
        }
      }
      const boundary = (offset: number, edge: 'start' | 'end'): [Node, number] => {
        const descend = (container: Node, position: number): [Node, number] => {
          if (container instanceof Text)
            return [container, Math.min(position, container.data.length)]
          if (container instanceof HTMLBRElement && container.parentNode) {
            const siblings: Node[] = [...container.parentNode.childNodes]
            return [container.parentNode, siblings.indexOf(container)]
          }
          if (ownedAtoms.current.has(container) || ownedMarkers.current.has(container)) {
            if (
              start === end &&
              ownedMarkers.current.has(container) &&
              position === nodeLength(container) &&
              container.nextSibling
            )
              return descend(container.nextSibling, 0)
            const parent = container.parentNode!
            const siblings: Node[] = [...parent.childNodes]
            const index = siblings.indexOf(container)
            return [
              parent,
              index +
                (position === nodeLength(container) || (position > 0 && edge === 'end') ? 1 : 0),
            ]
          }
          if (ownedRows.current.get(container)) {
            if (position === 0) {
              const siblings: Node[] = [...container.parentNode!.childNodes]
              return [container.parentNode!, siblings.indexOf(container)]
            }
            position--
          }
          for (const child of container.childNodes) {
            const length = nodeLength(child)
            if (position <= length) return descend(child, position)
            position -= length
          }
          return [container, container.childNodes.length]
        }
        return descend(host, Math.max(0, Math.min(model.current.text.length, offset)))
      }
      const a = boundary(start, 'start'),
        b = boundary(end, 'end')
      const range = document.createRange()
      range.setStart(...a)
      range.setEnd(...b)
      const selected = window.getSelection()
      selected?.removeAllRanges()
      selected?.addRange(range)
      lastRange.current = { start, end }
      let caret = range.getBoundingClientRect()
      if (!caret.height) {
        const anchor =
          range.endContainer instanceof Element
            ? range.endContainer
            : range.endContainer.parentElement
        if (anchor) caret = anchor.getBoundingClientRect()
      }
      const viewport = host.getBoundingClientRect()
      if (caret.height && caret.bottom > viewport.bottom - 8)
        host.scrollTop += caret.bottom - viewport.bottom + 8
      else if (caret.height && caret.top < viewport.top + 8)
        host.scrollTop -= viewport.top - caret.top + 8
    },
    [nodeLength, offsetAt],
  )
  const project = useCallback(
    (documentValue: ComposerDocument, range?: ComposerRange): void => {
      const host = hostRef.current
      if (!host || composing.current) return
      const nodes: Node[] = [],
        nextAtoms: Atom[] = []
      const previous = new Map(atomNodes.current.map((entry) => [entry.key, entry]))
      const occurrences = new Map<string, number>()
      ownedAtoms.current.clear()
      ownedMarkers.current.clear()
      ownedRows.current.clear()
      ownedTailBreak.current = undefined
      const skills = documentValue.skills.toSorted((a, b) => a.start - b.start)
      let skillAt = 0
      const append = (target: Node, start: number, end: number): void => {
        let cursor = start
        while (skillAt < skills.length && skills[skillAt]!.start < end) {
          const skill = skills[skillAt++]!
          if (
            skill.start < cursor ||
            skill.end > end ||
            documentValue.text.slice(skill.start, skill.end) !== `/${skill.name}`
          )
            continue
          if (skill.start > cursor)
            target.appendChild(
              document.createTextNode(documentValue.text.slice(cursor, skill.start)),
            )
          const number = occurrences.get(skill.id) ?? 0
          occurrences.set(skill.id, number + 1)
          const key = `${skill.id}:${number}`
          const atom = previous.get(key) ?? { key, skill, host: document.createElement('span') }
          atom.skill = skill
          atom.host.contentEditable = 'false'
          atom.host.className = 'inline-block align-baseline'
          ownedAtoms.current.set(atom.host, skill)
          nextAtoms.push(atom)
          target.appendChild(atom.host)
          cursor = skill.end
        }
        target.appendChild(document.createTextNode(documentValue.text.slice(cursor, end)))
      }
      let index: ComposerListIndex | undefined
      try {
        index = indexComposerLists(documentValue.text)
        if (
          index.groups.length &&
          index.rows.length * 4 + index.itemCount + skills.length * 8 > 10_000
        )
          throw new Error('This draft exceeds the list projection capacity.')
        capacityNotice.current = false
      } catch {
        index = undefined
        const hasListSyntax = /(?:^|\n)(?:\d+\. | {4}[a-z]+\. )/u.test(documentValue.text)
        if (!capacityNotice.current && (documentValue.text.length <= 100_000 || hasListSyntax))
          notifyEditingFailure(
            'List formatting capacity exceeded. The complete draft is shown as plain text.',
          )
        capacityNotice.current = true
      }
      listIndex.current = index
      if (index?.groups.length) {
        for (const entry of index.rows) {
          const row = document.createElement('div'),
            body = document.createElement('span')
          row.className =
            entry.group === undefined
              ? 'pact-composer-row'
              : 'pact-composer-row pact-composer-list-row'
          if (entry.depth === 1) row.classList.add('pact-composer-child-row')
          ownedRows.current.set(row, entry.start > 0)
          body.className = 'pact-composer-row-body'
          if (entry.group !== undefined) {
            const marker = document.createElement('span')
            const prefix = documentValue.text.slice(entry.start, entry.contentStart)
            marker.contentEditable = 'false'
            marker.className = 'pact-composer-list-marker'
            // Display numbering without placing it in native editable surrounding text.
            // The owned Map still supplies its complete canonical prefix for copy and offsets.
            marker.setAttribute('data-list-label', prefix.trim())
            ownedMarkers.current.set(marker, prefix)
            row.appendChild(marker)
          }
          append(body, entry.group === undefined ? entry.start : entry.contentStart, entry.end)
          if (entry.contentStart === entry.end) body.replaceChildren(document.createElement('br'))
          row.appendChild(body)
          nodes.push(row)
        }
      } else {
        const fragment = document.createDocumentFragment()
        append(fragment, 0, documentValue.text.length)
        nodes.push(...fragment.childNodes)
        // A terminal LF needs an editable empty-line anchor in Chromium. The LF
        // stays in its Text node; only this owned BR contributes zero characters.
        if (documentValue.text.endsWith('\n')) {
          ownedTailBreak.current = document.createElement('br')
          nodes.push(ownedTailBreak.current)
        }
      }
      host.replaceChildren(...nodes)
      atomNodes.current = nextAtoms
      setAtoms(nextAtoms)
      if (range) {
        select(range.start, range.end)
        selectAfterCommit.current = range
      }
    },
    [select, notifyEditingFailure],
  )
  const remember = useCallback(
    (
      before: ComposerDocument,
      after: ComposerDocument,
      previousSelection: ComposerRange,
      afterRange: ComposerRange,
    ): (() => void) => {
      const edit = composerDifference(before.text, after.text)
      assertComposerInverseCapacity(before.text.slice(edit.start, edit.end), edit.text)
      // A compressed text splice may enclose unchanged atoms between two real edits.
      // Keep their complete facts so replay cannot delete identities inside that splice.
      const skillsChanged =
        JSON.stringify(before.skills) !== JSON.stringify(after.skills) ||
        before.skills.some((skill) => skill.start < edit.end && skill.end > edit.start) ||
        after.skills.some(
          (skill) => skill.start < edit.start + edit.text.length && skill.end > edit.start,
        )
      const entry: HistoryEntry = {
        start: edit.start,
        deleted: before.text.slice(edit.start, edit.end),
        inserted: edit.text,
        ...(skillsChanged ? { beforeSkills: before.skills, afterSkills: after.skills } : {}),
        beforeMention: before.mention,
        afterMention: after.mention,
        beforeRoute: before.route,
        afterRoute: after.route,
        beforeRange: previousSelection,
        afterRange,
        bytes: 0,
      }
      entry.bytes = encoder.encode(JSON.stringify(entry)).byteLength
      if (entry.bytes > COMPOSER_HISTORY_BYTES)
        throw new Error('This edit is too large to undo safely. Your draft was kept.')
      return () => {
        const next = [...history.current.slice(0, historyIndex.current), entry]
        let bytes = next.reduce((sum, item) => sum + item.bytes, 0)
        while (next.length > HISTORY_ITEMS || bytes > COMPOSER_HISTORY_BYTES)
          bytes -= next.shift()!.bytes
        history.current = next
        historyIndex.current = next.length
        setHistoryRevision((revision) => revision + 1)
      }
    },
    [],
  )
  const commit = useCallback(
    (
      next: ComposerDocument,
      range: ComposerRange,
      record = true,
      render = true,
      origin?: { document: ComposerDocument; range: ComposerRange },
    ): boolean => {
      if (!skillSelectionsSchema.safeParse(next.skills).success) {
        notifyEditingFailure('This edit exceeds the Composer capacity. Your draft was kept.')
        if (!composing.current) project(model.current, lastRange.current)
        return false
      }
      if (
        next.skills.some((skill) => next.text.slice(skill.start, skill.end) !== `/${skill.name}`) ||
        (next.mention &&
          (next.mention.start < 0 ||
            next.text.slice(next.mention.start, next.mention.end) !== next.mention.token))
      ) {
        notifyEditingFailure('An input label no longer matched its text. Your draft was kept.')
        if (!composing.current) project(model.current, lastRange.current)
        return false
      }
      const previous = origin?.document ?? model.current
      try {
        assertComposerEditCapacity(previous.text, 0, previous.text.length, next.text)
        const installHistory =
          record && !sameComposerDocument(previous, next)
            ? remember(previous, next, origin?.range ?? lastRange.current, range)
            : undefined
        // The Hook owns cross-Session residency and may refuse before DOM/history installation.
        if (callbacks.current.onChange(next, range.end, composing.current) === false) {
          if (!composing.current) project(model.current, lastRange.current)
          return false
        }
        installHistory?.()
      } catch (error) {
        notifyEditingFailure(error instanceof Error ? error.message : 'Your draft was kept.')
        if (!composing.current) project(model.current, lastRange.current)
        return false
      }
      if (!sameComposerDocument(previous, next)) {
        editFailureNotified.current = false
      }
      pendingFormatting.current = false
      model.current = next
      published.current = next
      lastRange.current = range
      if (render) project(next, range)
      reportedCursor.current = range.end
      return true
    },
    [project, remember, notifyEditingFailure],
  )
  const replace = useCallback(
    (range: ComposerRange, text: string, skills: SkillSelection[] = []): void => {
      const expandedRange = wholeComposerAtoms(model.current, range)
      try {
        assertComposerReplacementCapacity(
          model.current.text,
          expandedRange.start,
          expandedRange.end,
          text,
        )
        if (
          callbacks.current.admitEdit?.(
            model.current.text.length - (expandedRange.end - expandedRange.start) + text.length,
          ) === false
        )
          return
      } catch (error) {
        notifyEditingFailure(error instanceof Error ? error.message : 'Your draft was kept.')
        return
      }
      const next = replaceComposerDocument(model.current, { ...expandedRange, text })
      next.skills = [
        ...next.skills,
        ...skills.map((entry) => ({
          ...entry,
          start: entry.start + expandedRange.start,
          end: entry.end + expandedRange.start,
        })),
      ].toSorted((a, b) => a.start - b.start)
      const cursor = expandedRange.start + text.length
      try {
        const edited = formatComposerLists(model.current, next, [{ ...expandedRange, text }], {
          start: cursor,
          end: cursor,
        })
        commit(edited.document, edited.selection)
      } catch (error) {
        notifyEditingFailure(
          error instanceof Error
            ? error.message
            : 'This list edit could not be applied. Your draft was kept.',
        )
      }
    },
    [commit, notifyEditingFailure],
  )
  const undo = useCallback(
    (redo: boolean): void => {
      const entry = history.current[redo ? historyIndex.current : historyIndex.current - 1]
      if (!entry || callbacks.current.disabled || composing.current) return
      const deleted = redo ? entry.deleted : entry.inserted,
        inserted = redo ? entry.inserted : entry.deleted
      if (
        callbacks.current.admitEdit?.(
          model.current.text.length - deleted.length + inserted.length,
        ) === false
      )
        return
      let next: ComposerDocument
      try {
        next = replaceComposerDocument(model.current, {
          start: entry.start,
          end: entry.start + deleted.length,
          text: inserted,
        })
      } catch (error) {
        notifyEditingFailure(error instanceof Error ? error.message : 'Your draft was kept.')
        return
      }
      const skills = redo ? entry.afterSkills : entry.beforeSkills
      if (skills) next.skills = skills
      next.mention = redo ? entry.afterMention : entry.beforeMention
      next.route = redo ? entry.afterRoute : entry.beforeRoute
      if (!commit(next, redo ? entry.afterRange : entry.beforeRange, false)) return
      historyIndex.current += redo ? 1 : -1
      setHistoryRevision((revision) => revision + 1)
    },
    [commit, notifyEditingFailure],
  )
  const readDom = useCallback(
    (
      editRange?: ComposerRange,
      initial = model.current,
    ): { document: ComposerDocument; edit: ComposerReplacement } => {
      const host = hostRef.current
      let text = '',
        nodes = 0,
        chars = 0
      const pieces: string[] = []
      const appendText = (piece: string): void => {
        chars += piece.length
        assertComposerEditLengths(initial.text.length, chars)
        pieces.push(piece)
      }
      const skills: SkillSelection[] = []
      const visit = (node: Node): void => {
        if (++nodes > 10_000) throw new Error('Composer markup capacity exceeded')
        const marker = ownedMarkers.current.get(node)
        if (marker !== undefined) {
          appendText(marker)
          return
        }
        const skill = ownedAtoms.current.get(node)
        if (skill) {
          const start = chars
          appendText(`/${skill.name}`)
          skills.push({ ...skill, start, end: chars })
          return
        }
        if (node instanceof Text) appendText(node.data)
        else if (node instanceof HTMLBRElement) {
          if (!isPlaceholderBreak(node)) appendText('\n')
        } else {
          if (ownedRows.current.has(node)) {
            if (ownedRows.current.get(node)) appendText('\n')
          } else if (
            node instanceof HTMLDivElement &&
            node !== host &&
            chars &&
            !pieces.at(-1)?.endsWith('\n')
          )
            appendText('\n')
          for (const child of node.childNodes) visit(child)
        }
      }
      if (host) for (const child of host.childNodes) visit(child)
      if (callbacks.current.admitEdit?.(chars) === false)
        throw new ComposerAdmissionRefused(
          'Open drafts and pending messages need too much memory. Your previous draft was kept.',
        )
      text = pieces.join('')
      const prefix = editRange ? initial.text.slice(0, editRange.start) : ''
      const suffix = editRange ? initial.text.slice(editRange.end) : ''
      if (
        editRange &&
        (!text.startsWith(prefix) ||
          !text.endsWith(suffix) ||
          text.length < prefix.length + suffix.length)
      )
        throw new Error('Native edit did not match its input range')
      // Native DOM supplies text; the actual pre-edit range supplies structural identity.
      const edit = editRange
        ? { ...editRange, text: text.slice(prefix.length, text.length - suffix.length) }
        : composerDifference(initial.text, text)
      const next = replaceComposerDocument(initial, edit)
      next.skills = skills
      return { document: next, edit }
    },
    [isPlaceholderBreak],
  )
  useEffect(() => {
    // Availability changes, not each keystroke, are the native menu's disposable projection.
    if (historyRevision >= 0 && disabled === callbacks.current.disabled) publishEditingState()
  }, [historyRevision, disabled, publishEditingState])
  useEffect(() => {
    const host = hostRef.current
    if (!host) return undefined
    host.addEventListener('focusin', publishEditingState)
    host.addEventListener('focusout', publishEditingState)
    const unsubscribe = window.pact.onComposerEditCommand((command) => {
      const focused = host.contains(document.activeElement)
      const allowed =
        command.ownerId === ownerId &&
        command.expiresAt >= Date.now() &&
        !callbacks.current.disabled &&
        !composing.current
      if (focused && allowed) undo(command.action === 'redo')
      void window.pact
        .settleComposerEdit({
          ownerId: command.ownerId,
          requestId: command.requestId,
          disposition: !focused ? 'native_target' : allowed ? 'handled' : 'blocked',
        })
        .catch(() => undefined)
      publishEditingState()
    })
    return () => {
      unsubscribe()
      host.removeEventListener('focusin', publishEditingState)
      host.removeEventListener('focusout', publishEditingState)
      void window.pact
        .setComposerEditingState({
          ownerId,
          focused: false,
          editable: false,
          composing: false,
          canUndo: false,
          canRedo: false,
        })
        .catch(() => undefined)
    }
  }, [ownerId, publishEditingState, undo])
  useImperativeHandle(editorRef, () => ({
    focus: () => hostRef.current?.focus(),
    selection,
    select,
    document: () => model.current,
    refuseEdit: notifyEditingFailure,
    apply: (next, range, replacements = []) => {
      if (composing.current) return
      try {
        assertComposerEditCapacity(model.current.text, 0, model.current.text.length, next.text)
        const edited = formatComposerLists(model.current, next, replacements, range)
        commit(edited.document, edited.selection)
      } catch (error) {
        notifyEditingFailure(error instanceof Error ? error.message : 'Your draft was kept.')
      }
    },
  }))
  useLayoutEffect(() => {
    callbacks.current = {
      onChange,
      admitEdit,
      onCursor,
      onKeyDown,
      onSkillOpen,
      onImages,
      onNotice,
      disabled,
    }
  })
  useLayoutEffect(() => {
    if (!hostRef.current) return
    if (model.current.returnedInputOperationId !== value.returnedInputOperationId) {
      // Context settlement must reach an active composition without replacing its native DOM.
      const context = {
        returnedInputOperationId: value.returnedInputOperationId,
        route: value.route,
      }
      model.current = { ...model.current, ...context }
      if (compositionBefore.current)
        compositionBefore.current.document = { ...compositionBefore.current.document, ...context }
      history.current = []
      historyIndex.current = 0
      published.current = undefined
      setHistoryRevision((revision) => revision + 1)
    }
    if (composing.current) return
    if (published.current && sameComposerDocument(value, published.current)) return
    editFailureNotified.current = false
    pendingFormatting.current = false
    beforeRange.current = undefined
    model.current = value
    history.current = []
    historyIndex.current = 0
    published.current = value
    project(value, document.activeElement === hostRef.current ? lastRange.current : undefined)
    setHistoryRevision((revision) => revision + 1)
  }, [value, project])
  useLayoutEffect(() => {
    const range = selectAfterCommit.current
    if (
      range &&
      atoms.every((atom) => atom.host.hasChildNodes()) &&
      !composing.current &&
      hostRef.current?.contains(document.activeElement)
    ) {
      selectAfterCommit.current = undefined
      select(range.start, range.end)
    }
  }, [atoms, select])
  useEffect(() => {
    const host = hostRef.current
    if (!host) return undefined
    const atomOwner = ownedAtoms.current
    const markerOwner = ownedMarkers.current
    const rowOwner = ownedRows.current
    const structural = (
      command: 'break' | 'indent' | 'outdent' | 'backspace' | 'delete',
    ): boolean => {
      if (callbacks.current.disabled || composing.current) return false
      // A known capacity fallback is still a complete editable draft, without list commands.
      if (capacityNotice.current && !listIndex.current) return false
      try {
        const edited = composerListCommand(model.current, selection(), command)
        if (!edited) return false
        commit(edited.document, edited.selection)
        return true
      } catch (error) {
        if (!listIndex.current && command === 'break') {
          replace(selection(), '\n')
          return true
        }
        notifyEditingFailure(
          error instanceof Error ? error.message : 'This list edit could not be applied.',
        )
        return command === 'break'
      }
    }
    const beforeInput = (event: InputEvent): void => {
      if (composing.current || event.isComposing) return
      if (callbacks.current.disabled) {
        event.preventDefault()
        return
      }
      pendingFormatting.current = event.inputType.startsWith('format')
      if (pendingFormatting.current) {
        beforeRange.current = undefined
        if (event.cancelable) {
          event.preventDefault()
          pendingFormatting.current = false
        }
        return
      }
      beforeRange.current = selection()
      if (event.inputType === 'insertText' || event.inputType === 'insertReplacementText') {
        const target = event.getTargetRanges()[0]
        if (target)
          beforeRange.current = {
            start: offsetAt(target.startContainer, target.startOffset, 'start'),
            end: offsetAt(target.endContainer, target.endOffset, 'end'),
          }
        const text =
          typeof event.data === 'string'
            ? event.data
            : event.dataTransfer?.types.includes('text/plain')
              ? event.dataTransfer.getData('text/plain')
              : undefined
        if (event.cancelable && text !== undefined) {
          event.preventDefault()
          replace(beforeRange.current, text)
          beforeRange.current = undefined
          return
        }
      }
      if (event.inputType === 'historyUndo' || event.inputType === 'historyRedo') {
        event.preventDefault()
        undo(event.inputType === 'historyRedo')
        return
      }
      if (event.inputType === 'insertParagraph' || event.inputType === 'insertLineBreak') {
        event.preventDefault()
        if (!structural('break')) replace(selection(), '\n')
        return
      }
      if (event.inputType.startsWith('delete')) {
        const target = event.getTargetRanges()[0]
        let range = target
          ? {
              start: offsetAt(target.startContainer, target.startOffset, 'start'),
              end: offsetAt(target.endContainer, target.endOffset, 'end'),
            }
          : selection()
        if (range.start === range.end)
          range = event.inputType.endsWith('Backward')
            ? { start: Math.max(0, range.start - 1), end: range.end }
            : { start: range.start, end: Math.min(model.current.text.length, range.end + 1) }
        const expandedRange = wholeComposerAtoms(model.current, range)
        beforeRange.current = range
        if (event.cancelable) {
          event.preventDefault()
          replace(expandedRange, '')
          return
        }
      }
    }
    const input = (): void => {
      if (callbacks.current.disabled) return
      const formatting = pendingFormatting.current
      pendingFormatting.current = false
      try {
        if (formatting) {
          const observed = readDom().document
          if (
            observed.text !== model.current.text ||
            !sameComposerDocument({ ...model.current, skills: observed.skills }, model.current)
          )
            throw new Error('Formatting changed an input label.')
          project(model.current, selection())
          return
        }
        const next = readDom(
            compositionBefore.current?.range ?? beforeRange.current,
            compositionBefore.current?.document,
          ),
          range = selection()
        if (beforeRange.current) lastRange.current = beforeRange.current
        beforeRange.current = undefined
        if (composing.current) commit(next.document, range, false, false)
        else {
          const edited = formatComposerLists(model.current, next.document, [next.edit], range)
          let repaint = edited.document.text !== next.document.text
          try {
            const index = indexComposerLists(edited.document.text)
            const markers = index.rows
              .filter((row) => row.group !== undefined)
              .map((row) => edited.document.text.slice(row.start, row.contentStart))
            repaint ||=
              Boolean(ownedRows.current.size) !== Boolean(index.groups.length) ||
              (index.groups.length > 0 && ownedRows.current.size !== index.rows.length) ||
              JSON.stringify([...ownedMarkers.current.values()]) !== JSON.stringify(markers)
          } catch {
            /* Capacity is handled by the document edit and projection. */
          }
          commit(edited.document, edited.selection, true, repaint)
        }
      } catch (error) {
        beforeRange.current = undefined
        if (!(error instanceof ComposerAdmissionRefused))
          notifyEditingFailure('Pact could not apply this edit. Your previous draft was kept.')
        project(model.current, lastRange.current)
      }
    }
    const compositionStart = (): void => {
      pendingFormatting.current = false
      compositionBefore.current = { document: model.current, range: selection() }
      composing.current = true
      publishEditingState()
    }
    const compositionEnd = (): void => {
      composing.current = false
      publishEditingState()
      const before = compositionBefore.current
      compositionBefore.current = undefined
      try {
        const next = readDom(before?.range, before?.document),
          range = selection()
        const edited = formatComposerLists(
          before?.document ?? model.current,
          next.document,
          [next.edit],
          range,
        )
        if (!commit(edited.document, edited.selection, true, true, before) && before)
          commit(before.document, before.range, false)
      } catch (error) {
        if (!(error instanceof ComposerAdmissionRefused))
          notifyEditingFailure(
            error instanceof Error
              ? error.message
              : 'This composition could not be applied. Your draft was kept.',
          )
        if (before) commit(before.document, before.range, false)
        else project(model.current, lastRange.current)
      }
    }
    const keyDown = (event: KeyboardEvent): void => {
      if (composing.current || event.isComposing || event.keyCode === 229) return
      let target: Node | null = event.target instanceof Node ? event.target : null
      while (target && target !== host && !ownedAtoms.current.has(target))
        target = target.parentNode
      if (target && ownedAtoms.current.has(target)) {
        if (event.key === 'Enter' || event.key === ' ') return
        const skill = ownedAtoms.current.get(target)!
        const start = offsetAt(target, 0, 'start')
        const current = model.current.skills.find(
          (entry) => entry.id === skill.id && entry.name === skill.name && entry.start === start,
        )
        if (current && (event.key === 'Backspace' || event.key === 'Delete')) {
          event.preventDefault()
          replace({ start: current.start, end: current.end }, '')
          return
        }
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        undo(event.shiftKey)
        return
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'y') {
        event.preventDefault()
        undo(true)
        return
      }
      if (event.key === 'Enter' && event.shiftKey) {
        if (event.metaKey || event.ctrlKey) {
          callbacks.current.onKeyDown(event)
          return
        }
        // The native beforeinput line-break event is the sole transaction owner.
        // Handling both keydown and beforeinput would create two items on macOS.
        return
      }
      callbacks.current.onKeyDown(event)
      if (event.defaultPrevented) return
      if (event.key === 'Tab' && structural(event.shiftKey ? 'outdent' : 'indent'))
        event.preventDefault()
      else if (event.key === 'Backspace' && structural('backspace')) event.preventDefault()
      else if (event.key === 'Delete' && structural('delete')) event.preventDefault()
    }
    const cursor = (): void => {
      if (!composing.current) {
        const selected = selection()
        let node: Node | null = window.getSelection()?.anchorNode ?? null
        while (node && node !== host && !ownedMarkers.current.has(node)) node = node.parentNode
        if (node && ownedMarkers.current.has(node) && selected.start === selected.end)
          select(selected.start)
        // A consumed menu key does not move the caret; its keyup must keep the active option.
        if (selected.end !== reportedCursor.current) {
          reportedCursor.current = selected.end
          callbacks.current.onCursor(selected.end)
        }
      }
    }
    const copy = (event: ClipboardEvent): void => {
      const range = wholeComposerAtoms(model.current, selection())
      if (range.start === range.end) return
      event.preventDefault()
      const text = model.current.text.slice(range.start, range.end)
      const skills = model.current.skills
        .filter((skill) => skill.start >= range.start && skill.end <= range.end)
        .map((skill) =>
          Object.assign({}, skill, {
            start: skill.start - range.start,
            end: skill.end - range.start,
          }),
        )
      let metadata: string | undefined
      if (skills.length) {
        metadata = JSON.stringify({
          version: 2,
          encoding: 'sha256-utf16le',
          textLength: text.length,
          digest: composerClipboardDigest(text),
          skills,
        })
        if (encoder.encode(metadata).byteLength > CLIPBOARD_METADATA_BYTES) {
          notifyEditingFailure(
            'The selected Skill labels exceed clipboard capacity. Your draft was kept.',
          )
          return
        }
      }
      event.clipboardData?.setData('text/plain', text)
      if (metadata) event.clipboardData?.setData(CLIPBOARD_V2_TYPE, metadata)
      if (event.type === 'cut' && !callbacks.current.disabled) replace(range, '')
    }
    const paste = (event: ClipboardEvent): void => {
      if (callbacks.current.disabled) return
      const files = [...(event.clipboardData?.files ?? [])]
      if (files.length && callbacks.current.onImages) {
        event.preventDefault()
        callbacks.current.onImages(files)
        return
      }
      event.preventDefault()
      const text = event.clipboardData?.getData('text/plain') ?? ''
      let skills: SkillSelection[] = []
      try {
        const modern = event.clipboardData?.getData(CLIPBOARD_V2_TYPE) ?? ''
        const raw = modern || (event.clipboardData?.getData(CLIPBOARD_TYPE) ?? '')
        if (raw) {
          const byteLimit = modern ? CLIPBOARD_METADATA_BYTES : 512 * 1024
          if (raw.length > byteLimit || encoder.encode(raw).byteLength > byteLimit)
            throw new Error('The selected Skill labels exceed clipboard capacity.')
          const fragment: unknown = JSON.parse(raw)
          if (
            fragment &&
            typeof fragment === 'object' &&
            (modern
              ? Reflect.get(fragment, 'version') === 2 &&
                Reflect.get(fragment, 'encoding') === 'sha256-utf16le' &&
                Reflect.get(fragment, 'textLength') === text.length &&
                Reflect.get(fragment, 'digest') === composerClipboardDigest(text)
              : Reflect.get(fragment, 'version') === 1 && Reflect.get(fragment, 'text') === text)
          ) {
            const parsed = skillSelectionsSchema.safeParse(Reflect.get(fragment, 'skills'))
            if (
              parsed.success &&
              parsed.data.every((entry) => text.slice(entry.start, entry.end) === `/${entry.name}`)
            )
              skills = parsed.data
            else throw new Error('Clipboard Skill labels do not match the copied text.')
          } else throw new Error('Clipboard Skill labels do not match the copied text.')
        }
      } catch (error) {
        notifyEditingFailure(
          error instanceof Error ? error.message : 'Clipboard Skill labels could not be read.',
        )
        return
      }
      replace(selection(), text, skills)
    }
    const drop = (event: DragEvent): void => {
      if (event.defaultPrevented) return
      if (
        event.dataTransfer?.files.length &&
        callbacks.current.onImages &&
        !callbacks.current.disabled
      ) {
        event.preventDefault()
        callbacks.current.onImages([...event.dataTransfer.files])
        return
      }
      event.preventDefault()
      notifyEditingFailure(
        'Drag and drop is unavailable here. Copy and paste preserves Skill labels.',
      )
    }
    const dragStart = (event: DragEvent): void => {
      event.preventDefault()
    }
    host.addEventListener('beforeinput', beforeInput)
    host.addEventListener('input', input)
    host.addEventListener('compositionstart', compositionStart)
    host.addEventListener('compositionend', compositionEnd)
    host.addEventListener('keydown', keyDown)
    host.addEventListener('keyup', cursor)
    host.addEventListener('mouseup', cursor)
    host.addEventListener('copy', copy)
    host.addEventListener('cut', copy)
    host.addEventListener('paste', paste)
    host.addEventListener('drop', drop)
    host.addEventListener('dragstart', dragStart)
    return () => {
      host.removeEventListener('beforeinput', beforeInput)
      host.removeEventListener('input', input)
      host.removeEventListener('compositionstart', compositionStart)
      host.removeEventListener('compositionend', compositionEnd)
      host.removeEventListener('keydown', keyDown)
      host.removeEventListener('keyup', cursor)
      host.removeEventListener('mouseup', cursor)
      host.removeEventListener('copy', copy)
      host.removeEventListener('cut', copy)
      host.removeEventListener('paste', paste)
      host.removeEventListener('drop', drop)
      host.removeEventListener('dragstart', dragStart)
      atomOwner.clear()
      markerOwner.clear()
      rowOwner.clear()
      ownedTailBreak.current = undefined
      listIndex.current = undefined
      history.current = []
    }
  }, [
    commit,
    offsetAt,
    project,
    readDom,
    replace,
    selection,
    select,
    undo,
    publishEditingState,
    notifyEditingFailure,
  ])
  return (
    <>
      <div
        ref={hostRef}
        contentEditable={!disabled}
        suppressContentEditableWarning
        data-placeholder={placeholder}
        className="pact-composer-editor min-h-16 max-h-36 min-w-0 flex-1 overflow-y-auto bg-transparent px-2 py-2 text-body leading-relaxed whitespace-pre-wrap break-words text-primary outline-none"
        aria-label="Message"
        aria-disabled={disabled}
        role="combobox"
        tabIndex={0}
        aria-autocomplete="list"
        aria-expanded={expanded}
        aria-controls={controls}
        aria-activedescendant={activeDescendant}
        aria-describedby={describedBy}
        data-history-revision={historyRevision}
      />
      {atoms.map((atom) =>
        createPortal(
          <button
            type="button"
            contentEditable={false}
            className="mx-0.5 inline-flex max-w-full items-baseline gap-1.5 rounded-control border border-border/60 bg-surface-muted px-2 py-0.5 align-baseline text-caption font-medium leading-normal text-primary hover:border-border-strong focus-visible:outline-2 focus-visible:outline-focus"
            aria-label={`Open ${atom.skill.agentId === 'codex' ? 'Codex' : 'Claude Code'} Skill ${atom.skill.name}`}
            title={`${atom.skill.agentId === 'codex' ? 'Codex' : 'Claude Code'} · ${atom.skill.name} · Open Skill document`}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => callbacks.current.onSkillOpen(atom.skill)}
          >
            <BookOpen
              aria-hidden="true"
              className="size-3.5 shrink-0 self-center"
              strokeWidth={1.75}
            />
            <span className="min-w-0 break-all">{atom.skill.name}</span>
          </button>,
          atom.host,
          atom.key,
        ),
      )}
    </>
  )
}
