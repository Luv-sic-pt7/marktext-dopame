import { test, expect, type AppWindow } from 'acde/test'
import { mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { clickCommand } from './command-helpers'

const evidence =
  process.env.MARKTEXT_EVIDENCE ??
  resolve(import.meta.dir, '../../../../../work/marktext-mvp-evidence')
mkdirSync(evidence, { recursive: true })

const sourceText = (app: AppWindow) =>
  app.evaluate<string>('document.querySelector(".CodeMirror").CodeMirror.getValue()')

async function selectSourceText(app: AppWindow, from: number, length: number) {
  await app.getByRole('button', { name: '源码', exact: true }).click()
  const source = app.getByRole('textbox', { name: 'Markdown 源码', exact: true })
  await source.press('ctrl+home')
  for (let offset = 0; offset < from; offset++) await source.press('right')
  for (let offset = 0; offset < length; offset++) await source.press('shift+right')
  await app.getByRole('button', { name: '富文本', exact: true }).click()
}

async function expectHiddenMarkers(app: AppWindow, count: number) {
  const markers = await app.evaluate<{ text: string; width: number; fontSize: string }[]>(
    'Array.from(document.querySelectorAll(".rich-host .mu-del-marker")).map(marker=>({text:marker.textContent,width:marker.getBoundingClientRect().width,fontSize:getComputedStyle(marker).fontSize}))'
  )
  expect(markers).toHaveLength(count)
  for (const marker of markers) {
    expect(marker.text).toBe('~~')
    expect(marker.width).toBeLessThanOrEqual(0.1)
    expect(marker.fontSize).toBe('0px')
  }
}

async function cleanRuntime(app: AppWindow) {
  expect((await app.console({ level: 'errors' })).entries).toEqual([])
  expect((await app.network({ failed: true })).entries).toEqual([])
}

test('strikethrough stays rendered when selected while source, copy, undo and saved Markdown keep their text', async ({
  acde,
  home
}) => {
  const original = '前缀 ~~中文删除~~ 后缀\n'
  const path = join(home, '删除线显示.md')
  await Bun.write(path, original)
  await acde.open('marktext-dopame')
  const app = acde.window('marktext-dopame')
  await acde.chooseFiles(path)
  await app.getByRole('button', { name: '原位打开文件', exact: true }).click()
  await expectHiddenMarkers(app, 2)
  await selectSourceText(app, original.indexOf('中文删除'), '中文删除'.length)
  await expect(app.locator('.mu-editor del.mu-inline-rule')).toHaveText('中文删除')
  expect(await app.evaluate<string>('getSelection()?.toString() ?? ""')).toBe('中文删除')
  await expectHiddenMarkers(app, 2)
  const strike = () => clickCommand(app, '格式', '删除线')
  await strike()
  await expect(app.locator('.mu-editor del.mu-inline-rule')).toHaveCount(0)
  await strike()
  await expectHiddenMarkers(app, 2)
  await acde.setClipboard('旧的剪贴板内容')
  await app.keyboard.press('ctrl+c')
  expect(await acde.clipboard()).toBe('中文删除')
  await app.locator('.format-toolbar').getByRole('button', { name: '撤销', exact: true }).click()
  await expect(app.locator('.mu-editor del.mu-inline-rule')).toHaveCount(0)
  await app.locator('.format-toolbar').getByRole('button', { name: '重做', exact: true }).click()
  await expectHiddenMarkers(app, 2)
  await app.screenshot({ path: join(evidence, 'native-rich-del-selected.png') })
  await app.getByRole('button', { name: '源码', exact: true }).click()
  expect(await sourceText(app)).toBe(original)
  await app.getByRole('button', { name: '保存', exact: true }).click()
  await expect(app.locator('.statusbar')).toContainText('已保存')
  expect(readFileSync(path, 'utf8')).toBe(original)
  await app.getByRole('button', { name: '预览', exact: true }).click()
  await expectHiddenMarkers(app, 2)
  await app.getByRole('button', { name: '源码', exact: true }).click()
  expect(await sourceText(app)).toBe(original)
  await cleanRuntime(app)
})

test('hidden delimiters preserve formatted typing and deletion without hiding literal tildes, code or headings', async ({
  acde,
  home
}) => {
  const original = '# 标题\n\n字面 \\~\\~ 与 `~~代码~~`，**~~嵌套~~**，尾部。\n'
  const path = join(home, '嵌套删除线.md')
  await Bun.write(path, original)
  await acde.open('marktext-dopame')
  const app = acde.window('marktext-dopame')
  await acde.chooseFiles(path)
  await app.getByRole('button', { name: '原位打开文件', exact: true }).click()
  await selectSourceText(app, original.indexOf('尾部'), 2)
  await clickCommand(app, '格式', '删除线')
  await expectHiddenMarkers(app, 4)
  await app.keyboard.insertText('替换😀')
  await expect(app.locator('.mu-editor del.mu-inline-rule').last()).toHaveText('替换😀')
  await app.keyboard.press('left')
  await app.keyboard.press('backspace')
  await expect(app.locator('.mu-editor del.mu-inline-rule').last()).toHaveText('替😀')
  await expectHiddenMarkers(app, 4)
  await expect(app.locator('.mu-editor code.mu-inline-rule')).toHaveText('~~代码~~')
  expect(
    await app
      .locator('.mu-editor code.mu-inline-rule')
      .evaluate((element) => element.getBoundingClientRect().width)
  ).toBeGreaterThan(0)
  await expect(app.locator('.mu-editor h1')).toContainText('标题')
  expect(
    await app.locator('.mu-editor h1').evaluate((element) => element.getBoundingClientRect().height)
  ).toBeGreaterThan(0)
  await app.screenshot({ path: join(evidence, 'native-rich-del-nested.png') })
  await app.getByRole('button', { name: '源码', exact: true }).click()
  const expected = original.replace('尾部', '~~替😀~~')
  expect(await sourceText(app)).toBe(expected)
  await app.getByRole('button', { name: '保存', exact: true }).click()
  await expect(app.locator('.statusbar')).toContainText('已保存')
  expect(readFileSync(path, 'utf8')).toBe(expected)
  await cleanRuntime(app)
})

test('caret navigation does not enter the zero-size strikethrough delimiters', async ({
  acde,
  home
}) => {
  const original = '左 ~~中文~~ 右\n'
  const path = join(home, '删除线边界光标.md')
  await Bun.write(path, original)
  await acde.open('marktext-dopame')
  const app = acde.window('marktext-dopame')
  await acde.chooseFiles(path)
  await app.getByRole('button', { name: '原位打开文件', exact: true }).click()
  await selectSourceText(app, original.indexOf('中文'), 2)
  const strike = () => clickCommand(app, '格式', '删除线')
  await strike()
  await strike()
  await expectHiddenMarkers(app, 2)
  await app.keyboard.press('right')
  const caretIsInsideMarker = () =>
    app.evaluate<boolean>(
      '(()=>{const selection=getSelection();const node=selection?.anchorNode;const element=node?.nodeType===1?node:node?.parentElement;return !!element?.closest(".mu-del-marker")})()'
    )
  expect(await caretIsInsideMarker()).toBe(false)
  for (let step = 0; step < 3; step++) {
    await app.keyboard.press('right')
    expect(await caretIsInsideMarker()).toBe(false)
  }
  for (let step = 0; step < 6; step++) {
    await app.keyboard.press('left')
    expect(await caretIsInsideMarker()).toBe(false)
  }
  await app.getByRole('button', { name: '源码', exact: true }).click()
  expect(await sourceText(app)).toBe(original)
  await cleanRuntime(app)
})
