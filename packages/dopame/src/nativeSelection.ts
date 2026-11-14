import { SelectionType, type Muya } from '@muyajs/core'

function attachCaretOverlay(root: HTMLElement): () => void {
  const doc = root.ownerDocument
  // acdert 0.0.9 accepts DOM selections but does not paint the contenteditable caret.
  const caret = doc.createElement('div')
  caret.className = 'native-editor-caret'
  caret.setAttribute('aria-hidden', 'true')
  doc.body.appendChild(caret)
  let frame = 0
  let lastStyle = ''
  function paintCaret() {
    const selection = doc.getSelection()
    let style = 'display:none'
    if (root.contains(doc.activeElement) && selection?.isCollapsed && selection.rangeCount
      && root.contains(selection.focusNode) && !root.classList.contains('mu-read-only')) {
      const rect = selection.getRangeAt(0).getBoundingClientRect()
      const node = selection.focusNode
      const content = (node?.nodeType === Node.ELEMENT_NODE ? node as Element : node?.parentElement)?.closest<HTMLElement>('.mu-content')
      if (content) {
        const bounds = content.getBoundingClientRect()
        const height = rect.height || parseFloat(getComputedStyle(content).lineHeight) || bounds.height
        const x = rect.height ? rect.x : bounds.x
        const y = rect.height ? rect.y : bounds.y
        const viewport = root.parentElement!.getBoundingClientRect()
        if (x >= viewport.left && x <= viewport.right && y >= viewport.top && y + height <= viewport.bottom) {
          style = `display:block;left:${x}px;top:${y}px;height:${height}px`
        }
      }
    }
    if (style !== lastStyle) { caret.style.cssText = style; lastStyle = style }
    frame = requestAnimationFrame(paintCaret)
  }
  frame = requestAnimationFrame(paintCaret)
  return () => {
    cancelAnimationFrame(frame)
    caret.remove()
  }
}

// These renderer profiles can focus contenteditable without establishing a Range.
// The tested system 0.0.11 package advertises the 0.0.10 renderer profile.
export function attachNativeSelection(muya: Muya): () => void {
  const rendererVersion = /\bacdert\/(0\.0\.(?:9|10))(?=$|[\s;)])/i.exec(navigator.userAgent)?.[1]
  const needsPointerSelection = rendererVersion === '0.0.9' || rendererVersion === '0.0.10'
  const needsArrowKeys = rendererVersion === '0.0.9' || rendererVersion === '0.0.10'
  const needsCaretOverlay = rendererVersion === '0.0.9'
  if (!needsPointerSelection) return () => {}

  const root = muya.domNode
  const doc = root.ownerDocument
  let detachCaret: (() => void) | undefined
  if (needsCaretOverlay) detachCaret = attachCaretOverlay(root)
  let anchor: { node: Node; offset: number } | null = null

  function atPoint(event: MouseEvent): Range | null {
    const target = event.target as Element
    const content = target.closest<HTMLElement>('.mu-content')
    if (!content || !root.contains(content) || !content.isContentEditable) return null
    if (target.closest('[contenteditable="false"]')) return null

    // Empty-hint pseudo text is not a DOM endpoint; use the empty span itself.
    if (!content.textContent) {
      const range = doc.createRange()
      range.selectNodeContents(content)
      range.collapse(true)
      return range
    }
    const range = doc.caretRangeFromPoint(event.clientX, event.clientY)
    return range && content.contains(range.startContainer) ? range : null
  }

  function down(event: MouseEvent) {
    if (event.button !== 0) return
    const range = atPoint(event)
    const selection = doc.getSelection()
    if (!range || !selection) return
    if (event.shiftKey && selection.anchorNode && root.contains(selection.anchorNode)) {
      selection.extend(range.startContainer, range.startOffset)
    } else {
      selection.removeAllRanges()
      selection.addRange(range)
    }
    anchor = { node: selection.anchorNode!, offset: selection.anchorOffset }
  }

  function move(event: MouseEvent) {
    if (!anchor || !(event.buttons & 1)) return
    const range = atPoint(event)
    if (!range) return
    doc.getSelection()!.setBaseAndExtent(anchor.node, anchor.offset, range.startContainer, range.startOffset)
  }

  function keydown(event: KeyboardEvent) {
    if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    const selection = muya.getSelection()
    if (selection?.kind !== SelectionType.TEXT || !selection.context.isSelectionInSameBlock) return
    const { anchor, focus, context } = selection
    const backwards = event.key === 'ArrowLeft'
    let offset: number
    if (!event.shiftKey && !context.isCollapsed) {
      offset = backwards ? Math.min(anchor.offset, focus.offset) : Math.max(anchor.offset, focus.offset)
    } else {
      const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(context.focusBlock.text)
      const boundaries = [0, ...Array.from(segments, item => item.index + item.segment.length)]
      offset = backwards
        ? boundaries.filter(value => value < focus.offset).at(-1) ?? focus.offset
        : boundaries.find(value => value > focus.offset) ?? focus.offset
    }
    if (context.isCollapsed && offset === focus.offset) return
    const next = { ...focus, offset }
    if (muya.setSelection({ kind: SelectionType.TEXT, anchor: event.shiftKey ? anchor : next, focus: next })) {
      event.preventDefault()
    }
  }

  function up() { anchor = null }
  root.addEventListener('mousedown', down, true)
  if (needsArrowKeys) root.addEventListener('keydown', keydown)
  doc.addEventListener('mousemove', move)
  doc.addEventListener('mouseup', up)
  return () => {
    detachCaret?.()
    root.removeEventListener('mousedown', down, true)
    if (needsArrowKeys) root.removeEventListener('keydown', keydown)
    doc.removeEventListener('mousemove', move)
    doc.removeEventListener('mouseup', up)
  }
}
