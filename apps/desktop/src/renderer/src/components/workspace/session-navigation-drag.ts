import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent,
  type RefObject,
} from 'react'

import type { SessionGroupPlacement } from '@pact/contracts'

export type DragSource =
  | { kind: 'session'; id: string; projectId: string; groupId: string | null }
  | { kind: 'group'; id: string; projectId: string }

export type DropTarget =
  | { kind: 'membership'; groupId: string | null; placement?: SessionGroupPlacement }
  | { kind: 'order'; groupId: string; placement: 'before' | 'after' }

type MembershipTarget = Extract<DropTarget, { kind: 'membership' }>

function membershipKey(target: MembershipTarget | undefined): string | undefined {
  if (!target) return undefined
  const position = target.placement
  return `${target.groupId ?? ''}:${position?.kind ?? ''}:${position && position.kind !== 'first' ? position.sessionId : ''}`
}

interface Point {
  x: number
  y: number
}

export interface NavigationDropRow extends Point {
  node: HTMLElement
  key: string
  height: number
}

const easing = 'cubic-bezier(0.2, 0.75, 0.25, 1)'

function translation(x: number, y: number): string {
  return `translate3d(${x}px, ${y}px, 0)`
}

export function useSessionNavigationDrag(
  scroll: RefObject<HTMLElement | null>,
  dropRows: RefObject<NavigationDropRow[]>,
  onDrop: (source: DragSource, target: DropTarget, origin: Point) => void,
  onReturnSession: (sessionId: string, origin: Point) => void,
) {
  const [source, setSource] = useState<DragSource>()
  const [hoverGroup, setHoverGroup] = useState<string>()
  const [membershipTarget, setMembershipTarget] = useState<MembershipTarget>()
  const cancelRef = useRef<(() => void) | undefined>(undefined)
  const settling = useRef<HTMLElement | undefined>(undefined)
  const suppressClickUntil = useRef(0)

  useEffect(
    () => () => {
      cancelRef.current?.()
      settling.current?.remove()
    },
    [],
  )

  const start = (event: PointerEvent<HTMLElement>, item: DragSource): void => {
    const nav = scroll.current
    const row = event.currentTarget
    const primary = row.querySelector<HTMLButtonElement>('button[data-nav-primary]')
    if (
      !nav ||
      !primary ||
      !event.isPrimary ||
      event.button !== 0 ||
      !(event.target instanceof Element) ||
      event.target.closest('input,textarea,[role=menu],button:not([data-nav-primary])')
    )
      return

    if (event.pointerType === 'mouse') event.preventDefault()
    cancelRef.current?.()
    settling.current?.remove()
    settling.current = undefined
    const id = event.pointerId
    const startX = event.clientX
    const startY = event.clientY
    let x = startX
    let y = startY
    let offsetX = 0
    let offsetY = 0
    let viewport: DOMRect | undefined
    let frame: number | undefined
    let preview: HTMLElement | undefined
    let highlighted: HTMLElement | undefined
    let placement: DropTarget | undefined
    let exitZone: { top: number; bottom: number; right: number } | undefined
    let displayedMembership: MembershipTarget | undefined
    let candidateMembership: string | undefined
    let slotTimer: number | undefined
    let hoverTimer: number | undefined
    let hovered: string | undefined
    let lastEdgeFrame: number | undefined

    const clearHover = (): void => {
      window.clearTimeout(hoverTimer)
      hoverTimer = undefined
      hovered = undefined
      setHoverGroup(undefined)
    }

    const finish = (returnToSource = false): void => {
      cancelRef.current = undefined
      if (frame !== undefined) window.cancelAnimationFrame(frame)
      clearHover()
      window.clearTimeout(slotTimer)
      highlighted?.removeAttribute('data-group-drop')
      row.removeAttribute('data-group-dragging')
      nav.removeAttribute('data-session-dragging')
      nav.removeAttribute('data-drag-invalid')
      document.removeEventListener('pointermove', move, true)
      document.removeEventListener('pointerup', release, true)
      document.removeEventListener('pointercancel', cancel, true)
      document.removeEventListener('keydown', key, true)
      nav.removeEventListener('lostpointercapture', cancel)
      nav.removeEventListener('scroll', queueFrame)
      window.removeEventListener('blur', cancel)
      window.removeEventListener('resize', cancel)
      if (nav.hasPointerCapture(id)) nav.releasePointerCapture(id)
      if (preview && returnToSource && item.kind === 'session') {
        onReturnSession(item.id, { x: x - offsetX, y: y - offsetY })
      }
      setSource(undefined)
      if (displayedMembership) setMembershipTarget(undefined)
      if (!preview) return

      suppressClickUntil.current = performance.now() + 300
      const ghost = preview
      if (
        !returnToSource ||
        item.kind === 'session' ||
        !primary.isConnected ||
        window.matchMedia('(prefers-reduced-motion: reduce)').matches
      ) {
        ghost.remove()
        return
      }
      const home = primary.getBoundingClientRect()
      settling.current = ghost
      const arrive = ghost.animate(
        [
          { transform: ghost.style.transform, opacity: 1 },
          {
            transform: translation(home.left, home.top),
            opacity: 0,
          },
        ],
        { duration: 160, easing, fill: 'forwards' },
      )
      const remove = (): void => {
        ghost.remove()
        if (settling.current === ghost) settling.current = undefined
      }
      void arrive.finished.then(remove, remove)
    }
    const cancel = (): void => finish()

    const updateTarget = (): void => {
      if (!preview || !viewport) return
      const listX = x - viewport.left - nav.clientLeft
      const listY = y - viewport.top - nav.clientTop + nav.scrollTop
      // Hit-test the mounted rows in layout coordinates, independently of their animations.
      const hit =
        listX >= 0 && listX < nav.clientWidth && nav.contains(document.elementFromPoint(x, y))
          ? dropRows.current.find((entry) => listY >= entry.y && listY < entry.y + entry.height)
          : undefined
      const foreign = hit && hit.node.dataset.dropProject !== item.projectId
      const target = foreign ? undefined : hit?.node
      const groupId = target?.dataset.dropGroup
      let marker: HTMLElement | undefined
      let mark: 'membership' | 'before' | 'after' | undefined
      placement = undefined
      if (item.kind === 'session' && hit && target && groupId !== undefined) {
        const memberId = target.dataset.sessionMenu
        const heading = target.hasAttribute('data-group-menu')
        const gutterEdge = hit.x + (heading ? 0 : 8)
        const inGutter = Boolean(groupId) && listX < gutterEdge
        const midpoint = hit.y + hit.height / 2
        const aboveSourceTitle = groupId === item.groupId && heading && listY < midpoint
        // The slot pushes rows down. Retain its original hit area until the pointer leaves it.
        const inOriginalExit =
          displayedMembership?.groupId === null &&
          exitZone &&
          listY >= exitZone.top &&
          listY < exitZone.bottom &&
          listX < exitZone.right
        if (item.groupId && (!groupId || inGutter || aboveSourceTitle || inOriginalExit)) {
          placement = { kind: 'membership', groupId: null }
          if (!inOriginalExit) {
            exitZone = {
              top: hit.y,
              bottom: aboveSourceTitle && !inGutter ? midpoint : hit.y + hit.height,
              right: inGutter ? gutterEdge : nav.clientWidth,
            }
          }
        } else if (groupId && !inGutter && target.dataset.navKey?.startsWith('drop-slot:')) {
          const side = target.dataset.dropPlacement
          const anchor = target.dataset.dropAnchor
          if (side === 'first')
            placement = { kind: 'membership', groupId, placement: { kind: 'first' } }
          else if ((side === 'before' || side === 'after') && anchor)
            placement = {
              kind: 'membership',
              groupId,
              placement: { kind: side, sessionId: anchor },
            }
        } else if (groupId && !inGutter && memberId && memberId !== item.id) {
          placement = {
            kind: 'membership',
            groupId,
            placement: {
              kind: listY < midpoint ? 'before' : 'after',
              sessionId: memberId,
            },
          }
        } else if (groupId && !inGutter && heading) {
          placement = { kind: 'membership', groupId, placement: { kind: 'first' } }
        }
        if (placement?.kind === 'membership' && placement.groupId) {
          marker = heading
            ? target
            : (nav.querySelector<HTMLElement>(
                `[data-group-menu="${CSS.escape(placement.groupId)}"]`,
              ) ?? undefined)
          mark = 'membership'
        }
      } else if (
        item.kind === 'group' &&
        hit &&
        groupId &&
        groupId !== item.id &&
        listX >= hit.x &&
        target?.hasAttribute('data-group-menu')
      ) {
        mark = listY < hit.y + hit.height / 2 ? 'before' : 'after'
        marker = target
        placement = { kind: 'order', groupId, placement: mark }
      }

      const membership = placement?.kind === 'membership' ? placement : undefined
      if (membership?.groupId !== null) exitZone = undefined
      const nextMembership = membershipKey(membership)
      if (nextMembership !== candidateMembership) {
        candidateMembership = nextMembership
        window.clearTimeout(slotTimer)
        if (!membership || membership.groupId === null) {
          displayedMembership = membership
          setMembershipTarget(membership)
        } else if (nextMembership !== membershipKey(displayedMembership)) {
          // Allow the row under the pointer to settle before the slot moves.
          slotTimer = window.setTimeout(() => {
            displayedMembership = membership
            setMembershipTarget(membership)
          }, 65)
        }
      }
      if (highlighted !== marker || (marker && marker.dataset.groupDrop !== mark)) {
        highlighted?.removeAttribute('data-group-drop')
        highlighted = marker
        if (mark && marker) marker.dataset.groupDrop = mark
      }
      if (hovered && groupId !== hovered) clearHover()
      if (
        !hovered &&
        item.kind === 'session' &&
        groupId &&
        marker?.dataset.dropCollapsed === 'true'
      ) {
        hovered = groupId
        hoverTimer = window.setTimeout(() => {
          setHoverGroup(groupId)
          queueFrame()
        }, 600)
      }
      preview.style.transform = translation(x - offsetX, y - offsetY)
      nav.toggleAttribute('data-drag-invalid', Boolean(foreign))
      preview.toggleAttribute('data-invalid', Boolean(foreign))
    }

    const queueFrame = (): void => {
      if (frame !== undefined) return
      frame = window.requestAnimationFrame((time) => {
        frame = undefined
        updateTarget()
        const bounds = viewport
        if (!bounds || x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom) {
          lastEdgeFrame = undefined
          return
        }
        const edge = Math.min(32, bounds.height / 2)
        const velocity =
          edge > 0
            ? y < bounds.top + edge
              ? -(bounds.top + edge - y) / edge
              : y > bounds.bottom - edge
                ? (y - bounds.bottom + edge) / edge
                : 0
            : 0
        if (
          !velocity ||
          (velocity < 0 && nav.scrollTop <= 0) ||
          (velocity > 0 && nav.scrollTop + nav.clientHeight >= nav.scrollHeight - 1)
        ) {
          lastEdgeFrame = undefined
          return
        }
        nav.scrollTop += (velocity * 480 * Math.min(32, time - (lastEdgeFrame ?? time))) / 1000
        lastEdgeFrame = time
        queueFrame()
      })
    }

    const move = (pointer: globalThis.PointerEvent): void => {
      if (pointer.pointerId !== id) return
      x = pointer.clientX
      y = pointer.clientY
      if (!preview && Math.hypot(x - startX, y - startY) <= 6) return
      if (!preview) {
        if (!row.isConnected) {
          finish()
          return
        }
        const box = primary.getBoundingClientRect()
        viewport = nav.getBoundingClientRect()
        offsetX = startX - box.left
        offsetY = startY - box.top
        nav.setPointerCapture(id)
        nav.addEventListener('scroll', queueFrame, { passive: true })
        nav.dataset.sessionDragging = item.kind
        setSource(item)
        if (item.kind === 'group') row.dataset.groupDragging = 'true'
        preview = document.createElement('div')
        preview.className = 'pact-nav-drag-preview'
        preview.setAttribute('aria-hidden', 'true')
        preview.style.width = `${box.width}px`
        preview.style.transform = translation(x - offsetX, y - offsetY)
        if (item.kind === 'group' && row.dataset.groupColor)
          preview.dataset.groupColor = row.dataset.groupColor
        const content = document.createElement('div')
        content.className = primary.className
        content.append(...Array.from(primary.childNodes, (node) => node.cloneNode(true)))
        preview.append(content)
        document.body.append(preview)
      }
      queueFrame()
    }
    const release = (pointer: globalThis.PointerEvent): void => {
      if (pointer.pointerId !== id) return
      x = pointer.clientX
      y = pointer.clientY
      updateTarget()
      const target = placement
      finish(!target)
      if (target) onDrop(item, target, { x: x - offsetX, y: y - offsetY })
    }
    const key = (keyboard: KeyboardEvent): void => {
      if (keyboard.key !== 'Escape') return
      if (preview) {
        keyboard.preventDefault()
        keyboard.stopPropagation()
      }
      finish(true)
    }
    cancelRef.current = cancel
    document.addEventListener('pointermove', move, true)
    document.addEventListener('pointerup', release, true)
    document.addEventListener('pointercancel', cancel, true)
    document.addEventListener('keydown', key, true)
    nav.addEventListener('lostpointercapture', cancel)
    window.addEventListener('blur', cancel)
    window.addEventListener('resize', cancel)
  }

  return {
    start,
    source,
    hoverGroup,
    membershipTarget,
    cancel: () => cancelRef.current?.(),
    suppressClick: () => {
      if (performance.now() > suppressClickUntil.current) return false
      suppressClickUntil.current = 0
      return true
    },
  }
}

