import CodeMirror from 'codemirror'
import 'codemirror/lib/codemirror.css'
import 'codemirror/mode/gfm/gfm'
import 'codemirror/addon/search/searchcursor'
import {
  Muya,
  zhCN,
  InlineFormatToolbar,
  TableChessboard,
  TableColumnToolbar,
  TableRowColumMenu,
  ParagraphFrontButton,
  ParagraphFrontMenu
} from '@muyajs/core'
import {
  DocumentController,
  type Session,
  type EngineState,
  type EditorBridge,
  type Mode
} from './document-controller'
import { setImageContext, clearImageContext } from './image-platform'

let pluginsRegistered = false
export class EditorAdapter implements EditorBridge {
  readonly muya: Muya
  readonly source: CodeMirror.Editor
  private sourceDocs = new Map<string, CodeMirror.Doc>()
  private currentId = ''
  private currentMode: Mode = 'rich'
  private loading = false
  private richBaseline = ''
  private imageScope = ''
  private imageRefresh: ReturnType<typeof setTimeout> | null = null
  private nativeKey = (event: KeyboardEvent) => {
    if (
      this.currentMode !== 'rich' ||
      this.controller.composing ||
      event.ctrlKey ||
      event.altKey ||
      event.metaKey ||
      !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)
    )
      return
    const selection = this.muya.editor.selection.getSelection()
    if (!selection) return
    let block = selection.focus.block
    const text = block.text
    let position = selection.focus.offset
    if (
      !event.shiftKey &&
      !selection.isCollapsed &&
      selection.isSelectionInSameBlock &&
      ['ArrowLeft', 'ArrowRight'].includes(event.key)
    ) {
      position = (event.key === 'ArrowLeft' ? Math.min : Math.max)(
        selection.anchor.offset,
        selection.focus.offset
      )
    } else if (event.key === 'Home')
      position = text.lastIndexOf('\n', Math.max(0, position - 1)) + 1
    else if (event.key === 'End') {
      const end = text.indexOf('\n', position)
      position = end < 0 ? text.length : end
    } else if (event.key === 'ArrowLeft' && position > 0)
      position -=
        /[\uDC00-\uDFFF]/.test(text[position - 1]) &&
        /[\uD800-\uDBFF]/.test(text[position - 2] ?? '')
          ? 2
          : 1
    else if (event.key === 'ArrowRight' && position < text.length)
      position +=
        /[\uD800-\uDBFF]/.test(text[position]) && /[\uDC00-\uDFFF]/.test(text[position + 1] ?? '')
          ? 2
          : 1
    else if (event.key === 'ArrowLeft') {
      const previous = block.previousContentInContext(true)
      if (previous) {
        block = previous
        position = block.text.length
      }
    } else if (event.key === 'ArrowRight') {
      const next = block.nextContentInContext(true)
      if (next) {
        block = next
        position = 0
      }
    }
    const focus = { block, path: [...block.path], offset: position }
    event.preventDefault()
    event.stopImmediatePropagation()
    ;(block.domNode as HTMLElement | null)?.focus({ preventScroll: true })
    this.muya.editor.selection.setSelection(event.shiftKey ? selection.anchor : focus, focus)
  }
  constructor(
    readonly controller: DocumentController,
    readonly richHost: HTMLElement,
    readonly sourceHost: HTMLElement,
    nativeSelection = false
  ) {
    if (!pluginsRegistered) {
      for (const p of [
        InlineFormatToolbar,
        TableChessboard,
        TableColumnToolbar,
        TableRowColumMenu,
        ParagraphFrontButton,
        ParagraphFrontMenu
      ])
        Muya.use(p)
      pluginsRegistered = true
    }
    const target = document.createElement('div')
    richHost.append(target)
    this.muya = new Muya(target, {
      markdown: '',
      locale: zhCN,
      fontSize: 17,
      lineHeight: 1.8,
      editorFontFamily: 'Open Sans, PingFang SC, Microsoft YaHei, sans-serif',
      disableHtml: true,
      trimUnnecessaryCodeBlockEmptyLines: false
    })
    this.muya.init({ focus: false })
    this.muya.domNode.setAttribute('aria-label', '富文本正文')
    this.source = CodeMirror(sourceHost, {
      value: '',
      mode: 'gfm',
      lineNumbers: true,
      lineWrapping: true,
      tabSize: 2,
      indentUnit: 2,
      inputStyle: 'textarea',
      extraKeys: {
        'Ctrl-S': () => void controller.save().catch((e: unknown) => controller.error(e))
      }
    })
    this.source.getInputField().setAttribute('aria-label', 'Markdown 源码')
    this.muya.on('json-change', () => {
      if (!this.loading && this.currentMode === 'rich' && !controller.composing) this.commit()
    })
    this.source.on('change', () => {
      if (!this.loading && this.currentMode === 'source' && !controller.composing) this.commit()
    })
    const compositionStart = () => {
      controller.composing = true
    }
    const compositionEnd = () => {
      controller.composing = false
      queueMicrotask(() => {
        if (!this.loading) this.commit()
      })
    }
    for (const host of [richHost, sourceHost]) {
      host.addEventListener('compositionstart', compositionStart)
      host.addEventListener('compositionend', compositionEnd)
    }
    controller.bridge = this
    // acdert 0.0.9 does not perform the browser's horizontal contenteditable selection default.
    if (nativeSelection) richHost.addEventListener('keydown', this.nativeKey, true)
  }
  private canonical(text: string) {
    return text
  }
  private commit() {
    const d = this.controller.docs.get(this.currentId)
    if (!d || d.mode === 'preview' || d.readOnly) return
    const text =
      this.currentMode === 'source'
        ? this.source.getValue()
        : this.canonical(this.muya.getMarkdown())
    this.controller.edit(this.currentId, text, this.capture())
  }
  capture(): EngineState {
    return {
      muya: this.muya.getHistory(),
      source: this.source.getHistory(),
      muyaText: this.canonical(this.muya.getMarkdown()),
      sourceText: this.source.getValue(),
      cursor:
        this.currentMode === 'source'
          ? { anchor: this.source.getCursor('anchor'), focus: this.source.getCursor('head') }
          : this.muya.getCursorOffset(),
      scroll: { rich: this.richHost.scrollTop, source: this.source.getScrollInfo().top }
    }
  }
  flush() {
    if (!this.currentId || this.controller.composing) return
    if (this.currentMode !== 'source') this.muya.flush()
    if (
      this.currentMode === 'source' ||
      this.canonical(this.muya.getMarkdown()) !== this.richBaseline
    )
      this.commit()
  }
  private setCursor(cursor: any) {
    if (!cursor?.anchor || !cursor?.focus) return
    const history = this.muya.getHistory()
    try {
      this.muya.setCursorByOffset(cursor)
    } finally {
      this.muya.setHistory(history)
    }
  }
  load(d: Session) {
    this.loading = true
    try {
      const same = this.currentId === d.id,
        oldMode = this.currentMode
      this.currentId = d.id
      this.currentMode = d.mode
      const imageScope =
        d.id + ':' + JSON.stringify(d.importSource?.resource ?? d.resource) + ':' + d.mode
      if (imageScope !== this.imageScope) {
        this.imageScope = imageScope
        const sourceResource = d.importSource?.resource ?? d.resource
        const resource = sourceResource ? JSON.parse(JSON.stringify(sourceResource)) : null
        setImageContext(
          (source) => this.controller.files.relativeImage(resource, source),
          () => this.refreshImages(),
          () =>
            this.controller.message(
              'info',
              '有图片尚未载入。相对图片需从已授权文件夹打开文档；首版支持 PNG、JPEG、GIF、WebP，单张最多 8MiB'
            ),
          d.mode !== 'source'
        )
        if (same) this.refreshImages()
      }
      if (!same) {
        if (d.externalSteps.length) {
          const first = d.externalSteps[0]
          this.muya.setContent(first.before)
          if (first.history.muya) this.muya.setHistory(first.history.muya)
          for (const step of d.externalSteps) this.muya.replaceContent(step.after)
        } else {
          this.muya.setContent(d.history.muyaText ?? d.text)
          if (d.history.muya) this.muya.setHistory(d.history.muya)
          if (d.history.muyaText && d.history.muyaText !== d.text) this.muya.replaceContent(d.text)
        }
        let cm = this.sourceDocs.get(d.id)
        if (!cm) {
          const first = d.externalSteps[0]
          cm = new CodeMirror.Doc(
            first?.history.sourceText ?? first?.before ?? d.history.sourceText ?? d.text,
            'gfm'
          )
          const history = first?.history.source ?? d.history.source
          if (history) cm.setHistory(history)
          this.sourceDocs.set(d.id, cm)
        }
        this.source.swapDoc(cm)
        if (d.externalSteps.length && this.source.getValue() !== d.text) {
          this.replaceSource(d.externalSteps[0].before)
          for (const step of d.externalSteps) this.replaceSource(step.after)
        } else this.replaceSource(d.text)
        this.setCursor(d.history.cursor)
      } else if (oldMode === 'source' && d.mode !== 'source') {
        if (this.canonical(this.muya.getMarkdown()) !== d.text) this.muya.replaceContent(d.text)
        this.setCursor({
          anchor: this.source.getCursor('anchor'),
          focus: this.source.getCursor('head')
        })
      } else if (oldMode !== 'source' && d.mode === 'source') {
        const cursor = this.muya.getCursorOffset()
        this.replaceSource(d.text)
        if (cursor?.anchor && cursor.focus) this.source.setSelection(cursor.anchor, cursor.focus)
      } else if (d.mode === 'source' && this.source.getValue() !== d.text) {
        this.replaceSource(d.text)
      } else if (
        d.mode !== 'source' &&
        this.canonical(this.muya.getMarkdown()) !== d.text &&
        d.text !== this.richBaseline
      ) {
        this.muya.setContent(d.text)
        if (d.history.muya) this.muya.setHistory(d.history.muya)
      }
      this.muya.setReadOnly(d.mode === 'preview' || d.readOnly)
      this.muya.domNode.setAttribute('aria-label', d.mode === 'preview' ? '阅读预览' : '富文本正文')
      this.source.setOption('readOnly', d.readOnly ? 'nocursor' : false)
      this.richHost.hidden = d.mode === 'source'
      this.sourceHost.hidden = d.mode !== 'source'
      this.richBaseline = this.canonical(this.muya.getMarkdown())
      requestAnimationFrame(() => {
        if (d.mode === 'source') this.source.refresh()
      })
    } finally {
      this.loading = false
    }
  }
  private refreshImages() {
    if (this.imageRefresh) return
    this.imageRefresh = setTimeout(() => {
      this.imageRefresh = null
      if (this.controller.composing) {
        this.refreshImages()
        return
      }
      const cursor = this.muya.hasFocus() ? this.muya.getCursorOffset() : null
      this.loading = true
      try {
        this.muya.invalidateImageCache()
        if (cursor) this.setCursor(cursor)
      } finally {
        this.loading = false
      }
    }, 50)
  }
  private replaceSource(text: string) {
    if (this.source.getValue() === text) return
    this.source.getDoc().changeGeneration(true)
    this.source.operation(() =>
      this.source.replaceRange(
        text,
        { line: 0, ch: 0 },
        this.source.posFromIndex(this.source.getValue().length),
        '+external'
      )
    )
    this.source.getDoc().changeGeneration(true)
  }
  replaceExternal(documentId: string, text: string): EngineState | null {
    if (documentId !== this.currentId) return null
    this.loading = true
    try {
      this.muya.replaceContent(text)
      this.replaceSource(text)
      this.richBaseline = this.canonical(this.muya.getMarkdown())
      return this.capture()
    } finally {
      this.loading = false
    }
  }
  focus() {
    if (this.currentMode === 'source') this.source.focus()
    else this.muya.focus()
  }
  undo() {
    if (this.currentMode === 'source') this.source.undo()
    else this.muya.undo()
    this.flush()
  }
  redo() {
    if (this.currentMode === 'source') this.source.redo()
    else this.muya.redo()
    this.flush()
  }
  format(type: 'strong' | 'em' | 'inline_code') {
    if (this.currentMode === 'preview') return
    if (this.currentMode === 'source') {
      const marker = type === 'strong' ? '**' : type === 'em' ? '*' : '`'
      const selection = this.source.getSelection()
      this.source.replaceSelection(marker + selection + marker, 'around', '+format')
    } else this.muya.format(type === 'inline_code' ? 'inline_code' : type)
    this.flush()
    this.focus()
  }
  insertTable() {
    if (this.currentMode === 'preview') return
    if (this.currentMode === 'source')
      this.source.replaceSelection(
        '| 项目 | 内容 |\n| --- | --- |\n| 示例 | 文本 |\n',
        'end',
        '+table'
      )
    else this.muya.updateParagraph('table')
    this.flush()
    this.focus()
  }
  heading(level: number) {
    if (this.currentMode === 'preview') return
    if (this.currentMode === 'source') {
      const p = this.source.getCursor()
      const line = this.source.getLine(p.line)
      this.source.replaceRange(
        '#'.repeat(level) + ' ' + line.replace(/^#{1,6}\s+/, ''),
        { line: p.line, ch: 0 },
        { line: p.line, ch: line.length },
        '+heading'
      )
    } else this.muya.updateParagraph('heading ' + level)
    this.flush()
    this.focus()
  }
  search(query: string) {
    if (!query) return 0
    const d = this.controller.active
    if (!d) return 0
    const count = d.text.split(query).length - 1
    if (this.currentMode === 'source') {
      let c = this.source.getSearchCursor(query, this.source.getCursor())
      if (!c.findNext()) {
        c = this.source.getSearchCursor(query, { line: 0, ch: 0 })
        if (!c.findNext()) return count
      }
      this.source.setSelection(c.from(), c.to())
      this.source.scrollIntoView({ from: c.from(), to: c.to() }, 60)
    } else this.muya.search(query)
    return count
  }
  replaceAll(query: string, replacement: string) {
    const d = this.controller.active
    if (!query || !d || d.readOnly || d.mode === 'preview') return
    const next = d.text.split(query).join(replacement)
    if (this.currentMode === 'source') this.replaceSource(next)
    else this.muya.replaceContent(next)
    this.commit()
    this.focus()
  }
  jumpTo(from: number) {
    const d = this.controller.active
    if (!d) return
    if (this.currentMode === 'source') {
      const p = this.source.posFromIndex(from)
      this.source.setCursor(p)
      this.source.scrollIntoView(p, 80)
      this.source.focus()
    } else {
      const prefix = d.text.slice(0, from).split('\n'),
        p = { line: prefix.length - 1, ch: prefix.at(-1)?.length ?? 0 }
      this.setCursor({ anchor: p, focus: p })
      this.muya.focus()
    }
  }
  destroy() {
    this.richHost.removeEventListener('keydown', this.nativeKey, true)
    clearImageContext()
    if (this.imageRefresh) clearTimeout(this.imageRefresh)
    this.muya.destroy()
    this.source.getWrapperElement().remove()
    this.controller.bridge = null
  }
}
