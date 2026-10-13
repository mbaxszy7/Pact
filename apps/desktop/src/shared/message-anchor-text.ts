import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import { unified } from 'unified'

export const MESSAGE_ANCHOR_TEXT_BASIS = 'markdown-visible-v2' as const

interface HastNode {
  type?: unknown
  value?: unknown
  children?: unknown
  tagName?: unknown
  properties?: unknown
}

const markdownToHast = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(markdownProjectionRehypePlugin)

/** The one parser pipeline used by both safe rendering and durable anchors. */
export function markdownVisibleProjection(markdown: string): string {
  return projectHast(markdownToHast.runSync(markdownToHast.parse(markdown))).text
}

export function markdownProjectionRehypePlugin() {
  return (tree: unknown): void => {
    let offset = 0
    const annotate = (candidate: unknown, parentTagName?: string): HastNode | undefined => {
      if (!candidate || typeof candidate !== 'object') return undefined
      const node = candidate as HastNode
      if (node.type === 'raw') return undefined
      if (
        node.type === 'text' &&
        typeof node.value === 'string' &&
        isVisibleHastText(node.value, parentTagName)
      ) {
        const start = offset
        offset += node.value.length
        Object.assign(node, {
          type: 'element',
          tagName: 'span',
          properties: {
            'data-pact-projection-start': start,
            'data-pact-projection-end': offset,
          },
          children: [{ type: 'text', value: node.value }],
        })
        return node
      }
      if (Array.isArray(node.children)) {
        const tagName = typeof node.tagName === 'string' ? node.tagName : undefined
        node.children = node.children
          .map((child) => annotate(child, tagName))
          .filter((child): child is HastNode => child !== undefined)
      }
      return node
    }
    annotate(tree)
  }
}

function projectHast(tree: unknown): { text: string } {
  const chunks: string[] = []
  const visit = (candidate: unknown): void => {
    if (!candidate || typeof candidate !== 'object') return
    const node = candidate as HastNode
    if (node.type === 'element' && node.tagName === 'span' && node.properties) {
      const children: unknown[] = Array.isArray(node.children) ? node.children : []
      const text = children
        .filter(
          (child): child is HastNode =>
            child !== null && typeof child === 'object' && 'type' in child && child.type === 'text',
        )
        .map((child) => (typeof child.value === 'string' ? child.value : ''))
        .join('')
      chunks.push(text)
      return
    }
    if (Array.isArray(node.children)) node.children.forEach(visit)
  }
  visit(tree)
  return { text: chunks.join('') }
}

function isVisibleHastText(value: string, parentTagName: string | undefined): boolean {
  return !(
    value.trim() === '' &&
    parentTagName !== undefined &&
    ['table', 'thead', 'tbody', 'tfoot', 'tr', 'ul', 'ol'].includes(parentTagName)
  )
}

/** Compile once with the existing semantics, then cut interpreted text, never raw Markdown. */
export function* markdownProjectionPages(markdown: string): Generator<{
  ordinal: number
  visibleStart: number
  visibleEnd: number
  tree: import('@pact/contracts').CollaborationMarkdownNode
  visibleText: string
}> {
  type Node = import('@pact/contracts').CollaborationMarkdownNode
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The same private HAST pipeline owns interpretation; each outgoing page is separately validated.
  const root = markdownToHast.runSync(markdownToHast.parse(markdown)) as unknown as Node
  const allowed = new Set([
    'href',
    'title',
    'alt',
    'src',
    'className',
    'start',
    'align',
    'type',
    'checked',
    'disabled',
    'data-pact-node-id',
    'data-pact-projection-start',
    'data-pact-projection-end',
  ])
  const identities = new WeakMap<Node, number>()
  let identity = 0
  const nodeId = (node: Node): number => {
    const old = identities.get(node)
    if (old !== undefined) return old
    const id = identity++
    identities.set(node, id)
    return id
  }
  const ancestors: Array<{ node: Node; index: number }> = []
  let ordinal = 0,
    start = 0,
    end = 0,
    text = '',
    nodes = 0
  let tree: Node = { type: 'root', children: [] }
  let copies = new Map<Node, Node>()
  const clean = (node: Node): Node => ({
    type: node.type,
    ...(node.tagName ? { tagName: node.tagName } : {}),
    ...(node.type === 'element'
      ? {
          properties: {
            ...Object.fromEntries(
              Object.entries(node.properties ?? {}).filter(([key]) => allowed.has(key)),
            ),
            'data-pact-node-id': nodeId(node),
          },
        }
      : {}),
    ...(node.value !== undefined ? { value: node.value } : {}),
    ...(node.children ? { children: [] } : {}),
  })
  const append = (leaf: Node): void => {
    let parent = tree
    for (const [i, ancestor] of ancestors.entries()) {
      const original = ancestor.node
      if (original.type === 'root') continue
      let copy = copies.get(original)
      if (!copy) {
        copy = clean(original)
        if (copy.tagName === 'ol') {
          const child = ancestors[i + 1]
          const before = child
            ? (original.children?.slice(0, child.index).filter((entry) => entry.tagName === 'li')
                .length ?? 0)
            : 0
          copy.properties = {
            ...copy.properties,
            start: Number(original.properties?.start ?? 1) + before,
          }
        }
        copies.set(original, copy)
        parent.children!.push(copy)
        nodes++
      }
      parent = copy
    }
    parent.children ??= []
    parent.children.push(leaf)
    nodes++
  }
  const page = () => ({ ordinal, visibleStart: start, visibleEnd: end, tree, visibleText: text })
  const reset = (): void => {
    ordinal++
    start = end
    text = ''
    nodes = 0
    tree = { type: 'root', children: [] }
    copies = new Map()
  }
  function* visit(node: Node, index: number): Generator<ReturnType<typeof page>> {
    if (
      node.type === 'element' &&
      node.tagName === 'span' &&
      typeof node.properties?.['data-pact-projection-start'] === 'number'
    ) {
      const value = node.children?.map((child) => child.value ?? '').join('') ?? ''
      for (let offset = 0; offset < value.length;) {
        if (text.length >= 4096 || nodes + ancestors.length + 2 > 256) {
          yield page()
          reset()
        }
        let stop = Math.min(value.length, offset + 4096 - text.length)
        if (stop < value.length && /[\uD800-\uDBFF]/u.test(value.charAt(stop - 1))) stop--
        if (stop === offset) {
          yield page()
          reset()
          continue
        }
        const piece = value.slice(offset, stop)
        const at = node.properties['data-pact-projection-start'] + offset
        append({
          type: 'element',
          tagName: 'span',
          properties: {
            'data-pact-node-id': nodeId(node),
            'data-pact-projection-start': at,
            'data-pact-projection-end': at + piece.length,
          },
          children: [{ type: 'text', value: piece }],
        })
        text += piece
        end = at + piece.length
        offset = stop
      }
      return
    }
    if (ancestors.length >= 64)
      throw new Error(
        'Markdown projection exceeded its working stack capacity. Original content is preserved.',
      )
    if (node.type === 'text') return // All visible text was annotated by the same projection plugin.
    if (!node.children?.length) {
      if (nodes + ancestors.length + 1 > 256) {
        yield page()
        reset()
      }
      append(clean(node))
      return
    }
    ancestors.push({ node, index })
    for (const [childIndex, child] of node.children.entries()) yield* visit(child, childIndex)
    ancestors.pop()
  }
  yield* visit(root, 0)
  if (nodes || ordinal === 0) yield page()
}
