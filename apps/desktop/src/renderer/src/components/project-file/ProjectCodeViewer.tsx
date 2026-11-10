import { MessageCirclePlus } from 'lucide-react'
import * as monaco from 'monaco-editor/editor/editor.api.js'
// oxlint-disable-next-line import/no-unassigned-import -- Monaco's icon font and glyph rules are stylesheet side effects.
import 'monaco-editor/features/codicon/register.js'
// Vite's `?worker` transform supplies these default constructors at bundle time.
// oxlint-disable-next-line import/default
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker'
import { useEffect, useRef, useState } from 'react'

import { IPC_TRAFFIC_UNIT, MAX_COMMENT_QUOTE_LENGTH } from '@pact/contracts'

import { measureMonacoWorkerMessage } from '../../../../shared/logical-ipc-traffic'
import { resolveFileLocation, type FileLocation } from './file-location'
import {
  loadProjectFileLanguage,
  type ProjectFileLanguageSupport,
} from './project-file-language-loader'

// Leave room for Monaco's 16px folding icons as well as its 11px diff signs.
const CODE_DECORATION_WIDTH = 20

interface ProjectCodeViewerProps {
  path: string
  content: string
  language: string
  location?: FileLocation | undefined
  onCreateComment?:
    | ((selection: {
        startLine: number
        startColumn: number
        endLine: number
        endColumn: number
        quote: string
      }) => void)
    | undefined
}

interface CodeSelectionAction {
  left: number
  top: number
  range: monaco.IRange
  tooLarge: boolean
}

