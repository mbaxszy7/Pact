import { BookOpen, ExternalLink, FileText } from 'lucide-react'
import { createElement, memo, useLayoutEffect, useMemo, useRef, type RefObject } from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

import {
  parseComposerCommandPrefix,
  type SkillSelection,
  type CollaborationMarkdownNode,
} from '@pact/contracts'

import { markdownProjectionRehypePlugin } from '../../../../shared/message-anchor-text'
import { MessageSelectionSurface, type MessageTextSelection } from './MessageSelectionSurface'

export interface ProjectFileTarget {
  path: string
  lineStart?: number
  lineEnd?: number
  startColumn?: number
  endColumn?: number
  expectedContentHash?: string
  commentId?: string
  quote?: string
}

interface MessageMarkdownProps {
  content: string
  tree?: CollaborationMarkdownNode | undefined
  skills?: SkillSelection[] | undefined
  onOpenProjectFile: (target: ProjectFileTarget) => void
  messageId?: string | undefined
  onCreateComment?: ((selection: MessageTextSelection) => void) | undefined
}

export const MessageMarkdown = memo(function MessageMarkdown({
  content,
  tree,
  skills,
  onOpenProjectFile,
  messageId,
  onCreateComment,
}: MessageMarkdownProps): React.JSX.Element {
  const openProjectFileRef = useRef(onOpenProjectFile)
  useLayoutEffect(() => {
    openProjectFileRef.current = onOpenProjectFile
  }, [onOpenProjectFile])
  const decorationContent = skills === undefined ? undefined : content
  const selectionKey =
    skills === undefined
      ? undefined
      : JSON.stringify(skills.map(({ name, start, end }) => [name, start, end]))
  const decoration = useMemo(() => {
    if (decorationContent === undefined || selectionKey === undefined) return undefined
    const parsed: unknown = JSON.parse(selectionKey)
    const selected = Array.isArray(parsed)
      ? parsed
          .filter(
            (value: unknown): value is [string, number, number] =>
              Array.isArray(value) &&
              value.length === 3 &&
              typeof value[0] === 'string' &&
              typeof value[1] === 'number' &&
              typeof value[2] === 'number',
          )
          .map(([name, start, end]) => ({ name, start, end }))
      : []
    const ranges: SkillRange[] = []
    for (const entry of [
      ...parseComposerCommandPrefix(decorationContent, selected).skills,
      ...selected,
    ]) {
      if (
        decorationContent.slice(entry.start, entry.end) !== `/${entry.name}` ||
        ranges.some((range) => range.start === entry.start && range.end === entry.end)
      )
        continue
      ranges.push(entry)
      // The ordinary message surface owns at most forty badges; large/complex tokens stay Markdown.
      if (ranges.length === 40) break
    }
    return { content: decorationContent, ranges: ranges.toSorted((a, b) => a.start - b.start) }
  }, [decorationContent, selectionKey])
  // Semantic decoration identity keeps completed text stable across callback/metadata updates.
  const markdownComponents = useMemo(
    // oxlint-disable-next-line react/refs -- The factory stores this ref only in click handlers; it never reads current during render.
    () => createMarkdownComponents(openProjectFileRef, decoration),
    [decoration],
  )
  const remarkPlugins = useMemo(() => [remarkGfm], [])
  const rehypePlugins = useMemo(() => [markdownProjectionRehypePlugin], [])
  const renderedMarkdown = useMemo(
    () =>
      tree ? (
        renderProjectionTree(tree, markdownComponents)
      ) : (
        <Markdown
          components={markdownComponents}
          remarkPlugins={remarkPlugins}
          rehypePlugins={rehypePlugins}
          skipHtml
          urlTransform={safeMarkdownUrl}
        >
          {content}
        </Markdown>
      ),
    [content, tree, markdownComponents, remarkPlugins, rehypePlugins],
  )
  return (
    <MessageSelectionSurface messageId={messageId} onCreateComment={onCreateComment}>
      {renderedMarkdown}
    </MessageSelectionSurface>
  )
})

function projectionComponent(
  value: unknown,
): value is React.ComponentType<Record<string, unknown>> {
  return typeof value === 'function'
}

