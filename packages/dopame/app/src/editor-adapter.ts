import CodeMirror from 'codemirror'
import 'codemirror/lib/codemirror.css'
import 'codemirror/mode/gfm/gfm'
import { matchString } from '@muyajs/core/utils/search.ts'
import {
  Muya,
  zhCN,
  InlineFormatToolbar,
  TableChessboard,
  TableColumnToolbar,
  TableRowColumMenu,
  ParagraphFrontButton,
  ParagraphFrontMenu,
  ParagraphQuickInsertMenu,
  type ISearchOption
} from '@muyajs/core'
import {
  DocumentController,
  type Session,
  type EngineState,
  type EditorBridge,
  type Mode
} from './document-controller'
import { setImageContext, clearImageContext } from './image-platform'

class AccessibleQuickInsertMenu extends ParagraphQuickInsertMenu {
  protected override activeEleScrollIntoView(element: HTMLElement) {
    // A smooth scroll to the old rows can outlive the filter render in acdert.
    element.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }
  override render() {
    super.render()
    this.container?.setAttribute('role', 'menu')
    this.container?.setAttribute('aria-label', '插入段落')
    this.scrollElement?.querySelectorAll<HTMLElement>('.item').forEach((item) => {
      item.setAttribute('role', 'menuitem')
      item.setAttribute('aria-label', item.querySelector('.big-title')?.textContent ?? '')
    })
    if (this.container) this.container.scrollTop = 0
  }
  override step(direction: 'previous' | 'next') {
    if (this.renderArray.length) super.step(direction)
  }
  override selectItem(item: Parameters<ParagraphQuickInsertMenu['selectItem']>[0]) {
    if (!this.renderArray.includes(item)) return
    super.selectItem(item)
    const selection = this.muya.editor.selection.getSelection()
    if (selection) {
      ;(selection.focus.block.domNode as HTMLElement).focus({ preventScroll: true })
      this.muya.editor.selection.setSelection(selection.anchor, selection.focus)
    }
  }
}

let pluginsRegistered = false
export interface SearchResult {
  index: number
  count: number
  error: string
}

function searchPattern(query: string, options: ISearchOption) {
  if (!options.isWholeWord) return { query, options }
  const pattern = options.isRegexp ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const word = '[\\p{L}\\p{N}\\p{M}_]'
  return {
    query: `(?<!${word})(?:${pattern})(?!${word})`,
    options: { ...options, isWholeWord: false, isRegexp: true }
  }
}

