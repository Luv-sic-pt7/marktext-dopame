import { test, expect, type AppWindow } from 'acde/test'
import { resolve, join } from 'node:path'
import { mkdirSync } from 'node:fs'

const evidence =
  process.env.MARKTEXT_EVIDENCE ??
  resolve(import.meta.dir, '../../../../../work/marktext-mvp-evidence')
mkdirSync(evidence, { recursive: true })
const sourceText = (app: AppWindow) =>
  app.evaluate<string>('document.querySelector(".CodeMirror").CodeMirror.getValue()')

async function createSource(app: AppWindow, text: string) {
  await app.getByRole('button', { name: '新建', exact: true }).click()
  await app.getByRole('button', { name: '源码', exact: true }).click()
  await app.getByRole('textbox', { name: 'Markdown 源码', exact: true }).type(text)
}

async function cleanRuntime(app: AppWindow) {
  expect((await app.console({ level: 'errors' })).entries).toEqual([])
  expect((await app.network({ failed: true })).entries).toEqual([])
}

test('source paragraph conversion replaces block markers and undo keeps the preceding input', async ({
  acde
}) => {
  await acde.open('marktext-dopame')
  const app = acde.window('marktext-dopame')
  const original = '首项中文 😀\n次项内容'
  await createSource(app, original)
  const input = app.getByRole('textbox', { name: 'Markdown 源码', exact: true })
  const type = app.getByRole('combobox', { name: '段落类型', exact: true })
  await input.press('ctrl+a')
  await type.selectOption('ul-bullet')
  await expect.poll(() => sourceText(app)).toBe('- 首项中文 😀\n- 次项内容')
  await app.getByRole('button', { name: '撤销', exact: true }).click()
  await expect.poll(() => sourceText(app)).toBe(original)
  await type.selectOption('ol-order')
  await expect.poll(() => sourceText(app)).toBe('1. 首项中文 😀\n2. 次项内容')
  await type.selectOption('blockquote')
  await expect.poll(() => sourceText(app)).toBe('> 首项中文 😀\n> 次项内容')
  await type.selectOption('paragraph')
  await expect.poll(() => sourceText(app)).toBe(original)
  await app.getByRole('button', { name: '预览', exact: true }).click()
  await expect(type).toBeDisabled()
  await expect(app.getByRole('button', { name: '增加缩进', exact: true })).toBeDisabled()
  await cleanRuntime(app)
})

test('rich list creation continues items and exits an empty item without losing the caret', async ({
  acde
}) => {
  await acde.open('marktext-dopame')
  const app = acde.window('marktext-dopame')
  await app.getByRole('button', { name: '新建', exact: true }).click()
  await app.locator('.mu-editor [contenteditable="true"]').first().click()
  await app.keyboard.insertText('首项')
  await app.getByRole('combobox', { name: '段落类型', exact: true }).selectOption('ul-bullet')
  await app.keyboard.press('End')
  await app.keyboard.press('Enter')
  await app.keyboard.insertText('次项')
  await app.keyboard.press('End')
  await app.keyboard.press('Enter')
  await app.keyboard.press('Enter')
  await app.keyboard.insertText('正文续写')
  await expect(app.locator('.mu-editor li')).toHaveCount(2)
  await app.getByRole('button', { name: '源码', exact: true }).click()
  expect((await sourceText(app)).trimEnd()).toBe('- 首项\n\n- 次项\n\n正文续写')
  await cleanRuntime(app)
})

test('list Tab and toolbar indentation preserve items and remain independently undoable', async ({
  acde
}) => {
  await acde.open('marktext-dopame')
  const app = acde.window('marktext-dopame')
  await createSource(app, '- 首项\n- 次项')
  await app.getByRole('button', { name: '富文本', exact: true }).click()
  await app.locator('.mu-editor li [contenteditable="true"]').last().click()
  await app.keyboard.press('End')
  await app.keyboard.press('Tab')
  await expect(app.locator('.mu-editor li li')).toHaveCount(1)
  await app.keyboard.press('shift+tab')
  await expect(app.locator('.mu-editor li li')).toHaveCount(0)
  await app.getByRole('button', { name: '增加缩进', exact: true }).click()
  await expect(app.locator('.mu-editor li li')).toHaveCount(1)
  await app.getByRole('button', { name: '减少缩进', exact: true }).click()
  await expect(app.locator('.mu-editor li li')).toHaveCount(0)
  await app.getByRole('button', { name: '撤销', exact: true }).click()
  await expect(app.locator('.mu-editor li li')).toHaveCount(1)
  await app.getByRole('button', { name: '源码', exact: true }).click()
  const input = app.getByRole('textbox', { name: 'Markdown 源码', exact: true })
  await input.press('ctrl+end')
  await input.press('arrowup')
  await input.press('end')
  await app.getByRole('button', { name: '减少缩进', exact: true }).click()
  expect((await sourceText(app)).trimEnd()).toBe('- 首项\n- 次项')
  await app.getByRole('button', { name: '增加缩进', exact: true }).click()
  expect((await sourceText(app)).trimEnd()).toBe('- 首项\n  - 次项')
  await app.getByRole('button', { name: '撤销', exact: true }).click()
  expect((await sourceText(app)).trimEnd()).toBe('- 首项\n- 次项')
  await cleanRuntime(app)
})

test('task checkbox changes persist to Markdown, undo individually and stay read-only in preview', async ({
  acde,
  home
}) => {
  const original = '- [ ] 待完成\n- [x] 已完成\n  - [ ] 子任务\n'
  const path = join(home, '任务列表.md')
  await Bun.write(path, original)
  await acde.open('marktext-dopame')
  const app = acde.window('marktext-dopame')
  await acde.chooseFiles(path)
  await app.getByRole('button', { name: '原位打开文件', exact: true }).click()
  const checks = app.getByRole('checkbox')
  await expect(checks).toHaveCount(3)
  await expect(checks.nth(0)).not.toBeChecked()
  await expect(checks.nth(1)).toBeChecked()
  await expect(checks.nth(2)).not.toBeChecked()
  await checks.nth(0).click()
  await app.getByRole('button', { name: '源码', exact: true }).click()
  expect(await sourceText(app)).toContain('- [x] 待完成')
  await app.getByRole('button', { name: '富文本', exact: true }).click()
  await checks.nth(2).click()
  await expect(checks.nth(2)).toBeChecked()
  await app.getByRole('button', { name: '撤销', exact: true }).click()
  await expect(checks.nth(0)).toBeChecked()
  await expect(checks.nth(2)).not.toBeChecked()
  await app.getByRole('button', { name: '保存', exact: true }).click()
  await expect(app.locator('.statusbar')).toContainText('已保存')
  expect(await Bun.file(path).text()).toContain('- [x] 待完成')
  await app.getByRole('button', { name: '预览', exact: true }).click()
  await checks.nth(0).click()
  await expect(checks.nth(0)).toBeChecked()
  await app.getByRole('button', { name: '源码', exact: true }).click()
  expect(await sourceText(app)).toContain('- [x] 待完成')
  expect(await sourceText(app)).toContain('- [ ] 子任务')
  await app.screenshot({ path: join(evidence, 'native-batch-2-tasks.png') })
  await cleanRuntime(app)
})
