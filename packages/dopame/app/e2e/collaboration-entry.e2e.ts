import { test, expect } from 'acde/test'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const evidence =
  process.env.MARKTEXT_EVIDENCE ??
  resolve(import.meta.dir, '../../../../../work/marktext-mvp-evidence')
mkdirSync(evidence, { recursive: true })

test('the collaboration entry keeps the editor window available and narrow layouts return to writing', async ({
  acde
}) => {
  await acde.open('marktext-dopame')
  const app = acde.window('marktext-dopame')
  const windows = async () =>
    (await acde.webs())
      .filter((web) => web.app)
      .map((web) => web.name)
      .sort()
  const state = () => app.evaluate<string>('import("acde:window").then(({window}) => window.state)')
  await app.getByRole('button', { name: '新建', exact: true }).click()
  await app.getByRole('button', { name: '源码', exact: true }).click()
  await app
    .getByRole('textbox', { name: 'Markdown 源码', exact: true })
    .type('协作入口编辑验证\n\n窄窗正文')
  await app.getByRole('button', { name: '富文本', exact: true }).click()
  const paragraph = app
    .locator('.mu-editor .mu-content[contenteditable="true"]')
    .filter({ hasText: '协作入口编辑验证' })
  await expect(paragraph).toHaveText('协作入口编辑验证')
  const initialWindows = await windows()
  expect(await state()).toBe('normal')
  const panel = app.getByRole('complementary', { name: '协作任务', exact: true })
  const sidebar = app.getByRole('complementary', { name: '文档导航', exact: true })
  for (let attempt = 0; attempt < 2; attempt++) {
    await sidebar.getByRole('button', { name: /^协作中心/ }).click()
    await expect(panel).toBeVisible()
    await expect(panel.getByRole('status', { name: '协作连接', exact: true })).toHaveText(
      '尚未配对'
    )
    await panel.getByRole('button', { name: '刷新任务', exact: true }).click()
    expect(await state()).toBe('normal')
    expect(await windows()).toEqual(initialWindows)
    await panel.getByRole('button', { name: '关闭协作任务', exact: true }).click()
    await expect(panel).not.toBeVisible()
  }
  await paragraph.click()
  await app.keyboard.press('End')
  await app.keyboard.insertText('，关闭面板后继续输入')
  await expect(paragraph).toHaveText('协作入口编辑验证，关闭面板后继续输入')
  await app.resize(390, 844)
  await app.getByRole('button', { name: '查看文件', exact: true }).click()
  await sidebar.getByRole('button', { name: /^协作中心/ }).click()
  await expect(panel).toBeVisible()
  await expect(panel.getByRole('button', { name: '关闭协作任务', exact: true })).toBeVisible()
  expect(await state()).toBe('normal')
  expect(await windows()).toEqual(initialWindows)
  await app.screenshot({ path: join(evidence, 'native-collaboration-entry-390.png') })
  await panel.getByRole('button', { name: '关闭协作任务', exact: true }).click()
  const narrowParagraph = app
    .locator('.mu-editor .mu-content[contenteditable="true"]')
    .filter({ hasText: '窄窗正文' })
  await expect(narrowParagraph).toBeVisible()
  await narrowParagraph.click()
  await app.keyboard.press('End')
  await app.keyboard.insertText('，继续编辑')
  await expect(narrowParagraph).toHaveText('窄窗正文，继续编辑')
  expect((await app.console({ level: 'errors' })).entries).toEqual([])
  expect((await app.network({ failed: true })).entries).toEqual([])
})
