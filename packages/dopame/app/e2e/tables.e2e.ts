import { test, expect, type AppWindow } from 'acde/test'
import { resolve, join } from 'node:path'
import { mkdirSync } from 'node:fs'

const evidence =
  process.env.MARKTEXT_EVIDENCE ??
  resolve(import.meta.dir, '../../../../../work/marktext-mvp-evidence')
mkdirSync(evidence, { recursive: true })

const fixture = '| 项目 | 数值 |\n| :--- | ---: |\n| 甲 | 12 |\n| 乙😀 | 34 |\n'
const originalCells = [
  ['项目', '数值'],
  ['甲', '12'],
  ['乙😀', '34']
]
const sourceText = (app: AppWindow) =>
  app.evaluate<string>('document.querySelector(".CodeMirror").CodeMirror.getValue()')
const cells = (app: AppWindow) =>
  app.evaluate<string[][]>(
    'Array.from(document.querySelectorAll(".mu-editor table tr")).map(row=>Array.from(row.querySelectorAll("td")).map(cell=>cell.textContent))'
  )

async function createTable(app: AppWindow, text = fixture) {
  await app.getByRole('button', { name: '新建', exact: true }).click()
  await app.getByRole('button', { name: '源码', exact: true }).click()
  await app.getByRole('textbox', { name: 'Markdown 源码', exact: true }).type(text)
  await app.getByRole('button', { name: '富文本', exact: true }).click()
}

async function chooseCell(app: AppWindow, row: number, column: number) {
  await app
    .getByRole('table')
    .getByRole('row')
    .nth(row)
    .getByRole('cell')
    .nth(column)
    .getByRole('textbox')
    .click()
}

async function cleanRuntime(app: AppWindow) {
  expect((await app.console({ level: 'errors' })).entries).toEqual([])
  expect((await app.network({ failed: true })).entries).toEqual([])
}

test('toolbar inserts editable tables from a fresh document and from title-input focus', async ({
  acde
}) => {
  await acde.open('marktext-dopame')
  const app = acde.window('marktext-dopame')
  await app.getByRole('button', { name: '新建', exact: true }).click()
  await app.getByRole('button', { name: '插入表格', exact: true }).click()
  const picker = app.getByRole('dialog', { name: '插入表格', exact: true })
  await expect(picker).toBeVisible()
  await picker.getByRole('textbox', { name: '表格行数', exact: true }).fill('3')
  await picker.getByRole('textbox', { name: '表格列数', exact: true }).fill('2')
  await expect(picker.locator('.mu-table-picker-cell.selected')).toHaveCount(6)
  await app.screenshot({ path: join(evidence, 'native-batch2-table-picker.png') })
  await picker.getByRole('button', { name: '确认插入表格', exact: true }).click()
  await expect(picker).toHaveCount(0)
  await expect(app.getByRole('table').getByRole('row')).toHaveCount(3)
  await expect(app.getByRole('table').getByRole('cell')).toHaveCount(6)
  await expect(app.getByRole('table').getByRole('textbox').first()).toBeFocused()
  await app.keyboard.insertText('项目😀')
  await app.keyboard.press('Tab')
  await app.keyboard.insertText('数值')
  expect((await cells(app))[0]).toEqual(['项目😀', '数值'])
  await chooseCell(app, 1, 0)
  await app.keyboard.insertText('真实入口')
  await app.getByRole('button', { name: '保存', exact: true }).click()
  await expect(app.locator('.statusbar')).toContainText('已保存')
  await app.getByRole('button', { name: '源码', exact: true }).click()
  const firstMarkdown = await sourceText(app)
  expect(firstMarkdown).toContain('项目😀')
  expect(firstMarkdown).toContain('数值')
  expect(firstMarkdown).toContain('真实入口')
  expect(
    await app.evaluate<string>(
      '(async()=>{const {fs}=await import("acde:fs");const files=await fs.list("private","notes");return (await fs.readText("private","notes/"+files.entries[0].name)).text})()'
    )
  ).toBe(firstMarkdown)
  await app.getByRole('button', { name: '新建', exact: true }).click()
  await app.getByRole('textbox', { name: '笔记标题', exact: true }).fill('从标题插入表格')
  await app.getByRole('button', { name: '插入表格', exact: true }).click()
  await expect(picker).toBeVisible()
  await picker.getByRole('button', { name: '2 行 3 列', exact: true }).hover()
  await picker.getByRole('button', { name: '2 行 3 列', exact: true }).click()
  await expect(app.getByRole('table').getByRole('row')).toHaveCount(2)
  await expect(app.getByRole('table').getByRole('cell')).toHaveCount(6)
  await expect(app.getByRole('table').getByRole('textbox').first()).toBeFocused()
  await app.keyboard.insertText('标题切换后仍能输入')
  await expect(app.getByRole('table').getByRole('cell').first()).toContainText('标题切换后仍能输入')
  await app.getByRole('button', { name: '插入表格', exact: true }).click()
  await picker.getByRole('textbox', { name: '表格行数', exact: true }).click()
  await app.keyboard.press('Escape')
  await expect(picker).toHaveCount(0)
  await expect(app.getByRole('table')).toHaveCount(1)
  await app.screenshot({ path: join(evidence, 'native-batch2-table-insertion.png') })
  await cleanRuntime(app)
})

