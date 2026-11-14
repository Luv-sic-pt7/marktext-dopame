import { test, expect, type AppWindow } from 'acde/test'
import { Png } from 'acde/driver'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { clickCommand } from './command-helpers'

const evidence =
  process.env.MARKTEXT_EVIDENCE ??
  resolve(import.meta.dir, '../../../../../work/marktext-mvp-evidence')
mkdirSync(evidence, { recursive: true })

interface CaretGeometry {
  editableFocused: boolean
  collapsed: boolean
  x: number
  y: number
  height: number
  viewportWidth: number
  viewportHeight: number
  color: string
}

const caretGeometry = (app: AppWindow) =>
  app.evaluate<CaretGeometry>(
    '(()=>{const selection=getSelection(),range=selection?.rangeCount?selection.getRangeAt(0):null,rect=range?.getBoundingClientRect(),active=document.activeElement,style=active?getComputedStyle(active):null;return {editableFocused:!!active?.matches(".mu-editor[contenteditable=true],.mu-editor .mu-content[contenteditable=true]"),collapsed:!!selection?.isCollapsed,x:rect?.x??0,y:rect?.y??0,height:rect?.height??0,viewportWidth:innerWidth,viewportHeight:innerHeight,color:style?.caretColor==="auto"?style.color:style?.caretColor??""}})()'
  )

function rgb(color: string): number[] {
  const decimal = color.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/)
  if (decimal) return decimal.slice(1, 4).map(Number)
  const hex = /^#([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(color)
  if (hex) return hex.slice(1).map((value) => parseInt(value, 16))
  throw new Error('Caret colour was not resolved: ' + color)
}

async function visibleCaret(app: AppWindow, name: string) {
  await expect
    .poll(async () => {
      const geometry = await caretGeometry(app)
      return geometry.editableFocused && geometry.collapsed && geometry.height >= 10
    })
    .toBe(true)
  const observations: unknown[] = []
  // Native caret blinking is independent of page timers; inspect several physical frames.
  for (let frame = 0; frame < 7; frame++) {
    const geometry = await caretGeometry(app)
    const capture = await app.capture()
    const { image, scale } = capture
    const target = rgb(geometry.color)
    const insetX = (image.width - geometry.viewportWidth * scale) / 2
    const insetY = image.height - geometry.viewportHeight * scale
    const x = geometry.x * scale + insetX
    const top = Math.max(0, Math.floor(geometry.y * scale + insetY) + 1)
    const bottom = Math.min(
      image.height,
      Math.ceil((geometry.y + geometry.height) * scale + insetY) - 1
    )
    let longest = 0
    for (
      let column = Math.max(0, Math.floor(x) - 2);
      column <= Math.min(image.width - 1, Math.ceil(x) + 2);
      column++
    ) {
      let run = 0
      for (let row = top; row < bottom; row++) {
        const pixel = (row * image.width + column) * 4
        const ink = target.every(
          (channel, index) => Math.abs(image.data[pixel + index] - channel) < 45
        )
        run = ink ? run + 1 : 0
        longest = Math.max(longest, run)
      }
    }
    observations.push({ frame, geometry, longest, scale })
    if (longest >= Math.max(8, Math.floor((bottom - top) * 0.55))) {
      await Bun.write(join(evidence, name + '.png'), Png.encode(image))
      await Bun.write(join(evidence, name + '.json'), JSON.stringify(observations, null, 2))
      return
    }
    if (frame < 6) await Bun.sleep(120)
  }
  await Bun.write(join(evidence, name + '.json'), JSON.stringify(observations, null, 2))
  await app.screenshot({ path: join(evidence, name + '-missing.png') })
  throw new Error('No visible native caret stroke found; see ' + name + '.json')
}

const sourceText = (app: AppWindow) =>
  app.evaluate<string>('document.querySelector(".CodeMirror").CodeMirror.getValue()')

test('new documents, mode changes and tab activation restore a visible native caret', async ({
  acde
}) => {
  await acde.open('marktext-dopame')
  const app = acde.window('marktext-dopame')
  await app.getByRole('button', { name: '新建', exact: true }).click()
  await visibleCaret(app, 'native-caret-empty-document')
  await app.keyboard.insertText('第一篇光标 ·  ')
  await visibleCaret(app, 'native-caret-new-document')
  await app.getByRole('button', { name: '源码', exact: true }).click()
  await expect(app.getByRole('textbox', { name: 'Markdown 源码', exact: true })).toBeFocused()
  expect(await sourceText(app)).toContain('第一篇光标 ·')
  await app.getByRole('button', { name: '富文本', exact: true }).click()
  await visibleCaret(app, 'native-caret-rich-mode')
  await app.getByRole('button', { name: '新建', exact: true }).click()
  await app.keyboard.insertText('第二篇光标 ·  ')
  await visibleCaret(app, 'native-caret-second-document')
  await app.getByRole('tab').first().click()
  await visibleCaret(app, 'native-caret-tab-activation')
  await app.keyboard.insertText('甲')
  await app.getByRole('button', { name: '源码', exact: true }).click()
  expect(await sourceText(app)).toContain('第一篇光标')
  expect(await sourceText(app)).toContain('甲')
  expect(await sourceText(app)).not.toContain('第二篇光标')
  expect((await app.console({ level: 'errors' })).entries).toEqual([])
})

