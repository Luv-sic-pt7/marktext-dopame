import { test, expect, type AppWindow } from 'acde/test'
import { resolve, join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { clickCommand } from './command-helpers'

const evidence =
  process.env.MARKTEXT_EVIDENCE ??
  resolve(import.meta.dir, '../../../../../work/marktext-mvp-evidence')
mkdirSync(evidence, { recursive: true })

const sourceText = (app: AppWindow) =>
  app.evaluate<string>('document.querySelector(".CodeMirror").CodeMirror.getValue()')
const sourceSelection = (app: AppWindow) =>
  app.evaluate<{ text: string; line: number; from: number }>(
    '(()=>{const cm=document.querySelector(".CodeMirror").CodeMirror;return {text:cm.getSelection(),line:cm.getCursor("from").line,from:cm.indexFromPos(cm.getCursor("from"))}})()'
  )
const richSelection = (app: AppWindow) =>
  app.evaluate<{ text: string; paragraph: number; from: number }>(
    '(()=>{const selection=getSelection();const node=selection?.anchorNode;const block=(node?.nodeType===1?node:node?.parentElement)?.closest("p.mu-paragraph");if(!selection||!node||!block)return {text:selection?.toString()??"",paragraph:-1,from:-1};const before=document.createRange();before.selectNodeContents(block);before.setEnd(node,selection.anchorOffset);return {text:selection.toString(),paragraph:Array.from(document.querySelectorAll(".mu-editor p.mu-paragraph")).indexOf(block),from:before.toString().length}})()'
  )

async function createSource(app: AppWindow, text: string) {
  await app.getByRole('button', { name: '新建', exact: true }).click()
  await app.getByRole('button', { name: '源码', exact: true }).click()
  await app.getByRole('textbox', { name: 'Markdown 源码', exact: true }).type(text)
}

test('outline includes Setext and duplicate headings and navigates in both editing modes', async ({
  acde,
  home
}) => {
  const markdown =
    '# 一级标题\n\nSetext 中文\n-----------\n\n## 重复标题\n\n第一节。\n\n## 重复标题\n\n第二节。\n\n###### 六级标题\n\n~~~md\n# 围栏伪标题\n伪 Setext\n---\n~~~\n\n    # 缩进伪标题\n'
  const path = join(home, '完整大纲.md')
  await Bun.write(path, markdown)
  await acde.open('marktext-dopame')
  const app = acde.window('marktext-dopame')
  await acde.chooseFiles(path)
  await app.getByRole('button', { name: '导入文件', exact: true }).first().click()
  const outline = app.getByRole('complementary', { name: '文档大纲', exact: true })
  await expect(outline.getByRole('button')).toHaveCount(5)
  await expect(outline.getByRole('button', { name: '围栏伪标题', exact: true })).toHaveCount(0)
  await expect(outline.getByRole('button', { name: '缩进伪标题', exact: true })).toHaveCount(0)
  await app.getByRole('button', { name: '源码', exact: true }).click()
  for (const [index, line] of [0, 2, 5, 9, 13].entries()) {
    await outline.getByRole('button').nth(index).click()
    expect((await sourceSelection(app)).line).toBe(line)
  }
  await app.getByRole('button', { name: '富文本', exact: true }).click()
  await outline.getByRole('button', { name: 'Setext 中文', exact: true }).click()
  expect(
    await app.evaluate<string>(
      '(()=>{const n=getSelection()?.anchorNode;return (n?.nodeType===1?n:n?.parentElement)?.closest("h2")?.textContent??""})()'
    )
  ).toContain('Setext 中文')
  await outline.getByRole('button', { name: '重复标题', exact: true }).nth(1).click()
  expect(
    await app.evaluate<number>(
      '(()=>{const n=getSelection()?.anchorNode;const h=(n?.nodeType===1?n:n?.parentElement)?.closest("h2");return Array.from(document.querySelectorAll(".mu-editor h2")).indexOf(h)})()'
    )
  ).toBe(2)
  await app.getByRole('button', { name: '保存', exact: true }).click()
  await expect(app.locator('.statusbar')).toContainText('已保存')
  expect(
    await app.evaluate<string>(
      '(async()=>{const {fs}=await import("acde:fs");const files=await fs.list("private","notes");return (await fs.readText("private","notes/"+files.entries[0].name)).text})()'
    )
  ).toBe(markdown)
  await app.screenshot({ path: join(evidence, 'native-batch-outline.png') })
})

test('find navigates both ways and single and all replacements each undo as one edit', async ({
  acde
}) => {
  await acde.open('marktext-dopame')
  const app = acde.window('marktext-dopame')
  const original = '中文 alpha 中文 alpha 中文'
  await createSource(app, original)
  await app.getByRole('button', { name: '查找', exact: true }).click()
  await app.getByRole('textbox', { name: '查找文本', exact: true }).fill('中文')
  const result = app.getByRole('status', { name: '查找结果', exact: true })
  await expect(result).toHaveText('1 / 3')
  await app.getByRole('button', { name: '下一处', exact: true }).click()
  await expect(result).toHaveText('2 / 3')
  expect((await sourceSelection(app)).text).toBe('中文')
  expect((await sourceSelection(app)).from).toBe(original.indexOf('中文', 2))
  await app.getByRole('button', { name: '上一处', exact: true }).click()
  await expect(result).toHaveText('1 / 3')
  await app.getByRole('button', { name: '上一处', exact: true }).click()
  await expect(result).toHaveText('3 / 3')
  await app.getByRole('button', { name: '下一处', exact: true }).click()
  await app.getByRole('textbox', { name: '替换为', exact: true }).fill('替换')
  await app.getByRole('button', { name: '替换当前', exact: true }).click()
  await expect.poll(() => sourceText(app)).toBe('替换 alpha 中文 alpha 中文')
  await expect(result).toHaveText('1 / 2')
  await app.getByRole('button', { name: '撤销', exact: true }).click()
  await expect.poll(() => sourceText(app)).toBe(original)
  await app.getByRole('button', { name: '全部替换', exact: true }).click()
  await expect.poll(() => sourceText(app)).toBe('替换 alpha 替换 alpha 替换')
  await expect(result).toHaveText('0 / 0')
  await app.getByRole('button', { name: '撤销', exact: true }).click()
  await expect.poll(() => sourceText(app)).toBe(original)
  await app.getByRole('textbox', { name: '查找文本', exact: true }).fill('')
  await expect(result).toHaveText('0 / 0')
  await expect(app.getByRole('button', { name: '替换当前', exact: true })).toBeDisabled()
})

test('rich search replaces the selected match and multi-paragraph replacement undoes in one step', async ({
  acde
}) => {
  await acde.open('marktext-dopame')
  const app = acde.window('marktext-dopame')
  const original = '第一段：中文 与 中文。\n\n第二段：中文 与 尾声。'
  await createSource(app, original)
  await app.getByRole('button', { name: '富文本', exact: true }).click()
  await app.getByRole('button', { name: '查找', exact: true }).click()
  await app.getByRole('textbox', { name: '查找文本', exact: true }).fill('中文')
  await expect(app.getByRole('textbox', { name: '查找文本', exact: true })).toBeFocused()
  const result = app.getByRole('status', { name: '查找结果', exact: true })
  const richText = () =>
    app.evaluate<string>(
      'Array.from(document.querySelectorAll(".mu-editor p.mu-paragraph")).map(p=>p.textContent).join("\\n\\n")'
    )
  await expect(result).toHaveText('1 / 3')
  expect(await richSelection(app)).toEqual({ text: '中文', paragraph: 0, from: 4 })
  await app.getByRole('button', { name: '下一处', exact: true }).click()
  await expect(result).toHaveText('2 / 3')
  expect(await richSelection(app)).toEqual({ text: '中文', paragraph: 0, from: 9 })
  await app.getByRole('button', { name: '下一处', exact: true }).click()
  await expect(result).toHaveText('3 / 3')
  expect(await richSelection(app)).toEqual({ text: '中文', paragraph: 1, from: 4 })
  await app.getByRole('button', { name: '上一处', exact: true }).click()
  await expect(result).toHaveText('2 / 3')
  await app.getByRole('button', { name: '上一处', exact: true }).click()
  await expect(result).toHaveText('1 / 3')
  await app.getByRole('button', { name: '下一处', exact: true }).click()
  await expect(result).toHaveText('2 / 3')
  await app.getByRole('textbox', { name: '替换为', exact: true }).fill('单处替换')
  await app.getByRole('button', { name: '替换当前', exact: true }).click()
  await expect.poll(richText).toBe('第一段：中文 与 单处替换。\n\n第二段：中文 与 尾声。')
  await expect(result).toHaveText('2 / 2')
  expect(await richSelection(app)).toEqual({ text: '中文', paragraph: 1, from: 4 })
  await app.getByRole('button', { name: '撤销', exact: true }).click()
  await expect.poll(richText).toBe(original)
  await app.getByRole('button', { name: '全部替换', exact: true }).click()
  await expect.poll(richText).toBe('第一段：单处替换 与 单处替换。\n\n第二段：单处替换 与 尾声。')
  await expect(result).toHaveText('0 / 0')
  await app.getByRole('button', { name: '撤销', exact: true }).click()
  await expect.poll(richText).toBe(original)
  await app.getByRole('button', { name: '源码', exact: true }).click()
  expect((await sourceText(app)).trimEnd()).toBe(original)
  expect((await app.console({ level: 'errors' })).entries).toEqual([])
  expect((await app.network({ failed: true })).entries).toEqual([])
})

test('live search refresh leaves continued typing at the source and rich editor caret', async ({
  acde
}) => {
  await acde.open('marktext-dopame')
  const app = acde.window('marktext-dopame')
  const original = '匹配目标 末尾'
  await createSource(app, original)
  await app.getByRole('button', { name: '查找', exact: true }).click()
  await app.getByRole('textbox', { name: '查找文本', exact: true }).fill('匹配')
  const result = app.getByRole('status', { name: '查找结果', exact: true })
  await expect(result).toHaveText('1 / 1')
  const source = app.getByRole('textbox', { name: 'Markdown 源码', exact: true })
  await source.press('ctrl+end')
  await source.type(' 匹配首轮')
  await expect(result).toHaveText('1 / 2')
  expect((await sourceSelection(app)).text).toBe('')
  await source.type(' 后续输入😀')
  const sourceExpected = original + ' 匹配首轮 后续输入😀'
  await expect.poll(() => sourceText(app)).toBe(sourceExpected)
  await app.getByRole('button', { name: '富文本', exact: true }).click()
  await app.locator('.mu-editor [contenteditable="true"]').last().click()
  await app.keyboard.press('end')
  await app.keyboard.insertText(' 匹配富文首轮')
  await expect(result).toHaveText('1 / 3')
  expect(await app.evaluate<string>('getSelection()?.toString() ?? ""')).toBe('')
  await app.keyboard.insertText(' 连续写入')
  await app.getByRole('button', { name: '源码', exact: true }).click()
  expect((await sourceText(app)).trimEnd()).toBe(sourceExpected + ' 匹配富文首轮 连续写入')
})

test('long rich search reveals each matching word inside the same paragraph', async ({ acde }) => {
  await acde.open('marktext-dopame')
  const app = acde.window('marktext-dopame')
  const original = '中文 ' + '用于跨屏定位的长段落文本。'.repeat(120) + ' 中文'
  await createSource(app, original)
  await app.getByRole('button', { name: '富文本', exact: true }).click()
  await app.getByRole('button', { name: '查找', exact: true }).click()
  await app.getByRole('textbox', { name: '查找文本', exact: true }).fill('中文')
  const result = app.getByRole('status', { name: '查找结果', exact: true })
  await expect(result).toHaveText('1 / 2')
  expect(await richSelection(app)).toEqual({ text: '中文', paragraph: 0, from: 0 })
  await app.getByRole('button', { name: '下一处', exact: true }).click()
  await expect(result).toHaveText('2 / 2')
  expect(await richSelection(app)).toEqual({
    text: '中文',
    paragraph: 0,
    from: original.lastIndexOf('中文')
  })
  const currentMatchVisible = () =>
    app.evaluate<boolean>(
      '(()=>{const host=document.querySelector(".rich-host").getBoundingClientRect();const match=document.querySelector(".mu-editor .mu-highlight").getBoundingClientRect();return match.top>=host.top&&match.bottom<=host.bottom})()'
    )
  await expect.poll(currentMatchVisible).toBe(true)
  expect(
    await app.evaluate<number>('document.querySelector(".rich-host").scrollTop')
  ).toBeGreaterThan(0)
  await app.getByRole('button', { name: '上一处', exact: true }).click()
  await expect(result).toHaveText('1 / 2')
  expect(await richSelection(app)).toEqual({ text: '中文', paragraph: 0, from: 0 })
  await expect.poll(currentMatchVisible).toBe(true)
  expect((await app.console({ level: 'errors' })).entries).toEqual([])
  expect((await app.network({ failed: true })).entries).toEqual([])
  await app.screenshot({ path: join(evidence, 'native-batch2-rich-search-position.png') })
})

test('search options, regular expression captures and invalid patterns preserve editable content', async ({
  acde
}) => {
  await acde.open('marktext-dopame')
  const app = acde.window('marktext-dopame')
  const original = 'Cat cat scatter cat_1\n中文 中文词 中文\ncode12 code34'
  await createSource(app, original)
  await app.getByRole('button', { name: '查找', exact: true }).click()
  const find = app.getByRole('textbox', { name: '查找文本', exact: true })
  const result = app.getByRole('status', { name: '查找结果', exact: true })
  await find.fill('cat')
  await expect(result).toHaveText('1 / 4')
  await app.getByRole('checkbox', { name: '区分大小写', exact: true }).check()
  await expect(result).toHaveText('1 / 3')
  await app.getByRole('checkbox', { name: '全词匹配', exact: true }).check()
  await expect(result).toHaveText('1 / 1')
  await app.getByRole('checkbox', { name: '区分大小写', exact: true }).uncheck()
  await expect(result).toHaveText('1 / 2')
  await find.fill('中文')
  await expect(result).toHaveText('1 / 2')
  await app.getByRole('checkbox', { name: '全词匹配', exact: true }).uncheck()
  await app.getByRole('checkbox', { name: '正则表达式', exact: true }).check()
  await find.fill('code(\\d+)')
  await expect(result).toHaveText('1 / 2')
  await app.getByRole('textbox', { name: '替换为', exact: true }).fill('item$1')
  await app.getByRole('button', { name: '全部替换', exact: true }).click()
  await expect.poll(() => sourceText(app)).toBe(original.replace('code12 code34', 'item12 item34'))
  await app.getByRole('button', { name: '撤销', exact: true }).click()
  await expect.poll(() => sourceText(app)).toBe(original)
  await find.fill('[')
  await expect(app.getByRole('alert')).toContainText('正则表达式无效')
  await expect(app.getByRole('button', { name: '替换当前', exact: true })).toBeDisabled()
  await expect(app.getByRole('button', { name: '全部替换', exact: true })).toBeDisabled()
  expect(await sourceText(app)).toBe(original)
  await find.fill('中文')
  await expect(app.getByRole('alert')).toHaveCount(0)
  await app.getByRole('button', { name: '预览', exact: true }).click()
  await expect(app.getByRole('button', { name: '替换当前', exact: true })).toBeDisabled()
  await expect(app.getByRole('button', { name: '全部替换', exact: true })).toBeDisabled()
  await app.getByRole('button', { name: '下一处', exact: true }).click()
  await expect(result).toHaveText('2 / 3')
  await app.getByRole('button', { name: '源码', exact: true }).click()
  expect(await sourceText(app)).toBe(original)
  await app.screenshot({ path: join(evidence, 'native-batch-find-options.png') })
  await app.resize(390, 800)
  expect(
    await app.evaluate<boolean>('document.documentElement.scrollWidth <= innerWidth + 1')
  ).toBe(true)
  await expect(app.getByRole('button', { name: '替换当前', exact: true })).toBeVisible()
  await app.screenshot({ path: join(evidence, 'native-batch-find-390.png') })
  await app.getByRole('button', { name: '查看文件', exact: true }).click()
  await app.getByRole('button', { name: '深色主题', exact: true }).click()
  await app.getByRole('button', { name: '查看文件', exact: true }).click()
  await app.screenshot({ path: join(evidence, 'native-batch-find-dark-390.png') })
  expect((await app.console({ level: 'errors' })).entries).toEqual([])
  expect((await app.network({ failed: true })).entries).toEqual([])
})

test('find, replace, save, new and close shortcuts respect input focus and the current document', async ({
  acde
}) => {
  await acde.open('marktext-dopame')
  const app = acde.window('marktext-dopame')
  const original = '正文需要保留 😀'
  await createSource(app, original)
  const source = app.getByRole('textbox', { name: 'Markdown 源码', exact: true })
  await source.press('ctrl+f')
  const find = app.getByRole('textbox', { name: '查找文本', exact: true })
  await expect(find).toBeFocused()
  await find.fill('正文')
  await find.press('enter')
  await expect(app.getByRole('status', { name: '查找结果', exact: true })).toHaveText('1 / 1')
  await find.press('escape')
  await expect(find).toHaveCount(0)
  await expect(source).toBeFocused()
  await app.getByRole('button', { name: '富文本', exact: true }).click()
  await app.locator('.mu-editor p.mu-paragraph').first().click()
  await app.keyboard.press('ctrl+f')
  await expect(find).toBeFocused()
  await find.fill('正文')
  await expect(find).toBeFocused()
  await find.press('enter')
  expect((await richSelection(app)).text).toBe('正文')
  await expect(find).toBeFocused()
  await find.press('escape')
  await app.getByRole('button', { name: '源码', exact: true }).click()
  await source.press('ctrl+h')
  const replacement = app.getByRole('textbox', { name: '替换为', exact: true })
  await expect(replacement).toBeFocused()
  await replacement.fill('只改查找表单')
  await replacement.press('ctrl+z')
  expect(await sourceText(app)).toBe(original)
  await replacement.press('escape')
  await source.press('ctrl+s')
  await expect(app.locator('.statusbar')).toContainText('已保存')
  await source.press('ctrl+n')
  await expect(app.getByRole('tab')).toHaveCount(2)
  await app.keyboard.press('ctrl+w')
  await expect(app.getByRole('tab')).toHaveCount(1)
  expect(await sourceText(app)).toBe(original)
})

test('strikethrough toggles in source and rich modes and remains undoable', async ({ acde }) => {
  await acde.open('marktext-dopame')
  const app = acde.window('marktext-dopame')
  const text = '中文 😀和文字'
  await createSource(app, text)
  await app.getByRole('textbox', { name: 'Markdown 源码', exact: true }).press('ctrl+a')
  const strike = () => clickCommand(app, '格式', '删除线')
  await strike()
  await expect.poll(() => sourceText(app)).toBe('~~' + text + '~~')
  await strike()
  await expect.poll(() => sourceText(app)).toBe(text)
  await app.keyboard.press('ctrl+shift+x')
  await app.getByRole('button', { name: '富文本', exact: true }).click()
  await expect(app.locator('.mu-editor del')).toContainText(text)
  await strike()
  await expect(app.locator('.mu-editor del')).toHaveCount(0)
  await app.getByRole('button', { name: '撤销', exact: true }).click()
  await expect(app.locator('.mu-editor del')).toContainText(text)
  await app.getByRole('button', { name: '源码', exact: true }).click()
  expect((await sourceText(app)).trimEnd()).toBe('~~' + text + '~~')
  await app.getByRole('button', { name: '预览', exact: true }).click()
  await expect(app.getByRole('button', { name: '格式', exact: true })).toBeDisabled()
})

test('slash insertion filters by Chinese labels, accepts keyboard selection and dismisses with Escape', async ({
  acde
}) => {
  await acde.open('marktext-dopame')
  const app = acde.window('marktext-dopame')
  await app.getByRole('button', { name: '新建', exact: true }).click()
  await app.locator('.mu-editor [contenteditable="true"]').first().click()
  await app.keyboard.type('/')
  await app.keyboard.insertText('标题')
  const menu = app.getByRole('menu', { name: '插入段落', exact: true })
  await expect(menu.getByRole('menuitem', { name: '标题 2', exact: true })).toBeVisible()
  expect(
    await menu.getByRole('menuitem', { name: '标题 1', exact: true }).evaluate((element) => {
      const row = element.getBoundingClientRect()
      const panel = element.closest('[role="menu"]')!.getBoundingClientRect()
      return row.top >= panel.top && row.bottom <= panel.bottom
    })
  ).toBe(true)
  await app.screenshot({ path: join(evidence, 'native-batch-slash-menu.png') })
  await app.keyboard.press('ArrowDown')
  await app.keyboard.press('Enter')
  await app.keyboard.insertText('快捷插入标题')
  await expect(app.getByRole('heading', { name: /快捷插入标题/, level: 2 })).toBeVisible()
  await app.keyboard.press('End')
  await app.keyboard.press('Enter')
  await app.keyboard.type('/')
  await expect(menu).toBeVisible()
  await app.keyboard.press('escape')
  await expect(menu).toHaveCount(0)
  await app.getByRole('button', { name: '源码', exact: true }).click()
  expect(await sourceText(app)).toContain('## 快捷插入标题')
  expect(await sourceText(app)).toContain('/')
  await app.screenshot({ path: join(evidence, 'native-batch-slash-insert.png') })
  await app.getByRole('button', { name: '新建', exact: true }).click()
  await app.locator('.mu-editor [contenteditable="true"]').first().click()
  await app.keyboard.type('/')
  await app.keyboard.type('zzzzzzzz')
  await expect(menu).toBeVisible()
  await expect(menu.getByRole('menuitem')).toHaveCount(0)
  await app.keyboard.press('arrowdown')
  await app.keyboard.press('arrowup')
  await app.keyboard.press('Enter')
  await app.keyboard.press('Escape')
  await app.keyboard.insertText('保留输入')
  await app.getByRole('button', { name: '源码', exact: true }).click()
  expect(await sourceText(app)).toContain('/zzzzzzzz保留输入')
  expect((await app.console({ level: 'errors' })).entries).toEqual([])
  expect((await app.network({ failed: true })).entries).toEqual([])
})