export function ProjectCodeViewer({
  path,
  content,
  language,
  location,
  onCreateComment,
}: ProjectCodeViewerProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | undefined>(undefined)
  const modelRef = useRef<monaco.editor.ITextModel | undefined>(undefined)
  const decorationsRef = useRef<monaco.editor.IEditorDecorationsCollection | undefined>(undefined)
  const onCreateCommentRef = useRef(onCreateComment)
  const confirmCommentRef = useRef<((range: monaco.IRange) => void) | undefined>(undefined)
  const locationRef = useRef(location)
  const [selectionAction, setSelectionAction] = useState<CodeSelectionAction | undefined>()
  const [ready, setReady] = useState(false)
  const [loadError, setLoadError] = useState<Error | undefined>()

  useEffect(() => {
    onCreateCommentRef.current = onCreateComment
  }, [onCreateComment])

  useEffect(() => {
    locationRef.current = location
  }, [location])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return undefined
    let cancelled = false
    let cleanupEditor: (() => void) | undefined
    setReady(false)
    const createEditor = (support: ProjectFileLanguageSupport | undefined): void => {
      if (cancelled) {
        support?.release()
        return
      }
      const workers = createWorkerEnvironment(support)
      let model: monaco.editor.ITextModel | undefined
      let editor: monaco.editor.IStandaloneCodeEditor | undefined
      let selectionListener: monaco.IDisposable | undefined
      let scrollListener: monaco.IDisposable | undefined
      let layoutListener: monaco.IDisposable | undefined
      let commentAction: monaco.IDisposable | undefined
      let themeObserver: MutationObserver | undefined
      let systemTheme: MediaQueryList | undefined
      let disposed = false
      const syncTheme = (): void => monaco.editor.setTheme(activeTheme())
      const dispose = (): void => {
        if (disposed) return
        disposed = true
        themeObserver?.disconnect()
        systemTheme?.removeEventListener('change', syncTheme)
        selectionListener?.dispose()
        scrollListener?.dispose()
        layoutListener?.dispose()
        decorationsRef.current?.clear()
        decorationsRef.current = undefined
        editorRef.current = undefined
        modelRef.current = undefined
        confirmCommentRef.current = undefined
        editor?.dispose()
        commentAction?.dispose()
        model?.dispose()
        support?.release()
        workers.dispose()
      }
      cleanupEditor = dispose
      try {
        definePactThemes()
        workers.install()
        const currentModel = monaco.editor.createModel(
          content,
          language,
          monaco.Uri.from({ scheme: 'pact-project-file', path: `/${path.replace(/^\/+/, '')}` }),
        )
        model = currentModel
        const currentEditor = monaco.editor.create(host, {
          model: currentModel,
          readOnly: true,
          domReadOnly: true,
          automaticLayout: true,
          ariaLabel: `${path} source code`,
          accessibilitySupport: 'auto',
          contextmenu: true,
          folding: true,
          glyphMargin: false,
          lineDecorationsWidth: CODE_DECORATION_WIDTH,
          lineNumbersMinChars: 3,
          minimap: { enabled: false },
          overviewRulerBorder: false,
          overviewRulerLanes: 0,
          padding: { top: 12, bottom: 12 },
          renderLineHighlight: 'none',
          roundedSelection: false,
          scrollBeyondLastLine: false,
          smoothScrolling: true,
          stickyScroll: { enabled: false },
          wordWrap: 'on',
          wrappingIndent: 'indent',
          fontFamily: 'JetBrains Mono Variable, SFMono-Regular, Consolas, monospace',
          fontSize: 13,
          lineHeight: 20,
          scrollbar: {
            horizontalScrollbarSize: 9,
            verticalScrollbarSize: 9,
            useShadows: false,
          },
          theme: activeTheme(),
        })
        editor = currentEditor
        editorRef.current = currentEditor
        modelRef.current = currentModel
        const confirmComment = (range: monaco.IRange): void => {
          if (
            currentModel.getValueLengthInRange(range, monaco.editor.EndOfLinePreference.LF) >
            MAX_COMMENT_QUOTE_LENGTH
          )
            return
          const quote = currentModel.getValueInRange(range, monaco.editor.EndOfLinePreference.LF)
          if (!quote) return
          onCreateCommentRef.current?.({
            startLine: range.startLineNumber,
            startColumn: range.startColumn,
            endLine: range.endLineNumber,
            endColumn: range.endColumn,
            quote,
          })
        }
        confirmCommentRef.current = confirmComment
        const updateSelectionAction = (): void => {
          const selection = currentEditor.getSelection()
          if (!selection || selection.isEmpty() || !onCreateCommentRef.current) {
            setSelectionAction(undefined)
            return
          }
          const position = currentEditor.getScrolledVisiblePosition(selection.getEndPosition())
          if (!position) {
            setSelectionAction(undefined)
            return
          }
          const actionWidth = 128
          const actionHeight = 32
          const gap = 8
          const centeredLeft = position.left - actionWidth / 2
          const preferredTop = position.top - actionHeight - gap
          setSelectionAction({
            left: Math.max(gap, Math.min(centeredLeft, host.clientWidth - actionWidth - gap)),
            top: Math.max(
              gap,
              Math.min(
                preferredTop >= gap ? preferredTop : position.top + position.height + gap,
                host.clientHeight - actionHeight - gap,
              ),
            ),
            range: selection,
            tooLarge:
              currentModel.getValueLengthInRange(selection, monaco.editor.EndOfLinePreference.LF) >
              MAX_COMMENT_QUOTE_LENGTH,
          })
        }
        selectionListener = currentEditor.onDidChangeCursorSelection(updateSelectionAction)
        scrollListener = currentEditor.onDidScrollChange(updateSelectionAction)
        layoutListener = currentEditor.onDidLayoutChange(updateSelectionAction)
        commentAction = onCreateCommentRef.current
          ? currentEditor.addAction({
              id: 'pact.create-file-comment',
              label: 'Comment on selection',
              contextMenuGroupId: 'navigation',
              keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyC],
              run: () => {
                const selection = currentEditor.getSelection()
                if (!selection || selection.isEmpty()) return
                confirmComment(selection)
              },
            })
          : undefined

        systemTheme = window.matchMedia('(prefers-color-scheme: dark)')
        themeObserver = new MutationObserver(syncTheme)
        themeObserver.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ['data-theme'],
        })
        systemTheme.addEventListener('change', syncTheme)
        revealFileLocation(currentEditor, currentModel, locationRef.current, decorationsRef)
        setReady(true)
      } catch (error) {
        dispose()
        throw error
      }
    }
    void loadProjectFileLanguage(language)
      .then(createEditor)
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(error instanceof Error ? error : new Error(String(error)))
      })
    return () => {
      cancelled = true
      cleanupEditor?.()
    }
  }, [content, language, path])

  useEffect(() => {
    const editor = editorRef.current
    const model = modelRef.current
    if (!editor || !model) return
    revealFileLocation(editor, model, location, decorationsRef)
  }, [location])

  if (loadError) throw loadError

  return (
    <div className="relative h-full min-h-0 w-full">
      <div ref={hostRef} className="h-full min-h-0 w-full" />
      {!ready ? (
        <span
          className="absolute inset-0 grid place-items-center text-caption text-secondary"
          aria-busy="true"
        >
          Preparing code view…
        </span>
      ) : null}
      {selectionAction?.tooLarge ? (
        <output
          className="absolute z-20 rounded-control bg-surface-raised px-2.5 py-1.5 text-caption text-secondary shadow-sm"
          style={{ left: selectionAction.left, top: selectionAction.top }}
        >
          Select at most {MAX_COMMENT_QUOTE_LENGTH.toLocaleString()} characters
        </output>
      ) : selectionAction ? (
        <button
          className="absolute z-20 inline-flex h-8 w-32 items-center justify-center gap-1.5 whitespace-nowrap rounded-control bg-surface-inverse px-2.5 text-caption font-medium text-inverse shadow-popover transition-[filter] duration-150 ease-out-pact hover:brightness-95 active:brightness-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          type="button"
          style={{ left: selectionAction.left, top: selectionAction.top }}
          aria-label="Comment on selected code"
          title="Comment on selected code"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            confirmCommentRef.current?.(selectionAction.range)
            setSelectionAction(undefined)
          }}
        >
          <MessageCirclePlus aria-hidden="true" className="size-4 shrink-0" strokeWidth={1.75} />
          Add comment
        </button>
      ) : null}
    </div>
  )
}

