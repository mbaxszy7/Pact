import { CONVERSATION_EXPAND_BYTES } from '@pact/contracts'

import type {
  ActivityBodySource,
  ExpandedActivityBody,
  LoadMoreActivityBody,
} from './conversation-window'

export function LargeMessagePreview({ preview }: { preview: string }): React.JSX.Element {
  return (
    <div className="space-y-1.5 text-caption text-secondary">
      <p className="text-center text-caption text-tertiary" role="note">
        Long message · Plain-text preview for performance
      </p>
      <pre
        className="max-h-40 overflow-hidden whitespace-pre-wrap break-words rounded-control bg-surface-muted p-2 font-sans text-body leading-relaxed text-primary"
        aria-label="Message preview"
      >
        {preview}
      </pre>
    </div>
  )
}

export function LargeActivityPreview({
  source,
  expanded,
  onLoadMore,
}: {
  source: ActivityBodySource
  expanded?: ExpandedActivityBody | undefined
  onLoadMore: LoadMoreActivityBody
}): React.JSX.Element {
  const matching =
    expanded?.activityId === source.activityId && expanded.revision === source.revision
  const complete = matching && !expanded?.loading && !expanded?.error
  const tooLarge = source.bodyBytes > CONVERSATION_EXPAND_BYTES
  return (
    <div className="space-y-1.5 text-caption text-secondary">
      <p className="text-tertiary">
        Work log detail · {Math.ceil(source.bodyBytes / 1024).toLocaleString()} KiB
      </p>
      <pre
        className={`${complete ? 'max-h-80 overflow-auto' : 'max-h-40 overflow-hidden'} whitespace-pre-wrap break-words rounded-control bg-surface-muted p-2 font-mono text-caption leading-relaxed text-primary`}
        aria-label={complete ? 'Full work log detail' : 'Work log detail preview'}
      >
        {complete ? expanded?.text : source.preview}
      </pre>
      {matching && expanded?.error ? (
        <p className="text-danger" role="alert">
          {expanded.error}
        </p>
      ) : null}
      {tooLarge ? (
        <p className="text-tertiary">
          Too large for inline expansion. The complete detail remains saved locally.
        </p>
      ) : !complete ? (
        <button
          className="min-h-8 rounded-control px-1 font-medium text-secondary hover:text-primary focus-visible:outline-2 focus-visible:outline-focus disabled:cursor-wait disabled:opacity-50"
          type="button"
          disabled={matching && expanded?.loading}
          onClick={() => onLoadMore(source)}
        >
          {matching && expanded?.loading ? 'Loading…' : 'Load more'}
        </button>
      ) : null}
    </div>
  )
}