export class EditorAdapter implements EditorBridge {
  readonly muya: Muya
  readonly source: CodeMirror.Editor
  private sourceDocs = new Map<string, CodeMirror.Doc>()
  private currentId = ''
  private currentMode: Mode = 'rich'
  private loading = false
  private richBaseline = ''
  private imageScope = ''
  private searchKey = ''
  private searchIndex = -1
  private searchMarks: CodeMirror.TextMarker[] = []
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
        ParagraphFrontMenu,
        AccessibleQuickInsertMenu
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
    this.clearSearch(false)
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
    if (
      !this.controller.active ||
      this.controller.active.readOnly ||
      this.currentMode === 'preview'
    )
      return
    if (this.currentMode === 'source') this.source.undo()
    else this.muya.undo()
    this.flush()
  }
  redo() {
    if (
      !this.controller.active ||
      this.controller.active.readOnly ||
      this.currentMode === 'preview'
    )
      return
    if (this.currentMode === 'source') this.source.redo()
    else this.muya.redo()
    this.flush()
  }
  format(type: 'strong' | 'em' | 'inline_code' | 'del') {
    if (this.currentMode === 'preview' || this.controller.active?.readOnly) return
    if (this.currentMode === 'source') {
      if (type === 'del') this.toggleSourceStrikethrough()
      else {
        const marker = type === 'strong' ? '**' : type === 'em' ? '*' : '`'
        const selection = this.source.getSelection()
        this.source.replaceSelection(marker + selection + marker, 'around', '+format')
      }
    } else {
      this.muya.flush()
      const history = this.muya.editor.history
      history.cutoff(this.muya.editor.selection.getSelection() ?? undefined)
      this.muya.format(type)
      this.muya.flush()
      history.cutoff()
    }
    this.flush()
    this.focus()
  }
  private toggleSourceStrikethrough() {
    const text = this.source.getValue()
    const from = this.source.indexFromPos(this.source.getCursor('from'))
    const to = this.source.indexFromPos(this.source.getCursor('to'))
    const selected = text.slice(from, to)
    let start = from,
      end = to,
      replacement = '~~' + selected + '~~',
      selectionStart = from + 2,
      selectionLength = selected.length
    if (selected.startsWith('~~') && selected.endsWith('~~') && selected.length >= 4) {
      replacement = selected.slice(2, -2)
      selectionStart = from
      selectionLength = replacement.length
    } else if (text.slice(from - 2, from) === '~~' && text.slice(to, to + 2) === '~~') {
      start -= 2
      end += 2
      replacement = selected
      selectionStart = start
    }
    const doc = this.source.getDoc()
    doc.changeGeneration(true)
    this.source.operation(() => {
      this.source.replaceRange(
        replacement,
        this.source.posFromIndex(start),
        this.source.posFromIndex(end),
        '+format'
      )
      this.source.setSelection(
        this.source.posFromIndex(selectionStart),
        this.source.posFromIndex(selectionStart + selectionLength)
      )
    })
    doc.changeGeneration(true)
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
  private clearSearchMarks() {
    for (const mark of this.searchMarks) mark.clear()
    this.searchMarks = []
  }
  clearSearch(restoreSelection = true) {
    this.clearSearchMarks()
    this.muya.search('', { selectHighlight: restoreSelection })
    this.searchKey = ''
    this.searchIndex = -1
  }
  search(
    query: string,
    options: ISearchOption = {},
    direction?: 'previous' | 'next',
    reveal = true
  ): SearchResult {
    this.flush()
    const d = this.controller.active
    if (!query || !d) {
      this.clearSearch(false)
      return { index: 0, count: 0, error: '' }
    }
    if (options.isRegexp) {
      try {
        new RegExp(query)
      } catch {
        this.clearSearch(false)
        return { index: 0, count: 0, error: '正则表达式无效' }
      }
    }
    const key = JSON.stringify([d.id, d.mode, query, options])
    const changed = key !== this.searchKey
    this.searchKey = key
    if (changed) this.searchIndex = 0
    const pattern = searchPattern(query, options)
    if (this.currentMode === 'source') {
      const matches = matchString(this.source.getValue(), pattern.query, pattern.options)
      const count = matches.length
      if (this.searchIndex < 0) this.searchIndex = 0
      if (count && direction && !changed) this.searchIndex += direction === 'next' ? 1 : -1
      this.searchIndex = count ? (this.searchIndex + count) % count : -1
      this.clearSearchMarks()
      this.source.operation(() => {
        matches.forEach((match, index) => {
          this.searchMarks.push(
            this.source.markText(
              this.source.posFromIndex(match.index),
              this.source.posFromIndex(match.index + match.match.length),
              { className: index === this.searchIndex ? 'search-current' : 'search-match' }
            )
          )
        })
      })
      const current = matches[this.searchIndex]
      if (current && reveal) {
        const from = this.source.posFromIndex(current.index)
        const to = this.source.posFromIndex(current.index + current.match.length)
        this.source.setSelection(from, to)
        this.source.scrollIntoView({ from, to }, 60)
      }
      return { index: this.searchIndex + 1, count, error: '' }
    }
    const selection = reveal ? null : this.muya.editor.selection.getSelection()
    const result = this.muya.search(pattern.query, {
      ...pattern.options,
      highlightIndex: this.searchIndex
    })
    if (direction && !changed) result.find(direction)
    this.searchIndex = result.index
    if (selection) this.muya.editor.selection.setSelection(selection.anchor, selection.focus)
    const current = result.matches[result.index]
    if (current && reveal)
      (current.block.domNode as HTMLElement)?.scrollIntoView({ block: 'nearest' })
    return { index: result.index + 1, count: result.matches.length, error: '' }
  }
  replace(query: string, replacement: string, options: ISearchOption = {}, single = true) {
    const d = this.controller.active
    if (!d || d.readOnly || d.mode === 'preview' || this.controller.composing) return
    const result = this.search(query, options)
    if (!result.count || result.error) return result
    const index = this.searchIndex
    if (this.currentMode === 'source') {
      const pattern = searchPattern(query, options)
      const matches = matchString(this.source.getValue(), pattern.query, pattern.options)
      const selected = single ? [matches[index]] : matches
      this.source.getDoc().changeGeneration(true)
      this.source.operation(() => {
        for (const match of [...selected].reverse()) {
          let value = replacement
          if (options.isRegexp) {
            const groups = [match.match, ...match.subMatches]
            value = replacement.replace(/(?<!\\)\$(0|[1-9]\d?)/g, (reference, digits: string) => {
              const group = Number(digits)
              if (group < groups.length) return groups[group] ?? ''
              const leading = Number(digits[0])
              return leading < groups.length ? (groups[leading] ?? '') + digits.slice(1) : reference
            })
          }
          this.source.replaceRange(
            value,
            this.source.posFromIndex(match.index),
            this.source.posFromIndex(match.index + match.match.length),
            '+replace'
          )
        }
      })
      this.source.getDoc().changeGeneration(true)
    } else {
      // Separate replacement from typing, and keep a multi-block replacement in one undo step.
      this.muya.flush()
      this.muya.editor.history.cutoff()
      this.muya.replace(replacement, { ...options, isWholeWord: false, isSingle: single })
      this.muya.flush()
      this.muya.editor.history.cutoff()
    }
    this.commit()
    this.searchIndex = index
    return this.search(query, options)
  }
  replaceAll(query: string, replacement: string, options: ISearchOption = {}) {
    return this.replace(query, replacement, options, false)
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
    this.clearSearch(false)
    this.richHost.removeEventListener('keydown', this.nativeKey, true)
    clearImageContext()
    if (this.imageRefresh) clearTimeout(this.imageRefresh)
    this.muya.destroy()
    this.source.getWrapperElement().remove()
    this.controller.bridge = null
  }
}