export function ProjectDiffViewer({
  path,
  before,
  after,
  language,
}: {
  path: string
  before: string
  after: string
  language: string
}): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const [ready, setReady] = useState(false)
  const [loadError, setLoadError] = useState<Error>()
  const [timedOut, setTimedOut] = useState(false)
  useEffect(() => {
    const host = hostRef.current
    if (!host) return undefined
    let cancelled = false
    let disposeEditor: (() => void) | undefined
    setReady(false)
    setTimedOut(false)
    setLoadError(undefined)
    void loadProjectFileLanguage(language)
      .then((support) => {
        if (cancelled) {
          support?.release()
          return undefined
        }
        const workers = createWorkerEnvironment(support)
        let editor: monaco.editor.IStandaloneDiffEditor | undefined
        let original: monaco.editor.ITextModel | undefined
        let modified: monaco.editor.ITextModel | undefined
        let observer: MutationObserver | undefined
        let listener: monaco.IDisposable | undefined
        const systemTheme = window.matchMedia('(prefers-color-scheme: dark)')
        const syncTheme = (): void => monaco.editor.setTheme(activeTheme())
        disposeEditor = () => {
          observer?.disconnect()
          systemTheme.removeEventListener('change', syncTheme)
          listener?.dispose()
          editor?.dispose()
          original?.dispose()
          modified?.dispose()
          support?.release()
          workers.dispose()
        }
        try {
          definePactThemes()
          workers.install()
          original = monaco.editor.createModel(
            before,
            language,
            monaco.Uri.from({ scheme: 'pact-saved-before', path: `/${path}` }),
          )
          modified = monaco.editor.createModel(
            after,
            language,
            monaco.Uri.from({ scheme: 'pact-saved-after', path: `/${path}` }),
          )
          const currentEditor = monaco.editor.createDiffEditor(host, {
            readOnly: true,
            domReadOnly: true,
            originalEditable: false,
            automaticLayout: true,
            ariaLabel: 'Saved file changes',
            accessibilitySupport: 'auto',
            renderSideBySide: true,
            useInlineViewWhenSpaceIsLimited: true,
            renderSideBySideInlineBreakpoint: 560,
            maxComputationTime: 2_000,
            diffAlgorithm: 'advanced',
            renderOverviewRuler: false,
            ignoreTrimWhitespace: false,
            minimap: { enabled: false },
            overviewRulerBorder: false,
            overviewRulerLanes: 0,
            lineNumbersMinChars: 3,
            lineDecorationsWidth: CODE_DECORATION_WIDTH,
            glyphMargin: false,
            scrollBeyondLastLine: false,
            stickyScroll: { enabled: false },
            wordWrap: 'on',
            fontFamily: 'JetBrains Mono Variable, SFMono-Regular, Consolas, monospace',
            fontSize: 13,
            lineHeight: 20,
            padding: { top: 12, bottom: 12 },
            scrollbar: { horizontalScrollbarSize: 9, verticalScrollbarSize: 9, useShadows: false },
            theme: activeTheme(),
          })
          editor = currentEditor
          currentEditor.setModel({ original, modified })
          listener = currentEditor.onDidUpdateDiff(() => {
            if (!cancelled) setTimedOut(currentEditor.getLineChanges() === null)
          })
          observer = new MutationObserver(syncTheme)
          observer.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ['data-theme'],
          })
          systemTheme.addEventListener('change', syncTheme)
          setReady(true)
        } catch (error) {
          disposeEditor()
          disposeEditor = undefined
          throw error
        }
        return undefined
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(error instanceof Error ? error : new Error(String(error)))
      })
    return () => {
      cancelled = true
      disposeEditor?.()
    }
  }, [path, before, after, language])
  if (loadError) throw loadError
  return (
    <div className="relative flex h-full min-h-0 w-full flex-col">
      {timedOut ? (
        <output className="shrink-0 border-b border-border px-3 py-2 text-caption text-secondary">
          Diff could not be computed. Choose After to read the saved code.
        </output>
      ) : null}
      <div ref={hostRef} className="min-h-0 w-full flex-1" />
      {!ready ? (
        <span
          className="absolute inset-0 grid place-items-center text-caption text-secondary"
          aria-busy="true"
        >
          Preparing Diff…
        </span>
      ) : null}
    </div>
  )
}