/** Validated interpreted pages use the same typography, links and selection spans. */
function renderProjectionTree(
  node: CollaborationMarkdownNode,
  components: Components,
  key = 'root',
): React.ReactNode {
  if (node.type === 'text') return node.value ?? ''
  const children = (node.children ?? []).map((child, index) =>
    renderProjectionTree(child, components, `${key}:${index}`),
  )
  if (node.type === 'root') return children
  const tag = node.tagName ?? 'span'
  const props: Record<string, unknown> = { ...node.properties, key }
  if (Array.isArray(props.className)) props.className = props.className.join(' ')
  for (const property of ['href', 'src'])
    if (typeof props[property] === 'string') props[property] = safeMarkdownUrl(props[property])
  const candidate: unknown = Reflect.get(components, tag)
  const component = projectionComponent(candidate) ? candidate : undefined
  if (component) return createElement(component, { ...props, node }, ...children)
  return createElement(tag, props, ...children)
}

function createMarkdownComponents(
  onOpenProjectFile: RefObject<(target: ProjectFileTarget) => void>,
  decoration?: { content: string; ranges: SkillRange[] },
): Components {
  return {
    span: ({ node, children, ...props }) => {
      const text = typeof children === 'string' ? children : undefined
      const rawStart = node?.position?.start.offset
      const rawEnd = node?.position?.end.offset
      const projectionStart = Number(node?.properties['data-pact-projection-start'])
      if (
        !decoration ||
        text === undefined ||
        rawStart === undefined ||
        rawEnd === undefined ||
        !Number.isInteger(projectionStart) ||
        decoration.content.slice(rawStart, rawEnd) !== text
      )
        return <span {...props}>{children}</span>
      const ranges = decoration.ranges.filter(
        (entry) => entry.start >= rawStart && entry.end <= rawEnd,
      )
      if (!ranges.length) return <span {...props}>{children}</span>
      let cursor = 0
      const parts: React.ReactNode[] = []
      const plain = (end: number): void => {
        if (end > cursor)
          parts.push(
            <span
              key={`text-${cursor}`}
              data-pact-projection-start={projectionStart + cursor}
              data-pact-projection-end={projectionStart + end}
            >
              {text.slice(cursor, end)}
            </span>,
          )
        cursor = end
      }
      for (const entry of ranges) {
        const start = entry.start - rawStart
        if (start < cursor) continue
        plain(start)
        const end = entry.end - rawStart
        parts.push(
          <span
            key={`skill-${start}`}
            title={`Skill · ${entry.name}`}
            className="relative mx-0.5 inline-flex max-w-full items-baseline gap-1.5 rounded-control border border-border/60 bg-surface-raised/50 px-2 py-0.5 align-baseline text-caption font-medium leading-normal text-primary"
          >
            <BookOpen
              aria-hidden="true"
              className="size-3.5 shrink-0 self-center"
              strokeWidth={1.75}
            />
            <span className="min-w-0 break-all">
              <span
                aria-hidden="true"
                className="text-[0px]"
                data-pact-projection-start={projectionStart + start}
                data-pact-projection-end={projectionStart + start + 1}
              >
                /
              </span>
              <span
                data-pact-projection-start={projectionStart + start + 1}
                data-pact-projection-end={projectionStart + end}
              >
                {entry.name}
              </span>
            </span>
          </span>,
        )
        cursor = end
      }
      plain(text.length)
      return <span>{parts}</span>
    },
    a: ({ href, children }) => {
      const target = href ? projectFileTarget(href) : undefined
      if (target) {
        return (
          <button
            className="inline-flex items-baseline gap-1 font-medium text-status-info-foreground underline decoration-status-info/40 underline-offset-4 hover:decoration-status-info"
            type="button"
            title={target.path}
            onClick={() => onOpenProjectFile.current(target)}
          >
            <FileText
              aria-hidden="true"
              className="relative top-0.5 size-3.5 shrink-0"
              strokeWidth={1.75}
            />
            <span>{children}</span>
          </button>
        )
      }
      const isWebLink = href !== undefined && /^https?:/iu.test(href)
      return (
        <a
          className="font-medium text-status-info-foreground underline decoration-status-info/40 underline-offset-4 hover:decoration-status-info"
          href={href}
          title={isWebLink ? href : undefined}
          rel="noreferrer"
          target="_blank"
        >
          {children}
          {isWebLink && (
            <ExternalLink
              aria-hidden="true"
              className="relative -top-px ml-1 inline-block size-3.5 align-middle"
              strokeWidth={1.75}
            />
          )}
        </a>
      )
    },
    h1: ({ children }) => <h1 className="mb-2 mt-4 text-subtitle font-medium">{children}</h1>,
    h2: ({ children }) => <h2 className="mb-2 mt-4 text-body font-medium">{children}</h2>,
    h3: ({ children }) => <h3 className="mb-1 mt-3 text-body font-medium">{children}</h3>,
    p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,
    ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
    ol: ({ children, start }) => (
      <ol start={start} className="my-2 list-decimal space-y-1 pl-5">
        {children}
      </ol>
    ),
    li: ({ children }) => <li className="pl-0.5">{children}</li>,
    blockquote: ({ children }) => (
      <blockquote className="my-3 border-l border-border-strong pl-3 text-secondary">
        {children}
      </blockquote>
    ),
    code: ({ className, children }) =>
      className ? (
        <code className={`${className} font-mono text-code`}>{children}</code>
      ) : (
        <code className="rounded-control bg-surface-raised/70 px-1.5 py-0.5 font-mono text-code">
          {children}
        </code>
      ),
    pre: ({ children }) => (
      <pre className="my-3 overflow-auto rounded-control bg-surface-raised/85 p-3 font-mono text-code leading-relaxed">
        {children}
      </pre>
    ),
    table: ({ children }) => (
      <div className="my-3 overflow-auto rounded-control border border-border">
        <table className="w-full border-collapse text-left text-caption">{children}</table>
      </div>
    ),
    th: ({ children }) => (
      <th className="border-b border-border bg-surface-raised/60 px-3 py-2 font-medium">
        {children}
      </th>
    ),
    td: ({ children }) => <td className="border-b border-border px-3 py-2">{children}</td>,
    hr: () => <hr className="my-4 border-0 border-t border-border" />,
  }
}

