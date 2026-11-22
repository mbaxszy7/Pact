import type { ReactNode } from 'react'

import { SideChatStage } from './SideChatStage'

export type ContextInspectorTab = 'plan' | 'sidechats' | 'changes' | 'file' | 'settings'

export interface ContextInspectorProps {
  activeTab: ContextInspectorTab
  planAvailable: boolean
  onPlanHostRef: (element: HTMLDivElement | null) => void
  sideChatsMounted: boolean
  sideChatsHostRef: React.RefObject<HTMLDivElement | null>
  sideChatsPanel?: ReactNode
  changesPanel?: ReactNode
  filePanel?: ReactNode
  settingsPanel?: ReactNode
  changesStageKey?: string | undefined
  fileStageKey?: string | undefined
}

/**
 * Unified right-side floating ContextInspector providing dual DOM keep-alive hosts
 * for Plan and Side Chats while topbar controls switch the active view.
 */
export function ContextInspector({
  activeTab,
  planAvailable,
  onPlanHostRef,
  sideChatsMounted,
  sideChatsHostRef,
  sideChatsPanel,
  changesPanel,
  filePanel,
  settingsPanel,
  changesStageKey,
  fileStageKey,
}: ContextInspectorProps): React.JSX.Element {
  return (
    <section
      className="flex h-full min-h-0 flex-col bg-surface text-primary"
      data-context-inspector
      data-active-tab={activeTab}
      aria-label="Context inspector"
    >
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {planAvailable ? (
          <div
            ref={onPlanHostRef}
            data-inspector-pane="plan"
            className="h-full min-h-0"
            hidden={activeTab !== 'plan'}
            inert={activeTab !== 'plan'}
            aria-hidden={activeTab !== 'plan'}
          />
        ) : null}

        {sideChatsMounted && sideChatsPanel ? (
          <div
            ref={sideChatsHostRef}
            data-inspector-pane="sidechats"
            className="h-full min-h-0"
            hidden={activeTab !== 'sidechats'}
            inert={activeTab !== 'sidechats'}
            aria-hidden={activeTab !== 'sidechats'}
          >
            {sideChatsPanel}
          </div>
        ) : null}

        {changesPanel ? (
          <div
            data-inspector-pane="changes"
            className="h-full min-h-0 bg-surface"
            hidden={activeTab !== 'changes'}
            inert={activeTab !== 'changes'}
            aria-hidden={activeTab !== 'changes'}
          >
            {changesStageKey ? (
              <SideChatStage stageKey={changesStageKey} depth={2}>
                {changesPanel}
              </SideChatStage>
            ) : (
              changesPanel
            )}
          </div>
        ) : null}

        {filePanel ? (
          <div
            data-inspector-pane="file"
            className="h-full min-h-0 bg-surface"
            hidden={activeTab !== 'file'}
            inert={activeTab !== 'file'}
            aria-hidden={activeTab !== 'file'}
          >
            {fileStageKey ? (
              <SideChatStage stageKey={fileStageKey} depth={2}>
                {filePanel}
              </SideChatStage>
            ) : (
              filePanel
            )}
          </div>
        ) : null}

        {settingsPanel ? (
          <div
            data-inspector-pane="settings"
            className="h-full min-h-0 bg-surface"
            hidden={activeTab !== 'settings'}
            inert={activeTab !== 'settings'}
            aria-hidden={activeTab !== 'settings'}
          >
            {settingsPanel}
          </div>
        ) : null}
      </div>
    </section>
  )
}
