import { MessageCirclePlus } from 'lucide-react'
import * as monaco from 'monaco-editor/editor/editor.api.js'
// oxlint-disable-next-line import/no-unassigned-import -- Monaco's icon font and glyph rules are stylesheet side effects.
import 'monaco-editor/features/codicon/register.js'
// Vite's `?worker` transform supplies these default constructors at bundle time.
// oxlint-disable-next-line import/default
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker'
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'

import { IPC_TRAFFIC_UNIT, MAX_COMMENT_QUOTE_LENGTH } from '@pact/contracts'

import { measureMonacoWorkerMessage } from '../../../../shared/logical-ipc-traffic'
import { resolveFileLocation, type FileLocation } from './file-location'
import {
  loadProjectFileLanguage,
  type ProjectFileLanguageSupport,
} from './project-file-language-loader'

// Leave room for Monaco's 16px folding icons as well as its 11px diff signs.
const CODE_DECORATION_WIDTH = 20
const DIFF_DECORATION_WIDTH = 26
// Bounded LRU model pool: <= 16 ITextModels per code viewer, <= 8 pairs (16 models) per diff viewer.
const MAX_POOLED_MODELS = 16
const MAX_POOLED_DIFF_ENTRIES = Math.floor(MAX_POOLED_MODELS / 2)

export interface CodeCommentSelection {
  startLine: number
  startColumn: number
  endLine: number
  endColumn: number
  quote: string
}

export interface RenderedViewerTarget {
  path: string
  contentHash: string
  beforeContentHash?: string | undefined
}

interface ProjectCodeViewerProps {
  path: string
  content: string
  contentHash?: string | undefined
  language: string
  location?: FileLocation | undefined
  openRequest?: unknown
  onCreateComment?: ((selection: CodeCommentSelection) => void) | undefined
  onRenderedTargetChange?: ((mounted: RenderedViewerTarget | undefined) => void) | undefined
}

interface ProjectDiffViewerProps {
  path: string
  before: string
  after: string
  beforeContentHash?: string | undefined
  afterContentHash?: string | undefined
  language: string
  onCreateComment?: ((selection: CodeCommentSelection) => void) | undefined
  onRenderedTargetChange?: ((mounted: RenderedViewerTarget | undefined) => void) | undefined
}

interface CodeSelectionAction {
  targetKey: string
  left: number
  top: number
  range: monaco.IRange
  tooLarge: boolean
}

interface MountedCodeModel {
  model: monaco.editor.ITextModel
  path: string
  content: string
  contentHash: string
  language: string
  targetKey: string
}

interface MountedDiffModel {
  modified: monaco.editor.ITextModel
  path: string
  before: string
  after: string
  beforeContentHash: string
  afterContentHash: string
  language: string
  targetKey: string
}

interface PooledCodeEntry {
  model: monaco.editor.ITextModel
  viewState: monaco.editor.ICodeEditorViewState | null
  content: string
  language: string
}

interface PooledDiffEntry {
  original: monaco.editor.ITextModel
  modified: monaco.editor.ITextModel
  viewState: monaco.editor.IDiffEditorViewState | null
  before: string
  after: string
  language: string
}

const loadedBasicLanguages = new Set<string>(['plaintext'])
const jsonWorkerLeases = new Set<{ createWorker: () => Worker }>()
const activeWorkers = new Set<Worker>()

interface CodeTargetProps {
  path: string
  content: string
  contentHash: string
  language: string
  targetKey: string
  onCreateComment?: ((selection: CodeCommentSelection) => void) | undefined
}

interface DiffTargetProps {
  path: string
  before: string
  after: string
  beforeContentHash: string
  afterContentHash: string
  language: string
  targetKey: string
  onCreateComment?: ((selection: CodeCommentSelection) => void) | undefined
}

function isCodeModelAligned(
  editor: monaco.editor.IStandaloneCodeEditor | undefined,
  mounted: MountedCodeModel | undefined,
  target: CodeTargetProps,
): boolean {
  return Boolean(
    editor &&
    mounted &&
    mounted.model === editor.getModel() &&
    mounted.path === target.path &&
    mounted.content === target.content &&
    mounted.contentHash === target.contentHash &&
    mounted.targetKey === target.targetKey,
  )
}

function isDiffModelAligned(
  diffEditor: monaco.editor.IStandaloneDiffEditor | undefined,
  mounted: MountedDiffModel | undefined,
  target: DiffTargetProps,
): boolean {
  return Boolean(
    diffEditor &&
    mounted &&
    mounted.modified === diffEditor.getModel()?.modified &&
    mounted.path === target.path &&
    mounted.before === target.before &&
    mounted.after === target.after &&
    mounted.beforeContentHash === target.beforeContentHash &&
    mounted.afterContentHash === target.afterContentHash &&
    mounted.targetKey === target.targetKey,
  )
}

function disposeDetachedJsonCodeModels(
  pool: Map<string, PooledCodeEntry>,
  activeModel: monaco.editor.ITextModel | undefined,
): void {
  for (const [entryKey, entry] of pool.entries()) {
    if (entry.language === 'json' && entry.model !== activeModel) {
      pool.delete(entryKey)
      entry.model.dispose()
    }
  }
}

