import { test, expect } from 'acde/test'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const evidence =
  process.env.MARKTEXT_EVIDENCE ??
  resolve(import.meta.dir, '../../../../../work/marktext-mvp-evidence')
mkdirSync(evidence, { recursive: true })

test('the launcher lives in the manager header and leaves editor text and sidebar controls unobstructed', async ({
  acde
}) => {
  const desktop = acde.desktop
  const dock = desktop.getByRole('navigation', { name: '应用', exact: true })
  await expect(dock).toBeVisible()
  expect(await dock.evaluate((element) => !!element.closest('header'))).toBe(true)
  await acde.screen({ path: join(evidence, 'native-batch2-manager-launcher.png') })
  await dock.getByRole('button', { name: '打开编辑器', exact: true }).click()
  const app = acde.window('marktext-dopame')
  await app.getByRole('button', { name: '深色主题', exact: true }).click()
  expect(await app.evaluate<string>('document.documentElement.dataset.theme')).toBe('dark')
  await app.getByRole('button', { name: '浅色主题', exact: true }).click()
  expect(await app.evaluate<string>('document.documentElement.dataset.theme')).toBe('light')
  await app.getByRole('button', { name: '新建', exact: true }).click()
  await app.getByRole('button', { name: '源码', exact: true }).click()
  const content =
    '# 交互修复验收\n\n正文中的查找目标。\n\n第二段也有查找目标。\n\n| 表格 | 内容 |\n| --- | --- |\n| 示例 | 可以编辑 |\n'
  await app.getByRole('textbox', { name: 'Markdown 源码', exact: true }).type(content)
  await app.getByRole('button', { name: '富文本', exact: true }).click()
  const paragraph = app
    .locator('.mu-editor .mu-content[contenteditable="true"]')
    .filter({ hasText: '第二段也有查找目标。' })
  await expect(paragraph).toHaveText('第二段也有查找目标。')
  await paragraph.click()
  await app.keyboard.press('End')
  await app.keyboard.insertText(' 继续输入成功。')
  await expect(paragraph).toHaveText('第二段也有查找目标。 继续输入成功。')
  await app.getByRole('button', { name: '源码', exact: true }).click()
  const saved = await app.evaluate<string>(
    'document.querySelector(".CodeMirror").CodeMirror.getValue()'
  )
  expect(saved.trimStart().startsWith('# 交互修复验收')).toBe(true)
  expect(saved).toContain('第二段也有查找目标。 继续输入成功。')
  expect(saved).toContain('可以编辑')
  await app.getByRole('button', { name: '富文本', exact: true }).click()
  await app.keyboard.press('ctrl+f')
  const find = app.getByRole('textbox', { name: '查找文本', exact: true })
  await expect(find).toBeFocused()
  await find.fill('查找目标')
  await app.getByRole('button', { name: '下一处', exact: true }).click()
  await expect(app.getByRole('status', { name: '查找结果', exact: true })).toHaveText('2 / 2')
  await app.getByRole('button', { name: '格式', exact: true }).click()
  await expect(
    app
      .getByRole('menu', { name: '格式', exact: true })
      .getByRole('menuitem', { name: '删除线', exact: true })
  ).toBeVisible()
  await app.keyboard.press('Escape')
  expect((await app.console({ level: 'errors' })).entries).toEqual([])
  expect((await desktop.console({ level: 'errors' })).entries).toEqual([])
  expect((await app.network({ failed: true })).entries).toEqual([])
  await acde.screen({ path: join(evidence, 'native-batch2-desktop-no-overlay.png') })
})
