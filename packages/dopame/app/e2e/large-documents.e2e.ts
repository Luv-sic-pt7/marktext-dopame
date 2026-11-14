import { test, expect, type AppWindow } from 'acde/test'
import { dirname, join } from 'node:path'
import { readFileSync } from 'node:fs'
import { createClient } from '../../client'
import { HttpTransport } from '../../http-transport'

const sourceText = (app: AppWindow) =>
  app.evaluate<string>('document.querySelector(".CodeMirror").CodeMirror.getValue()')

async function openSource(acde: any, app: AppWindow, file: string) {
  await acde.chooseFiles(file)
  await app.getByRole('button', { name: '打开选项', exact: true }).click()
  await app.getByRole('menuitem', { name: '源码原位打开', exact: true }).click()
  await expect(app.getByRole('textbox', { name: 'Markdown 源码', exact: true })).toBeVisible()
}

test('source-first file loading defers rich content while preserving source edits and mode history', async ({
  acde,
  home
}) => {
  const file = join(home, '源码优先.md')
  const initial = '# 源码标题\n\n正文 😀\n'
  await Bun.write(file, initial)
  await acde.open('marktext-dopame')
  const app = acde.window('marktext-dopame')
  await openSource(acde, app, file)
  expect(await sourceText(app)).toBe(initial)
  expect(await app.locator('.mu-editor').evaluate((e) => e.textContent)).toBe('')
  const input = app.getByRole('textbox', { name: 'Markdown 源码', exact: true })
  await input.press('ctrl+end')
  await input.type('保留源码修改')
  await app.getByRole('button', { name: '新建', exact: true }).click()
  await app.locator('.mu-editor [contenteditable="true"]').first().click()
  await app.keyboard.insertText('其他文档')
  await app.getByRole('tab', { name: /源码优先/ }).click()
  expect(await sourceText(app)).toBe(initial + '保留源码修改')
  await app.getByRole('button', { name: '富文本', exact: true }).click()
  await expect(app.locator('.mu-editor h1')).toContainText('源码标题')
  await expect(app.locator('.mu-editor')).toContainText('保留源码修改')
  await expect(app.locator('.mu-editor')).not.toContainText('其他文档')
  await app.getByRole('button', { name: '撤销', exact: true }).click()
  await app.getByRole('button', { name: '源码', exact: true }).click()
  expect((await sourceText(app)).trimEnd()).toBe(initial.trimEnd())
  expect(readFileSync(file, 'utf8')).toBe(initial)
})

test('near-limit source documents open edit search and save without building a hidden rich tree', async ({
  acde,
  home
}) => {
  const file = join(home, '大文档.md')
  const text = '大文档 0123456789 abcdefghijklmnopqrstuvwxyz\n'.repeat(37000)
  await Bun.write(file, text)
  await acde.open('marktext-dopame')
  const app = acde.window('marktext-dopame')
  await openSource(acde, app, file)
  expect((await sourceText(app)) === text).toBe(true)
  expect(await app.locator('.mu-editor').evaluate((e) => e.textContent)).toBe('')
  const input = app.getByRole('textbox', { name: 'Markdown 源码', exact: true })
  await input.press('ctrl+end')
  await input.type('尾部标记 😀')
  await app.keyboard.press('ctrl+f')
  await app.getByRole('textbox', { name: '查找文本', exact: true }).fill('尾部标记')
  await expect(app.getByRole('status', { name: '查找结果', exact: true })).toHaveText('1 / 1')
  await app.getByRole('button', { name: '关闭查找', exact: true }).click()
  await app.getByRole('button', { name: '保存', exact: true }).click()
  await expect(app.locator('.statusbar')).toContainText('已保存')
  expect(readFileSync(file, 'utf8') === text + '尾部标记 😀').toBe(true)
  expect((await app.console({ level: 'errors' })).entries).toEqual([])
})

test('encoded BOM overhead is rejected before overwriting an exact-limit file', async ({
  acde,
  home
}) => {
  const file = join(home, 'BOM边界.md')
  const size = 2 * 1024 * 1024
  const line = 'line content 0123456789\n'
  const body = line.repeat(Math.floor((size - 3) / line.length)).padEnd(size - 3, 'x')
  const original = new TextEncoder().encode('\ufeff' + body)
  await Bun.write(file, original)
  await acde.open('marktext-dopame')
  const app = acde.window('marktext-dopame')
  await openSource(acde, app, file)
  const input = app.getByRole('textbox', { name: 'Markdown 源码', exact: true })
  await input.press('ctrl+end')
  await input.type('x')
  await app.getByRole('button', { name: '保存', exact: true }).click()
  await expect(app.getByRole('status', { name: '文档操作反馈', exact: true })).toContainText(
    '超过 2MiB'
  )
  expect(readFileSync(file).equals(Buffer.from(original))).toBe(true)
  expect((await sourceText(app)) === body + 'x').toBe(true)
  await expect(app.locator('.statusbar')).toContainText('有未保存修改')
  expect((await app.console({ level: 'errors' })).entries).toEqual([])
})