function disposeDetachedJsonDiffModels(
  pool: Map<string, PooledDiffEntry>,
  activeOriginal: monaco.editor.ITextModel | undefined,
  activeModified: monaco.editor.ITextModel | undefined,
): void {
  for (const [entryKey, entry] of pool.entries()) {
    if (
      entry.language === 'json' &&
      entry.original !== activeOriginal &&
      entry.modified !== activeModified
    ) {
      pool.delete(entryKey)
      entry.original.dispose()
      entry.modified.dispose()
    }
  }
}
let workerEnvLeases = 0
let previousMonacoEnvironment: unknown
let installedMonacoEnvironment:
  | { getWorker: (_moduleId: string, label: string) => Worker }
  | undefined
let themesDefined = false

function normalizeModelPath(path: string): string {
  const cleaned = path.replace(/\\/gu, '/').replace(/^\/+/u, '')
  return cleaned || 'untitled'
}

function sanitizeAuthority(rawId: string): string {
  const cleaned = rawId.toLowerCase().replace(/[^a-z0-9-]/gu, '')
  return cleaned || 'viewer'
}

function computeSelectionAction(
  host: HTMLElement,
  editor: monaco.editor.ICodeEditor,
  model: monaco.editor.ITextModel,
  targetKey: string,
): CodeSelectionAction | undefined {
  const selection = editor.getSelection()
  if (!selection || selection.isEmpty()) return undefined
  const position = editor.getScrolledVisiblePosition(selection.getEndPosition())
  if (!position) return undefined
  const editorDom = editor.getDomNode()
  const hostRect = host.getBoundingClientRect()
  const editorRect = editorDom?.getBoundingClientRect()
  const offsetLeft = editorRect ? editorRect.left - hostRect.left : 0
  const offsetTop = editorRect ? editorRect.top - hostRect.top : 0
  const actionWidth = 128
  const actionHeight = 32
  const gap = 8
  const centeredLeft = offsetLeft + position.left - actionWidth / 2
  const preferredTop = offsetTop + position.top - actionHeight - gap
  return {
    targetKey,
    left: Math.max(gap, Math.min(centeredLeft, host.clientWidth - actionWidth - gap)),
    top: Math.max(
      gap,
      Math.min(
        preferredTop >= gap ? preferredTop : offsetTop + position.top + position.height + gap,
        host.clientHeight - actionHeight - gap,
      ),
    ),
    range: selection,
    tooLarge:
      model.getValueLengthInRange(selection, monaco.editor.EndOfLinePreference.LF) >
      MAX_COMMENT_QUOTE_LENGTH,
  }
}

