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

test('P0 multi-file opening reuses live file handles and keeps the draft recoverable after reload', async ({
  acde,
  home
}) => {
  const first = join(home, '第一份 中文.md'),
    second = join(home, '第二份.md')
  await Bun.write(first, '# 第一份\n')
  await Bun.write(second, '# 第二份\n')
  await acde.open('marktext-dopame')
  const app = acde.window('marktext-dopame')
  await acde.chooseFiles([first, second])
  await app.getByRole('button', { name: '原位打开文件', exact: true }).click()
  await expect(app.getByRole('tab')).toHaveCount(2)
  await app.getByRole('tab', { name: '第一份 中文.md', exact: true }).click()
  await app.getByRole('button', { name: '源码', exact: true }).click()
  const input = app.getByRole('textbox', { name: 'Markdown 源码', exact: true })
  await input.press('ctrl+end')
  await input.type('保留未保存输入 😀')
  await input.press('ctrl+w')
  await acde.chooseFiles(first)
  await app.getByRole('button', { name: '原位打开文件', exact: true }).click()
  await expect(app.getByRole('tab')).toHaveCount(2)
  await expect(
    app.getByRole('region', { name: '笔记列表', exact: true }).getByRole('listitem')
  ).toHaveCount(2)
  expect(await sourceText(app)).toBe('# 第一份\n保留未保存输入 😀')
  await acde.chooseFiles(first)
  await app.getByRole('button', { name: '原位打开文件', exact: true }).click()
  await expect(app.getByRole('tab')).toHaveCount(2)
  expect(readFileSync(first, 'utf8')).toBe('# 第一份\n')
  await app.reload()
  await expect(app.getByRole('textbox', { name: 'Markdown 源码', exact: true })).toBeVisible()
  expect(await sourceText(app)).toBe('# 第一份\n保留未保存输入 😀')
  await expect(
    app.getByRole('region', { name: '笔记列表', exact: true }).getByRole('listitem')
  ).toHaveCount(2)
  const savedCopy = join(home, '重选后的副本.md')
  await acde.chooseSaveFile(savedCopy)
  await app
    .locator('.storage-location')
    .getByRole('button', { name: '另存为', exact: true })
    .click()
  await expect(app.locator('.statusbar')).toContainText('已保存')
  expect(readFileSync(savedCopy, 'utf8')).toBe('# 第一份\n保留未保存输入 😀')
  expect(readFileSync(first, 'utf8')).toBe('# 第一份\n')
})

test('P0 one invalid file in a multiple selection does not discard the valid documents', async ({
  acde,
  home
}) => {
  const before = join(home, '可用一.md'),
    invalid = join(home, '损坏编码.md'),
    after = join(home, '可用二.md')
  await Bun.write(before, '# 可用一\n')
  await Bun.write(invalid, new Uint8Array([255, 254, 0, 65]))
  await Bun.write(after, '# 可用二\n')
  await acde.open('marktext-dopame')
  const app = acde.window('marktext-dopame')
  await acde.chooseFiles([before, invalid, after])
  await app.getByRole('button', { name: '原位打开文件', exact: true }).click()
  await expect(app.getByRole('tab')).toHaveCount(2)
  await expect(app.getByRole('status', { name: '文档操作反馈', exact: true })).toContainText(
    '损坏编码.md'
  )
  await expect(app.getByRole('status', { name: '文档操作反馈', exact: true })).toContainText(
    'UTF-8'
  )
  expect(Array.from(readFileSync(invalid))).toEqual([255, 254, 0, 65])
  await app.getByRole('button', { name: '源码', exact: true }).click()
  expect(await sourceText(app)).toBe('# 可用二\n')
})

test('P0 a system open-file request edits the selected file and reuses its existing tab', async ({
  acde,
  home
}) => {
  const file = join(home, '系统打开 中文.md')
  const initial = '# 系统请求\n'
  await Bun.write(file, initial)
  const openFile = () =>
    acde.desktop.evaluate(
      '(async()=>{const {openPath}=await import("acde:openPath");return openPath(' +
        JSON.stringify(file) +
        ',{app:"marktext-dopame"})})()'
    )
  await openFile()
  const app = acde.window('marktext-dopame')
  await expect(app.getByRole('textbox', { name: '笔记标题', exact: true })).toHaveValue(
    '系统打开 中文.md'
  )
  await expect(app.locator('.storage-location')).toContainText('原位保存')
  await app.getByRole('button', { name: '源码', exact: true }).click()
  const input = app.getByRole('textbox', { name: 'Markdown 源码', exact: true })
  await input.press('ctrl+end')
  await input.type('由系统请求打开后修改')
  await openFile()
  await expect(app.getByRole('tab')).toHaveCount(1)
  expect(await sourceText(app)).toBe(initial + '由系统请求打开后修改')
  await app.getByRole('button', { name: '保存', exact: true }).click()
  await expect(app.locator('.statusbar')).toContainText('已保存')
  expect(readFileSync(file, 'utf8')).toBe(initial + '由系统请求打开后修改')
})

