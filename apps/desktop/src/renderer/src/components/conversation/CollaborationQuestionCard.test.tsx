import type { ComponentProps } from 'react'

// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import type { DesktopBridge } from '@pact/contracts'

import { CollaborationQuestionCard } from './CollaborationQuestionCard'

type Props = ComponentProps<typeof CollaborationQuestionCard>

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
function fixture(): ComponentProps<typeof CollaborationQuestionCard> {
  return {
    sessionId: crypto.randomUUID(),
    runId: crypto.randomUUID(),
    actor: 'codex',
    disabled: false,
    onOpenProjectFile: vi.fn<Props['onOpenProjectFile']>(),
    onSubmit: vi.fn<Props['onSubmit']>(),
    canSubmit: false,
    onDraftChange: vi.fn<NonNullable<Props['onDraftChange']>>().mockReturnValue(true),
    onClearDraft: vi.fn<NonNullable<Props['onClearDraft']>>().mockReturnValue(true),
    decision: {
      reference: {
        taskId: crypto.randomUUID(),
        runId: crypto.randomUUID(),
        decisionInputSequence: 1,
        expectedInputSequence: 1,
      },
      questions: [
        {
          id: 'q1',
          prompt: 'When should delivery happen?',
          selection: 'single',
          options: [
            { id: 'o1', label: 'Queue' },
            { id: 'o2', label: 'Steer', description: 'Interrupt the active turn.' },
          ],
        },
        {
          id: 'q2',
          prompt: 'Which targets?',
          selection: 'multiple',
          options: [
            { id: 'o1', label: 'Desktop' },
            { id: 'o2', label: 'Web' },
          ],
        },
      ],
    },
  }
}
it('edits explicit choice and free text drafts without starting a turn or preselecting answers', () => {
  const props = fixture()
  const view = render(<CollaborationQuestionCard {...props} />)
  expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Queue' }).checked).toBe(false)
  fireEvent.click(screen.getByRole('radio', { name: 'Queue' }))
  expect(props.onDraftChange).toHaveBeenLastCalledWith({
    ...props.decision,
    answers: { q1: { optionIds: ['o1'], text: '' } },
  })
  expect(props.onSubmit).not.toHaveBeenCalled()
  const draft = {
    ...props.decision,
    answers: {
      q1: { optionIds: ['o1'], text: 'Keep my context' },
      q2: { optionIds: ['o1'], text: '' },
    },
  }
  view.rerender(<CollaborationQuestionCard {...props} draft={draft} canSubmit />)
  fireEvent.click(screen.getByRole('checkbox', { name: 'Web' }))
  expect(props.onDraftChange).toHaveBeenLastCalledWith({
    ...draft,
    answers: { ...draft.answers, q2: { optionIds: ['o1', 'o2'], text: '' } },
  })
  fireEvent.change(screen.getAllByRole('textbox')[0]!, { target: { value: 'Later please' } })
  expect(props.onDraftChange).toHaveBeenLastCalledWith({
    ...draft,
    answers: { ...draft.answers, q1: { optionIds: ['o1'], text: 'Later please' } },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Send answers' }))
  expect(props.onSubmit).toHaveBeenCalledOnce()
})
it('preserves stale answers and requires explicit keep or discard before the new request', () => {
  const props = fixture()
  const draft = {
    ...props.decision,
    reference: { ...props.decision.reference, runId: crypto.randomUUID() },
    answers: { q1: { optionIds: ['o1'], text: 'Saved answer' } },
  }
  render(<CollaborationQuestionCard {...props} draft={draft} canSubmit />)
  expect(screen.getByRole('alert').textContent).toContain('earlier request')
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Send answers' }).disabled).toBe(
    true,
  )
  expect(screen.getByRole('radio', { name: 'Queue' }).closest('fieldset')?.disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Keep answers in message draft' }))
  expect(props.onClearDraft).toHaveBeenLastCalledWith(true)
  fireEvent.click(screen.getByRole('button', { name: 'Discard saved answers' }))
  expect(props.onClearDraft).toHaveBeenLastCalledWith(false)
  expect(props.onSubmit).not.toHaveBeenCalled()
  expect(draft.answers.q1.text).toBe('Saved answer')
})
it('surfaces a rejected draft edit while keeping the controlled saved answer', () => {
  const props = fixture()
  props.onDraftChange = vi.fn<NonNullable<Props['onDraftChange']>>().mockReturnValue(false)
  render(
    <CollaborationQuestionCard
      {...props}
      draft={{ ...props.decision, answers: { q1: { optionIds: [], text: 'Saved' } } }}
    />,
  )
  fireEvent.change(screen.getAllByRole('textbox')[0]!, { target: { value: 'Rejected edit' } })
  expect(screen.getByRole('alert').textContent).toContain('Existing answers have been kept')
  expect(screen.getAllByRole<HTMLTextAreaElement>('textbox')[0]!.value).toBe('Saved')
})
it('keeps legacy requests lazy, retries unavailable source reads, and saves free text through the draft owner', async () => {
  const props = fixture()
  props.decision.questions = []
  const read = vi.fn<DesktopBridge['getConversation']>().mockResolvedValue({
    ok: false,
    error: { code: 'CONTEXT_UNAVAILABLE', message: 'Source unavailable' },
  })
  vi.stubGlobal('pact', { getConversation: read })
  render(<CollaborationQuestionCard {...props} />)
  expect(read).not.toHaveBeenCalled()
  fireEvent.change(screen.getByRole('textbox', { name: 'Your answer' }), {
    target: { value: 'My reply' },
  })
  expect(props.onDraftChange).toHaveBeenCalledWith({
    ...props.decision,
    answers: {},
    originalReply: 'My reply',
  })
  fireEvent.click(screen.getByRole('button', { name: 'Read original request' }))
  await screen.findByText('Source unavailable')
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
  await screen.findByText('Source unavailable')
  expect(read).toHaveBeenCalledTimes(2)
  expect(props.onSubmit).not.toHaveBeenCalled()
})