export function ProjectCodeViewer({
  path,
  content,
  contentHash,
  language,
  location,
  openRequest,
  onCreateComment,
  onRenderedTargetChange,
}: ProjectCodeViewerProps): React.JSX.Element {
  const authority = sanitizeAuthority(useId())
  const normalizedPath = normalizeModelPath(path)
  const normalizedHash = contentHash ?? ''
  const targetKey = JSON.stringify([normalizedPath, language, normalizedHash, content.length])
  const hostRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | undefined>(undefined)
  const mountedModelRef = useRef<MountedCodeModel | undefined>(undefined)
  const targetPropsRef = useRef({
    path: normalizedPath,
    content,
    contentHash: normalizedHash,
    language,
    targetKey,
    onCreateComment,
  })
  const onRenderedTargetChangeRef = useRef(onRenderedTargetChange)
  const poolRef = useRef(new Map<string, PooledCodeEntry>())
  const activeKeyRef = useRef<string | undefined>(undefined)
  const modelVersionRef = useRef(0)
  const jsonSupportRef = useRef<ProjectFileLanguageSupport | undefined>(undefined)
  const decorationsRef = useRef<monaco.editor.IEditorDecorationsCollection | undefined>(undefined)
  const locationRef = useRef(location)
  const hadLocationRef = useRef(Boolean(location))
  const openRequestRef = useRef<unknown>(openRequest)
  const lastHandledOpenRequestRef = useRef<unknown>(undefined)
  const [selectionAction, setSelectionAction] = useState<CodeSelectionAction | undefined>()
  const [ready, setReady] = useState(false)
  const [loadError, setLoadError] = useState<Error | undefined>()

  useLayoutEffect(() => {
    targetPropsRef.current = {
      path: normalizedPath,
      content,
      contentHash: normalizedHash,
      language,
      targetKey,
      onCreateComment,
    }
    onRenderedTargetChangeRef.current = onRenderedTargetChange
  }, [
    content,
    language,
    normalizedHash,
    normalizedPath,
    onCreateComment,
    onRenderedTargetChange,
    targetKey,
  ])

  useEffect(() => {
    const isNewOpenRequest =
      openRequest !== undefined && openRequest !== lastHandledOpenRequestRef.current
    const clearedLocation = hadLocationRef.current && location === undefined
    locationRef.current = location
    openRequestRef.current = openRequest
    const editor = editorRef.current
    const mounted = mountedModelRef.current
    if (!editor || !mounted || !isCodeModelAligned(editor, mounted, targetPropsRef.current)) return
    lastHandledOpenRequestRef.current = openRequest
    hadLocationRef.current = Boolean(location)
    if (location) {
      revealFileLocation(editor, mounted.model, location, decorationsRef)
    } else if (isNewOpenRequest || clearedLocation) {
      const activeKey = activeKeyRef.current
      if (activeKey) {
        const entry = poolRef.current.get(activeKey)
        if (entry) entry.viewState = null
      }
      decorationsRef.current?.clear()
      decorationsRef.current = undefined
      editor.setSelection(new monaco.Selection(1, 1, 1, 1))
      editor.setScrollTop(0)
      editor.setScrollLeft(0)
    } else {
      revealFileLocation(editor, mounted.model, undefined, decorationsRef)
    }
  }, [location, openRequest])

  // Persistent Monaco instance: mount once, dispose only on unmount.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return undefined
    const workerEnv = acquireWorkerEnvironment()
    let editor: monaco.editor.IStandaloneCodeEditor | undefined
    let selectionListener: monaco.IDisposable | undefined
    let scrollListener: monaco.IDisposable | undefined
    let layoutListener: monaco.IDisposable | undefined
    let commentAction: monaco.IDisposable | undefined
    let themeObserver: MutationObserver | undefined
    let systemTheme: MediaQueryList | undefined
    let disposed = false
    const syncTheme = (): void => monaco.editor.setTheme(activeTheme())
    const pool = poolRef.current
    const dispose = (): void => {
      if (disposed) return
      disposed = true
      themeObserver?.disconnect()
      systemTheme?.removeEventListener('change', syncTheme)
      selectionListener?.dispose()
      scrollListener?.dispose()
      layoutListener?.dispose()
      commentAction?.dispose()
      decorationsRef.current?.clear()
      decorationsRef.current = undefined
      editorRef.current = undefined
      mountedModelRef.current = undefined
      activeKeyRef.current = undefined
      onRenderedTargetChangeRef.current?.(undefined)
      if (editor) {
        editor.setModel(null)
        editor.dispose()
      }
      for (const entry of pool.values()) entry.model.dispose()
      pool.clear()
      releaseJsonSupport(jsonSupportRef)
      workerEnv.release()
    }
    try {
      definePactThemes()
      const currentEditor = monaco.editor.create(host, {
        model: null,
        readOnly: true,
        domReadOnly: true,
        automaticLayout: true,
        ariaLabel: 'Source code',
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
      const updateSelectionAction = (): void => {
        const mounted = mountedModelRef.current
        const target = targetPropsRef.current
        if (
          !mounted ||
          !target.onCreateComment ||
          !isCodeModelAligned(currentEditor, mounted, target)
        ) {
          setSelectionAction(undefined)
          return
        }
        setSelectionAction(
          computeSelectionAction(host, currentEditor, mounted.model, target.targetKey),
        )
      }
      selectionListener = currentEditor.onDidChangeCursorSelection(updateSelectionAction)
      scrollListener = currentEditor.onDidScrollChange(updateSelectionAction)
      layoutListener = currentEditor.onDidLayoutChange(updateSelectionAction)
      commentAction = currentEditor.addAction({
        id: 'pact.create-file-comment',
        label: 'Comment on selection',
        contextMenuGroupId: 'navigation',
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyC],
        run: () => {
          const target = targetPropsRef.current
          const mounted = mountedModelRef.current
          if (
            !target.onCreateComment ||
            !mounted ||
            !isCodeModelAligned(currentEditor, mounted, target)
          )
            return
          const selection = currentEditor.getSelection()
          if (!selection || selection.isEmpty()) return
          emitSelectionComment(mounted.model, selection, target.onCreateComment)
        },
      })
      systemTheme = window.matchMedia('(prefers-color-scheme: dark)')
      themeObserver = new MutationObserver(syncTheme)
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-theme'],
      })
      systemTheme.addEventListener('change', syncTheme)
    } catch (error) {
      dispose()
      const err = error instanceof Error ? error : new Error(String(error))
      queueMicrotask(() => setLoadError(err))
    }
    return dispose
  }, [])

  // Swap pooled ITextModel + saved IEditorViewState across path/content/language changes without recreating Monaco.
  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return undefined
    let cancelled = false
    const key = normalizedPath
    setSelectionAction(undefined)

    const applyModel = (usePlaintextFallback: boolean): void => {
      if (cancelled || editorRef.current !== editor) return
      const effectiveLanguage = usePlaintextFallback ? 'plaintext' : language
      const pool = poolRef.current
      const prevKey = activeKeyRef.current
      if (prevKey && prevKey !== key) {
        const prevEntry = pool.get(prevKey)
        if (prevEntry) prevEntry.viewState = editor.saveViewState()
      }

      setSelectionAction(undefined)
      decorationsRef.current?.clear()
      decorationsRef.current = undefined

      let entry = pool.get(key)
      let contentChanged = false
      let staleModelToDispose: monaco.editor.ITextModel | undefined
      if (entry) {
        if (entry.content !== content && (entry.language === 'json' || language === 'json')) {
          // Never call setValue() on JSON models: recreate cleanly so Monaco's 500ms LSP timer is never armed.
          pool.delete(key)
          staleModelToDispose = entry.model
          entry = undefined
          contentChanged = true
        } else {
          // Refresh LRU recency.
          pool.delete(key)
          pool.set(key, entry)
          if (entry.content !== content) {
            entry.model.setValue(content)
            entry.content = content
            entry.viewState = null
            contentChanged = true
          }
          if (entry.language !== effectiveLanguage) {
            monaco.editor.setModelLanguage(entry.model, effectiveLanguage)
            entry.language = effectiveLanguage
          }
        }
      }
      if (!entry) {
        const uri = monaco.Uri.from({
          scheme: 'pact-project-file',
          authority,
          path: `/${key}`,
          ...(staleModelToDispose || language === 'json'
            ? { query: `v=${++modelVersionRef.current}` }
            : {}),
        })
        const existing = monaco.editor.getModel(uri)
        if (existing && existing !== staleModelToDispose) existing.dispose()
        const model = monaco.editor.createModel(content, effectiveLanguage, uri)
        entry = { model, viewState: null, content, language: effectiveLanguage }
        pool.set(key, entry)
      }

      if (editor.getModel() !== entry.model) {
        editor.setModel(entry.model)
      }
      staleModelToDispose?.dispose()
      mountedModelRef.current = {
        model: entry.model,
        path: key,
        content,
        contentHash: normalizedHash,
        language: effectiveLanguage,
        targetKey,
      }
      activeKeyRef.current = key
      editor.updateOptions({ ariaLabel: `${path} source code` })

      // Evict after attaching the active model so the evicted model is never attached to the editor.
      while (pool.size > MAX_POOLED_MODELS) {
        const oldestKey = pool.keys().next().value
        if (oldestKey === undefined || oldestKey === key) break
        const evicted = pool.get(oldestKey)
        pool.delete(oldestKey)
        evicted?.model.dispose()
      }

      const isExplicitUnanchoredOpen =
        locationRef.current === undefined &&
        openRequestRef.current !== undefined &&
        openRequestRef.current !== lastHandledOpenRequestRef.current
      lastHandledOpenRequestRef.current = openRequestRef.current
      hadLocationRef.current = Boolean(locationRef.current)

      if (locationRef.current) {
        revealFileLocation(editor, entry.model, locationRef.current, decorationsRef)
      } else if (isExplicitUnanchoredOpen) {
        entry.viewState = null
        editor.setSelection(new monaco.Selection(1, 1, 1, 1))
        editor.setScrollTop(0)
        editor.setScrollLeft(0)
      } else if (entry.viewState && !contentChanged) {
        editor.restoreViewState(entry.viewState)
      } else if (prevKey !== key || contentChanged) {
        editor.setSelection(new monaco.Selection(1, 1, 1, 1))
        editor.setScrollTop(0)
        editor.setScrollLeft(0)
      }

      onRenderedTargetChangeRef.current?.({
        path: normalizedPath,
        contentHash: normalizedHash,
      })
      setReady(true)
    }

    const upgradeLanguage = (): void => {
      if (cancelled || editorRef.current !== editor) return
      const mounted = mountedModelRef.current
      if (!mounted || mounted.targetKey !== targetKey) return
      const entry = poolRef.current.get(key)
      if (!entry || entry.model !== mounted.model) return
      if (entry.language !== language) {
        monaco.editor.setModelLanguage(entry.model, language)
        entry.language = language
      }
      mountedModelRef.current = { ...mounted, language }
    }

    if (language === 'json') {
      if (jsonSupportRef.current) {
        applyModel(false)
      } else {
        applyModel(true)
        const loadJson = async (): Promise<void> => {
          const support = await acquireJsonLanguageSupport()
          if (cancelled || editorRef.current !== editor) {
            support?.release()
            return
          }
          if (support) {
            releaseJsonSupport(jsonSupportRef)
            jsonSupportRef.current = support
          }
          upgradeLanguage()
        }
        void loadJson().catch((error: unknown) => {
          if (!cancelled) {
            onRenderedTargetChangeRef.current?.(undefined)
            setLoadError(error instanceof Error ? error : new Error(String(error)))
          }
        })
      }
    } else {
      const languageReady = loadedBasicLanguages.has(language)
      applyModel(!languageReady)
      disposeDetachedJsonCodeModels(poolRef.current, mountedModelRef.current?.model)
      releaseJsonSupport(jsonSupportRef)
      if (!languageReady) {
        const loadLang = async (): Promise<void> => {
          await loadProjectFileLanguage(language)
          loadedBasicLanguages.add(language)
          if (cancelled || editorRef.current !== editor) return
          upgradeLanguage()
        }
        void loadLang().catch((error: unknown) => {
          if (!cancelled) {
            onRenderedTargetChangeRef.current?.(undefined)
            setLoadError(error instanceof Error ? error : new Error(String(error)))
          }
        })
      }
    }

    return () => {
      cancelled = true
    }
  }, [authority, content, language, normalizedHash, normalizedPath, path, targetKey])

  if (loadError) throw loadError

  return (
    <div className="relative h-full min-h-0 w-full">
      <div ref={hostRef} className="h-full min-h-0 w-full" />
      {!ready ? (
        <span
          className="absolute inset-0 grid place-items-center text-caption text-secondary"
          aria-busy="true"
        >
          Loading code view…
        </span>
      ) : null}
      <SelectionCommentPill
        selectionAction={
          onCreateComment && selectionAction?.targetKey === targetKey ? selectionAction : undefined
        }
        onCommit={(range) => {
          const mounted = mountedModelRef.current
          const target = targetPropsRef.current
          if (
            mounted &&
            target.onCreateComment &&
            selectionAction?.targetKey === target.targetKey &&
            isCodeModelAligned(editorRef.current, mounted, target)
          ) {
            emitSelectionComment(mounted.model, range, target.onCreateComment)
          }
          setSelectionAction(undefined)
        }}
      />
    </div>
  )
}

