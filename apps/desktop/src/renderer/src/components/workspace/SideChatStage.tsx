import { Component, createRef, type ReactNode } from 'react'

interface SideChatStageProps {
  stageKey: string
  depth: number
  children: ReactNode
  className?: string | undefined
}

interface OutgoingSnapshot {
  nodes: Node[]
  scrollTops: number[]
  direction: 1 | -1
}

interface StageState {
  activeKey: string
  activeDepth: number
  direction: 1 | -1
  animate: boolean
  hasOutgoing: boolean
}

/**
 * Horizontal push/pop stage animating push (`+12px -> 0`, 180ms) and pop (`-12px -> 0`, 160ms).
 * Snapshots the outgoing DOM before commit into an `inert`, `absolute` layer cleared by a single replaceable timer.
 */
export class SideChatStage extends Component<SideChatStageProps, StageState> {
  private readonly activeLayerRef = createRef<HTMLDivElement>()
  private readonly outgoingLayerRef = createRef<HTMLDivElement>()
  private pendingOutgoing: OutgoingSnapshot | undefined
  private exitTimer: number | undefined

  public constructor(props: SideChatStageProps) {
    super(props)
    this.state = {
      activeKey: props.stageKey,
      activeDepth: props.depth,
      direction: 1,
      animate: false,
      hasOutgoing: false,
    }
  }

  public static getDerivedStateFromProps(
    props: SideChatStageProps,
    state: StageState,
  ): Partial<StageState> | null {
    if (props.stageKey === state.activeKey) return null
    const direction: 1 | -1 = props.depth >= state.activeDepth ? 1 : -1
    return {
      activeKey: props.stageKey,
      activeDepth: props.depth,
      direction,
      animate: true,
      hasOutgoing: true,
    }
  }

  public override getSnapshotBeforeUpdate(prevProps: SideChatStageProps): OutgoingSnapshot | null {
    if (prevProps.stageKey === this.props.stageKey) return null
    const host = this.activeLayerRef.current
    if (!host) return null
    const scrollTops: number[] = []
    for (const element of host.querySelectorAll<HTMLElement>('*')) {
      if (element.scrollTop > 0) scrollTops.push(element.scrollTop)
    }
    const clone = host.cloneNode(true)
    const nodes = clone instanceof HTMLElement ? [...clone.childNodes] : []
    const direction: 1 | -1 = this.props.depth >= prevProps.depth ? -1 : 1
    return { nodes, scrollTops, direction }
  }

  public override componentDidUpdate(
    prevProps: SideChatStageProps,
    _prevState: StageState,
    snapshot: OutgoingSnapshot | null,
  ): void {
    if (prevProps.stageKey === this.props.stageKey) return
    if (this.exitTimer !== undefined) {
      window.clearTimeout(this.exitTimer)
      this.exitTimer = undefined
    }
    const outgoing = this.outgoingLayerRef.current
    if (!snapshot || !outgoing) {
      if (this.state.hasOutgoing) this.clearOutgoing()
      return
    }
    this.pendingOutgoing = snapshot
    outgoing.replaceChildren(...snapshot.nodes)
    outgoing.setAttribute('data-direction', String(snapshot.direction))
    outgoing.setAttribute('data-stage-state', 'outgoing')
    let scrollIndex = 0
    for (const element of outgoing.querySelectorAll<HTMLElement>('*')) {
      if (scrollIndex >= snapshot.scrollTops.length) break
      if (element.scrollHeight > element.clientHeight) {
        element.scrollTop = snapshot.scrollTops[scrollIndex++] ?? 0
      }
    }
    const durationMs = this.state.direction === 1 ? 180 : 160
    this.exitTimer = window.setTimeout(() => {
      this.exitTimer = undefined
      this.clearOutgoing()
    }, durationMs)
  }

  public override componentWillUnmount(): void {
    if (this.exitTimer !== undefined) {
      window.clearTimeout(this.exitTimer)
      this.exitTimer = undefined
    }
    this.pendingOutgoing = undefined
  }

  private clearOutgoing(): void {
    this.pendingOutgoing = undefined
    this.outgoingLayerRef.current?.replaceChildren()
    this.setState((current) => (current.hasOutgoing ? { ...current, hasOutgoing: false } : null))
  }

  public override render(): ReactNode {
    const { stageKey, children, className } = this.props
    const { direction, animate, hasOutgoing } = this.state
    const outgoingDirection = this.pendingOutgoing?.direction ?? (direction === 1 ? -1 : 1)

    return (
      <div
        className={
          className
            ? `pact-side-chat-stage relative flex h-full min-h-0 flex-1 flex-col overflow-hidden ${className}`
            : 'pact-side-chat-stage relative flex h-full min-h-0 flex-1 flex-col overflow-hidden'
        }
      >
        <div
          ref={this.outgoingLayerRef}
          hidden={!hasOutgoing}
          aria-hidden="true"
          inert
          data-stage-state="outgoing"
          data-direction={outgoingDirection}
          data-animate={hasOutgoing ? 'true' : 'false'}
          className="pact-side-chat-stage-layer pointer-events-none absolute inset-0 z-0 flex h-full min-h-0 flex-col bg-surface-raised"
        />
        <div
          key={stageKey}
          ref={this.activeLayerRef}
          data-stage-state="active"
          data-direction={direction}
          data-animate={animate ? 'true' : 'false'}
          className="pact-side-chat-stage-layer relative z-1 flex h-full min-h-0 flex-1 flex-col bg-surface-raised"
        >
          {children}
        </div>
      </div>
    )
  }
}
