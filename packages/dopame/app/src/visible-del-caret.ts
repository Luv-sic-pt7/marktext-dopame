import type { Muya } from '@muyajs/core'
import type Content from '@muyajs/core/block/base/content.ts'
import type { IAnchorFocusInfo } from '@muyajs/core/selection/types.ts'
import { resolveEndpoint } from '@muyajs/core/selection/dom.ts'

type Direction = -1 | 1
type DomPoint = { node: Node; offset: number }
type MarkerRange = { element: HTMLElement; start: number; end: number }

function textLeaves(node: Node): Text[] {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ? [node as Text] : []
  return Array.from(node.childNodes).flatMap(textLeaves)
}

function markerRange(element: HTMLElement, block: Content): MarkerRange | null {
  const leaves = textLeaves(element)
  const first = leaves[0]
  const last = leaves.at(-1)
  if (!first || !last) return null
  const start = resolveEndpoint(first, 0)
  const end = resolveEndpoint(last, last.length)
  if (start?.block !== block || end?.block !== block) return null
  return { element, start: start.offset, end: end.offset }
}

function ranges(block: Content): MarkerRange[] {
  return Array.from(block.domNode?.querySelectorAll<HTMLElement>('.mu-del-marker') ?? [])
    .map((element) => markerRange(element, block))
    .filter((range): range is MarkerRange => !!range)
}

function pointAt(point: IAnchorFocusInfo, offset: number): IAnchorFocusInfo {
  return { block: point.block, path: [...point.block.path], offset }
}

function skipMarkers(point: IAnchorFocusInfo, direction: Direction, includeBoundary: boolean) {
  let offset = point.offset
  for (const range of direction > 0 ? ranges(point.block) : ranges(point.block).reverse()) {
    const inside =
      direction > 0
        ? (includeBoundary ? offset >= range.start : offset > range.start) && offset < range.end
        : offset > range.start && (includeBoundary ? offset <= range.end : offset < range.end)
    if (inside) offset = direction > 0 ? range.end : range.start
  }
  return pointAt(point, offset)
}

export function delVisibleBoundary(point: IAnchorFocusInfo, direction: Direction) {
  return skipMarkers(point, direction, true)
}

/** Delimiters do not consume an arrow step; a paragraph boundary still does. */
export function moveVisibleDelCaret(point: IAnchorFocusInfo, direction: Direction) {
  const current = skipMarkers(point, direction, true)
  const { block, offset } = current
  const text = block.text
  if (direction > 0 && offset === text.length) {
    const next = block.nextContentInContext(true)
    return next ? delVisibleBoundary({ block: next, path: [...next.path], offset: 0 }, 1) : current
  }
  if (direction < 0 && offset === 0) {
    const previous = block.previousContentInContext(true)
    return previous
      ? delVisibleBoundary(
          { block: previous, path: [...previous.path], offset: previous.text.length },
          -1
        )
      : current
  }
  const length =
    direction > 0
      ? /[\uD800-\uDBFF]/.test(text[offset]) && /[\uDC00-\uDFFF]/.test(text[offset + 1] ?? '')
        ? 2
        : 1
      : /[\uDC00-\uDFFF]/.test(text[offset - 1]) && /[\uD800-\uDBFF]/.test(text[offset - 2] ?? '')
        ? 2
        : 1
  return pointAt(current, offset + direction * length)
}

function markerAt(node: Node | null): HTMLElement | null {
  const element = node instanceof Element ? node : node?.parentElement
  return element?.closest<HTMLElement>('.mu-del-marker') ?? null
}

function matches(point: DomPoint, expected: IAnchorFocusInfo) {
  if (markerAt(point.node)) return false
  const resolved = resolveEndpoint(point.node, point.offset)
  return resolved?.block === expected.block && resolved.offset === expected.offset
}

function outsideMarker(
  marker: HTMLElement,
  edge: 'start' | 'end',
  expected: IAnchorFocusInfo
): DomPoint | null {
  let current: Node = marker
  let boundary: DomPoint | null = null
  const content = expected.block.domNode
  while (current.parentNode && current !== content) {
    const sibling = edge === 'end' ? current.nextSibling : current.previousSibling
    if (sibling) {
      const leaves = textLeaves(sibling)
      const leaf = edge === 'end' ? leaves[0] : leaves.at(-1)
      if (
        leaf?.parentElement?.isContentEditable &&
        getComputedStyle(leaf.parentElement).fontSize !== '0px'
      ) {
        const candidate = { node: leaf, offset: edge === 'end' ? 0 : leaf.length }
        if (matches(candidate, expected)) return candidate
      }
    }
    const parent = current.parentNode
    const index = Array.from(parent.childNodes).indexOf(current as ChildNode)
    const candidate = { node: parent, offset: index + (edge === 'end' ? 1 : 0) }
    if (!boundary && matches(candidate, expected)) boundary = candidate
    current = parent
  }
  return boundary
}

function visibleEndpoint(node: Node, offset: number, expected: IAnchorFocusInfo): DomPoint {
  const marker = markerAt(node)
  if (!marker || !expected.block.domNode?.contains(marker)) return { node, offset }
  const range = markerRange(marker, expected.block)
  const edge =
    expected.offset === range?.start ? 'start' : expected.offset === range?.end ? 'end' : null
  return edge ? (outsideMarker(marker, edge, expected) ?? { node, offset }) : { node, offset }
}

export function setVisibleDelSelection(
  muya: Muya,
  anchor: IAnchorFocusInfo,
  focus: IAnchorFocusInfo,
  direction: Direction = 1
) {
  const nextFocus = skipMarkers(focus, direction, false)
  const collapsed = anchor.block === focus.block && anchor.offset === focus.offset
  const nextAnchor = collapsed ? nextFocus : anchor
  muya.editor.selection.setSelection(nextAnchor, nextFocus)
  const selection = document.getSelection()
  if (!selection?.anchorNode || !selection.focusNode) return
  const start = visibleEndpoint(selection.anchorNode, selection.anchorOffset, nextAnchor)
  const end = visibleEndpoint(selection.focusNode, selection.focusOffset, nextFocus)
  if (
    start.node === selection.anchorNode &&
    start.offset === selection.anchorOffset &&
    end.node === selection.focusNode &&
    end.offset === selection.focusOffset
  )
    return
  // Keep the model's raw offsets while choosing a real caret boundary outside the zero-size span.
  const range = document.createRange()
  range.setStart(start.node, start.offset)
  range.collapse(true)
  selection.removeAllRanges()
  selection.addRange(range)
  selection.extend(end.node, end.offset)
}

export function normalizeVisibleDelCaret(muya: Muya) {
  const selection = document.getSelection()
  if (!selection?.isCollapsed || !selection.anchorNode) return
  const marker = markerAt(selection.anchorNode)
  const point = resolveEndpoint(selection.anchorNode, selection.anchorOffset)
  if (!marker || !point || point.block.muya !== muya) return
  const range = markerRange(marker, point.block)
  if (!range) return
  const offset =
    point.offset > range.start && point.offset < range.end
      ? marker.nextElementSibling?.matches('del.mu-inline-rule')
        ? range.end
        : range.start
      : point.offset
  const current = pointAt(point, offset)
  setVisibleDelSelection(muya, current, current)
}