function createWorkerEnvironment(support: ProjectFileLanguageSupport | undefined): {
  install: () => void
  dispose: () => void
} {
  const ownedWorkers = new Set<Worker>()
  const previous = Reflect.get(self, 'MonacoEnvironment')
  const environment = {
    getWorker(_moduleId: string, label: string): Worker {
      const worker = label === 'json' && support ? support.createWorker() : new EditorWorker()
      ownedWorkers.add(worker)
      const observe = window.pact.observeMonacoWorkerTraffic
      let removeObservation: (() => void) | undefined
      if (observe) {
        observe({ type: 'created', unit: IPC_TRAFFIC_UNIT })
        const receive = (event: MessageEvent<unknown>): void =>
          observe({
            type: 'message',
            unit: IPC_TRAFFIC_UNIT,
            category: 'monaco-renderer.reply',
            measurement: measureMonacoWorkerMessage(event.data),
          })
        const error = (): void => observe({ type: 'transport-error', unit: IPC_TRAFFIC_UNIT })
        worker.addEventListener('message', receive)
        worker.addEventListener('messageerror', error)
        worker.addEventListener('error', error)
        const post: unknown = Reflect.get(worker, 'postMessage')
        if (typeof post !== 'function') throw new Error('The browser Worker has no transport.')
        worker.postMessage = function (
          this: Worker,
          ...args: [message: unknown, options?: Transferable[] | StructuredSerializeOptions]
        ): void {
          if (this !== worker) return Reflect.apply(post, this, args)
          const measurement = measureMonacoWorkerMessage(args[0])
          try {
            Reflect.apply(post, worker, args)
            observe({
              type: 'message',
              unit: IPC_TRAFFIC_UNIT,
              category: 'renderer-monaco.request',
              measurement,
            })
          } catch (failure) {
            error()
            throw failure
          }
        }
        removeObservation = () => {
          worker.removeEventListener('message', receive)
          worker.removeEventListener('messageerror', error)
          worker.removeEventListener('error', error)
          observe({ type: 'termination-requested', unit: IPC_TRAFFIC_UNIT })
        }
      }
      const terminate = worker.terminate.bind(worker)
      worker.terminate = () => {
        if (ownedWorkers.delete(worker)) {
          terminate()
          removeObservation?.()
        }
      }
      return worker
    },
  }
  return {
    install: () => {
      Reflect.set(self, 'MonacoEnvironment', environment)
    },
    dispose: () => {
      for (const worker of ownedWorkers) worker.terminate()
      if (Reflect.get(self, 'MonacoEnvironment') === environment)
        Reflect.set(self, 'MonacoEnvironment', previous)
    },
  }
}

