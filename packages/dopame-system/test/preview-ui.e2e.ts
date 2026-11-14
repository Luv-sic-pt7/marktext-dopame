import { test, expect } from 'acde/test'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

test('preview requests pairing without exposing approval, document edits or file capabilities', async({ acde }) => {
  const page = await acde.open('marktext-dopame')
  await expect(page.getByRole('status')).toContainText('服务已连接')
  await expect(page.getByRole('heading', { name: '连接与授权', exact: true })).toBeVisible()
  await page.getByRole('textbox', { name: '调用方名称' }).fill('界面研究调用方')
  await page.getByRole('button', { name: '申请配对', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('请求保持待处理')
  await page.getByRole('button', { name: '查询配对批准', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('批准宿主尚未接通')
  const denied = await page.evaluate(`import('acde:fs').then(() => false, () => true)`)
  expect(denied).toBe(true)
  expect(await page.evaluate(`document.querySelectorAll('[contenteditable="true"]').length`)).toBe(0)
  await expect(page.getByRole('button', { name: '保存', exact: true })).toHaveCount(0)
  expect((await acde.console()).entries.filter(entry => entry.level === 'error')).toHaveLength(0)
})

test('preview navigation keeps real empty and disabled states at narrow widths', async({ acde }) => {
  const page = await acde.open('marktext-dopame')
  await expect(page.getByRole('status')).toContainText('服务已连接')
  const screenshots = process.env.MARKTEXT_REVIEW_SCREENSHOTS
  if (screenshots) {
    await mkdir(screenshots, { recursive: true })
    for (const width of [1440, 768, 390]) {
      await page.resize(width, 800)
      await page.screenshot({ path: join(screenshots, `collaboration-${width}.png`) })
    }
  }
  await page.resize(390, 720)
  await page.getByRole('button', { name: 'Agent 收件箱', exact: true }).click()
  await expect(page.getByRole('button', { name: '读取已授权文档', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: '建议面板', exact: true }).click()
  await expect(page.getByRole('region', { name: '建议列表', exact: true })).toContainText('先在收件箱读取文档')
  await page.getByRole('button', { name: '任务中心', exact: true }).click()
  await expect(page.getByRole('button', { name: '刷新任务与事件', exact: true })).toBeDisabled()
  expect(await page.evaluate(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true)
})
