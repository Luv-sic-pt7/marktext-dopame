import { test, expect, type AppWindow } from 'acde/test'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const evidence =
  process.env.MARKTEXT_EVIDENCE ??
  resolve(import.meta.dir, '../../../../../work/marktext-mvp-evidence')
mkdirSync(evidence, { recursive: true })

async function selectParagraph(app: AppWindow) {
  await app.locator('.mu-editor .mu-content[contenteditable="true"]').first().click()
  await app.keyboard.press('End')
  await app.keyboard.press('ctrl+a')
  await expect(app.getByRole('toolbar', { name: '选区格式', exact: true })).toBeVisible()
}

async function createText(app: AppWindow, text: string) {
  await app.getByRole('button', { name: '新建', exact: true }).click()
  await app.getByRole('button', { name: '源码', exact: true }).click()
  await app.getByRole('textbox', { name: 'Markdown 源码', exact: true }).type(text)
  await app.getByRole('button', { name: '富文本', exact: true }).click()
}

test('selected text exposes visible format glyphs and a toolbar format undoes independently of typing', async ({
  acde
}) => {
  await acde.open('marktext-dopame')
  const app = acde.window('marktext-dopame')
  await createText(app, '浮条文字')
  await app.locator('.mu-editor .mu-content[contenteditable="true"]').first().click()
  await app.keyboard.press('End')
  await app.keyboard.insertText(' 中文😀')
  const original = '浮条文字 中文😀'
  await selectParagraph(app)
  const toolbar = app.getByRole('toolbar', { name: '选区格式', exact: true })
  for (const name of [
    '选区加粗',
    '选区斜体',
    '选区下划线',
    '选区删除线',
    '选区高亮',
    '选区行内代码',
    '选区行内公式',
    '选区链接',
    '选区图片',
    '选区清除格式'
  ])
    await expect(toolbar.getByRole('button', { name, exact: true })).toBeVisible()
  expect(
    await toolbar
      .getByRole('button', { name: '选区加粗', exact: true })
      .locator('.dopame-inline-glyph')
      .evaluate((element) => element.textContent)
  ).toBe('B')
  expect(
    await toolbar
      .getByRole('button', { name: '选区删除线', exact: true })
      .locator('.dopame-inline-glyph')
      .evaluate((element) => element.textContent)
  ).toBe('S')
  expect(
    await toolbar
      .getByRole('button', { name: '选区行内代码', exact: true })
      .locator('svg')
      .evaluate((element) => {
        const rect = element.getBoundingClientRect()
        const button = element.closest('[role="button"]')!.getBoundingClientRect()
        return (
          rect.width >= 16 &&
          rect.height >= 16 &&
          rect.left >= button.left &&
          rect.right <= button.right
        )
      })
  ).toBe(true)
  await app.screenshot({ path: join(evidence, 'native-inline-toolbar-light.png') })
  await toolbar.getByRole('button', { name: '选区加粗', exact: true }).click()
  await expect(app.locator('.mu-editor strong')).toContainText(original)
  expect(await app.evaluate<string>('getSelection()?.toString() ?? ""')).toContain(original)
  await app.getByRole('button', { name: '撤销', exact: true }).click()
  await expect(app.locator('.mu-editor strong')).toHaveCount(0)
  await expect(app.locator('.mu-editor p.mu-paragraph')).toHaveText(original)
  await app.getByRole('button', { name: '重做', exact: true }).click()
  await expect(app.locator('.mu-editor strong')).toContainText(original)
  await app.getByRole('button', { name: '源码', exact: true }).click()
  expect(
    (
      await app.evaluate<string>('document.querySelector(".CodeMirror").CodeMirror.getValue()')
    ).trimEnd()
  ).toBe('**' + original + '**')
  await app.getByRole('button', { name: '预览', exact: true }).click()
  await expect(toolbar).toHaveCount(0)
  expect((await app.console({ level: 'errors' })).entries).toEqual([])
  expect((await app.network({ failed: true })).entries).toEqual([])
})

test('the selection toolbar keeps its colours, palette and viewport position in dark and narrow layouts', async ({
  acde
}) => {
  await acde.open('marktext-dopame')
  const app = acde.window('marktext-dopame')
  await createText(app, '颜色与工具条 中文😀')
  await app.getByRole('button', { name: '深色主题', exact: true }).click()
  await selectParagraph(app)
  const toolbar = app.getByRole('toolbar', { name: '选区格式', exact: true })
  expect(
    await toolbar
      .getByRole('button', { name: '选区加粗', exact: true })
      .locator('.dopame-inline-glyph')
      .evaluate((element) => element.textContent)
  ).toBe('B')
  await app.screenshot({ path: join(evidence, 'native-inline-toolbar-dark.png') })
  await toolbar.getByRole('button', { name: '选区文字和背景颜色', exact: true }).click()
  const palette = toolbar.getByRole('dialog', { name: '选区颜色设置', exact: true })
  await expect(palette).toBeVisible()
  await expect(
    palette.getByRole('button', { name: '选区文字颜色 红色', exact: true })
  ).toBeVisible()
  await palette.getByRole('button', { name: '选区文字颜色 红色', exact: true }).click()
  await expect
    .poll(() =>
      app.evaluate<boolean>(
        'Array.from(document.querySelectorAll(".mu-editor span")).some(element => getComputedStyle(element).color === "rgb(230, 67, 64)" && element.textContent.includes("颜色与工具条 中文😀"))'
      )
    )
    .toBe(true)
  await app.getByRole('button', { name: '源码', exact: true }).click()
  expect(
    await app.evaluate<string>('document.querySelector(".CodeMirror").CodeMirror.getValue()')
  ).toContain('color:#e64340')
  await app.getByRole('button', { name: '富文本', exact: true }).click()
  await selectParagraph(app)
  await app.resize(390, 800)
  await expect(toolbar).toBeVisible()
  expect(
    await toolbar.evaluate((element) => {
      const rect = element.getBoundingClientRect()
      return (
        rect.left >= 0 &&
        rect.right <= innerWidth + 1 &&
        rect.top >= 0 &&
        rect.bottom <= innerHeight + 1
      )
    })
  ).toBe(true)
  await app.screenshot({ path: join(evidence, 'native-inline-toolbar-dark-390.png') })
  expect((await app.console({ level: 'errors' })).entries).toEqual([])
  expect((await app.network({ failed: true })).entries).toEqual([])
})