test('opening a document and applying or undoing formatting restores the editable caret', async ({
  acde,
  home
}) => {
  const path = join(home, '光标打开验收.md')
  await Bun.write(path, '打开文档光标 ·  ')
  await acde.open('marktext-dopame')
  const app = acde.window('marktext-dopame')
  await acde.chooseFiles(path)
  await app.getByRole('button', { name: '导入文件', exact: true }).first().click()
  await app.keyboard.press('End')
  await visibleCaret(app, 'native-caret-open-document')
  await app.keyboard.press('Home')
  await app.keyboard.press('shift+arrowright')
  await app.keyboard.press('shift+arrowright')
  await clickCommand(app, '格式', '加粗')
  await app.keyboard.press('arrowright')
  await app.keyboard.press('End')
  await app.keyboard.insertText('续写 ·  ')
  await expect(app.locator('.mu-editor strong')).toHaveText('打开')
  await visibleCaret(app, 'native-caret-after-format')
  await app.locator('.format-toolbar').getByRole('button', { name: '撤销', exact: true }).click()
  await expect.poll(async () => (await caretGeometry(app)).editableFocused).toBe(true)
  await app.locator('.format-toolbar').getByRole('button', { name: '重做', exact: true }).click()
  await app.keyboard.press('End')
  await visibleCaret(app, 'native-caret-after-redo')
  await app.getByRole('button', { name: '深色主题', exact: true }).click()
  await app.locator('.mu-editor .mu-content[contenteditable="true"]').first().click()
  await app.keyboard.press('End')
  await visibleCaret(app, 'native-caret-dark-theme')
  expect((await app.console({ level: 'errors' })).entries).toEqual([])
})

test('editor focus restoration leaves search, title and code-language fields in control', async ({
  acde
}) => {
  await acde.open('marktext-dopame')
  const app = acde.window('marktext-dopame')
  await app.getByRole('button', { name: '新建', exact: true }).click()
  await app.keyboard.insertText('正文内容')
  await app.keyboard.press('ctrl+f')
  const find = app.getByRole('textbox', { name: '查找文本', exact: true })
  await find.fill('正文')
  await find.press('Enter')
  await expect(find).toBeFocused()
  await expect(app.locator('.native-rich-caret')).toBeHidden()
  await find.press('Escape')
  const title = app.getByRole('textbox', { name: '笔记标题', exact: true })
  await title.fill('焦点验收')
  await expect(title).toBeFocused()
  await expect(app.locator('.native-rich-caret')).toBeHidden()
  await title.type('新题')
  await expect(title).toHaveValue('焦点验收新题')
  await app.getByRole('button', { name: '源码', exact: true }).click()
  const source = app.getByRole('textbox', { name: 'Markdown 源码', exact: true })
  await source.press('ctrl+a')
  await source.type('```js\nconst answer = 42\n```\n')
  await app.getByRole('button', { name: '富文本', exact: true }).click()
  await app.locator('pre.mu-code-block').hover()
  const language = app.getByRole('textbox', { name: '代码语言', exact: true })
  await language.fill('py')
  await expect(language).toBeFocused()
  await expect(language).toHaveValue('py')
  await expect(app.locator('.native-rich-caret')).toBeHidden()
  expect((await app.console({ level: 'errors' })).entries).toEqual([])
})

test('range caret follows movement and scroll and hides for selection, preview and inactive windows', async ({
  acde
}) => {
  await acde.open('marktext-dopame')
  const app = acde.window('marktext-dopame')
  await app.getByRole('button', { name: '新建', exact: true }).click()
  await app.getByRole('button', { name: '源码', exact: true }).click()
  const markdown =
    Array.from({ length: 40 }, (_, index) => `段落 ${index + 1}：滚动内容。`).join('\n\n') +
    '\n\n末尾光标 ·  '
  await app.getByRole('textbox', { name: 'Markdown 源码', exact: true }).type(markdown)
  await app.getByRole('button', { name: '富文本', exact: true }).click()
  const tail = app
    .locator('.mu-editor .mu-content[contenteditable="true"]')
    .filter({ hasText: '末尾光标' })
  await tail.click()
  await app.keyboard.press('End')
  await visibleCaret(app, 'native-caret-scroll-end')
  const right = (await caretGeometry(app)).x
  await app.keyboard.press('arrowleft')
  await visibleCaret(app, 'native-caret-arrow-move')
  expect((await caretGeometry(app)).x).toBeLessThan(right)
  await app.keyboard.press('shift+arrowleft')
  await expect(app.locator('.native-rich-caret')).toBeHidden()
  await app.keyboard.press('arrowright')
  await visibleCaret(app, 'native-caret-collapse-selection')
  await app.locator('.rich-host').scroll(-400)
  await expect(app.locator('.native-rich-caret')).toBeHidden()
  await tail.click()
  await app.keyboard.press('End')
  await visibleCaret(app, 'native-caret-scroll-return')
  await app.minimize()
  await expect
    .poll(() => app.evaluate<boolean>('document.querySelector(".native-rich-caret").hidden'))
    .toBe(true)
  await app.restore()
  await visibleCaret(app, 'native-caret-window-reactivate')
  await app.getByRole('button', { name: '预览', exact: true }).click()
  await expect(app.locator('.native-rich-caret')).toBeHidden()
  await app.getByRole('button', { name: '源码', exact: true }).click()
  expect((await sourceText(app)).trimEnd()).toBe(markdown.trimEnd())
  expect((await app.console({ level: 'errors' })).entries).toEqual([])
})
