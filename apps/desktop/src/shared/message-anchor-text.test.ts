import { describe, expect, it } from 'vitest'

import { markdownProjectionRehypePlugin, markdownVisibleProjection } from './message-anchor-text.js'

describe('markdown-visible-v2 projection', () => {
  it.each([
    [
      'ignores raw HTML tags while preserving their visible text',
      '<span>hidden</span>\n\nVisible',
      'hidden\nVisible',
    ],
    [
      'keeps GFM table cell text in document order',
      '| Name | Value |\n| --- | --- |\n| one | two |',
      'NameValueonetwo',
    ],
    [
      'keeps inline and fenced code as selectable text',
      'Use `value_name`.\n\n```ts\nconst answer = 42\n```',
      'Use value_name.\nconst answer = 42\n',
    ],
    ['decodes entities and retains emoji', 'Fish &amp; chips 😀', 'Fish & chips 😀'],
  ])('%s', (_description, markdown, expected) => {
    expect(markdownVisibleProjection(markdown)).toBe(expected)
  })

  it('uses the same span boundaries rendered by the shared rehype plugin', () => {
    const markdown = 'A **bold** `value_name`'
    const projection = markdownVisibleProjection(markdown)
    const plugin = markdownProjectionRehypePlugin()
    const tree = {
      type: 'root',
      children: [
        {
          type: 'element',
          tagName: 'p',
          children: [
            { type: 'text', value: 'A ' },
            { type: 'element', tagName: 'strong', children: [{ type: 'text', value: 'bold' }] },
            { type: 'text', value: ' ' },
            { type: 'element', tagName: 'code', children: [{ type: 'text', value: 'value_name' }] },
          ],
        },
      ],
    }

    plugin(tree)

    const spans = collectProjectionSpans(tree)
    expect(spans).toEqual([
      { text: 'A ', start: 0, end: 2 },
      { text: 'bold', start: 2, end: 6 },
      { text: ' ', start: 6, end: 7 },
      { text: 'value_name', start: 7, end: 17 },
    ])
    expect(projection).toBe('A bold value_name')
  })
})

function collectProjectionSpans(tree: unknown): { text: string; start: number; end: number }[] {
  const spans: { text: string; start: number; end: number }[] = []
  const visit = (candidate: unknown): void => {
    if (!candidate || typeof candidate !== 'object') return
    const node = candidate as {
      type?: unknown
      tagName?: unknown
      properties?: unknown
      children?: unknown
    }
    if (
      node.type === 'element' &&
      node.tagName === 'span' &&
      node.properties &&
      typeof node.properties === 'object'
    ) {
      const properties = node.properties
      const [child] = Array.isArray(node.children) ? node.children : []
      const text =
        child && typeof child === 'object' && 'value' in child && typeof child.value === 'string'
          ? child.value
          : ''
      spans.push({
        text,
        start: Number(Reflect.get(properties, 'data-pact-projection-start')),
        end: Number(Reflect.get(properties, 'data-pact-projection-end')),
      })
      return
    }
    if (Array.isArray(node.children)) node.children.forEach(visit)
  }
  visit(tree)
  return spans
}
