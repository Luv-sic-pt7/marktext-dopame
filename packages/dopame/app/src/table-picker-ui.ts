import { TableChessboard } from '@muyajs/core'
import { getBlock } from '@muyajs/core/utils/dom.ts'

export class AccessibleTablePicker extends TableChessboard {
  override listen() {
    super.listen()
    this.muya.eventCenter.attachDOMEvent(this.floatBox!, 'input', (event: Event) => {
      if (
        event.target instanceof HTMLInputElement &&
        event.target.matches('.row-input,.column-input')
      )
        this.syncSelection()
    })
    this.muya.domNode.addEventListener(
      'click',
      (event: MouseEvent) => {
        if (
          this.muya.isReadOnly ||
          event.button !== 0 ||
          event.shiftKey ||
          !(event.target instanceof Element)
        )
          return
        const block = getBlock(event.target.closest('.mu-table-cell-content'))
        if (!block?.isContent() || block.blockName !== 'table.cell.content') return
        const selection = this.muya.editor.selection
        const live = selection.getSelection()
        if (live?.anchor.block === block && live.focus.block === block)
          selection.setSelection(live.anchor, live.focus)
        // acdert can focus a new cell while retaining the previous cell's DOM range.
        else if (!live || live.isCollapsed)
          block.setCursor(block.text.length, block.text.length, true)
      },
      true
    )
    this.muya.eventCenter.attachDOMEvent(this.floatBox!, 'keydown', (event: Event) => {
      if (!(event instanceof KeyboardEvent) || event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      this.hide()
      this.muya.focus()
    })
    this.floatBox!.addEventListener(
      'click',
      (event: MouseEvent) => {
        const cell =
          event.target instanceof Element
            ? event.target.closest<HTMLElement>('.mu-table-picker-cell')
            : null
        if (!cell) return
        event.preventDefault()
        event.stopImmediatePropagation()
        this.accept(Math.max(2, Number(cell.dataset.row) + 1), Number(cell.dataset.column) + 1)
      },
      true
    )
  }
  override render() {
    super.render()
    this.container?.setAttribute('role', 'dialog')
    this.container?.setAttribute('aria-label', '插入表格')
    const row = this.container?.querySelector<HTMLInputElement>('.row-input')
    const column = this.container?.querySelector<HTMLInputElement>('.column-input')
    if (row) {
      row.setAttribute('aria-label', '表格行数')
      row.setAttribute('inputmode', 'numeric')
      row.value = String(Math.max(2, Number(row.value)))
    }
    if (column) {
      column.setAttribute('aria-label', '表格列数')
      column.setAttribute('inputmode', 'numeric')
      column.value = String(Math.max(1, Number(column.value)))
    }
    this.container?.querySelector('button')?.setAttribute('aria-label', '确认插入表格')
    this.container?.querySelectorAll<HTMLElement>('.mu-table-picker-cell').forEach((cell) => {
      cell.setAttribute('role', 'button')
      const row = Number(cell.dataset.row)
      const label = `${Math.max(2, row + 1)} 行 ${Number(cell.dataset.column) + 1} 列`
      cell.setAttribute('aria-label', row === 0 ? '表头，' + label : label)
    })
    this.syncSelection()
  }
  private syncSelection() {
    const rows = Number(this.container?.querySelector<HTMLInputElement>('.row-input')?.value)
    const columns = Number(this.container?.querySelector<HTMLInputElement>('.column-input')?.value)
    this.container?.querySelectorAll<HTMLElement>('.mu-table-picker-cell').forEach((cell) => {
      cell.classList.toggle(
        'selected',
        Number(cell.dataset.row) < rows && Number(cell.dataset.column) < columns
      )
    })
  }
  override selectItem() {
    const rows = Number(this.container?.querySelector<HTMLInputElement>('.row-input')?.value)
    const columns = Number(this.container?.querySelector<HTMLInputElement>('.column-input')?.value)
    this.accept(rows, columns)
  }
  private accept(rows: number, columns: number) {
    if (!this.muya.canMutate) return this.hide()
    const valid =
      Number.isSafeInteger(rows) && rows >= 2 && Number.isSafeInteger(columns) && columns >= 1
    if (!valid) {
      let error = this.container!.querySelector<HTMLElement>('[role="alert"]')
      if (!error) {
        error = document.createElement('p')
        error.setAttribute('role', 'alert')
        this.container!.append(error)
      }
      error.textContent = '请输入至少 2 行、1 列的整数尺寸'
      return
    }
    this.container?.querySelector('[role="alert"]')?.remove()
    this.muya.flush()
    const history = this.muya.editor.history
    history.cutoff(this.muya.editor.selection.getSelection() ?? undefined)
    this.cb(rows - 1, columns - 1)
    const selection = this.muya.editor.selection.getSelection()
    if (selection) {
      ;(selection.focus.block.domNode as HTMLElement).focus({ preventScroll: true })
      this.muya.editor.selection.setSelection(selection.anchor, selection.focus)
    }
    this.muya.flush()
    history.cutoff()
    this.hide()
  }
}