export function ProjectDiffViewer({
  path,
  before,
  after,
  beforeContentHash,
  afterContentHash,
  language,
  onCreateComment,
  onRenderedTargetChange,
}: ProjectDiffViewerProps): React.JSX.Element {
  const authority = sanitizeAuthority(useId())
  const normalizedPath = normalizeModelPath(path)
  const normalizedBeforeHash = beforeContentHash ?? ''
  const normalizedHash = afterContentHash ?? ''
  const targetKey = JSON.stringify([
    normalizedPath,
    language,
    normalizedBeforeHash,
    normalizedHash,
    before.length,
    after.length,
  ])
  const hostRef = useRef<HTMLDivElement>(null)
  const diffEditorRef = useRef<monaco.editor.IStandaloneDiffEditor | undefined>(undefined)
  const mountedModelRef = useRef<MountedDiffModel | undefined>(undefined)
  const targetPropsRef = useRef({
    path: normalizedPath,
    before,
    after,
    beforeContentHash: normalizedBeforeHash,
    afterContentHash: normalizedHash,
    language,
    targetKey,
    onCreateComment,
  })
  const onRenderedTargetChangeRef = useRef(onRenderedTargetChange)
  const poolRef = useRef(new Map<string, PooledDiffEntry>())
  const activeKeyRef = useRef<string | undefined>(undefined)
  const modelVersionRef = useRef(0)
  const jsonSupportRef = useRef<ProjectFileLanguageSupport | undefined>(undefined)
  const [selectionAction, setSelectionAction] = useState<CodeSelectionAction | undefined>()
  const [ready, setReady] = useState(false)
  const [loadError, setLoadError] = useState<Error | undefined>()
  const [timedOut, setTimedOut] = useState(false)

  useLayoutEffect(() => {
    targetPropsRef.current = {
      path: normalizedPath,
      before,
      after,
      beforeContentHash: normalizedBeforeHash,
      afterContentHash: normalizedHash,
      language,
      targetKey,
      onCreateComment,
    }
    onRenderedTargetChangeRef.current = onRenderedTargetChange
  }, [
    after,
    before,
    language,
    normalizedBeforeHash,
    normalizedHash,
    normalizedPath,
    onCreateComment,
    onRenderedTargetChange,
    targetKey,
  ])

  // Persistent Monaco DiffEditor: mount once, dispose only on unmount.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return undefined
    const workerEnv = acquireWorkerEnvironment()
    let diffEditor: monaco.editor.IStandaloneDiffEditor | undefined
    let diffUpdateListener: monaco.IDisposable | undefined
    let selectionListener: monaco.IDisposable | undefined
    let scrollListener: monaco.IDisposable | undefined
    let layoutListener: monaco.IDisposable | undefined
    let commentAction: monaco.IDisposable | undefined
    let themeObserver: MutationObserver | undefined
    let systemTheme: MediaQueryList | undefined
    let disposed = false
    const syncTheme = (): void => monaco.editor.setTheme(activeTheme())
    const pool = poolRef.current
    const dispose = (): void => {
      if (disposed) return
      disposed = true
      themeObserver?.disconnect()
      systemTheme?.removeEventListener('change', syncTheme)
      diffUpdateListener?.dispose()
      selectionListener?.dispose()
      scrollListener?.dispose()
      layoutListener?.dispose()
      commentAction?.dispose()
      diffEditorRef.current = undefined
      mountedModelRef.current = undefined
      activeKeyRef.current = undefined
      onRenderedTargetChangeRef.current?.(undefined)
      if (diffEditor) {
        diffEditor.setModel(null)
        diffEditor.dispose()
      }
      for (const entry of pool.values()) {
        entry.original.dispose()
        entry.modified.dispose()
      }
      pool.clear()
      releaseJsonSupport(jsonSupportRef)
      workerEnv.release()
    }
    try {
      definePactThemes()
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
        renderMarginRevertIcon: false,
        ignoreTrimWhitespace: false,
        minimap: { enabled: false },
        overviewRulerBorder: false,
        overviewRulerLanes: 0,
        lineNumbersMinChars: 4,
        lineDecorationsWidth: DIFF_DECORATION_WIDTH,
        glyphMargin: false,
        scrollBeyondLastLine: false,
        smoothScrolling: true,
        stickyScroll: { enabled: false },
        wordWrap: 'off',
        diffWordWrap: 'off',
        fontFamily: 'JetBrains Mono Variable, SFMono-Regular, Consolas, monospace',
        fontSize: 13,
        lineHeight: 20,
        padding: { top: 12, bottom: 12 },
        scrollbar: { horizontalScrollbarSize: 9, verticalScrollbarSize: 9, useShadows: false },
        theme: activeTheme(),
      })
      diffEditor = currentEditor
      diffEditorRef.current = currentEditor
      diffUpdateListener = currentEditor.onDidUpdateDiff(() => {
        if (!disposed) setTimedOut(currentEditor.getLineChanges() === null)
      })
      const modifiedEditor = currentEditor.getModifiedEditor()
      const updateSelectionAction = (): void => {
        const mounted = mountedModelRef.current
        const target = targetPropsRef.current
        if (
          !mounted ||
          !target.onCreateComment ||
          !isDiffModelAligned(currentEditor, mounted, target)
        ) {
          setSelectionAction(undefined)
          return
        }
        setSelectionAction(
          computeSelectionAction(host, modifiedEditor, mounted.modified, target.targetKey),
        )
      }
      selectionListener = modifiedEditor.onDidChangeCursorSelection(updateSelectionAction)
      scrollListener = modifiedEditor.onDidScrollChange(updateSelectionAction)
      layoutListener = modifiedEditor.onDidLayoutChange(updateSelectionAction)
      commentAction = modifiedEditor.addAction({
        id: 'pact.create-diff-comment',
        label: 'Comment on selection',
        contextMenuGroupId: 'navigation',
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyC],
        run: () => {
          const target = targetPropsRef.current
          const mounted = mountedModelRef.current
          if (
            !target.onCreateComment ||
            !mounted ||
            !isDiffModelAligned(currentEditor, mounted, target)
          )
            return
          const selection = modifiedEditor.getSelection()
          if (!selection || selection.isEmpty()) return
          emitSelectionComment(mounted.modified, selection, target.onCreateComment)
        },
      })
      systemTheme = window.matchMedia('(prefers-color-scheme: dark)')
      themeObserver = new MutationObserver(syncTheme)
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-theme'],
      })
      systemTheme.addEventListener('change', syncTheme)
    } catch (error) {
      dispose()
      const err = error instanceof Error ? error : new Error(String(error))
      queueMicrotask(() => setLoadError(err))
    }
    return dispose
  }, [])

  // Swap pooled original/modified ITextModels + viewState across path/content/language changes without recreating Monaco.
  useEffect(() => {
    const diffEditor = diffEditorRef.current
    if (!diffEditor) return undefined
    let cancelled = false
    const key = normalizedPath
    setSelectionAction(undefined)

    const applyModels = (usePlaintextFallback: boolean): void => {
      if (cancelled || diffEditorRef.current !== diffEditor) return
      const effectiveLanguage = usePlaintextFallback ? 'plaintext' : language
      const pool = poolRef.current
      const prevKey = activeKeyRef.current
      if (prevKey && prevKey !== key) {
        const prevEntry = pool.get(prevKey)
        if (prevEntry) prevEntry.viewState = diffEditor.saveViewState()
      }

      setSelectionAction(undefined)
      setTimedOut(false)

      let entry = pool.get(key)
      let contentChanged = false
      let stalePairToDispose:
        | { original: monaco.editor.ITextModel; modified: monaco.editor.ITextModel }
        | undefined
      if (entry) {
        const pairChanged = entry.before !== before || entry.after !== after
        if (pairChanged && (entry.language === 'json' || language === 'json')) {
          // Never call setValue() on JSON models: recreate cleanly so Monaco's 500ms LSP timer is never armed.
          pool.delete(key)
          stalePairToDispose = { original: entry.original, modified: entry.modified }
          entry = undefined
          contentChanged = true
        } else {
          pool.delete(key)
          pool.set(key, entry)
          if (entry.before !== before) {
            entry.original.setValue(before)
            entry.before = before
            entry.viewState = null
            contentChanged = true
          }
          if (entry.after !== after) {
            entry.modified.setValue(after)
            entry.after = after
            entry.viewState = null
            contentChanged = true
          }
          if (entry.language !== effectiveLanguage) {
            monaco.editor.setModelLanguage(entry.original, effectiveLanguage)
            monaco.editor.setModelLanguage(entry.modified, effectiveLanguage)
            entry.language = effectiveLanguage
          }
        }
      }
      if (!entry) {
        const query =
          stalePairToDispose || language === 'json'
            ? { query: `v=${++modelVersionRef.current}` }
            : {}
        const beforeUri = monaco.Uri.from({
          scheme: 'pact-saved-before',
          authority,
          path: `/${key}`,
          ...query,
        })
        const afterUri = monaco.Uri.from({
          scheme: 'pact-saved-after',
          authority,
          path: `/${key}`,
          ...query,
        })
        const existingBefore = monaco.editor.getModel(beforeUri)
        if (existingBefore && existingBefore !== stalePairToDispose?.original) {
          existingBefore.dispose()
        }
        const existingAfter = monaco.editor.getModel(afterUri)
        if (existingAfter && existingAfter !== stalePairToDispose?.modified) {
          existingAfter.dispose()
        }
        const original = monaco.editor.createModel(before, effectiveLanguage, beforeUri)
        const modified = monaco.editor.createModel(after, effectiveLanguage, afterUri)
        entry = { original, modified, viewState: null, before, after, language: effectiveLanguage }
        pool.set(key, entry)
      }

      const currentModel = diffEditor.getModel()
      if (
        !currentModel ||
        currentModel.original !== entry.original ||
        currentModel.modified !== entry.modified
      ) {
        diffEditor.setModel({ original: entry.original, modified: entry.modified })
      }
      stalePairToDispose?.original.dispose()
      stalePairToDispose?.modified.dispose()
      mountedModelRef.current = {
        modified: entry.modified,
        path: key,
        before,
        after,
        beforeContentHash: normalizedBeforeHash,
        afterContentHash: normalizedHash,
        language: effectiveLanguage,
        targetKey,
      }
      activeKeyRef.current = key

      // Evict after attaching the active pair so we never dispose currently attached models.
      while (pool.size > MAX_POOLED_DIFF_ENTRIES) {
        const oldestKey = pool.keys().next().value
        if (oldestKey === undefined || oldestKey === key) break
        const evicted = pool.get(oldestKey)
        pool.delete(oldestKey)
        if (evicted) {
          evicted.original.dispose()
          evicted.modified.dispose()
        }
      }

      if (entry.viewState && !contentChanged) {
        diffEditor.restoreViewState(entry.viewState)
      } else if (prevKey !== key || contentChanged) {
        diffEditor.getOriginalEditor().setScrollTop(0)
        diffEditor.getOriginalEditor().setScrollLeft(0)
        diffEditor.getModifiedEditor().setScrollTop(0)
        diffEditor.getModifiedEditor().setScrollLeft(0)
      }

      onRenderedTargetChangeRef.current?.({
        path: normalizedPath,
        contentHash: normalizedHash,
        ...(beforeContentHash ? { beforeContentHash } : {}),
      })
      setReady(true)
    }

    const upgradeLanguage = (): void => {
      if (cancelled || diffEditorRef.current !== diffEditor) return
      const mounted = mountedModelRef.current
      if (!mounted || mounted.targetKey !== targetKey) return
      const entry = poolRef.current.get(key)
      if (!entry || entry.modified !== mounted.modified) return
      if (entry.language !== language) {
        monaco.editor.setModelLanguage(entry.original, language)
        monaco.editor.setModelLanguage(entry.modified, language)
        entry.language = language
      }
      mountedModelRef.current = { ...mounted, language }
    }

    if (language === 'json') {
      if (jsonSupportRef.current) {
        applyModels(false)
      } else {
        applyModels(true)
        const loadJson = async (): Promise<void> => {
          const support = await acquireJsonLanguageSupport()
          if (cancelled || diffEditorRef.current !== diffEditor) {
            support?.release()
            return
          }
          if (support) {
            releaseJsonSupport(jsonSupportRef)
            jsonSupportRef.current = support
          }
          upgradeLanguage()
        }
        void loadJson().catch((error: unknown) => {
          if (!cancelled) {
            onRenderedTargetChangeRef.current?.(undefined)
            setLoadError(error instanceof Error ? error : new Error(String(error)))
          }
        })
      }
    } else {
      const languageReady = loadedBasicLanguages.has(language)
      applyModels(!languageReady)
      const activeDiffModels = diffEditor.getModel()
      disposeDetachedJsonDiffModels(
        poolRef.current,
        activeDiffModels?.original,
        activeDiffModels?.modified,
      )
      releaseJsonSupport(jsonSupportRef)
      if (!languageReady) {
        const loadLang = async (): Promise<void> => {
          await loadProjectFileLanguage(language)
          loadedBasicLanguages.add(language)
          if (cancelled || diffEditorRef.current !== diffEditor) return
          upgradeLanguage()
        }
        void loadLang().catch((error: unknown) => {
          if (!cancelled) {
            onRenderedTargetChangeRef.current?.(undefined)
            setLoadError(error instanceof Error ? error : new Error(String(error)))
          }
        })
      }
    }

    return () => {
      cancelled = true
    }
  }, [
    after,
    authority,
    before,
    beforeContentHash,
    language,
    normalizedBeforeHash,
    normalizedHash,
    normalizedPath,
    targetKey,
  ])

  if (loadError) throw loadError

  return (
    <div className="relative flex h-full min-h-0 w-full flex-col">
      {timedOut ? (
        <output className="shrink-0 border-b border-border px-3 py-2 text-caption text-secondary">
          Couldn’t compute diff. Choose After to read the saved code.
        </output>
      ) : null}
      <div ref={hostRef} className="min-h-0 w-full flex-1" />
      {!ready ? (
        <span
          className="absolute inset-0 grid place-items-center text-caption text-secondary"
          aria-busy="true"
        >
          Loading diff…
        </span>
      ) : null}
      <SelectionCommentPill
        selectionAction={
          onCreateComment && selectionAction?.targetKey === targetKey ? selectionAction : undefined
        }
        onCommit={(range) => {
          const mounted = mountedModelRef.current
          const target = targetPropsRef.current
          if (
            mounted &&
            target.onCreateComment &&
            selectionAction?.targetKey === target.targetKey &&
            isDiffModelAligned(diffEditorRef.current, mounted, target)
          ) {
            emitSelectionComment(mounted.modified, range, target.onCreateComment)
          }
          setSelectionAction(undefined)
        }}
      />
    </div>
  )
}