test('P0 read-only folders save to a chosen copy and cancellation retains the original target', async ({
  acde,
  home
}) => {
  const folder = join(home, '只读资料'),
    file = join(folder, '只读.md'),
    copy = join(home, '可写副本.md')
  mkdirSync(folder)
  const initial = '# 只读原文\n'
  await Bun.write(file, initial)
  await acde.open('marktext-dopame')
  const app = acde.window('marktext-dopame')
  await acde.chooseFolder(folder)
  await app.evaluate('showDirectoryPicker()')
  await app.reload()
  await app.getByRole('button', { name: '只读资料', exact: true }).click()
  await app.getByRole('button', { name: '原位打开文件 只读.md', exact: true }).click()
  const saveCopy = app.locator('.top-actions').getByRole('button', { name: '另存为', exact: true })
  await expect(saveCopy).toBeVisible()
  await acde.chooseSaveFile(null)
  await saveCopy.click()
  await expect(saveCopy).toBeVisible()
  expect(readFileSync(file, 'utf8')).toBe(initial)
  await acde.chooseSaveFile(copy)
  await saveCopy.click()
  await expect(app.locator('.storage-location')).toContainText('可写副本.md')
  await app.getByRole('button', { name: '源码', exact: true }).click()
  const input = app.getByRole('textbox', { name: 'Markdown 源码', exact: true })
  await input.press('ctrl+end')
  await input.type('副本可以继续编辑')
  await app.getByRole('button', { name: '保存', exact: true }).click()
  await expect(app.locator('.statusbar')).toContainText('已保存')
  expect(readFileSync(copy, 'utf8')).toBe(initial + '副本可以继续编辑')
  expect(readFileSync(file, 'utf8')).toBe(initial)
})

test('P0 revoking folder access preserves input and allows explicit save as recovery', async ({
  acde,
  home
}) => {
  const folder = join(home, '临时授权'),
    file = join(folder, '授权文档.md'),
    recovered = join(home, '恢复副本.md')
  mkdirSync(folder)
  const initial = '# 源文件\n'
  await Bun.write(file, initial)
  await acde.open('marktext-dopame')
  const app = acde.window('marktext-dopame')
  await acde.chooseFolder(folder)
  await app.getByRole('button', { name: '添加文件夹', exact: true }).click()
  await app.getByRole('button', { name: '临时授权', exact: true }).click()
  await app.getByRole('button', { name: '原位打开文件 授权文档.md', exact: true }).click()
  await app.getByRole('button', { name: '源码', exact: true }).click()
  const input = app.getByRole('textbox', { name: 'Markdown 源码', exact: true })
  await input.press('ctrl+end')
  await input.type('授权失效后保留的输入 😀')
  await app.evaluate(
    '(async()=>{const {fs}=await import("acde:fs");const root=(await fs.roots()).find(r=>r.source==="granted"&&r.label==="临时授权");await fs.revoke(root.id)})()'
  )
  await app.getByRole('button', { name: '保存', exact: true }).click()
  await expect(app.getByRole('status', { name: '文档操作反馈', exact: true })).toContainText(
    '授权已撤销'
  )
  expect(await sourceText(app)).toBe(initial + '授权失效后保留的输入 😀')
  expect(readFileSync(file, 'utf8')).toBe(initial)
  await acde.chooseSaveFile(recovered)
  await app
    .locator('.storage-location')
    .getByRole('button', { name: '另存为', exact: true })
    .click()
  await expect(app.locator('.statusbar')).toContainText('已保存')
  expect(readFileSync(recovered, 'utf8')).toBe(initial + '授权失效后保留的输入 😀')
})

test('P0 killing the app restores a durable checkpoint without writing the external source', async ({
  acde,
  home
}) => {
  const file = join(home, '异常退出.md'),
    initial = '# 原始磁盘\n',
    draft = '已落盘草稿 😀'
  await Bun.write(file, initial)
  await acde.open('marktext-dopame')
  const app = acde.window('marktext-dopame')
  await acde.chooseFiles(file)
  await app.getByRole('button', { name: '原位打开文件', exact: true }).click()
  await app.getByRole('button', { name: '源码', exact: true }).click()
  const input = app.getByRole('textbox', { name: 'Markdown 源码', exact: true })
  await input.press('ctrl+end')
  await input.type(draft)
  await expect
    .poll(() =>
      app.evaluate<string>(
        '(async()=>{const{fs}=await import("acde:fs");const{entries}=await fs.list("private","checkpoints");return JSON.parse((await fs.readText("private","checkpoints/"+entries[0].name)).text).session.text})()'
      )
    )
    .toBe(initial + draft)
  const windowId = await app.evaluate<number>('import("acde:window").then(({window})=>window.id)')
  await acde.desktop.evaluate(
    '(async()=>{const{windows}=await import("acde:windows");return windows.kill(' +
      windowId +
      ')})()'
  )
  await expect(app).not.toBeOpen()
  await acde.open('marktext-dopame')
  const restored = acde.window('marktext-dopame')
  await expect(restored.getByRole('textbox', { name: 'Markdown 源码', exact: true })).toBeVisible()
  expect(await sourceText(restored)).toBe(initial + draft)
  expect(readFileSync(file, 'utf8')).toBe(initial)
  await expect(restored.locator('.statusbar')).toContainText('有未保存修改')
  expect((await restored.console({ level: 'errors' })).entries).toEqual([])
})