function revealFileLocation(
  editor: monaco.editor.IStandaloneCodeEditor,
  model: monaco.editor.ITextModel,
  location: FileLocation | undefined,
  decorations: { current: monaco.editor.IEditorDecorationsCollection | undefined },
): void {
  decorations.current?.clear()
  decorations.current = undefined
  const resolved = resolveFileLocation(location, model.getLineCount(), (lineNumber) =>
    model.getLineMaxColumn(lineNumber),
  )
  if (!resolved) return
  const range = new monaco.Range(
    resolved.lineStart,
    resolved.startColumn,
    resolved.lineEnd,
    resolved.endColumn,
  )
  if (!range.isEmpty()) {
    decorations.current = editor.createDecorationsCollection([
      { range, options: { inlineClassName: 'pact-monaco-linked-range' } },
    ])
  }
  editor.setSelection(
    new monaco.Selection(
      range.startLineNumber,
      range.startColumn,
      range.endLineNumber,
      range.endColumn,
    ),
  )
  editor.revealRangeInCenter(range, monaco.editor.ScrollType.Immediate)
}

function activeTheme(): 'pact-light' | 'pact-dark' {
  const selectedTheme = document.documentElement.dataset.theme
  if (selectedTheme === 'dark') return 'pact-dark'
  if (selectedTheme === 'light') return 'pact-light'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'pact-dark' : 'pact-light'
}

function definePactThemes(): void {
  monaco.editor.defineTheme('pact-light', {
    base: 'vs',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#FAFDFF',
      'editor.foreground': '#0A0D12',
      'editorLineNumber.foreground': '#7A8793',
      'editorLineNumber.activeForeground': '#36424E',
      'editor.selectionBackground': '#B9DBFF88',
      'editor.inactiveSelectionBackground': '#D8EAFA88',
      'editorCursor.foreground': '#0069E0',
      'editorIndentGuide.background1': '#DDE7EF',
      'diffEditor.insertedLineBackground': '#E5F8ED',
      'diffEditor.removedLineBackground': '#FFF0EE',
    },
  })
  monaco.editor.defineTheme('pact-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#1D2A36',
      'editor.foreground': '#F2F7FB',
      'editorLineNumber.foreground': '#728395',
      'editorLineNumber.activeForeground': '#C4D0DB',
      'editor.selectionBackground': '#245E9188',
      'editor.inactiveSelectionBackground': '#24456088',
      'editorCursor.foreground': '#67B1FF',
      'editorIndentGuide.background1': '#2B3A48',
      'diffEditor.insertedLineBackground': '#17392B',
      'diffEditor.removedLineBackground': '#402421',
    },
  })
}