function SelectionCommentPill({
  selectionAction,
  onCommit,
}: {
  selectionAction: CodeSelectionAction | undefined
  onCommit: (range: monaco.IRange) => void
}): React.JSX.Element | null {
  if (!selectionAction) return null
  if (selectionAction.tooLarge) {
    return (
      <output
        className="absolute z-20 rounded-xl border border-border bg-surface-raised px-2.5 py-1.5 text-caption text-secondary shadow-popover"
        style={{ left: selectionAction.left, top: selectionAction.top }}
      >
        Select at most {MAX_COMMENT_QUOTE_LENGTH.toLocaleString()} characters
      </output>
    )
  }
  return (
    <button
      className="pact-pressable absolute z-20 inline-flex h-8 w-32 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-xl bg-surface-inverse px-2.5 text-caption font-medium text-inverse shadow-popover transition-[filter] duration-150 ease-out-pact hover:brightness-95 active:brightness-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      type="button"
      style={{ left: selectionAction.left, top: selectionAction.top }}
      aria-label="Comment on selected code"
      title="Comment on selected code"
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => onCommit(selectionAction.range)}
    >
      <MessageCirclePlus aria-hidden="true" className="size-4 shrink-0" strokeWidth={1.75} />
      Add comment
    </button>
  )
}