test('table row and column commands preserve surrounding cells and each undo as one change', async ({
  acde
}) => {
  await acde.open('marktext-dopame')
  const app = acde.window('marktext-dopame')
  await createTable(app)
  await chooseCell(app, 1, 0)
  await app.getByRole('button', { name: '表格下方插入行', exact: true }).click()
  await expect
    .poll(() => cells(app))
    .toEqual([originalCells[0], originalCells[1], ['', ''], originalCells[2]])
  await app.getByRole('button', { name: '撤销', exact: true }).click()
  await expect.poll(() => cells(app)).toEqual(originalCells)
  await app.getByRole('button', { name: '重做', exact: true }).click()
  await expect(app.getByRole('table').getByRole('row')).toHaveCount(4)
  await app.getByRole('button', { name: '撤销', exact: true }).click()
  await chooseCell(app, 1, 0)
  await app.getByRole('button', { name: '表格右侧插入列', exact: true }).click()
  await expect.poll(() => cells(app)).toEqual(originalCells.map(([a, b]) => [a, '', b]))
  await app.getByRole('button', { name: '撤销', exact: true }).click()
  await expect.poll(() => cells(app)).toEqual(originalCells)
  await chooseCell(app, 1, 1)
  await app.getByRole('button', { name: '删除表格行', exact: true }).click()
  await expect.poll(() => cells(app)).toEqual([originalCells[0], originalCells[2]])
  await app.getByRole('button', { name: '撤销', exact: true }).click()
  await expect.poll(() => cells(app)).toEqual(originalCells)
  await chooseCell(app, 1, 0)
  await app.getByRole('button', { name: '删除表格列', exact: true }).click()
  await expect.poll(() => cells(app)).toEqual(originalCells.map(([, b]) => [b]))
  await app.getByRole('button', { name: '撤销', exact: true }).click()
  await expect.poll(() => cells(app)).toEqual(originalCells)
  await app.screenshot({ path: join(evidence, 'native-batch2-table-commands.png') })
  await cleanRuntime(app)
})

