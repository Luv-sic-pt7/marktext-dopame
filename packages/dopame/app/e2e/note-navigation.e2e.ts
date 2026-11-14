import { test, expect, type AppWindow } from 'acde/test'
import { resolve, join } from 'node:path'
import { mkdirSync } from 'node:fs'

const evidence =
  process.env.MARKTEXT_EVIDENCE ??
  resolve(import.meta.dir, '../../../../../work/marktext-mvp-evidence')
mkdirSync(evidence, { recursive: true })

const sourceText = (app: AppWindow) =>
  app.evaluate<string>('document.querySelector(".CodeMirror").CodeMirror.getValue()')

async function nameActive(app: AppWindow, title: string) {
  const input = app.getByRole('textbox', { name: '笔记标题', exact: true })
  await input.fill(title)
  await input.press('Tab')
  await expect(app.getByRole('tab', { name: title + ' •', exact: true })).toBeVisible()
}

async function noteMenu(app: AppWindow, title: string) {
  const notes = app.getByRole('region', { name: '笔记列表', exact: true })
  const row = notes.getByRole('listitem', { name: title, exact: true }).first()
  await row.hover()
  await row.getByRole('button', { name: '笔记操作 ' + title, exact: true }).click()
  return app.getByRole('menu', { name: '笔记操作 ' + title, exact: true })
}

test('compact note navigation filters, folds and separates closed drafts from open tabs', async ({
  acde
}) => {
  await acde.open('marktext-dopame')
  const app = acde.window('marktext-dopame')
  const notes = app.getByRole('region', { name: '笔记列表', exact: true })
  await notes.getByRole('button', { name: '新建笔记', exact: true }).click()
  await nameActive(app, '导航 Alpha')
  await app.getByRole('button', { name: '源码', exact: true }).click()
  await app.getByRole('textbox', { name: 'Markdown 源码', exact: true }).type('Alpha 草稿😀')
  await notes.getByRole('button', { name: '新建笔记', exact: true }).click()
  await nameActive(app, '导航 Beta')

  await notes.getByRole('button', { name: '筛选笔记', exact: true }).click()
  const filter = notes.getByRole('textbox', { name: '筛选私有笔记', exact: true })
  await filter.fill('导航')
  await expect(notes.getByRole('listitem')).toHaveCount(2)
  await expect(notes.locator('.note-count')).toHaveText('2')
  await filter.fill('ALPHA')
  await expect(notes.getByRole('listitem')).toHaveCount(1)
  await expect(notes.locator('.note-count')).toHaveText('1')
  await filter.fill('不存在的笔记')
  await expect(notes.getByRole('listitem')).toHaveCount(0)
  await expect(notes).toContainText('没有匹配的笔记')
  await filter.fill('导航')

  const alphaMenu = await noteMenu(app, '导航 Alpha')
  await expect(app.getByRole('textbox', { name: '笔记标题', exact: true })).toHaveValue('导航 Beta')
  await alphaMenu.getByRole('menuitem', { name: '关闭标签', exact: true }).click()
  await notes.getByRole('button', { name: '已打开', exact: true }).click()
  await expect(notes.getByRole('listitem')).toHaveCount(1)
  await expect(notes.getByRole('listitem', { name: '导航 Beta', exact: true })).toBeVisible()
  await notes.getByRole('button', { name: '全部', exact: true }).click()
  await expect(notes.getByRole('listitem')).toHaveCount(2)
  await notes.getByRole('button', { name: '导航 Alpha', exact: true }).click()
  await expect.poll(() => sourceText(app)).toBe('Alpha 草稿😀')

  const toggle = notes.getByRole('button', { name: '私有笔记', exact: true })
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(notes.getByRole('list')).toBeHidden()
  await toggle.click()
  await expect(notes.getByRole('listitem')).toHaveCount(2)
  await app.screenshot({ path: join(evidence, 'native-note-navigation-filter.png') })
  expect((await app.console({ level: 'errors' })).entries).toEqual([])
  expect((await app.network({ failed: true })).entries).toEqual([])
})

