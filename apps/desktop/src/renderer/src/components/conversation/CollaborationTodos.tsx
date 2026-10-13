import {
  Check,
  ChevronDown,
  Circle,
  CircleDot,
  CircleHelp,
  Info,
  LoaderCircle,
  MessageSquarePlus,
  RotateCcw,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react'

import type {
  AnchoredComment,
  CollaborationDocument,
  CollaborationTodo,
  RuntimeAgentId,
  TodoCommentAnchor,
} from '@pact/contracts'

import type { ProjectFileTarget } from './MessageMarkdown'

import { readableCollaborationText } from '../../../../shared/collaboration-display-text'
import { CollaborationDocumentView } from './CollaborationDocumentView'
import { clearProjectionHighlight, focusProjectionRange } from './message-selection'
import { commentDraftSaveSucceeded, type CommentDraftSaveOutcome } from './useConversation'

/** A bounded display projection; the Repository owns the Todo and its state. */
export type CollaborationTodoRow = CollaborationTodo

export interface CollaborationTodoDetail {
  todo: CollaborationTodoRow
  runId: string
  messageId: string
  document: CollaborationDocument
}

export interface TodoCommentDraft {
  requestId: string
  commentId?: string | undefined
  todo: CollaborationTodoRow
  body: string
  quote?: string | undefined
  selection?: TodoCommentAnchor['selection'] | undefined
  answer?: { questionId: string; questionRevision: number; optionIndex?: number } | undefined
}

interface TodoEditor {
  todo: CollaborationTodoRow
  todoId: string
  revision: number
  requestId: string
  commentId?: string | undefined
  body: string
  quote?: string | undefined
  selection?: TodoCommentAnchor['selection'] | undefined
  optionIndex?: number | undefined
  answer: boolean
}

const todoKey = (todo: CollaborationTodoRow): string => `${todo.id}:${todo.revision}`
const agentName = (id: RuntimeAgentId): string => (id === 'claude' ? 'Claude Code' : 'Codex')
const statusName = (status: CollaborationTodo['status']): string =>
  status === 'done' ? 'Done' : status === 'awaiting_review' ? 'Awaiting review' : 'Open'

/** One detail and editor, no Todo mutation controls or independent Send entry. */
export function CollaborationTodos({
  sessionId,
  active,
  taskId,
  ledgerRevision,
  items,
  sourceTodo,
  sourceCurrent,
  activeCount,
  doneCount,
  showDone,
  loading,
  error,
  hasPrevious,
  hasNext,
  disabled,
  reveal,
  addedDrafts,
  answerDrafts,
  onShowDone,
  onPrevious,
  onNext,
  onRetry,
  onReadDetail,
  onAddComment,
  onEditorChange,
  onNotice,
  onOpenProjectFile,
}: {
  sessionId: string
  active: boolean
  taskId: string
  ledgerRevision: number
  items: CollaborationTodoRow[]
  sourceTodo?: CollaborationTodoRow | undefined
  sourceCurrent?: Pick<CollaborationTodo, 'revision' | 'status'> | null | undefined
  activeCount: number
  doneCount: number
  showDone: boolean
  loading: boolean
  error?: string | undefined
  hasPrevious: boolean
  hasNext: boolean
  disabled: boolean
  reveal?:
    | {
        todoId: string
        revision: number
        navigationId: string
        selection?: TodoCommentAnchor['selection']
      }
    | undefined
  addedDrafts: ReadonlySet<string>
  answerDrafts?: ReadonlyMap<string, AnchoredComment> | undefined
  onShowDone: (value: boolean) => void
  onPrevious: () => void
  onNext: () => void
  onRetry: () => void
  onReadDetail: (todo: CollaborationTodoRow) => Promise<CollaborationTodoDetail | undefined>
  onAddComment: (draft: TodoCommentDraft) => Promise<CommentDraftSaveOutcome>
  onEditorChange: (editing: boolean) => void
  onNotice: (message: string) => void
  onOpenProjectFile: (target: ProjectFileTarget) => void
}): React.JSX.Element {
  const [expanded, setExpanded] = useState<string>()
  const [detail, setDetail] = useState<CollaborationTodoDetail>()
  const [detailError, setDetailError] = useState(false)
  const [reading, setReading] = useState(false)
  const [editor, setEditor] = useState<TodoEditor>()
  const [saving, setSaving] = useState(false)
  const [info, setInfo] = useState<{ key: string; scope: string }>()
  const infoScope = `${taskId}:${showDone}:${ledgerRevision}`
  const activeInfo = info?.scope === infoScope ? info.key : undefined
  useEffect(() => {
    if (!activeInfo) return undefined
    const dismiss = (): void => setInfo(undefined)
    const keyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') dismiss()
    }
    const pointerDown = (event: PointerEvent): void => {
      const trigger = rowRefs.current.get(activeInfo)?.querySelector('[data-pact-done-reason]')
      if (!(event.target instanceof Node) || !trigger?.contains(event.target)) dismiss()
    }
    document.addEventListener('keydown', keyDown)
    document.addEventListener('pointerdown', pointerDown, true)
    document.addEventListener('scroll', dismiss, true)
    window.addEventListener('blur', dismiss)
    window.addEventListener('resize', dismiss)
    return () => {
      document.removeEventListener('keydown', keyDown)
      document.removeEventListener('pointerdown', pointerDown, true)
      document.removeEventListener('scroll', dismiss, true)
      window.removeEventListener('blur', dismiss)
      window.removeEventListener('resize', dismiss)
    }
  }, [activeInfo])
  const pendingAdd = useRef<{ draft: TodoCommentDraft; editor: TodoEditor } | undefined>(undefined)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const rowRefs = useRef(new Map<string, HTMLLIElement>())
  const appliedNavigation = useRef<string | undefined>(undefined)
  const pendingReveal = useRef<string | undefined>(undefined)
  const owner = useRef({
    active: true,
    pending: false,
    desired: undefined as CollaborationTodoRow | undefined,
  })
  const readDetail = useEffectEvent(onReadDetail)
  const revealedItem = reveal
    ? [sourceTodo, ...items].find(
        (item) => item?.id === reveal.todoId && item.revision === reveal.revision,
      )
    : undefined
  const navigationId = reveal?.navigationId
  const revealedKey = reveal ? `${reveal.todoId}:${reveal.revision}` : undefined
  const revealSelection = Boolean(reveal?.selection)
  const editorMissing = editor && !items.some((item) => todoKey(item) === todoKey(editor.todo))
  // At most one referenced version and one unsaved editor source, separate from the 24-row page.
  const pinnedItems = [sourceTodo, editorMissing ? editor.todo : undefined].filter(
    (item, index, rows): item is CollaborationTodoRow =>
      Boolean(
        item && rows.findIndex((other) => other && todoKey(other) === todoKey(item)) === index,
      ),
  )
  const pinnedKeys = new Set(pinnedItems.map(todoKey))
  const groupedItems = items.filter(
    (item) => (item.status === 'done') === showDone && !pinnedKeys.has(todoKey(item)),
  )
  const displayItems = [...pinnedItems, ...groupedItems]
  const selected = displayItems.find((item) => todoKey(item) === expanded)
  const alignTodo = useCallback((key: string): boolean => {
    const row = rowRefs.current.get(key)
    const scrollHost = row?.closest<HTMLElement>('[data-pact-context-scroll]')
    if (!row || !scrollHost) return false
    if (
      textarea.current &&
      row.contains(textarea.current) &&
      document.activeElement === textarea.current
    )
      return false
    const inset = Number.parseFloat(getComputedStyle(scrollHost).paddingTop) || 0
    scrollHost.scrollTo({
      top: Math.max(
        0,
        scrollHost.scrollTop +
          row.getBoundingClientRect().top -
          scrollHost.getBoundingClientRect().top -
          inset,
      ),
      behavior: 'instant',
    })
    return true
  }, [])
  const handleDetailReady = useCallback((): (() => void) | undefined => {
    // Opening a row can be clamped while its detail/Markdown reads are pending.
    // Complete that one reveal only after the document's actual DOM is ready.
    if (active && expanded && pendingReveal.current === expanded) {
      if (revealSelection && expanded === revealedKey) pendingReveal.current = undefined
      else if (alignTodo(expanded)) pendingReveal.current = undefined
    }
    if (!active || !reveal?.selection || expanded !== `${reveal.todoId}:${reveal.revision}`)
      return undefined
    const content = rowRefs.current
      .get(expanded)
      ?.querySelector<HTMLElement>('[data-pact-message-content]')
    if (
      !content ||
      !focusProjectionRange(content, reveal.selection.startOffset, reveal.selection.endOffset)
    )
      return undefined
    const selectedRange = window.getSelection()?.getRangeAt(0)
    return () => {
      const current = window.getSelection()
      if (selectedRange && current?.rangeCount && current.getRangeAt(0) === selectedRange)
        clearProjectionHighlight()
    }
  }, [active, reveal, expanded, revealSelection, revealedKey, alignTodo])
  useEffect(() => {
    const current = owner.current
    current.active = true
    return () => {
      current.active = false
      current.desired = undefined
      onEditorChange(false)
    }
  }, [onEditorChange])
  useEffect(() => {
    onEditorChange(Boolean(editor?.body.trim() || editor?.optionIndex !== undefined))
  }, [editor, onEditorChange])
  useEffect(() => {
    const current = owner.current
    current.desired = active ? selected : undefined
    const read = async (): Promise<void> => {
      if (!current.active || current.pending || !current.desired) return
      const requested = current.desired
      current.pending = true
      setReading(true)
      setDetailError(false)
      try {
        const next = await readDetail(requested)
        if (!current.active || current.desired !== requested) return
        setDetail(next)
        setDetailError(!next)
      } catch {
        if (current.active && current.desired === requested) setDetailError(true)
      } finally {
        current.pending = false
        if (current.active && current.desired !== requested) void read()
        else if (current.active) setReading(false)
      }
    }
    void read()
  }, [selected, active])
  const editorRequestId = editor?.requestId
  useLayoutEffect(() => {
    if (active && editorRequestId && textarea.current)
      textarea.current.focus({ preventScroll: true })
  }, [editorRequestId, active])
  useLayoutEffect(() => {
    if (!active || !navigationId || !revealedItem || appliedNavigation.current === navigationId)
      return
    appliedNavigation.current = navigationId
    pendingReveal.current = todoKey(revealedItem)
    // Reveal the exact version before measuring the committed expanded row.
    setExpanded(todoKey(revealedItem))
  }, [active, navigationId, revealedItem])
  useLayoutEffect(() => {
    if (navigationId && appliedNavigation.current !== navigationId) return
    if (!active || !expanded || (pendingReveal.current && pendingReveal.current !== expanded))
      return
    const row = rowRefs.current.get(expanded)
    if (!row) return
    // Keep a restored selection or an active Comment editor's focus and position.
    if (
      textarea.current &&
      row.contains(textarea.current) &&
      document.activeElement === textarea.current
    )
      return
    if (!revealSelection || expanded !== revealedKey)
      row
        .querySelector<HTMLButtonElement>('[data-pact-todo-toggle]')
        ?.focus({ preventScroll: true })
    alignTodo(expanded)
  }, [active, expanded, navigationId, revealedKey, revealSelection, alignTodo])
  const navigate = (action: () => void): void => {
    if (editor && (editor.body.trim() || editor.optionIndex !== undefined)) {
      onNotice('Add this Comment to the draft or cancel before changing Todo groups or pages.')
      return
    }
    setEditor(undefined)
    setInfo(undefined)
    action()
  }
  const open = (todo: CollaborationTodoRow): void => {
    if (
      editor &&
      (editor.todoId !== todo.id || editor.revision !== todo.revision) &&
      (editor.body.trim() || editor.optionIndex !== undefined)
    ) {
      onNotice('Add this Comment to the draft or cancel before opening another Todo.')
      return
    }
    pendingReveal.current = expanded === todoKey(todo) ? undefined : todoKey(todo)
    setExpanded((current) => (current === todoKey(todo) ? undefined : todoKey(todo)))
  }
  const savedAnswer = (todo: CollaborationTodoRow): AnchoredComment | undefined => {
    const draft = answerDrafts?.get(`${todo.taskId}:${todoKey(todo)}`)
    return draft?.anchor.type === 'todo' &&
      draft.anchor.question?.id === todo.question?.id &&
      draft.anchor.question?.revision === todo.question?.revision
      ? draft
      : undefined
  }
  const startComment = (
    todo: CollaborationTodoRow,
    answer = false,
    source?: { quote: string; selection: NonNullable<TodoCommentAnchor['selection']> },
  ): void => {
    if (source && editor && (editor.body.trim() || editor.optionIndex !== undefined)) {
      onNotice('Add the current Comment to the draft or cancel before changing its source.')
      return
    }
    if (
      editor &&
      (editor.todoId !== todo.id ||
        editor.revision !== todo.revision ||
        editor.answer !== answer) &&
      (editor.body.trim() || editor.optionIndex !== undefined)
    ) {
      onNotice('Add this Comment to the draft or cancel before editing another Todo.')
      return
    }
    const draft = answer ? savedAnswer(todo) : undefined
    const anchor = draft?.anchor.type === 'todo' ? draft.anchor : undefined
    const optionIndex = anchor?.question?.optionIndex
    const option = optionIndex === undefined ? undefined : todo.question?.options[optionIndex]
    const body =
      option && draft?.body.startsWith(option)
        ? draft.body.slice(option.length).trimStart()
        : (draft?.body ?? '')
    setExpanded(todoKey(todo))
    setEditor((current) =>
      current?.todoId === todo.id && current.revision === todo.revision && current.answer === answer
        ? { ...current, answer, ...(source ? source : {}) }
        : {
            todo,
            todoId: todo.id,
            revision: todo.revision,
            requestId: crypto.randomUUID(),
            ...(draft ? { commentId: draft.id } : {}),
            body,
            optionIndex,
            answer,
            ...(anchor?.quote ? { quote: anchor.quote } : {}),
            ...(anchor?.selection ? { selection: anchor.selection } : {}),
            ...(source ? source : {}),
          },
    )
  }
  const add = async (): Promise<void> => {
    if (!editor || saving || disabled) return
    const todo = editor.todo
    let pending = pendingAdd.current
    if (!pending || pending.editor.requestId !== editor.requestId) {
      const option =
        editor.optionIndex === undefined ? undefined : todo.question?.options[editor.optionIndex]
      const body = [option, editor.body.trim()].filter(Boolean).join('\n\n')
      if (!body) return
      pending = {
        editor,
        draft: {
          requestId: editor.requestId,
          ...(editor.commentId ? { commentId: editor.commentId } : {}),
          todo,
          body,
          ...(editor.quote ? { quote: editor.quote } : {}),
          ...(editor.selection ? { selection: editor.selection } : {}),
          ...(editor.answer && todo.question
            ? {
                answer: {
                  questionId: todo.question.id,
                  questionRevision: todo.question.revision,
                  ...(editor.optionIndex === undefined ? {} : { optionIndex: editor.optionIndex }),
                },
              }
            : {}),
        },
      }
      pendingAdd.current = pending
    }
    const submitted = pending.editor
    setSaving(true)
    try {
      const saved = await onAddComment(pending.draft)
      if (typeof saved === 'object') {
        pendingAdd.current = undefined
        setEditor((current) =>
          current?.requestId === submitted.requestId
            ? { ...current, requestId: crypto.randomUUID() }
            : current,
        )
      } else if (commentDraftSaveSucceeded(saved)) {
        pendingAdd.current = undefined
        setEditor((current) =>
          current?.requestId === submitted.requestId
            ? current === submitted
              ? undefined
              : {
                  ...current,
                  commentId:
                    typeof saved === 'string'
                      ? saved
                      : (submitted.commentId ?? submitted.requestId),
                  requestId: crypto.randomUUID(),
                }
            : current,
        )
      }
    } finally {
      setSaving(false)
    }
  }
  const renderTodo = (todo: CollaborationTodoRow): React.JSX.Element => {
    const displayContext = {
      taskId: todo.taskId,
      runId: todo.sourceRunId,
      todoId: todo.id,
      questionId: todo.question?.id,
      documentId: todo.document.id,
      documentHash: todo.document.sha256,
    }
    const readableTitle = readableCollaborationText(todo.title, displayContext)
    const key = todoKey(todo)
    const isOpen = expanded === key
    const isEditing = editor?.todoId === todo.id && editor.revision === todo.revision
    const answerDraft = savedAnswer(todo)
    const isReference = pinnedKeys.has(key)
    const currentVersion = isReference
      ? sourceTodo && todoKey(sourceTodo) === key
        ? (sourceCurrent ??
          items.find(
            (item) =>
              item.taskId === todo.taskId && item.id === todo.id && item.revision >= todo.revision,
          ))
        : items.find(
            (item) =>
              item.taskId === todo.taskId && item.id === todo.id && item.revision >= todo.revision,
          )
      : undefined
    const historical = Boolean(currentVersion && currentVersion.revision > todo.revision)
    const needsAnswer =
      todo.status === 'open' &&
      todo.needsUserAnswer &&
      (!isReference || currentVersion?.revision === todo.revision)
    const detailCurrent =
      isOpen && detail?.todo.id === todo.id && detail.todo.revision === todo.revision
    const Status =
      todo.status === 'done'
        ? Check
        : todo.status === 'awaiting_review'
          ? RotateCcw
          : needsAnswer
            ? CircleHelp
            : Circle
    const label = isReference
      ? `${historical ? 'Then' : currentVersion ? 'Current' : 'Recorded'}: ${statusName(todo.status)}`
      : needsAnswer
        ? todo.kind === 'decision'
          ? 'Your decision'
          : 'Your input'
        : statusName(todo.status)
    return (
      <li
        key={key}
        ref={(element) => {
          if (element) rowRefs.current.set(key, element)
          else rowRefs.current.delete(key)
        }}
        data-pact-todo-id={todo.id}
        data-pact-todo-revision={todo.revision}
        className="py-1.5"
      >
        <div className="flex min-h-8 items-start gap-2">
          <Status
            aria-label={label}
            className={`mt-2 size-3.5 shrink-0 ${needsAnswer ? 'text-status-warning-foreground' : 'text-secondary'}`}
            strokeWidth={1.75}
          />
          <button
            type="button"
            data-pact-todo-toggle
            aria-expanded={isOpen}
            onClick={() => open(todo)}
            className="flex min-h-8 min-w-0 flex-1 items-start gap-2 rounded-control px-0.5 py-1.5 text-left focus-visible:outline-2 focus-visible:outline-focus"
          >
            <span className="min-w-0 flex-1 break-words">
              <span className="block text-body font-medium text-primary">{readableTitle}</span>
              {isReference ? (
                <span className="mt-1 block text-caption font-normal text-secondary">
                  <span className="block">
                    {historical
                      ? 'Historical version'
                      : currentVersion
                        ? 'Current version'
                        : 'Referenced version'}
                    {` · v${todo.revision} · ${label}`}
                  </span>
                  {historical ? (
                    <span className="mt-1 block">
                      Current status: {statusName(currentVersion!.status)} · v
                      {currentVersion!.revision}
                    </span>
                  ) : null}
                </span>
              ) : null}
            </span>
            {!isReference ? (
              <span className="mt-0.5 shrink-0 text-caption font-normal text-secondary">
                {label}
              </span>
            ) : null}
            <ChevronDown
              aria-hidden="true"
              className={`mt-0.5 size-3.5 shrink-0 text-secondary ${isOpen ? 'rotate-180' : ''}`}
              strokeWidth={1.75}
            />
          </button>
          {todo.status === 'done' ? (
            <span
              data-pact-done-reason
              className="relative mt-1 shrink-0"
              onPointerEnter={() => setInfo({ key, scope: infoScope })}
              onPointerLeave={() =>
                setInfo((current) => (current?.key === key ? undefined : current))
              }
            >
              <button
                type="button"
                aria-label={
                  historical
                    ? `Why ${readableTitle} was Done in v${todo.revision}`
                    : `Why ${readableTitle} is Done`
                }
                aria-describedby={`todo-reason-${key}`}
                onFocus={(event) => {
                  if (event.currentTarget.matches(':focus-visible'))
                    setInfo({ key, scope: infoScope })
                }}
                onBlur={() => setInfo((current) => (current?.key === key ? undefined : current))}
                onClick={() =>
                  setInfo((current) =>
                    current?.key === key && current.scope === infoScope
                      ? undefined
                      : { key, scope: infoScope },
                  )
                }
                className="grid size-7 place-items-center rounded-control text-secondary hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-focus"
              >
                <Info aria-hidden="true" className="size-3.5" strokeWidth={1.75} />
              </button>
              <span
                id={`todo-reason-${key}`}
                role="tooltip"
                className={`pointer-events-none absolute right-0 top-full z-20 mt-1 w-64 max-w-[calc(100cqw-2rem)] rounded-control bg-surface-inverse px-3 py-2 text-caption text-inverse ${activeInfo === key ? 'block' : 'hidden'}`}
              >
                {readableCollaborationText(
                  todo.resolutionReasonPreview || 'Open this Todo to read its recorded resolution.',
                  displayContext,
                )}
              </span>
            </span>
          ) : null}
        </div>
        {isOpen ? (
          <div className="ml-5 pb-2 pl-0.5">
            <p className="mb-2 text-caption text-secondary">
              {agentName(todo.author)}
              {needsAnswer && todo.answerResolver
                ? ` · Answer to ${agentName(todo.answerResolver)}`
                : ''}
            </p>
            {detailCurrent && active ? (
              <CollaborationDocumentView
                sessionId={sessionId}
                runId={detail.runId}
                source={detail.document}
                displayContext={displayContext}
                messageId={detail.messageId}
                aroundOffset={
                  reveal?.todoId === todo.id && reveal.revision === todo.revision
                    ? reveal.selection?.startOffset
                    : undefined
                }
                basis={
                  reveal?.todoId === todo.id && reveal.revision === todo.revision
                    ? reveal.selection?.textBasis
                    : undefined
                }
                onReady={handleDetailReady}
                onCreateComment={(selection) =>
                  startComment(todo, false, {
                    quote: selection.quote,
                    selection: {
                      contentHash: selection.contentHash,
                      textBasis: selection.textBasis,
                      startOffset: selection.startOffset,
                      endOffset: selection.endOffset,
                    },
                  })
                }
                onOpenProjectFile={onOpenProjectFile}
              />
            ) : reading ? (
              <output className="flex items-center gap-2 text-caption text-secondary">
                <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />
                Loading Todo…
              </output>
            ) : detailError ? (
              <p role="alert" className="text-caption text-secondary">
                Todo details could not be loaded.{' '}
                <button
                  type="button"
                  className="underline"
                  onClick={() => {
                    setExpanded(undefined)
                    requestAnimationFrame(() => setExpanded(key))
                  }}
                >
                  Try again
                </button>
              </p>
            ) : null}
            {!isEditing ? (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {todo.question && needsAnswer ? (
                  <button
                    type="button"
                    disabled={disabled || !detailCurrent}
                    onClick={() => startComment(detailCurrent ? detail.todo : todo, true)}
                    className="min-h-7 rounded-control bg-surface-inverse px-2.5 text-caption font-medium text-inverse hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-default disabled:opacity-45"
                  >
                    {answerDraft ? 'Edit answer' : 'Add your answer'}
                  </button>
                ) : null}
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => startComment(todo)}
                  className="inline-flex min-h-7 items-center gap-1.5 rounded-control border border-border-strong bg-surface-muted px-2.5 text-caption font-medium text-primary hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-default disabled:opacity-45"
                >
                  <MessageSquarePlus aria-hidden="true" className="size-3.5" strokeWidth={1.75} />
                  Comment on Todo
                </button>
                {addedDrafts.has(key) ? (
                  <span className="text-caption text-secondary">In draft · not sent</span>
                ) : null}
              </div>
            ) : (
              <div className="mt-group">
                {editor.quote && (!editor.answer || editor.selection) ? (
                  <p
                    className="mb-2 line-clamp-2 text-caption text-secondary"
                    title={readableCollaborationText(editor.quote, displayContext)}
                  >
                    “{readableCollaborationText(editor.quote, displayContext)}”
                  </p>
                ) : null}
                {editor.answer && editor.todo.question?.type === 'choice' ? (
                  <fieldset disabled={disabled} className="mb-2 space-y-1">
                    <legend className="sr-only">Your answer</legend>
                    {editor.todo.question.options.map((option, index) => {
                      const isSelected = editor.optionIndex === index
                      const Choice = isSelected ? CircleDot : Circle
                      return (
                        <button
                          key={`${editor.todo.question!.id}:${option}`}
                          type="button"
                          aria-pressed={isSelected}
                          title={isSelected ? 'Click again to clear this choice' : undefined}
                          onClick={() =>
                            setEditor({
                              ...editor,
                              optionIndex: isSelected ? undefined : index,
                            })
                          }
                          className={`flex min-h-8 w-full cursor-pointer items-start gap-2 rounded-control px-2 py-1.5 text-left text-caption text-primary focus-visible:outline-2 focus-visible:outline-focus ${isSelected ? 'bg-surface-muted' : 'hover:bg-surface-muted'}`}
                        >
                          <Choice
                            aria-hidden="true"
                            className={`mt-0.5 size-3.5 shrink-0 ${isSelected ? 'text-focus' : 'text-secondary'}`}
                            strokeWidth={1.75}
                          />
                          <span className="min-w-0 flex-1 break-words">{option}</span>
                          {editor.todo.question!.recommended === index ? (
                            <span className="mt-0.5 shrink-0 whitespace-nowrap rounded-control bg-surface-raised px-1.5 text-caption text-secondary">
                              Recommended
                            </span>
                          ) : null}
                        </button>
                      )
                    })}
                  </fieldset>
                ) : null}
                <textarea
                  ref={textarea}
                  value={editor.body}
                  aria-label={editor.answer ? 'Todo answer' : 'Todo comment'}
                  placeholder={
                    editor.answer && editor.todo.question?.type === 'choice'
                      ? 'Additional explanation, or your own answer…'
                      : editor.answer
                        ? 'Your answer…'
                        : 'What should the Agent consider?'
                  }
                  disabled={disabled}
                  onChange={(event) => setEditor({ ...editor, body: event.target.value })}
                  className="block min-h-20 max-h-40 w-full resize-y rounded-control border border-border bg-surface-raised px-3 py-2 text-body text-primary placeholder:text-tertiary focus-visible:outline-2 focus-visible:outline-focus"
                />
                <div className="mt-2 flex items-center gap-2">
                  <button
                    type="button"
                    disabled={
                      disabled ||
                      saving ||
                      (!editor.body.trim() && editor.optionIndex === undefined)
                    }
                    onClick={() => void add()}
                    className="min-h-8 rounded-control bg-surface-inverse px-3 text-caption font-medium text-inverse focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:opacity-45"
                  >
                    {saving ? 'Adding…' : 'Add to comment'}
                  </button>
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => setEditor(undefined)}
                    className="inline-flex min-h-8 items-center gap-1 rounded-control px-2 text-caption text-secondary hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-focus"
                  >
                    <X aria-hidden="true" className="size-3.5" strokeWidth={1.75} />
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : null}
      </li>
    )
  }
  return (
    <section
      aria-label="Shared Todos"
      data-pact-task-id={taskId}
      data-pact-ledger-revision={ledgerRevision}
      className="min-w-0 text-body"
    >
      {pinnedItems.length ? (
        <section
          aria-label="Referenced Todo versions"
          className="mb-3 border-b border-border/60 pb-2"
        >
          <ol className="divide-y divide-border/60">{pinnedItems.map(renderTodo)}</ol>
        </section>
      ) : null}
      <div className="mb-2 flex min-h-7 items-center justify-between gap-2 text-caption text-secondary">
        <span>{showDone ? `Done · ${doneCount}` : `Pending · ${activeCount}`}</span>
        {showDone ? (
          <button
            type="button"
            onClick={() => navigate(() => onShowDone(false))}
            className="rounded-control px-2 py-1 hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-focus"
          >
            Show pending
          </button>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="mb-group text-caption text-status-danger-foreground">
          {error}{' '}
          <button type="button" onClick={onRetry} className="underline">
            Try again
          </button>
        </p>
      ) : null}
      <ol className="divide-y divide-border/60" aria-busy={loading}>
        {groupedItems.map(renderTodo)}
      </ol>
      {!loading && !groupedItems.length && !error ? (
        <p className="py-group text-caption text-secondary">
          {showDone ? 'No completed Todos.' : 'No pending Todos.'}
        </p>
      ) : null}
      {hasPrevious || hasNext ? (
        <nav
          aria-label="Todo pages"
          className="mt-group flex justify-between text-caption text-secondary"
        >
          <button
            type="button"
            disabled={!hasPrevious || loading}
            onClick={() => navigate(onPrevious)}
            className="min-h-8 rounded-control px-2 hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-40"
          >
            Previous
          </button>
          <button
            type="button"
            disabled={!hasNext || loading}
            onClick={() => navigate(onNext)}
            className="min-h-8 rounded-control px-2 hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-40"
          >
            Next
          </button>
        </nav>
      ) : null}
      {!showDone && doneCount > 0 ? (
        <button
          type="button"
          onClick={() => navigate(() => onShowDone(true))}
          className="mt-group flex min-h-8 w-full items-center justify-between rounded-control px-1 text-caption text-secondary hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-focus"
        >
          <span>Done · {doneCount}</span>
          <ChevronDown aria-hidden="true" className="size-3.5" strokeWidth={1.75} />
        </button>
      ) : null}
    </section>
  )
}
