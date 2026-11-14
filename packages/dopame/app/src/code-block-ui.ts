import { CodeBlockLanguageSelector, type Muya } from '@muyajs/core'
import { getBlock } from '@muyajs/core/utils/dom.ts'

export function labelCodeBlocks(muya: Muya) {
  for (const input of muya.domNode.querySelectorAll('pre.mu-code-block .mu-language-input'))
    input.setAttribute('aria-label', '代码语言')
  for (const content of muya.domNode.querySelectorAll('pre.mu-code-block .mu-codeblock-content'))
    content.setAttribute('aria-label', '代码正文')
}

export class AccessibleCodeBlockLanguageSelector extends CodeBlockLanguageSelector {
  constructor(muya: Muya) {
    super(muya)
    muya.on('json-change', () => queueMicrotask(() => labelCodeBlocks(muya)))
    muya.on('selection-change', () => labelCodeBlocks(muya))
    muya.domNode.addEventListener(
      'click',
      (event: MouseEvent) => {
        if (
          muya.isReadOnly ||
          event.button !== 0 ||
          event.shiftKey ||
          !(event.target instanceof Element)
        )
          return
        const element = event.target.closest(
          'pre.mu-code-block .mu-language-input, pre.mu-code-block .mu-codeblock-content'
        )
        const block = getBlock(element)
        if (!block?.isContent()) return
        const selection = muya.editor.selection
        const live = selection.getSelection()
        if (live?.anchor.block === block && live.focus.block === block)
          selection.setSelection(live.anchor, live.focus)
        // acdert can focus a code field while keeping the previous field's DOM range.
        else if (!live || live.isCollapsed)
          block.setCursor(block.text.length, block.text.length, true)
      },
      true
    )
  }
  protected override activeEleScrollIntoView(element: HTMLElement) {
    element.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }
  override render() {
    super.render()
    this.container?.setAttribute('role', 'menu')
    this.container?.setAttribute('aria-label', '代码语言建议')
    this.container?.querySelectorAll<HTMLElement>('.item').forEach((item) => {
      item.setAttribute('role', 'menuitem')
      item.setAttribute('aria-label', item.dataset.label ?? '')
    })
  }
  override selectItem(item: Parameters<CodeBlockLanguageSelector['selectItem']>[0]) {
    if (!this.muya.canMutate || !this.renderArray.includes(item)) return
    this.muya.flush()
    const history = this.muya.editor.history
    history.cutoff(this.muya.editor.selection.getSelection() ?? undefined)
    super.selectItem(item)
    const content = this.muya.editor.activeContentBlock
    if (content) {
      ;(content.domNode as HTMLElement).focus({ preventScroll: true })
      content.setCursor(0, 0, true)
    }
    this.muya.flush()
    history.cutoff()
    labelCodeBlocks(this.muya)
  }
}