interface RowMotion {
  x: number
  y: number
  fromX: number
  fromY: number
  animation?: Animation
}

export function useNavigationRowMotion(
  scroll: RefObject<HTMLElement | null>,
  rows: readonly { key: string }[],
  mountedKeys: string,
  updateDropRows: (rows: NavigationDropRow[]) => void,
): (key: string, point: Point) => void {
  const motion = useRef(new Map<string, RowMotion>())
  const previousLayout = useRef<{ rows: typeof rows; mountedKeys: string } | undefined>(undefined)
  const dropped = useRef<{ key: string; point: Point } | undefined>(undefined)

  useLayoutEffect(() => {
    const nav = scroll.current
    if (!nav) return
    const layout = previousLayout.current
    if (layout?.rows === rows && layout.mountedKeys === mountedKeys) return
    const changed = layout !== undefined && layout.rows !== rows
    previousLayout.current = { rows, mountedKeys }
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const previous = motion.current
    const drop = dropped.current
    const next = new Map<string, RowMotion>()
    const mounted = Array.from(nav.querySelectorAll<HTMLElement>('[data-nav-key]'), (node) => ({
      node,
      key: node.dataset.navKey ?? '',
      x: node.offsetLeft,
      y: node.offsetTop,
      height: node.offsetHeight,
    }))
    updateDropRows(mounted)
    for (const { node, key, x, y } of mounted) {
      const before = previous.get(key)
      const progress = before?.animation?.effect?.getComputedTiming().progress ?? 1
      let fromX = before ? before.x + before.fromX * (1 - progress) - x : 0
      let fromY = before ? before.y + before.fromY * (1 - progress) - y : 0
      if (drop?.key === key && !reduced) {
        // Drop coordinates describe the primary content, not its row's outer gutter.
        const primary = node.querySelector('[data-nav-primary]') ?? node
        const rect = primary.getBoundingClientRect()
        fromX = drop.point.x - rect.left + (before?.fromX ?? 0) * (1 - progress)
        fromY = drop.point.y - rect.top + (before?.fromY ?? 0) * (1 - progress)
      }
      previous.delete(key)
      if (!reduced && drop?.key !== key && before && before.x === x && before.y === y) {
        next.set(key, before)
        continue
      }
      before?.animation?.cancel()
      const record: RowMotion = { x, y, fromX, fromY }
      const landing = drop?.key === key
      const entering =
        changed && !before && !drop && (key.startsWith('group:') || key.startsWith('drop-slot:'))
      if (!reduced && (Math.abs(fromX) + Math.abs(fromY) > 1 || entering || landing)) {
        const frames = entering
          ? [{ opacity: 0.35 }, { opacity: 1 }]
          : [{ transform: translation(fromX, fromY) }, { transform: 'none' }]
        record.animation = node.animate(frames, { duration: landing ? 180 : 150, easing })
      }
      next.set(key, record)
    }
    for (const row of previous.values()) row.animation?.cancel()
    motion.current = next
    if (changed || (drop && next.has(drop.key))) dropped.current = undefined
  }, [rows, mountedKeys, scroll, updateDropRows])

  useEffect(
    () => () => {
      for (const row of motion.current.values()) row.animation?.cancel()
      motion.current.clear()
      previousLayout.current = undefined
      updateDropRows([])
    },
    [updateDropRows],
  )

  return (key, point) => {
    dropped.current = { key, point }
  }
}
