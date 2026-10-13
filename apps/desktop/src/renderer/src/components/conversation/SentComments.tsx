import { LoaderCircle } from 'lucide-react'

import type { AnchoredComment } from '@pact/contracts'

interface SentCommentsProps {
  comments: AnchoredComment[] | undefined
  loading: boolean
  error?: string | undefined
  commentOnly: boolean
  onRetry: () => void
  onOpenComment: (comment: AnchoredComment) => void
  hasMore?: boolean | undefined
  hasEarlier?: boolean | undefined
  paging?: boolean | undefined
  onNext?: (() => void) | undefined
  onFirst?: (() => void) | undefined
}

export function SentComments({
  comments,
  loading,
  error,
  commentOnly,
  onRetry,
  onOpenComment,
  hasMore,
  hasEarlier,
  paging,
  onNext,
  onFirst,
}: SentCommentsProps): React.JSX.Element {
  return (
    <div className={commentOnly ? 'mt-2' : 'mt-3 border-t border-border/55 pt-2'}>
      {comments?.length ? (
        <div aria-label={comments.length === 1 ? 'Comment' : 'Comments'}>
          <p className="text-caption font-medium text-tertiary">
            {comments.length === 1 ? 'Comment' : 'Comments'}
          </p>
          <div className="mt-1.5 space-y-2">
            {comments.map((comment) => (
              <button
                key={comment.id}
                className="block w-full rounded-control border border-border/75 bg-surface-raised/20 px-2.5 py-2 text-left text-caption text-secondary transition-colors duration-150 hover:border-border-strong hover:bg-surface-raised/40 focus-visible:outline-2 focus-visible:outline-focus"
                type="button"
                onClick={() => onOpenComment(comment)}
              >
                <span className="block line-clamp-2 text-tertiary">“{comment.anchor.quote}”</span>
                <span className="mt-1 block whitespace-pre-wrap break-words text-primary">
                  {comment.body}
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : error ? (
        <p className="flex items-center gap-2 text-caption text-secondary" role="alert">
          Comments unavailable.
          <button
            className="min-h-8 font-medium text-primary hover:underline focus-visible:outline-2 focus-visible:outline-focus"
            type="button"
            onClick={onRetry}
          >
            Retry
          </button>
        </p>
      ) : loading ? (
        <output
          className="inline-flex min-h-5 items-center text-tertiary"
          aria-label="Loading comments"
        >
          <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" strokeWidth={1.8} />
        </output>
      ) : null}
      {onFirst && !loading && (hasMore || hasEarlier || !comments?.length) ? (
        <div className="mt-1 flex items-center gap-2 text-caption text-secondary">
          {hasEarlier || !comments?.length ? (
            <button
              type="button"
              disabled={paging}
              onClick={onFirst}
              className="min-h-7 rounded-control px-1.5 hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-45"
            >
              {comments?.length ? 'First Comments' : 'View Comments'}
            </button>
          ) : null}
          {hasMore && comments?.length && onNext ? (
            <button
              type="button"
              disabled={paging}
              onClick={onNext}
              className="min-h-7 rounded-control px-1.5 hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-45"
            >
              {paging ? 'Loading…' : 'More Comments'}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