test('character counts preserve Unicode code points and outline refreshes on structural changes', async ({
  acde
}) => {
  await acde.open('marktext-dopame')
  const app = acde.window('marktext-dopame')
  await app.getByRole('button', { name: '新建', exact: true }).click()
  await app.getByRole('button', { name: '源码', exact: true }).click()
  const input = app.getByRole('textbox', { name: 'Markdown 源码', exact: true })
  await input.type('A 😀 e\u0301 中\t\n\u00a0\u2028👨‍👩‍👧‍👦')
  await expect(app.locator('.statusbar')).toContainText('12 字符')
  await input.press('ctrl+a')
  await input.type('# 标题\n\n正文')
  await input.press('ctrl+end')
  await input.type('新增字')
  await expect(app.locator('.outline button')).toHaveCount(1)
  await input.type('\n## 新标题')
  await expect(app.locator('.outline button')).toHaveCount(2)
  await app.getByRole('button', { name: '深色主题', exact: true }).click()
  await expect(app.locator('.outline button')).toHaveCount(2)
  expect((await app.console({ level: 'errors' })).entries).toEqual([])
})

test('a source insertion beyond the raw text limit is rejected without diverging from the saved document', async ({
  acde,
  home
}) => {
  const file = join(home, '正文边界.md')
  const line = 'plain content 0123456789\n'
  const size = 2 * 1024 * 1024
  const initial = line.repeat(Math.floor(size / line.length)).padEnd(size, 'x')
  await Bun.write(file, initial)
  await acde.open('marktext-dopame')
  const app = acde.window('marktext-dopame')
  await openSource(acde, app, file)
  const input = app.getByRole('textbox', { name: 'Markdown 源码', exact: true })
  await input.press('ctrl+end')
  await input.type('x')
  expect((await sourceText(app)) === initial).toBe(true)
  await expect(app.getByRole('status', { name: '文档操作反馈', exact: true })).toContainText('过大')
  await app.getByRole('button', { name: '保存', exact: true }).click()
  expect(readFileSync(file, 'utf8') === initial).toBe(true)
  await input.press('backspace')
  expect((await sourceText(app)) === initial.slice(0, -1)).toBe(true)
  await app.getByRole('button', { name: '撤销', exact: true }).click()
  expect((await sourceText(app)) === initial).toBe(true)
  expect((await app.console({ level: 'errors' })).entries).toEqual([])
})

test('source-first reload establishes the new disk baseline before the first rich undo', async ({
  acde,
  home
}) => {
  const file = join(home, '源码重新载入.md')
  await Bun.write(file, '# 原来内容\n\n原正文\n')
  await acde.open('marktext-dopame')
  const app = acde.window('marktext-dopame')
  await openSource(acde, app, file)
  const input = app.getByRole('textbox', { name: 'Markdown 源码', exact: true })
  await input.press('ctrl+end')
  await input.type('本地未保存')
  const reloaded = '# 磁盘新版本\n\n重新载入基线 😀\n'
  await Bun.write(file, reloaded)
  await app.getByRole('button', { name: '保存', exact: true }).click()
  await app.getByRole('button', { name: '保留草稿并载入磁盘版本', exact: true }).click()
  expect(await sourceText(app)).toBe(reloaded)
  expect(await app.locator('.mu-editor').evaluate((e) => e.textContent)).toBe('')
  await input.press('ctrl+end')
  await input.type('重载后输入')
  await app.getByRole('button', { name: '富文本', exact: true }).click()
  await expect(app.locator('.mu-editor')).toContainText('重载后输入')
  await app.getByRole('button', { name: '撤销', exact: true }).click()
  await app.getByRole('button', { name: '源码', exact: true }).click()
  expect((await sourceText(app)).trimEnd()).toBe(reloaded.trimEnd())
  expect(readFileSync(file, 'utf8')).toBe(reloaded)
  expect((await app.console({ level: 'errors' })).entries).toEqual([])
})

test('oversized rich input restores valid text and keeps the caret at its last accepted position', async ({
  acde
}) => {
  await acde.open('marktext-dopame')
  const app = acde.window('marktext-dopame')
  await app.getByRole('button', { name: '新建', exact: true }).click()
  await app.locator('.mu-editor [contenteditable="true"]').first().click()
  await app.keyboard.insertText('保留正文')
  await expect(app.locator('.mu-editor')).toContainText('保留正文')
  await app.keyboard.insertText('超'.repeat(700000))
  await expect(app.getByRole('status', { name: '文档操作反馈', exact: true })).toContainText('过大')
  await expect(app.locator('.mu-editor')).toContainText('保留正文')
  await expect(app.locator('.mu-editor')).not.toContainText('超')
  await app.keyboard.insertText('继续')
  await app.getByRole('button', { name: '源码', exact: true }).click()
  expect((await sourceText(app)).trimEnd()).toBe('保留正文继续')
  await app.getByRole('button', { name: '富文本', exact: true }).click()
  await app.getByRole('button', { name: '撤销', exact: true }).click()
  await expect(app.locator('.mu-editor')).toContainText('保留正文')
  expect((await app.console({ level: 'errors' })).entries).toEqual([])
})

