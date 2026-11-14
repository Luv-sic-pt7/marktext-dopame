import { InlineFormatToolbar, type Muya } from '@muyajs/core'
import type { Token } from '@muyajs/core/inlineRenderer/types.ts'
import type { FormatToolIcon } from '@muyajs/core/ui/inlineFormatToolbar/config.ts'
import type { VNode } from 'snabbdom'
import { h } from '@muyajs/core/utils/snabbdom.ts'
import './inline-toolbar-ui.css'

const labels = {
  strong: '选区加粗',
  em: '选区斜体',
  u: '选区下划线',
  del: '选区删除线',
  mark: '选区高亮',
  color: '选区颜色',
  inline_code: '选区行内代码',
  inline_math: '选区行内公式',
  link: '选区链接',
  image: '选区图片',
  clear: '选区清除格式'
} as const

function activate(event: Event) {
  if (!(event instanceof KeyboardEvent) || !['Enter', ' '].includes(event.key)) return
  event.preventDefault()
  event.stopPropagation()
  ;(event.currentTarget as HTMLElement).click()
}

function svg(paths: VNode[]) {
  return h(
    'svg.dopame-inline-glyph',
    {
      attrs: {
        viewBox: '0 0 20 20',
        'aria-hidden': 'true',
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': 1.6,
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round'
      }
    },
    paths
  )
}

function glyph(type: keyof typeof labels): VNode {
  const attrs = { 'aria-hidden': 'true' }
  switch (type) {
    case 'strong':
      return h('strong.dopame-inline-glyph', { attrs }, 'B')
    case 'em':
      return h('em.dopame-inline-glyph', { attrs }, 'I')
    case 'u':
      return h('span.dopame-inline-glyph.dopame-underline', { attrs }, 'U')
    case 'del':
      return h('s.dopame-inline-glyph', { attrs }, 'S')
    case 'color':
      return h('span.dopame-inline-glyph', { attrs }, 'A')
    case 'mark':
      return svg([h('path', { attrs: { d: 'm5 12 7-8 4 4-8 7H5v-3ZM4 17h12' } })])
    case 'inline_code':
      return svg([h('path', { attrs: { d: 'm7 5-5 5 5 5m6-10 5 5-5 5M11 3 9 17' } })])
    case 'inline_math':
      return h('span.dopame-inline-glyph', { attrs }, '∑')
    case 'link':
      return svg([
        h('path', {
          attrs: { d: 'm8 12 4-4M7 7l2-2a4 4 0 0 1 6 6l-2 2M7 7l-2 2a4 4 0 0 0 6 6l2-2' }
        })
      ])
    case 'image':
      return svg([
        h('rect', { attrs: { x: 2, y: 3, width: 16, height: 14, rx: 1 } }),
        h('circle', { attrs: { cx: 6, cy: 7, r: 1 } }),
        h('path', { attrs: { d: 'm3 15 5-5 3 3 2-2 4 4' } })
      ])
    case 'clear':
      return svg([h('path', { attrs: { d: 'm4 12 8-8 5 5-8 8H7l-3-3v-2Zm4-4 5 5M4 17h13' } })])
  }
}

function enhanceColorControls(node: VNode) {
  if (node.sel?.startsWith('div.mu-color-swatch')) {
    const data = (node.data ??= {})
    const attrs = (data.attrs ??= {})
    attrs.role = 'button'
    attrs.tabindex = 0
    attrs['aria-label'] = `选区${node.sel.includes('.text') ? '文字' : '背景'}颜色 ${attrs.title}`
    attrs['aria-pressed'] = String(node.sel.includes('.active'))
    data.on = { ...data.on, keydown: activate }
  }
  if (node.sel === 'button.mu-color-reset') {
    const data = (node.data ??= {})
    data.attrs = { ...data.attrs, 'aria-label': '选区清除颜色' }
  }
  for (const child of node.children ?? [])
    if (child && typeof child === 'object') enhanceColorControls(child)
}

