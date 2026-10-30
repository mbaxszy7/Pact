import {
  collaborationReviewInputSchema,
  type CollaborationReviewObservation,
  type CollaborationInputObservation,
} from '@pact/contracts'

/** The complete provider-native answer has the same projection live, cold and at Fork. */
export function projectCollaborationAnswer(
  items: readonly { id: string; text: string; phase?: unknown }[],
): string {
  return items
    .map((item) => item.text)
    .filter(Boolean)
    .join('\n\n')
}

/** Different questions are also conflicting submissions; incomplete remains sticky. */
export function mergeWorkflowReview(
  current: CollaborationReviewObservation | undefined,
  next: CollaborationReviewObservation,
): CollaborationReviewObservation {
  return current === undefined || JSON.stringify(current) === JSON.stringify(next)
    ? next
    : { verdict: 'incomplete' }
}
export function mergeWorkflowInput(
  current: CollaborationInputObservation | undefined,
  next: CollaborationInputObservation,
): CollaborationInputObservation {
  return current === undefined || JSON.stringify(current) === JSON.stringify(next)
    ? next
    : { outcome: 'incomplete' }
}
export function readWorkflowReview(value: unknown): CollaborationReviewObservation | undefined {
  const result = collaborationReviewInputSchema.safeParse(value)
  return result.success ? result.data : undefined
}
