/** Display aliases for private Pact references; original documents and their offsets stay intact. */
export interface CollaborationDisplayContext {
  taskId?: string | undefined
  runId?: string | undefined
  todoId?: string | undefined
  questionId?: string | undefined
  documentId?: string | undefined
  documentHash?: string | undefined
}

export interface CollaborationDisplayEdit {
  start: number
  end: number
  text: string
}

const MAX_DISPLAY_CHARS = 64 * 1024
const MAX_DISPLAY_EDITS = 4096
const UUID = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}'
// A reason preview can stop inside its final identifier. The declared reference type still owns it.
const UUID_TAIL = '[0-9a-f]{8}[0-9a-f-]{0,27}(?=$)'
const OPAQUE_ITEM = '[a-z0-9]{1,24}[-_][a-z0-9_-]{1,55}'
const REVISION = '(?:[\\s,，]*(?:revision|rev)\\s*[:：]?\\s*\\d+)?'
const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')

/** One bounded scan, only declared Pact reference syntax or exact source identities. */
export function collaborationDisplayEdits(
  text: string,
  context: CollaborationDisplayContext = {},
): CollaborationDisplayEdit[] {
  if (text.length > MAX_DISPLAY_CHARS)
    throw new Error('This document window exceeds its readable text budget.')
  const chinese = /[\u3400-\u9fff]/u.test(text)
  const labels = chinese
    ? {
        task: '当前任务',
        run: '讨论记录',
        input: '原输入',
        comment: '用户评论',
        item: '相关意见',
        question: '该问题',
        document: '引用内容',
        hash: '内容校验',
        choice: '所选方案',
      }
    : {
        task: 'task',
        run: 'run',
        input: 'input',
        comment: 'comment',
        item: 'item',
        question: 'question',
        document: 'source',
        hash: 'checksum',
        choice: 'choice',
      }
  const known = new Map<string, string>()
  for (const [id, label] of [
    [context.taskId, labels.task],
    [context.runId, labels.run],
    [context.todoId, labels.item],
    [context.questionId, labels.question],
    [context.documentId, labels.document],
    [context.documentHash, labels.hash],
  ])
    if (id && /^[a-z0-9_-]{8,80}$/iu.test(id)) known.set(id.toLowerCase(), label!)
  const exact = [...known.keys()].toSorted((left, right) => right.length - left.length).map(escape)
  const patterns = [
    `(?<referenceKind>Batch|Comment|Run|Task|任务|输入批次|评论|运行记录|sourceGrant)\\s*(?:ID\\s*)?[:：=]?\\s*(?:${UUID}|${UUID_TAIL})${REVISION}`,
    `(?<itemKind>Todo|question|问题|todoId|questionId)\\s*[:：=]?\\s*(?:${OPAQUE_ITEM}${exact.length ? `|${exact.join('|')}` : ''})(?![a-z0-9_-])${REVISION}`,
    ...(exact.length ? [`(?<known>${exact.join('|')})(?![a-z0-9_-])${REVISION}`] : []),
    '(?<choice>optionIndex)\\s*[:：=]?\\s*\\d+',
    '(?:冻结\\s*)?answerResolver\\s*(?:为|是|[:：=]|is)\\s*(?<handler>codex|claude)(?![a-z0-9_])',
    '(?:本轮\\s*)?Actor\\s*(?:也是|也为|为|是|[:：=]|is)\\s*(?<actor>codex|claude)(?![a-z0-9_])',
  ]
  const pattern = new RegExp(`(?<![a-z0-9_.])(?:${patterns.join('|')})`, 'giu')
  const edits: CollaborationDisplayEdit[] = []
  for (const match of text.matchAll(pattern)) {
    if (edits.length === MAX_DISPLAY_EDITS)
      throw new Error('This document contains too many private references to display.')
    const groups = match.groups!
    let label: string
    if (groups.referenceKind) {
      const kind = groups.referenceKind.toLowerCase()
      label = ['batch', '输入批次'].includes(kind)
        ? labels.input
        : ['comment', '评论'].includes(kind)
          ? labels.comment
          : ['task', '任务'].includes(kind)
            ? labels.task
            : kind === 'sourcegrant'
              ? labels.document
              : labels.run
    } else if (groups.itemKind) {
      label = /question|问题/iu.test(groups.itemKind) ? labels.question : labels.item
    } else if (groups.known) label = known.get(groups.known.toLowerCase())!
    else if (groups.choice) label = labels.choice
    else {
      const actor = groups.handler ?? groups.actor
      if (!actor) throw new Error('The document reference could not be displayed.')
      const agent = actor.toLowerCase() === 'codex' ? 'Codex' : 'Claude Code'
      label = groups.handler
        ? chinese
          ? `由 ${agent} 处理答案`
          : `${agent} handles the answer`
        : chinese
          ? `本轮由 ${agent} 处理`
          : `${agent} handles this turn`
    }
    edits.push({ start: match.index, end: match.index + match[0].length, text: label })
  }
  return edits
}

export function readableCollaborationText(
  text: string,
  context: CollaborationDisplayContext = {},
): string {
  const edits = collaborationDisplayEdits(text, context)
  if (!edits.length) return text
  const parts: string[] = []
  let position = 0
  for (const edit of edits) {
    parts.push(text.slice(position, edit.start), edit.text)
    position = edit.end
  }
  parts.push(text.slice(position))
  return parts.join('')
}