interface SkillRange {
  name: string
  start: number
  end: number
}

function safeMarkdownUrl(url: string): string {
  if (/^[a-z]:[\\/]/iu.test(url)) return url
  if (/^(https?:|mailto:|file:)/iu.test(url)) return url
  if (/^[a-z][a-z\d+.-]*:/iu.test(url)) return ''
  return url
}

function projectFileTarget(href: string): ProjectFileTarget | undefined {
  if (/^(https?|mailto):/iu.test(href) || href.startsWith('#')) return undefined
  if (/^[a-z][a-z\d+.-]*:/iu.test(href) && !/^file:/iu.test(href) && !/^[a-z]:[\\/]/iu.test(href)) {
    return undefined
  }
  const hashIndex = href.lastIndexOf('#')
  let path = hashIndex >= 0 ? href.slice(0, hashIndex) : href
  if (!path) return undefined
  let hash: string
  try {
    hash = decodeURIComponent(hashIndex >= 0 ? href.slice(hashIndex + 1) : '')
  } catch {
    return undefined
  }
  const range = /^L(\d+)(?:-L?(\d+))?$/u.exec(hash)
  if (hash && !range) return undefined
  const suffixRange = hash ? undefined : /^(.*):(\d+)(?::\d+)?(?:-(\d+))?$/u.exec(path)
  if (suffixRange?.[1]) path = suffixRange[1]
  try {
    // Utility decodes file URLs with the host platform's native path rules.
    if (!/^file:/iu.test(path)) path = decodeURIComponent(path)
  } catch {
    return undefined
  }
  const lineStart = range?.[1]
    ? Number(range[1])
    : suffixRange?.[2]
      ? Number(suffixRange[2])
      : undefined
  const lineEnd = range?.[2]
    ? Number(range[2])
    : suffixRange?.[3]
      ? Number(suffixRange[3])
      : lineStart
  return {
    path,
    ...(lineStart ? { lineStart } : {}),
    ...(lineEnd ? { lineEnd } : {}),
  }
}