function emitSelectionComment(
  model: monaco.editor.ITextModel,
  range: monaco.IRange,
  onCreateComment: (selection: CodeCommentSelection) => void,
): void {
  if (
    model.getValueLengthInRange(range, monaco.editor.EndOfLinePreference.LF) >
    MAX_COMMENT_QUOTE_LENGTH
  )
    return
  const quote = model.getValueInRange(range, monaco.editor.EndOfLinePreference.LF)
  if (!quote) return
  onCreateComment({
    startLine: range.startLineNumber,
    startColumn: range.startColumn,
    endLine: range.endLineNumber,
    endColumn: range.endColumn,
    quote,
  })
}

async function acquireJsonLanguageSupport(): Promise<ProjectFileLanguageSupport | undefined> {
  let lease: { createWorker: () => Worker } | undefined
  return loadProjectFileLanguage('json', {
    beforeEnableJson: (createWorker) => {
      lease = { createWorker }
      jsonWorkerLeases.add(lease)
    },
    afterDisableJson: () => {
      if (lease) {
        jsonWorkerLeases.delete(lease)
        lease = undefined
      }
    },
  })
}

function releaseJsonSupport(ref: { current: ProjectFileLanguageSupport | undefined }): void {
  const current = ref.current
  if (!current) return
  ref.current = undefined
  current.release()
}

