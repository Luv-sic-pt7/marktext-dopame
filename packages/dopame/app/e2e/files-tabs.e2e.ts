import { test, expect, type AppWindow } from 'acde/test'
import { join, resolve } from 'node:path'
import { mkdirSync, readFileSync } from 'node:fs'

const evidence =
  process.env.MARKTEXT_EVIDENCE ??
  resolve(import.meta.dir, '../../../../../work/marktext-mvp-evidence')
mkdirSync(evidence, { recursive: true })
const sourceText = (app: AppWindow) =>
  app.evaluate<string>('document.querySelector(".CodeMirror").CodeMirror.getValue()')

test('save as changes the save destination while cancel and export preserve that destination', async ({
  acde,
  home
}) => {
  const original = join(home, '原位源.md'),
    copy = join(home, '新的保存目标.md'),
    exported = join(home, '导出副本.md')
  const initial = '# 原文\n\n中文 😀\n'
  const bytes = (text: string) => '\ufeff' + text.replace(/\n/g, '\r\n')
  await Bun.write(original, bytes(initial))
  await acde.open('marktext-dopame')
  const app = acde.window('marktext-dopame')
  await acde.chooseFiles(original)
  await app.getByRole('button', { name: '原位打开文件', exact: true }).click()
  await app.getByRole('button', { name: '源码', exact: true }).click()
  const source = app.getByRole('textbox', { name: 'Markdown 源码', exact: true })
  await source.press('ctrl+end')
  await source.type('另存前修改')
  const first = initial + '另存前修改'
  await acde.chooseSaveFile(copy)
  await app
    .locator('.storage-location')
    .getByRole('button', { name: '另存为', exact: true })
    .click()
  await expect(app.locator('.storage-location')).toContainText('新的保存目标.md')
  await expect(app.locator('.statusbar')).toContainText('已保存')
  expect(readFileSync(original, 'utf8')).toBe(bytes(initial))
  expect(readFileSync(copy, 'utf8')).toBe(bytes(first))
  await source.press('ctrl+end')
  await source.type('\n继续写入')
  const second = first + '\n继续写入'
  await app.getByRole('button', { name: '保存', exact: true }).click()
  await expect(app.locator('.statusbar')).toContainText('已保存')
  expect(readFileSync(copy, 'utf8')).toBe(bytes(second))
  await acde.chooseSaveFile(null)
  await app
    .locator('.storage-location')
    .getByRole('button', { name: '另存为', exact: true })
    .click()
  await expect(app.locator('.storage-location')).toContainText('新的保存目标.md')
  expect(await sourceText(app)).toBe(second)
  await acde.chooseSaveFile(exported)
  await app.getByRole('button', { name: '导出', exact: true }).click()
  await expect(app.locator('.storage-location')).toContainText('上次导出')
  await source.press('ctrl+end')
  await source.type('\n导出后的编辑')
  await app.getByRole('button', { name: '保存', exact: true }).click()
  await expect(app.locator('.statusbar')).toContainText('已保存')
  expect(readFileSync(original, 'utf8')).toBe(bytes(initial))
  expect(readFileSync(exported, 'utf8')).toBe(bytes(second))
  expect(readFileSync(copy, 'utf8')).toBe(bytes(second + '\n导出后的编辑'))
  expect((await app.console({ level: 'errors' })).entries).toEqual([])
  expect((await app.network({ failed: true })).entries).toEqual([])
  await app.screenshot({ path: join(evidence, 'native-batch2-save-as.png') })
})

test('reopening a closed tab preserves its unsaved text, mode and independent undo history', async ({
  acde
}) => {
  await acde.open('marktext-dopame')
  const app = acde.window('marktext-dopame')
  await app.getByRole('button', { name: '新建', exact: true }).click()
  await app.getByRole('button', { name: '源码', exact: true }).click()
  const source = app.getByRole('textbox', { name: 'Markdown 源码', exact: true })
  await source.type('第一篇保留 😀')
  await app.getByRole('button', { name: '新建', exact: true }).click()
  await app.getByRole('button', { name: '源码', exact: true }).click()
  await source.type('第二篇未保存 中文 😀')
  await source.press('ctrl+w')
  await expect(app.getByRole('tab')).toHaveCount(1)
  expect(await sourceText(app)).toBe('第一篇保留 😀')
  await source.press('ctrl+shift+t')
  await expect(app.getByRole('tab')).toHaveCount(2)
  await expect(app.getByRole('button', { name: '源码', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  expect(await sourceText(app)).toBe('第二篇未保存 中文 😀')
  await app.getByRole('button', { name: '撤销', exact: true }).click()
  expect(await sourceText(app)).toBe('')
  await app.getByRole('button', { name: '重做', exact: true }).click()
  expect(await sourceText(app)).toBe('第二篇未保存 中文 😀')
  await app.getByRole('tab').first().click()
  expect(await sourceText(app)).toBe('第一篇保留 😀')
  await expect(app.getByRole('button', { name: '恢复关闭标签', exact: true })).toBeDisabled()
})

test('closed external-file drafts reopen after reload without writing to the source file', async ({
  acde,
  home
}) => {
  const path = join(home, '关闭后恢复.md')
  const original = '# 磁盘正文\n'
  await Bun.write(path, original)
  await acde.open('marktext-dopame')
  const app = acde.window('marktext-dopame')
  await acde.chooseFiles(path)
  await app.getByRole('button', { name: '原位打开文件', exact: true }).click()
  await app.getByRole('button', { name: '源码', exact: true }).click()
  const source = app.getByRole('textbox', { name: 'Markdown 源码', exact: true })
  await source.press('ctrl+end')
  await source.type('尚未保存的草稿 😀')
  expect(await sourceText(app)).toBe(original + '尚未保存的草稿 😀')
  await source.press('ctrl+w')
  await expect(app.getByRole('tab')).toHaveCount(0)
  expect(readFileSync(path, 'utf8')).toBe(original)
  const checkpoint = await app.evaluate<any>(
    '(async()=>{const {fs}=await import("acde:fs");const list=await fs.list("private","checkpoints");const record=JSON.parse((await fs.readText("private","checkpoints/"+list.entries[0].name)).text);return {text:record.session.text,sourceText:record.session.history.sourceText,muyaText:record.session.history.muyaText,cursor:record.session.history.cursor}})()'
  )
  expect(checkpoint.text).toBe(original + '尚未保存的草稿 😀')
  expect(checkpoint.sourceText).toBe(original + '尚未保存的草稿 😀')
  await app.reload()
  const reopen = app.getByRole('button', { name: '恢复关闭标签', exact: true })
  await expect(reopen).not.toBeDisabled()
  await reopen.click()
  await expect(app.getByRole('tab')).toHaveCount(1)
  await expect(app.getByRole('textbox', { name: '笔记标题', exact: true })).toHaveValue(
    '关闭后恢复.md'
  )
  expect(await sourceText(app)).toBe(original + '尚未保存的草稿 😀')
  await expect(app.locator('.statusbar')).toContainText('有未保存修改')
  expect(
    await app.evaluate('document.querySelector(".CodeMirror").CodeMirror.getCursor()')
  ).toEqual(checkpoint.cursor.focus)
  expect(readFileSync(path, 'utf8')).toBe(original)
  expect((await app.console({ level: 'errors' })).entries).toEqual([])
  expect((await app.network({ failed: true })).entries).toEqual([])
  await app.screenshot({ path: join(evidence, 'native-batch2-reopen.png') })
})