test('table alignment, cell navigation and inserted-cell input survive source mode and save', async ({
  acde
}) => {
  await acde.open('marktext-dopame')
  const app = acde.window('marktext-dopame')
  await createTable(app)
  await chooseCell(app, 1, 1)
  const center = app.getByRole('button', { name: '表格居中对齐', exact: true })
  await center.click()
  const secondColumnAlignment = () =>
    app.evaluate<string[]>(
      'Array.from(document.querySelectorAll(".mu-editor table tr")).map(row=>row.children[1].getAttribute("data-align"))'
    )
  await expect.poll(secondColumnAlignment).toEqual(['center', 'center', 'center'])
  await center.click()
  await expect.poll(secondColumnAlignment).toEqual(['none', 'none', 'none'])
  await app.getByRole('button', { name: '撤销', exact: true }).click()
  await expect.poll(secondColumnAlignment).toEqual(['center', 'center', 'center'])
  await chooseCell(app, 1, 1)
  await app.getByRole('button', { name: '表格右对齐', exact: true }).click()
  await expect.poll(secondColumnAlignment).toEqual(['right', 'right', 'right'])
  await chooseCell(app, 1, 0)
  await app.keyboard.press('Tab')
  expect(
    await app.evaluate<number>(
      '(()=>{const node=getSelection()?.anchorNode;const cell=(node?.nodeType===1?node:node?.parentElement)?.closest("td");return cell?Array.from(cell.parentElement.children).indexOf(cell):-1})()'
    )
  ).toBe(1)
  await app.keyboard.press('Shift+Tab')
  expect(
    await app.evaluate<number>(
      '(()=>{const node=getSelection()?.anchorNode;const cell=(node?.nodeType===1?node:node?.parentElement)?.closest("td");return cell?Array.from(cell.parentElement.children).indexOf(cell):-1})()'
    )
  ).toBe(0)
  await app.getByRole('button', { name: '表格下方插入行', exact: true }).click()
  await app.keyboard.insertText('新增中文😀')
  await expect
    .poll(() => cells(app))
    .toEqual([originalCells[0], originalCells[1], ['新增中文😀', ''], originalCells[2]])
  await app.getByRole('button', { name: '源码', exact: true }).click()
  const markdown = await sourceText(app)
  expect(markdown).toContain('新增中文😀')
  expect(markdown).toContain('---:')
  await app.getByRole('button', { name: '保存', exact: true }).click()
  await expect(app.locator('.statusbar')).toContainText('已保存')
  expect(
    await app.evaluate<string>(
      '(async()=>{const {fs}=await import("acde:fs");const list=await fs.list("private","notes");return (await fs.readText("private","notes/"+list.entries[0].name)).text})()'
    )
  ).toBe(markdown)
  await app.getByRole('button', { name: '富文本', exact: true }).click()
  await expect
    .poll(() => cells(app))
    .toEqual([originalCells[0], originalCells[1], ['新增中文😀', ''], originalCells[2]])
  await cleanRuntime(app)
})

test('table controls keep one row and column, and preview does not expose editing commands', async ({
  acde
}) => {
  await acde.open('marktext-dopame')
  const app = acde.window('marktext-dopame')
  await createTable(app, '| A | B |\n| --- | --- |\n| 甲 \\| 乙 | `x_y` |\n')
  await chooseCell(app, 0, 0)
  await app.getByRole('button', { name: '删除表格行', exact: true }).click()
  await expect(app.getByRole('table').getByRole('row')).toHaveCount(1)
  await expect(app.getByRole('button', { name: '删除表格行', exact: true })).toBeDisabled()
  await app.getByRole('button', { name: '删除表格列', exact: true }).click()
  await expect(app.getByRole('table').getByRole('cell')).toHaveCount(1)
  await expect(app.getByRole('button', { name: '删除表格列', exact: true })).toBeDisabled()
  await app.getByRole('button', { name: '撤销', exact: true }).click()
  await app.getByRole('button', { name: '撤销', exact: true }).click()
  await app.getByRole('button', { name: '源码', exact: true }).click()
  const restored = await sourceText(app)
  expect(restored).toContain('甲 \\| 乙')
  expect(restored).toContain('`x_y`')
  await app.getByRole('button', { name: '预览', exact: true }).click()
  await expect(app.getByRole('button', { name: '表格下方插入行', exact: true })).toHaveCount(0)
  await expect(app.getByRole('button', { name: '表格右侧插入列', exact: true })).toHaveCount(0)
  await app.getByRole('button', { name: '源码', exact: true }).click()
  expect(await sourceText(app)).toBe(restored)
  await cleanRuntime(app)
})