test('two external source-first edits keep separate rich undo boundaries without loading a hidden tree', async ({
  acde,
  home
}) => {
  const file = join(home, '源码协作历史.md')
  const initial = '# 源码协作\n\n原始内容\n'
  await Bun.write(file, initial)
  const administratorPath = await acde.desktop.evaluate<string>(
    '(async()=>{const m=await import("acde:marktext-agent");return (await m["marktext-agent"].request({method:"health"})).value.credentialPath})()'
  )
  const transport = new HttpTransport(join(dirname(administratorPath), 'endpoint.json'))
  const desktop = acde.desktop
  await acde.chooseFiles(administratorPath)
  await desktop.getByRole('button', { name: '选择管理员凭证', exact: true }).click()
  await desktop.getByRole('textbox', { name: '调用方 ID', exact: true }).fill('source-history')
  await desktop.getByRole('textbox', { name: '显示名称', exact: true }).fill('source-history')
  await desktop.getByRole('checkbox', { name: '允许在授权范围内直接应用修改', exact: true }).check()
  await desktop.getByRole('button', { name: '创建配对凭证', exact: true }).click()
  await desktop
    .getByRole('combobox', { name: '调用方', exact: true })
    .selectOption('source-history')
  await desktop.getByRole('combobox', { name: '资源类型', exact: true }).selectOption('workspace')
  await desktop.getByRole('button', { name: '授予所选权限', exact: true }).click()
  await desktop.getByRole('combobox', { name: '资源类型', exact: true }).selectOption('document')
  await desktop.getByRole('combobox', { name: '文档', exact: true }).selectOption('*')
  await desktop.getByRole('combobox', { name: '允许动作', exact: true }).selectOption('edit')
  await desktop.getByRole('button', { name: '授予所选权限', exact: true }).click()
  const credentialPath = join(dirname(administratorPath), 'client-source-history.json')
  const client = createClient(transport, JSON.parse(readFileSync(credentialPath, 'utf8')).token)
  async function run(capability: string, input: any) {
    const receipt = await client.request('documents.' + capability, input)
    const { task, result } = await client.wait(receipt.taskId, { timeoutMs: 15000 })
    expect(task.state).toBe('succeeded')
    return result
  }
  await acde.open('marktext-dopame')
  const app = acde.window('marktext-dopame')
  await openSource(acde, app, file)
  const input = app.getByRole('textbox', { name: 'Markdown 源码', exact: true })
  await input.press('ctrl+end')
  await input.type('首次协作前输入\n')
  const beforeFirst = initial + '首次协作前输入\n'
  await run('create', { title: '协作连接检查', markdown: '' })
  const listed = await run('list', {})
  const document = listed.documents.find((item: any) => item.title === '源码协作历史.md').document
  const first = beforeFirst + '第一次修改\n'
  let result = await run('patch', {
    document,
    baseRevision: document.revision,
    edits: [
      { from: beforeFirst.length, to: beforeFirst.length, expectedText: '', text: '第一次修改\n' }
    ]
  })
  expect(await sourceText(app)).toBe(first)
  await input.press('ctrl+end')
  await input.type('中间本地输入\n')
  const middle = first + '中间本地输入\n'
  const version = (await run('list', {})).documents.find(
    (item: any) => item.title === '源码协作历史.md'
  ).document
  result = await run('patch', {
    document: version,
    baseRevision: version.revision,
    edits: [{ from: middle.length, to: middle.length, expectedText: '', text: '第二次修改\n' }]
  })
  expect(result.document.revision).toBe(version.revision + 1)
  expect(await sourceText(app)).toBe(middle + '第二次修改\n')
  expect(await app.locator('.mu-editor').evaluate((e) => e.textContent)).toBe('')
  await input.press('ctrl+end')
  await input.type('末次本地输入')
  const final = middle + '第二次修改\n末次本地输入'
  await input.press('ctrl+w')
  await expect(app.getByRole('tab')).toHaveCount(0)
  await app.reload()
  await app.getByRole('button', { name: '恢复关闭标签', exact: true }).click()
  expect(await sourceText(app)).toBe(final)
  const undoTexts = [middle + '第二次修改\n', middle, first, beforeFirst, initial]
  for (const text of undoTexts) {
    await app.getByRole('button', { name: '撤销', exact: true }).click()
    expect((await sourceText(app)).trimEnd()).toBe(text.trimEnd())
  }
  for (let i = 0; i < undoTexts.length; i++)
    await app.getByRole('button', { name: '重做', exact: true }).click()
  expect(await sourceText(app)).toBe(final)
  await app.getByRole('button', { name: '富文本', exact: true }).click()
  for (const text of undoTexts) {
    await app.getByRole('button', { name: '撤销', exact: true }).click()
    await app.getByRole('button', { name: '源码', exact: true }).click()
    expect((await sourceText(app)).trimEnd()).toBe(text.trimEnd())
    await app.getByRole('button', { name: '富文本', exact: true }).click()
  }
  expect(readFileSync(file, 'utf8')).toBe(initial)
  expect((await app.console({ level: 'errors' })).entries).toEqual([])
})