test('note actions rename and duplicate content while menu keyboard dismissal restores focus', async ({
  acde
}) => {
  await acde.open('marktext-dopame')
  const app = acde.window('marktext-dopame')
  const notes = app.getByRole('region', { name: '笔记列表', exact: true })
  await notes.getByRole('button', { name: '新建笔记', exact: true }).click()
  await nameActive(app, '待改标题')
  await app.getByRole('button', { name: '源码', exact: true }).click()
  const markdown = '# 原笔记\n\n保留 **格式** 与中文😀。'
  await app.getByRole('textbox', { name: 'Markdown 源码', exact: true }).type(markdown)

  await noteMenu(app, '待改标题')
  await app.keyboard.press('Escape')
  await expect(app.getByRole('menu', { name: '笔记操作 待改标题', exact: true })).toHaveCount(0)
  await expect(notes.getByRole('button', { name: '笔记操作 待改标题', exact: true })).toBeFocused()
  await (
    await noteMenu(app, '待改标题')
  )
    .getByRole('menuitem', { name: '重命名', exact: true })
    .click()
  const rename = notes.getByRole('textbox', { name: '重命名笔记', exact: true })
  await rename.fill('取消的标题')
  await rename.press('Escape')
  await expect(notes.getByRole('listitem', { name: '待改标题', exact: true })).toBeVisible()
  await (
    await noteMenu(app, '待改标题')
  )
    .getByRole('menuitem', { name: '重命名', exact: true })
    .click()
  await rename.fill('已命名计划')
  await rename.press('Enter')
  await expect(notes.getByRole('listitem', { name: '已命名计划', exact: true })).toBeVisible()
  await expect(app.getByRole('textbox', { name: '笔记标题', exact: true })).toHaveValue(
    '已命名计划'
  )
  expect(await sourceText(app)).toBe(markdown)

  const count = await notes.getByRole('listitem').count()
  await (
    await noteMenu(app, '已命名计划')
  )
    .getByRole('menuitem', { name: '创建副本', exact: true })
    .click()
  await expect(notes.getByRole('listitem')).toHaveCount(count + 1)
  await expect.poll(() => sourceText(app)).toBe(markdown)
  expect(await app.getByRole('textbox', { name: '笔记标题', exact: true }).value()).not.toBe(
    '已命名计划'
  )
  await notes.getByRole('button', { name: '已命名计划', exact: true }).click()
  await expect.poll(() => sourceText(app)).toBe(markdown)
  await (
    await noteMenu(app, '已命名计划')
  )
    .getByRole('menuitem', { name: '重命名', exact: true })
    .click()
  await rename.fill('同名笔记')
  await rename.press('Enter')
  await notes.getByRole('button', { name: '新建笔记', exact: true }).click()
  await nameActive(app, '同名笔记')
  await expect(notes.getByRole('listitem', { name: '同名笔记', exact: true })).toHaveCount(2)
  const details = await app.evaluate<string[]>(
    'Array.from(document.querySelectorAll(".note-detail"), element => element.textContent ?? "")'
  )
  expect(details.length).toBe(2)
  expect(new Set(details).size).toBe(2)
  await app.getByRole('button', { name: '深色主题', exact: true }).click()
  await noteMenu(app, '同名笔记')
  await app.screenshot({ path: join(evidence, 'native-note-navigation-dark.png') })
  await app.resize(390, 840)
  await app.getByRole('button', { name: '查看文件', exact: true }).click()
  await expect(notes).toBeVisible()
  await app.screenshot({ path: join(evidence, 'native-note-navigation-390.png') })
  expect((await app.console({ level: 'errors' })).entries).toEqual([])
  expect((await app.network({ failed: true })).entries).toEqual([])
})
