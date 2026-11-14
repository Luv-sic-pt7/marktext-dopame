import { test, expect, type AppWindow } from 'acde/test'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { clickCommand } from './command-helpers'

const evidence =
  process.env.MARKTEXT_EVIDENCE ??
  resolve(import.meta.dir, '../../../../../work/marktext-mvp-evidence')
mkdirSync(evidence, { recursive: true })

const sourceText = (app: AppWindow) =>
  app.evaluate<string>('document.querySelector(".CodeMirror").CodeMirror.getValue()')

function luminance(color: string) {
  const channels = color
    .match(/[\d.]+/g)!
    .slice(0, 3)
    .map(Number)
  const linear = channels.map((channel) => {
    const value = channel / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722
}

test('command menus stay legible in both themes and keep keyboard focus and viewport bounds', async ({
  acde
}) => {
  await acde.open('marktext-dopame')
  const app = acde.window('marktext-dopame')
  await app.getByRole('button', { name: '新建', exact: true }).click()
  await app.keyboard.insertText('菜单交互 中文😀')
  const trigger = app.getByRole('button', { name: '段落类型', exact: true })
  const menu = app.getByRole('menu', { name: '段落类型', exact: true })
  await expect(app.locator('select.paragraph-menu')).toHaveCount(0)
  await trigger.press('ArrowDown')
  await expect(menu.getByRole('menuitem', { name: '正文', exact: true })).toBeFocused()
  await app.keyboard.press('End')
  await expect(menu.getByRole('menuitem', { name: '减少缩进', exact: true })).toBeFocused()
  await app.keyboard.press('Home')
  await expect(menu.getByRole('menuitem', { name: '正文', exact: true })).toBeFocused()
  await app.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(trigger).toBeFocused()
  await trigger.press('Enter')
  await expect(menu.getByRole('menuitem', { name: '正文', exact: true })).toBeFocused()
  await app.keyboard.press('Tab')
  await expect(menu).toHaveCount(0)
  await expect(app.getByRole('button', { name: '格式', exact: true })).toBeFocused()

  await app.keyboard.press('ctrl+f')
  const find = app.getByRole('textbox', { name: '查找文本', exact: true })
  await expect(find).toBeFocused()
  await trigger.click()
  await app.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(find).toBeVisible()
  await expect(trigger).toBeFocused()
  await app.keyboard.press('Escape')
  await expect(find).toHaveCount(0)
  await expect
    .poll(() =>
      app.evaluate('document.querySelector(".mu-editor").contains(document.activeElement)')
    )
    .toBe(true)
  await trigger.press('ArrowDown')
  await app.keyboard.press('ctrl+f')
  await expect(menu).toHaveCount(0)
  await expect(find).toBeFocused()
  await app.keyboard.press('Escape')
  await expect(find).toHaveCount(0)

  for (const theme of ['light', 'dark']) {
    await app.resize(1440, 900)
    if (theme === 'dark') await app.getByRole('button', { name: '深色主题', exact: true }).click()
    expect(await app.evaluate<string>('document.documentElement.dataset.theme')).toBe(theme)
    for (const width of [1440, 768, 390]) {
      await app.resize(width, 900)
      await trigger.click()
      await expect(menu).toBeVisible()
      const styles = await menu.evaluate((element) =>
        Array.from(element.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).map(
          (button) => {
            const style = getComputedStyle(button)
            return {
              name: button.getAttribute('aria-label'),
              color: style.color,
              background: style.backgroundColor,
              disabled: button.disabled
            }
          }
        )
      )
      expect(styles.map((style) => style.name)).toContain('引用')
      expect(styles.map((style) => style.name)).toContain('任务列表')
      for (const style of styles.filter((item) => !item.disabled)) {
        const foreground = luminance(style.color)
        const background = luminance(style.background)
        expect(
          (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05)
        ).toBeGreaterThanOrEqual(4.5)
      }
      expect(
        await menu.evaluate((element) => {
          const rect = element.getBoundingClientRect()
          return (
            rect.left >= 0 &&
            rect.right <= innerWidth + 1 &&
            rect.top >= 0 &&
            rect.bottom <= innerHeight + 1
          )
        })
      ).toBe(true)
      expect(
        await app.evaluate<boolean>('document.documentElement.scrollWidth <= innerWidth + 1')
      ).toBe(true)
      await app.screenshot({ path: join(evidence, `native-command-menu-${theme}-${width}.png`) })
      await app.keyboard.press('Escape')
    }
  }
  await app.resize(1440, 900)
  await trigger.click()
  await app.getByRole('button', { name: '格式', exact: true }).click()
  await expect(menu).toHaveCount(0)
  await expect(app.locator('.command-popup')).toHaveCount(1)
  await app.keyboard.press('Escape')
  await app.getByRole('button', { name: '预览', exact: true }).click()
  for (const label of ['段落类型', '格式', '插入'])
    await expect(app.getByRole('button', { name: label, exact: true })).toBeDisabled()
  expect((await app.console({ level: 'errors' })).entries).toEqual([])
  expect((await app.network({ failed: true })).entries).toEqual([])
})

test('paragraph menus convert heading levels and insert an undoable thematic break without losing text', async ({
  acde
}) => {
  await acde.open('marktext-dopame')
  const app = acde.window('marktext-dopame')
  const text = '标题转换 中文😀'
  const labels = ['二级标题', '三级标题', '四级标题', '五级标题', '六级标题']
  await app.getByRole('button', { name: '新建', exact: true }).click()
  await app.keyboard.insertText(text)
  await expect(app.locator('.mu-editor p.mu-paragraph')).toHaveText(text)
  for (const [index, label] of labels.entries()) {
    const level = index + 2
    await clickCommand(app, '段落类型', label)
    await expect(app.locator(`.mu-editor h${level}`)).toContainText(text)
    await app.getByRole('button', { name: '源码', exact: true }).click()
    expect((await sourceText(app)).trimEnd()).toBe('#'.repeat(level) + ' ' + text)
    await app.getByRole('button', { name: '富文本', exact: true }).click()
  }
  await clickCommand(app, '段落类型', '正文')
  await expect(app.locator('.mu-editor p.mu-paragraph')).toHaveText(text)
  await clickCommand(app, '插入', '分隔线')
  await expect(app.locator('.mu-editor .mu-thematic-break')).toHaveCount(1)
  await expect(app.locator('.mu-editor p.mu-paragraph').first()).toHaveText(text)
  await app.getByRole('button', { name: '撤销', exact: true }).click()
  await expect(app.locator('.mu-editor .mu-thematic-break')).toHaveCount(0)
  await expect(app.locator('.mu-editor p.mu-paragraph')).toHaveText(text)
  await app.getByRole('button', { name: '重做', exact: true }).click()
  await expect(app.locator('.mu-editor .mu-thematic-break')).toHaveCount(1)
  await app.getByRole('button', { name: '源码', exact: true }).click()
  const saved = await sourceText(app)
  expect(saved).toContain(text)
  expect(/\n\n(?:---|\*\*\*|___)\n/.test(saved)).toBe(true)
  await app.getByRole('button', { name: '保存', exact: true }).click()
  await expect(app.locator('.statusbar')).toContainText('已保存')
  expect(
    await app.evaluate<string>(
      '(async()=>{const {fs}=await import("acde:fs");const list=await fs.list("private","notes");return (await fs.readText("private","notes/"+list.entries[0].name)).text})()'
    )
  ).toBe(saved)
  await app.getByRole('button', { name: '预览', exact: true }).click()
  await expect(app.locator('.mu-editor .mu-thematic-break')).toHaveCount(1)
  await app.getByRole('button', { name: '源码', exact: true }).click()
  expect(await sourceText(app)).toBe(saved)
  expect((await app.console({ level: 'errors' })).entries).toEqual([])
  expect((await app.network({ failed: true })).entries).toEqual([])
})