function acquireWorkerEnvironment(): { release: () => void } {
  if (workerEnvLeases === 0) {
    previousMonacoEnvironment = Reflect.get(self, 'MonacoEnvironment')
    installedMonacoEnvironment = {
      getWorker(_moduleId: string, label: string): Worker {
        let worker: Worker
        if (label === 'json') {
          const jsonWorkerLease = jsonWorkerLeases.values().next().value
          if (!jsonWorkerLease) {
            throw new Error('JSON language support closed.')
          }
          worker = jsonWorkerLease.createWorker()
        } else {
          worker = new EditorWorker()
        }
        activeWorkers.add(worker)
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
          if (activeWorkers.delete(worker)) {
            terminate()
            removeObservation?.()
          }
        }
        return worker
      },
    }
    Reflect.set(self, 'MonacoEnvironment', installedMonacoEnvironment)
  }
  workerEnvLeases += 1
  let released = false
  return {
    release: () => {
      if (released) return
      released = true
      workerEnvLeases -= 1
      if (workerEnvLeases === 0) {
        for (const worker of activeWorkers) worker.terminate()
        activeWorkers.clear()
        if (Reflect.get(self, 'MonacoEnvironment') === installedMonacoEnvironment) {
          Reflect.set(self, 'MonacoEnvironment', previousMonacoEnvironment)
        }
        installedMonacoEnvironment = undefined
      }
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
  if (themesDefined) return
  themesDefined = true
  monaco.editor.defineTheme('pact-light', {
    base: 'vs',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#FFFFFF',
      'editor.foreground': '#12161F',
      'editorLineNumber.foreground': '#636C7C',
      'editorLineNumber.activeForeground': '#12161F',
      'editor.selectionBackground': '#0069E02E',
      'editor.inactiveSelectionBackground': '#0069E018',
      'editorCursor.foreground': '#0069E0',
      'editorIndentGuide.background1': '#0F172A14',
      'diffEditor.insertedLineBackground': '#E5F8ED',
      'diffEditor.removedLineBackground': '#FFF0EE',
      'diffEditor.insertedTextBackground': '#16883F22',
      'diffEditor.removedTextBackground': '#B4231822',
    },
  })
  monaco.editor.defineTheme('pact-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#171A21',
      'editor.foreground': '#EEF2F7',
      'editorLineNumber.foreground': '#8794A8',
      'editorLineNumber.activeForeground': '#EEF2F7',
      'editor.selectionBackground': '#67B1FF47',
      'editor.inactiveSelectionBackground': '#67B1FF22',
      'editorCursor.foreground': '#67B1FF',
      'editorIndentGuide.background1': '#F1F5F914',
      'diffEditor.insertedLineBackground': '#17392B',
      'diffEditor.removedLineBackground': '#402421',
      'diffEditor.insertedTextBackground': '#5EE58A24',
      'diffEditor.removedTextBackground': '#FF8A8024',
    },
  })
}