export class AccessibleInlineFormatToolbar extends InlineFormatToolbar {
  private beforeFormat = (event: MouseEvent) => {
    if (!(event.target instanceof Element)) return
    const item = event.target.closest('li.item')
    if (!item) return
    if (
      item.classList.contains('color') &&
      !event.target.closest('.mu-color-swatch,.mu-color-reset,li.item.color i.icon')
    )
      return
    if (!this.muya.canMutate) {
      event.preventDefault()
      event.stopImmediatePropagation()
      return
    }
    this.muya.flush()
    const history = this.muya.editor.history
    history.cutoff(this.muya.editor.selection.getSelection() ?? undefined)
    queueMicrotask(() => {
      this.muya.flush()
      history.cutoff()
    })
  }
  private keepSelection = (event: MouseEvent) => {
    if (event.button === 0) event.preventDefault()
  }
  private escape = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    this.hide()
    this.muya.focus()
  }
  constructor(muya: Muya, options = {}) {
    super(muya, options)
    this.container!.classList.add('dopame-inline-format-toolbar')
    this.container!.setAttribute('role', 'toolbar')
    this.container!.setAttribute('aria-label', '选区格式')
    this.floatBox!.setAttribute('aria-hidden', 'true')
    this.container!.addEventListener('mousedown', this.keepSelection, true)
    this.container!.addEventListener('click', this.beforeFormat, true)
    this.container!.addEventListener('keydown', this.escape)
  }
  protected override createIconItem(
    icon: FormatToolIcon,
    formats: Token[],
    i18n: typeof this.muya.i18n
  ) {
    const item = super.createIconItem(icon, formats, i18n)
    const type = icon.type as keyof typeof labels
    const active = formats.some(
      (format) =>
        format.type === icon.type || (format.type === 'html_tag' && format.tag === icon.type)
    )
    const data = (item.data ??= {})
    data.attrs = {
      ...data.attrs,
      role: 'button',
      tabindex: 0,
      'aria-label': labels[type],
      'aria-pressed': String(active)
    }
    data.on = { ...data.on, keydown: activate }
    // Keep Muya's formatting callback; only replace the filter-dependent icon subtree.
    item.children = [glyph(type)]
    return item
  }
  protected override createColorItem(icon: FormatToolIcon, i18n: typeof this.muya.i18n) {
    const item = super.createColorItem(icon, i18n)
    const data = (item.data ??= {})
    data.attrs = { ...data.attrs, role: 'group', 'aria-label': labels.color }
    const wrapper = item.children![0] as VNode
    const color = wrapper.children![0] as VNode
    const caret = wrapper.children![1] as VNode
    color.children = [glyph('color')]
    const colorData = (color.data ??= {})
    colorData.attrs = {
      ...colorData.attrs,
      role: 'button',
      tabindex: 0,
      'aria-label': '选区重置颜色'
    }
    colorData.on = { ...colorData.on, keydown: activate }
    const caretData = (caret.data ??= {})
    caretData.attrs = {
      ...caretData.attrs,
      role: 'button',
      tabindex: 0,
      'aria-label': '选区文字和背景颜色',
      'aria-haspopup': 'dialog'
    }
    caretData.on = {
      ...caretData.on,
      keydown: activate,
      click: (event: Event) => {
        event.preventDefault()
        event.stopPropagation()
        ;(event.currentTarget as HTMLElement).dispatchEvent(new MouseEvent('mouseenter'))
      }
    }
    const panel = item.children![1] as VNode
    const panelData = (panel.data ??= {})
    panelData.attrs = { ...panelData.attrs, role: 'dialog', 'aria-label': '选区颜色设置' }
    enhanceColorControls(panel)
    return item
  }
  override show(
    reference: Parameters<InlineFormatToolbar['show']>[0],
    cb?: Parameters<InlineFormatToolbar['show']>[1]
  ) {
    super.show(reference, cb)
    this.floatBox!.setAttribute('aria-hidden', String(!this.status))
  }
  override hide() {
    super.hide()
    this.floatBox?.setAttribute('aria-hidden', 'true')
  }
  override destroy() {
    this.container?.removeEventListener('mousedown', this.keepSelection, true)
    this.container?.removeEventListener('click', this.beforeFormat, true)
    this.container?.removeEventListener('keydown', this.escape)
    super.destroy()
  }
}
