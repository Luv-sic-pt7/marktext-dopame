import CodeMirror from 'codemirror'
import { createSourceEditor } from './source-editor'
import { matchString } from '@muyajs/core/utils/search.ts'
import { getBlock } from '@muyajs/core/utils/dom.ts'
import {
  delVisibleBoundary,
  moveVisibleDelCaret,
  normalizeVisibleDelCaret,
  setVisibleDelSelection
} from './visible-del-caret'
import { NativeCaret } from './native-caret'
import {
  Muya,
  zhCN,
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
import { AccessibleTablePicker } from './table-picker-ui'
import { AccessibleInlineFormatToolbar } from './inline-toolbar-ui'
import {
  convertParagraphLines,
  indentListLines,
  type ParagraphType,
  type ParagraphLineChange
} from './paragraph-commands'
import { AccessibleCodeBlockLanguageSelector, labelCodeBlocks } from './code-block-ui'
import { AgentError, boundedText, LIMITS } from '../../protocol'

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
  private nativeCaret: NativeCaret | null = null
  private richBaseline = ''
  private richLoaded = false
  private imageScope = ''
  private searchKey = ''
  private searchIndex = -1
  private searchMarks: CodeMirror.TextMarker[] = []
  private nativePointerTarget: HTMLElement | null = null
  private nativePointer = (event: MouseEvent) => {
    this.nativePointerTarget =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>('.mu-content[contenteditable="true"]')
        : null
  }
  private taskCheckbox = (event: MouseEvent) => {
    if (
      this.currentMode !== 'rich' ||
      this.controller.active?.readOnly ||
      !(event.target instanceof HTMLInputElement) ||
      !event.target.matches('.mu-task-list-checkbox')
    )
      return
    this.muya.flush()
    this.muya.editor.history.cutoff(this.muya.editor.selection.getSelection() ?? undefined)
    queueMicrotask(() => {
      this.muya.flush()
      this.muya.editor.history.cutoff()
      this.flush()
    })
  }
  private imageRefresh: ReturnType<typeof setTimeout> | null = null
  private nativeKey = (event: KeyboardEvent) => {
    const pointerTarget = this.nativePointerTarget
    this.nativePointerTarget = null
    const documentBoundary =
      (event.ctrlKey || event.metaKey) && (event.key === 'Home' || event.key === 'End')
    if (
      this.currentMode !== 'rich' ||
      this.controller.composing ||
      event.isComposing ||
      event.altKey ||
      ((event.ctrlKey || event.metaKey) && !documentBoundary) ||
      (event.target instanceof Element && !!event.target.closest('input,textarea,select')) ||
      !['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Tab'].includes(event.key)
    )
      return
    const selection = this.muya.editor.selection.getSelection()
    if (documentBoundary) {
      const page = this.muya.editor.scrollPage
      let block =
        event.key === 'Home' ? page?.firstContentInDescendant() : page?.lastContentInDescendant()
      if (block?.blockName === 'language-input') block = block.parent?.lastContentInDescendant()
      if (!block) return
      const focus = delVisibleBoundary(
        { block, path: [...block.path], offset: event.key === 'Home' ? 0 : block.text.length },
        event.key === 'Home' ? 1 : -1
      )
      event.preventDefault()
      event.stopImmediatePropagation()
      ;(block.domNode as HTMLElement).focus({ preventScroll: true })
      setVisibleDelSelection(
        this.muya,
        event.shiftKey && selection ? selection.anchor : focus,
        focus
      )
      this.richHost.scrollTop = event.key === 'Home' ? 0 : this.richHost.scrollHeight
      return
    }
    if (!event.shiftKey && (event.key === 'Home' || event.key === 'End')) {
      const target =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>('.mu-content[contenteditable="true"]')
          : null
      const focused = getBlock(target)
      // Only a pointer click makes the editable target newer than acdert's retained DOM range.
      if (
        target === pointerTarget &&
        target !== null &&
        focused?.isContent() &&
        focused.muya === this.muya &&
        focused.outMostBlock &&
        (!selection || (selection.isCollapsed && selection.focus.block !== focused))
      ) {
        const point = {
          block: focused,
          path: [...focused.path],
          offset: event.key === 'Home' ? 0 : focused.text.length
        }
        event.preventDefault()
        event.stopImmediatePropagation()
        target!.focus({ preventScroll: true })
        const visible = delVisibleBoundary(point, event.key === 'Home' ? 1 : -1)
        setVisibleDelSelection(this.muya, visible, visible)
        return
      }
    }
    if (!selection) return
    if (event.key === 'Tab') {
      const block = selection.focus.block
      if (
        this.controller.active?.readOnly ||
        !selection.isSelectionInSameBlock ||
        block.blockName !== 'paragraph.content' ||
        !['bullet-list', 'order-list', 'task-list'].some((name) => block.closestBlock(name))
      )
        return
      event.preventDefault()
      event.stopImmediatePropagation()
      this.indentList(event.shiftKey)
      return
    }
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
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      const next = moveVisibleDelCaret(selection.focus, event.key === 'ArrowLeft' ? -1 : 1)
      block = next.block
      position = next.offset
    }
    const current = { block, path: [...block.path], offset: position }
    const focus =
      event.key === 'Home' || event.key === 'End'
        ? delVisibleBoundary(current, event.key === 'Home' ? 1 : -1)
        : current
    event.preventDefault()
    event.stopImmediatePropagation()
    ;(block.domNode as HTMLElement | null)?.focus({ preventScroll: true })
    setVisibleDelSelection(
      this.muya,
      event.shiftKey ? selection.anchor : focus,
      focus,
      event.key === 'ArrowLeft' || event.key === 'End' ? -1 : 1
    )
  }
  constructor(
    readonly controller: DocumentController,
    readonly richHost: HTMLElement,
    readonly sourceHost: HTMLElement,
    nativeSelection = false,
    private readonly onContextChange: () => void = () => {},
    sourceEditor?: CodeMirror.Editor
  ) {
    if (!pluginsRegistered) {
      for (const p of [
        AccessibleInlineFormatToolbar,
        AccessibleTablePicker,
        TableColumnToolbar,
        TableRowColumMenu,
        ParagraphFrontButton,
        ParagraphFrontMenu,
        AccessibleQuickInsertMenu,
        AccessibleCodeBlockLanguageSelector
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
    this.source =
      sourceEditor ??
      createSourceEditor(sourceHost, () => {
        void controller.save().catch((e: unknown) => controller.error(e))
      })
    if (nativeSelection)
      this.nativeCaret = new NativeCaret(
        richHost,
        this.muya.domNode,
        () => this.currentMode === 'rich' && !!controller.active && !controller.active.readOnly
      )
    this.muya.on('json-change', () => {
      if (!this.loading && this.currentMode === 'rich' && !controller.composing) this.commit()
      this.nativeCaret?.refresh()
    })
    this.source.on('change', () => {
      if (!this.loading && this.currentMode === 'source' && !controller.composing) this.commit()
    })
    this.source.on('beforeChange', (_editor, change) => {
      if (this.loading || this.currentMode !== 'source') return
      const previous = this.source.getValue()
      const from = this.source.indexFromPos(change.from)
      const to = this.source.indexFromPos(change.to)
      const inserted = change.text.join('\n')
      // Each UTF-16 unit occupies at most three UTF-8 bytes. Ordinary edits need no extra scan.
      if (3 * (previous.length - (to - from) + inserted.length) <= LIMITS.text) return
      try {
        boundedText(previous.slice(0, from) + inserted + previous.slice(to), '文档')
      } catch (error) {
        change.cancel()
        controller.error(error)
      }
    })
    this.muya.on('selection-change', () => {
      this.onContextChange()
      this.nativeCaret?.refresh()
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
    if (nativeSelection) {
      richHost.addEventListener('keydown', this.nativeKey, true)
      richHost.addEventListener('click', this.nativePointer, true)
    }
    richHost.addEventListener('click', this.taskCheckbox, true)
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
    try {
      this.controller.edit(this.currentId, text, this.capture())
    } catch (error) {
      if (!(error instanceof AgentError) || error.code !== 'INVALID_ARGUMENT') throw error
      // Rich input and composition commit after mutating the engine; restore its last valid state.
      this.loading = true
      try {
        if (this.currentMode === 'source') {
          this.source.setValue(d.text)
          if (d.history.source) this.source.setHistory(d.history.source)
          if (d.history.cursor?.anchor && d.history.cursor?.focus)
            this.source.setSelection(d.history.cursor.anchor, d.history.cursor.focus)
        } else {
          this.loadRich(d)
          this.setCursor(d.history.cursor)
        }
      } finally {
        this.loading = false
      }
      this.focus()
      this.controller.error(error)
    }
  }
  capture(): EngineState {
    const history = this.controller.docs.get(this.currentId)?.history ?? {}
    const readRich = this.currentMode !== 'source' && this.richLoaded
    return {
      muya: readRich ? this.muya.getHistory() : history.muya,
      source: this.source.getHistory(),
      muyaText: readRich ? this.canonical(this.muya.getMarkdown()) : history.muyaText,
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
  private loadRich(d: Session) {
    if (d.externalSteps.length) {
      const first = d.externalSteps[0]
      const baseline = first.history.muyaText ?? first.before
      this.muya.setContent(baseline)
      if (first.history.muya) this.muya.setHistory(first.history.muya)
      let content = baseline
      for (const step of d.externalSteps) {
        if (content !== step.before) this.muya.replaceContent(step.before)
        this.muya.replaceContent(step.after)
        content = step.after
      }
      if (content !== d.text) this.muya.replaceContent(d.text)
    } else {
      this.muya.setContent(d.history.muyaText ?? d.text)
      if (d.history.muya) this.muya.setHistory(d.history.muya)
      if (d.history.muyaText !== undefined && d.history.muyaText !== d.text)
        this.muya.replaceContent(d.text)
    }
    this.richLoaded = true
  }
  load(d: Session) {
    this.clearSearch(false)
    this.loading = true
    try {
      const same = this.currentId === d.id,
        oldMode = this.currentMode
      this.currentId = d.id
      this.currentMode = d.mode
      const reset = same && d.history.muyaText === undefined && !d.externalSteps.length
      if (reset) this.richLoaded = false
      if (d.mode === 'source' && d.history.muyaText === undefined && !d.externalSteps.length)
        d.history.muyaText = d.text
      this.muya.setReadOnly(d.mode !== 'rich' || d.readOnly)
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
        if (same && d.mode !== 'source' && this.richLoaded) this.refreshImages()
      }
      if (!same) {
        this.richLoaded = false
        if (d.mode !== 'source') this.loadRich(d)
        let cm = this.sourceDocs.get(d.id)
        if (!cm) {
          const first = d.externalSteps[0]
          const checkpoint =
            d.history.sourceText === d.text ? d.history : (first?.history ?? d.history)
          cm = new CodeMirror.Doc(checkpoint.sourceText ?? first?.before ?? d.text, 'gfm')
          const history = checkpoint.source
          if (history) cm.setHistory(history)
          this.sourceDocs.set(d.id, cm)
        }
        this.source.swapDoc(cm)
        if (d.externalSteps.length && this.source.getValue() !== d.text) {
          this.replaceSource(d.externalSteps[0].before)
          for (const step of d.externalSteps) {
            this.replaceSource(step.before)
            this.replaceSource(step.after)
          }
        }
        this.replaceSource(d.text)
        if (d.mode !== 'source') this.setCursor(d.history.cursor)
        if (d.history.cursor?.anchor && d.history.cursor?.focus)
          this.source.setSelection(d.history.cursor.anchor, d.history.cursor.focus)
      } else if (oldMode === 'source' && d.mode !== 'source') {
        if (!this.richLoaded || d.externalSteps.length) this.loadRich(d)
        else if (this.canonical(this.muya.getMarkdown()) !== d.text)
          this.muya.replaceContent(d.text)
        this.setCursor({
          anchor: this.source.getCursor('anchor'),
          focus: this.source.getCursor('head')
        })
      } else if (oldMode !== 'source' && d.mode === 'source') {
        const cursor = this.muya.getCursorOffset()
        this.replaceSource(d.text)
        if (cursor?.anchor && cursor.focus) this.source.setSelection(cursor.anchor, cursor.focus)
      } else if (d.mode === 'source') {
        this.replaceSource(d.text)
        if (reset) this.source.clearHistory()
      } else if (
        reset ||
        (this.canonical(this.muya.getMarkdown()) !== d.text && d.text !== this.richBaseline)
      ) {
        this.loadRich(d)
      }
      this.muya.domNode.setAttribute('aria-label', d.mode === 'preview' ? '阅读预览' : '富文本正文')
      this.source.setOption('readOnly', d.readOnly ? 'nocursor' : false)
      this.richHost.hidden = d.mode === 'source'
      this.sourceHost.hidden = d.mode !== 'source'
      if (d.mode !== 'source') {
        labelCodeBlocks(this.muya)
        this.richBaseline = this.canonical(this.muya.getMarkdown())
        d.externalSteps = []
      }
      d.history = this.capture()
      requestAnimationFrame(() => {
        if (d.mode === 'source') this.source.refresh()
        this.nativeCaret?.refresh()
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
      if (this.currentMode !== 'source') {
        this.muya.replaceContent(text)
        this.richBaseline = this.canonical(this.muya.getMarkdown())
      }
      this.replaceSource(text)
      return this.capture()
    } finally {
      this.loading = false
    }
  }
  focus() {
    if (!this.controller.active) return
    if (this.currentMode === 'source') {
      this.source.focus()
      return
    }
    if (this.muya.isReadOnly) {
      this.muya.domNode.focus({ preventScroll: true })
      return
    }
    const selection = this.muya.editor.selection.getSelection()
    const live =
      selection &&
      [selection.anchor, selection.focus].every(
        (point) => point.block.domNode && this.muya.domNode.contains(point.block.domNode)
      )
    if (live && document.activeElement === selection.focus.block.domNode) {
      normalizeVisibleDelCaret(this.muya)
      this.nativeCaret?.refresh()
      return
    }
    // Muya restores a Range; the native renderer also needs its editable DOM node focused.
    this.muya.domNode.focus({ preventScroll: true })
    this.muya.focus()
    const restored = live ? selection : this.muya.editor.selection.getSelection()
    if (restored) {
      this.muya.editor.selection.setSelection(restored.anchor, restored.focus)
    }
    normalizeVisibleDelCaret(this.muya)
    this.nativeCaret?.refresh()
  }
  setCaretActive(active: boolean) {
    this.nativeCaret?.setActive(active)
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
    this.focus()
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
    this.focus()
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
  private selectedTableCell() {
    const document = this.controller.active
    if (!document || document.readOnly || this.currentMode !== 'rich') return null
    const selection = this.muya.editor.selection.getSelection()
    if (
      !selection?.isSelectionInSameBlock ||
      selection.focus.block.blockName !== 'table.cell.content'
    )
      return null
    const cell = selection.focus.block
      .parent as import('@muyajs/core/block/gfm/table/cell.ts').default
    if (!cell.outMostBlock) return null
    return { cell, selection }
  }
  get tableContext() {
    const current = this.selectedTableCell()
    if (!current) return null
    const { cell } = current
    return {
      row: cell.rowOffset,
      column: cell.columnOffset,
      rows: cell.table.rowCount,
      columns: cell.table.columnCount,
      align: cell.align,
      canDeleteRow: cell.table.rowCount > 1,
      canDeleteColumn: cell.table.columnCount > 1
    }
  }
  tableCommand(
    action:
      | 'insert-row'
      | 'delete-row'
      | 'insert-column'
      | 'delete-column'
      | 'align-left'
      | 'align-center'
      | 'align-right'
  ) {
    const current = this.selectedTableCell()
    if (!current || this.controller.composing) return
    const { cell, selection } = current
    const { table, rowOffset: row, columnOffset: column } = cell
    if (action === 'delete-row' && table.rowCount <= 1) return
    if (action === 'delete-column' && table.columnCount <= 1) return
    this.muya.flush()
    const history = this.muya.editor.history
    history.cutoff(selection)
    let target = selection.focus.block
    switch (action) {
      case 'insert-row':
        target = table.insertRow(row + 1) ?? target
        break
      case 'delete-row':
        target = table.removeRow(row) ?? target
        break
      case 'insert-column':
        target = table.insertColumn(column + 1)
        break
      case 'delete-column':
        target = table.removeColumn(column) ?? target
        break
      default:
        table.alignColumn(column, action.slice('align-'.length))
    }
    ;(target.domNode as HTMLElement).focus({ preventScroll: true })
    if (action.startsWith('align-'))
      this.muya.editor.selection.setSelection(selection.anchor, selection.focus)
    else target.setCursor(0, 0, true)
    this.muya.flush()
    history.cutoff()
    this.flush()
    this.controller.emit()
  }
  insertCodeBlock() {
    if (
      !this.controller.active ||
      this.controller.active.readOnly ||
      this.currentMode === 'preview' ||
      this.controller.composing
    )
      return
    if (this.currentMode === 'source') {
      const from = this.source.getCursor('from')
      const to = this.source.getCursor('to')
      const selected = this.source.getSelection()
      const runs = selected.match(/`+/g) ?? []
      const fence = '`'.repeat(runs.reduce((length, run) => Math.max(length, run.length + 1), 3))
      const prefix = from.ch > 0 ? '\n' : ''
      const suffix = to.ch < this.source.getLine(to.line).length ? '\n' : ''
      const start = this.source.indexFromPos(from) + prefix.length + fence.length + 1
      const inserted =
        prefix + fence + '\n' + selected + (selected.endsWith('\n') ? '' : '\n') + fence + suffix
      const doc = this.source.getDoc()
      doc.changeGeneration(true)
      this.source.operation(() => {
        this.source.replaceRange(inserted, from, to, '+code-block')
        this.source.setSelection(
          this.source.posFromIndex(start),
          this.source.posFromIndex(start + selected.length)
        )
      })
      doc.changeGeneration(true)
    } else {
      this.muya.flush()
      const history = this.muya.editor.history
      history.cutoff(this.muya.editor.selection.getSelection() ?? undefined)
      const current = this.muya.editor.selection.getSelection()?.focus.block
      if (!current?.closestBlock('code-block')) this.muya.updateParagraph('pre')
      const code = this.muya.editor.activeContentBlock?.closestBlock('code-block')
      const content = code?.isParent() ? code.lastContentInDescendant() : null
      if (content) {
        ;(content.domNode as HTMLElement).focus({ preventScroll: true })
        content.setCursor(content.text.length, content.text.length, true)
      }
      this.muya.flush()
      history.cutoff()
      labelCodeBlocks(this.muya)
    }
    this.flush()
    this.focus()
  }
  insertTable() {
    if (
      !this.controller.active ||
      this.controller.active.readOnly ||
      this.currentMode === 'preview' ||
      this.controller.composing
    )
      return
    if (this.currentMode === 'source') {
      this.source.getDoc().changeGeneration(true)
      this.source.replaceSelection(
        '| 项目 | 内容 |\n| --- | --- |\n| 示例 | 文本 |\n',
        'end',
        '+table'
      )
      this.source.getDoc().changeGeneration(true)
    } else {
      this.muya.focus()
      const block = this.muya.editor.selection.getSelection()?.focus.block.getAnchor()
      if (!block?.outMostBlock || !block.domNode) return
      this.muya.eventCenter.emit(
        'muya-table-picker',
        { row: 1, column: 1 },
        block.domNode,
        (row: number, column: number) => {
          if (block.outMostBlock)
            this.muya.createTable({ rows: row + 1, columns: column + 1 }, { block })
        }
      )
    }
    this.flush()
    this.focus()
  }
  heading(level: number) {
    if (
      !this.controller.active ||
      this.controller.active.readOnly ||
      this.currentMode === 'preview' ||
      this.controller.composing
    )
      return
    if (this.currentMode === 'source') {
      const p = this.source.getCursor()
      const line = this.source.getLine(p.line)
      this.source.getDoc().changeGeneration(true)
      this.source.replaceRange(
        '#'.repeat(level) + ' ' + line.replace(/^#{1,6}\s+/, ''),
        { line: p.line, ch: 0 },
        { line: p.line, ch: line.length },
        '+heading'
      )
      this.source.getDoc().changeGeneration(true)
    } else {
      this.muya.flush()
      const history = this.muya.editor.history
      history.cutoff(this.muya.editor.selection.getSelection() ?? undefined)
      this.muya.updateParagraph('heading ' + level)
      this.muya.flush()
      history.cutoff()
    }
    this.flush()
    this.focus()
  }
  insertHorizontalRule() {
    if (
      !this.controller.active ||
      this.controller.active.readOnly ||
      this.currentMode === 'preview' ||
      this.controller.composing
    )
      return
    if (this.currentMode === 'source') {
      const current = this.source.getCursor('to')
      const line = this.source.getLine(current.line)
      const from = { line: current.line, ch: line.length }
      const text = (line.length ? '\n\n' : '') + '---\n\n'
      const cursor = this.source.indexFromPos(from) + text.length
      this.source.getDoc().changeGeneration(true)
      this.source.operation(() => {
        this.source.replaceRange(text, from, from, '+horizontal-rule')
        this.source.setCursor(this.source.posFromIndex(cursor))
      })
      this.source.getDoc().changeGeneration(true)
    } else {
      this.muya.flush()
      const history = this.muya.editor.history
      history.cutoff(this.muya.editor.selection.getSelection() ?? undefined)
      this.muya.updateParagraph('hr')
      this.muya.flush()
      history.cutoff()
    }
    this.flush()
    this.focus()
  }
  convertParagraph(type: ParagraphType) {
    if (
      !this.controller.active ||
      this.currentMode === 'preview' ||
      this.controller.active.readOnly ||
      this.controller.composing
    )
      return
    if (this.currentMode === 'source') {
      const { from, to } = this.selectedParagraphRange()
      const lines = Array.from({ length: to - from + 1 }, (_, index) =>
        this.source.getLine(from + index)
      )
      this.changeParagraphLines(from, to, convertParagraphLines(lines, type))
    } else {
      this.muya.flush()
      const history = this.muya.editor.history
      history.cutoff(this.muya.editor.selection.getSelection() ?? undefined)
      this.muya.updateParagraph(type === 'paragraph' ? 'reset-to-paragraph' : type)
      this.muya.flush()
      history.cutoff()
      const selection = this.muya.editor.selection.getSelection()
      if (selection) {
        ;(selection.focus.block.domNode as HTMLElement).focus({ preventScroll: true })
        this.muya.editor.selection.setSelection(selection.anchor, selection.focus)
      }
    }
    this.flush()
    this.focus()
  }
  indentList(outdent = false) {
    if (
      !this.controller.active ||
      this.currentMode === 'preview' ||
      this.controller.active.readOnly ||
      this.controller.composing
    )
      return
    if (this.currentMode === 'source') {
      const { from, to } = this.selectedParagraphRange()
      const changes = indentListLines(this.source.getValue().split('\n'), from, to, outdent)
      if (!changes) return
      this.changeParagraphLines(from, to, changes)
    } else {
      this.muya.flush()
      const selection = this.muya.editor.selection.getSelection()
      const block = selection?.focus.block
      if (
        !selection?.isSelectionInSameBlock ||
        !block ||
        block.blockName !== 'paragraph.content' ||
        !['bullet-list', 'order-list', 'task-list'].some((name) => block.closestBlock(name))
      )
        return
      const history = this.muya.editor.history
      history.cutoff(selection)
      ;(block.domNode as HTMLElement).focus({ preventScroll: true })
      this.muya.editor.selection.setSelection(selection.anchor, selection.focus)
      block.tabHandler(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: outdent }))
      this.muya.flush()
      history.cutoff()
      const current = this.muya.editor.selection.getSelection()
      if (current) {
        ;(current.focus.block.domNode as HTMLElement).focus({ preventScroll: true })
        this.muya.editor.selection.setSelection(current.anchor, current.focus)
      }
    }
    this.flush()
    this.focus()
  }
  private selectedParagraphRange() {
    const start = this.source.getCursor('from')
    const end = this.source.getCursor('to')
    return { from: start.line, to: end.line > start.line && end.ch === 0 ? end.line - 1 : end.line }
  }
  private changeParagraphLines(from: number, to: number, changes: ParagraphLineChange[]) {
    const anchor = this.source.getCursor('anchor')
    const head = this.source.getCursor('head')
    const mapped = (position: CodeMirror.Position) => {
      const change = changes[position.line - from]
      return change
        ? {
            line: position.line,
            ch: Math.min(
              change.text.length,
              Math.max(0, position.ch - change.removed) + change.added
            )
          }
        : position
    }
    const document = this.source.getDoc()
    document.changeGeneration(true)
    this.source.operation(() => {
      this.source.replaceRange(
        changes.map((line) => line.text).join('\n'),
        { line: from, ch: 0 },
        { line: to, ch: this.source.getLine(to).length },
        '+paragraph'
      )
      this.source.setSelection(mapped(anchor), mapped(head))
    })
    document.changeGeneration(true)
  }
  private clearSearchMarks() {
    for (const mark of this.searchMarks) mark.clear()
    this.searchMarks = []
  }
  clearSearch(restoreSelection = true) {
    this.nativePointerTarget = null
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
    if (current && reveal) {
      current.block.setCursor(current.start, current.end)
      const block = current.block.domNode as HTMLElement | null
      ;(block?.querySelector<HTMLElement>('.mu-highlight') ?? block)?.scrollIntoView({
        block: 'center',
        inline: 'nearest'
      })
    }
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
    this.nativeCaret?.destroy()
    this.clearSearch(false)
    this.richHost.removeEventListener('keydown', this.nativeKey, true)
    this.richHost.removeEventListener('click', this.nativePointer, true)
    this.richHost.removeEventListener('click', this.taskCheckbox, true)
    clearImageContext()
    if (this.imageRefresh) clearTimeout(this.imageRefresh)
    this.muya.destroy()
    this.source.getWrapperElement().remove()
    this.controller.bridge = null
  }
}
