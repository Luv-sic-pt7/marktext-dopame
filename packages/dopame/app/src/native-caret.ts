export class NativeCaret {
  private readonly element = document.createElement('div')
  private frame = 0
  private active = true
  private changedAt = performance.now()
  private readonly blink: ReturnType<typeof setInterval>
  private readonly changed = () => this.refresh()
  private readonly moved = () => this.refresh(false)

  constructor(
    private readonly host: HTMLElement,
    private readonly editor: HTMLElement,
    private readonly editable: () => boolean
  ) {
    this.element.className = 'native-rich-caret'
    this.element.setAttribute('aria-hidden', 'true')
    this.element.hidden = true
    host.append(this.element)
    document.addEventListener('selectionchange', this.changed)
    document.addEventListener('focusin', this.changed)
    document.addEventListener('focusout', this.changed)
    host.addEventListener('input', this.changed)
    host.addEventListener('keydown', this.changed)
    host.addEventListener('keyup', this.changed)
    host.addEventListener('pointerup', this.changed)
    host.addEventListener('compositionstart', this.changed)
    host.addEventListener('compositionend', this.changed)
    host.addEventListener('scroll', this.moved)
    window.addEventListener('resize', this.moved)
    this.blink = setInterval(() => this.refresh(false), 530)
  }

  setActive(active: boolean) {
    this.active = active
    if (!active) this.element.hidden = true
    this.refresh()
  }

  refresh(resetBlink = true) {
    if (resetBlink) this.changedAt = performance.now()
    if (this.frame) return
    this.frame = requestAnimationFrame(() => {
      this.frame = 0
      this.paint()
    })
  }

  private paint() {
    const focused = document.activeElement
    const selection = document.getSelection()
    const contentFocused =
      focused instanceof HTMLElement &&
      focused.isContentEditable &&
      (focused === this.editor || this.editor.contains(focused))
    if (
      !this.active ||
      !this.editable() ||
      !document.hasFocus() ||
      !contentFocused ||
      !selection?.isCollapsed ||
      !selection.rangeCount ||
      !selection.anchorNode ||
      !this.editor.contains(selection.anchorNode)
    ) {
      this.element.hidden = true
      return
    }
    const range = selection.getRangeAt(0)
    const rect =
      Array.from(range.getClientRects())
        .filter((item) => item.height > 0)
        .at(-1) ?? range.getBoundingClientRect()
    const viewport = this.host.getBoundingClientRect()
    if (
      !rect.height ||
      rect.bottom <= viewport.top ||
      rect.top >= viewport.bottom ||
      rect.right < viewport.left ||
      rect.left > viewport.right
    ) {
      this.element.hidden = true
      return
    }
    this.element.hidden = false
    this.element.style.left = rect.left - viewport.left + this.host.scrollLeft + 'px'
    this.element.style.top = rect.top - viewport.top + this.host.scrollTop + 'px'
    this.element.style.height = rect.height + 'px'
    this.element.style.visibility =
      (performance.now() - this.changedAt) % 1060 < 530 ? 'visible' : 'hidden'
  }

  destroy() {
    clearInterval(this.blink)
    if (this.frame) cancelAnimationFrame(this.frame)
    document.removeEventListener('selectionchange', this.changed)
    document.removeEventListener('focusin', this.changed)
    document.removeEventListener('focusout', this.changed)
    this.host.removeEventListener('input', this.changed)
    this.host.removeEventListener('keydown', this.changed)
    this.host.removeEventListener('keyup', this.changed)
    this.host.removeEventListener('pointerup', this.changed)
    this.host.removeEventListener('compositionstart', this.changed)
    this.host.removeEventListener('compositionend', this.changed)
    this.host.removeEventListener('scroll', this.moved)
    window.removeEventListener('resize', this.moved)
    this.element.remove()
  }
}
