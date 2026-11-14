import { test, expect, type AppWindow } from 'acde/test'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'

const value = `Array.from(document.querySelectorAll('.editor-panel')).find(p => getComputedStyle(p).display !== 'none').querySelector('.CodeMirror').CodeMirror.getValue()`
async function source(app: AppWindow, text: string) {
  await expect(app.getByRole('button', { name: '源码', exact: true })).toBeEnabled()
  await app.getByRole('button', { name: '源码', exact: true }).click()
  await app.getByRole('textbox', { name: 'Markdown 源码' }).press('ctrl+a')
  await app.keyboard.insertText(text)
}
async function richSelection(app: AppWindow) {
  await app.evaluate(`(() => {
    const content = document.querySelector('.mu-content'); content.focus();
    const range = document.createRange(); range.selectNodeContents(content);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
  })()`)
}

test('Save As creates a new target and subsequent saves use it', async({ app, acde, home }) => {
  await source(app, '# new target')
  const path = join(home, 'new.md')
  await acde.chooseSaveFile(path)
  await app.keyboard.press('Meta+Shift+s')
  await expect(app.getByRole('tab', { name: 'new.md', exact: true })).toBeVisible()
  expect(await readFile(path, 'utf8')).toBe('# new target')
  await app.keyboard.insertText(' continued')
  await app.keyboard.press('Meta+s')
  await expect.poll(() => readFile(path, 'utf8')).toBe('# new target continued')
})

test('unknown draft version survives reload and editing', async({ app }) => {
  const raw = JSON.stringify({ version: 2, tabs: [{ text: 'irreplaceable' }] })
  await app.evaluate(`import('acde:fs').then(({fs}) => fs.writeFile('private', '.marktext/session.json', ${JSON.stringify(raw)}, {mkdirs:true}))`)
  await app.reload()
  await expect(app.getByRole('alert')).toContainText('原记录未覆盖')
  await source(app, 'fresh text')
  await app.keyboard.press('ctrl+n')
  await new Promise(resolve => setTimeout(resolve, 800))
  expect(await app.evaluate(`import('acde:fs').then(({fs}) => fs.readText('private', '.marktext/session.json')).then(f => f.text)`)).toBe(raw)
})

for (const modifier of ['ctrl', 'Meta']) {
  for (const mode of ['源码', '编辑']) {
    test(`${modifier} undo and redo in ${mode}`, async({ app }) => {
      if (mode === '源码') {
        await expect(app.getByRole('button', { name: mode, exact: true })).toBeEnabled()
        await app.getByRole('button', { name: mode, exact: true }).click()
      }
      else await app.locator('.mu-content').first().click()
      await app.keyboard.insertText('History text')
      if (mode === '源码') await expect.poll(() => app.evaluate(value)).toBe('History text')
      else await expect(app.getByRole('textbox', { name: 'Markdown 编辑器' })).toContainText('History text')
      await app.keyboard.press(`${modifier}+z`)
      if (mode === '源码') await expect.poll(() => app.evaluate(value)).toBe('')
      else await expect(app.getByRole('textbox', { name: 'Markdown 编辑器' })).not.toContainText('History text')
      await app.keyboard.press(`${modifier}+shift+z`)
      if (mode === '源码') await expect.poll(() => app.evaluate(value)).toBe('History text')
      else await expect(app.getByRole('textbox', { name: 'Markdown 编辑器' })).toContainText('History text')
    })
  }
  for (const [key, expected] of [['h', '<mark>word</mark>'], ['e', '$word$'], ['i', '![word]'], ['r', 'word']]) {
    test(`${modifier} shift ${key} format`, async({ app }) => {
      await source(app, key === 'r' ? '**word**' : 'word')
      await app.getByRole('button', { name: '编辑', exact: true }).click()
      await richSelection(app)
      await app.keyboard.press(`${modifier}+shift+${key}`)
      await expect(app.getByRole('button', { name: '源码', exact: true })).toBeEnabled()
      await app.getByRole('button', { name: '源码', exact: true }).click()
      const actual = await app.evaluate(value)
      if (key === 'r') expect(actual.trim()).toBe('word')
      else expect(actual).toContain(expected)
    })
  }
  test(`${modifier} heading accepts following input and mode shortcut never saves`, async({ app }) => {
    await app.locator('.mu-content').first().click()
    await app.keyboard.press(`${modifier}+1`)
    await app.keyboard.insertText('Heading')
    await app.keyboard.press(`${modifier}+alt+s`)
    await expect.poll(() => app.evaluate(value)).toContain('# Heading')
    await expect(app.getByRole('button', { name: '源码', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(app.getByRole('alert')).toHaveCount(0)
  })
}

test('close modal blocks new-tab and save shortcuts', async({ app }) => {
  await source(app, 'keep me')
  await app.keyboard.press('ctrl+w')
  await expect(app.getByRole('dialog')).toBeVisible()
  await app.keyboard.press('ctrl+n')
  await app.keyboard.press('Meta+t')
  await expect(app.getByRole('tab')).toHaveCount(0)
  await app.getByRole('button', { name: '取消', exact: true }).click()
  await expect(app.getByRole('tab')).toHaveCount(1)
  await expect.poll(() => app.evaluate(value)).toBe('keep me')
})

test('Setext and long fences preserve heading source positions', async({ app }) => {
  await source(app, 'Title\n=====\n\n````md\n```\n# fake\n````\n\n## Real')
  await app.getByRole('button', { name: 'Title', exact: true }).click()
  await expect.poll(() => app.evaluate(value.replace('.getValue()', '.getCursor().line'))).toBe(0)
  await app.getByRole('button', { name: 'Real', exact: true }).click()
  await expect.poll(() => app.evaluate(value.replace('.getValue()', '.getCursor().line'))).toBe(8)
  await expect(app.getByRole('button', { name: 'fake', exact: true })).toHaveCount(0)
})

test('authorized relative image, light text and cross-entry identity', async({ app, acde, home }) => {
  const dir = join(home, 'project'); await mkdir(dir)
  await writeFile(join(dir, 'same.md'), '# Title\n\n**bold**\n\n![pixel](pixel.png)')
  await writeFile(join(dir, 'pixel.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAEAAAAAwCAIAAAAuKetIAAAAfklEQVR4nO3PMQ3AMAADwWAqsjLoEE5lUF4lEA+ZPpZe8viDb8zvXe567uVO68dphwTQhwTQhwTQh7YBLUdTL4DuBdC9ALrvB7QcTb0AuhdA9wLovh/QcjT1AuheAN0LoPt+QMvR1AugewF0L4Du+wEtR1MvgO4F0L0Auq8H/Mmquw8Z9B88AAAAAElFTkSuQmCC', 'base64'))
  await acde.chooseFolder(dir)
  await app.getByRole('button', { name: '添加文件夹', exact: true }).click()
  await app.getByRole('button', { name: /≡same.md/ }).click()
  await app.getByRole('button', { name: '阅读', exact: true }).click()
  await expect.poll(() => app.evaluate(`Array.from(document.querySelectorAll('.mu-image-success img')).some(i => i.complete && i.naturalWidth === 64)`)).toBe(true)
  expect(await app.evaluate(`getComputedStyle(document.querySelector('.mu-atx-heading')).color`)).not.toBe('rgba(255, 255, 255, 0.8)')
  await expect(app.locator('.mu-image-success img')).toBeVisible()
  if (process.env.MARKTEXT_SHOTS) await app.screenshot({ path: join(process.env.MARKTEXT_SHOTS, 'develop-light-image.png') })
  await app.getByRole('button', { name: '切换主题', exact: true }).click()
  if (process.env.MARKTEXT_SHOTS) await app.screenshot({ path: join(process.env.MARKTEXT_SHOTS, 'develop-dark-image.png') })
  await app.getByRole('button', { name: '切换主题', exact: true }).click()
  await expect.poll(() => app.evaluate(`import('acde:fs').then(({fs}) => fs.readText('private', '.marktext/session.json')).then(f => JSON.parse(f.text).tabs.some(t => t.name === 'same.md' && t.mode === 'read'))`)).toBe(true)
  await app.reload()
  await expect(app.getByRole('tab', { name: 'same.md', exact: true })).toBeVisible()
  await acde.chooseFolder(dir)
  await app.getByRole('button', { name: '添加文件夹', exact: true }).click()
  await acde.chooseFiles(join(dir, 'same.md'))
  await app.keyboard.press('ctrl+o')
  await expect(app.getByRole('tab', { name: 'same.md', exact: true })).toHaveCount(1)
  expect((await acde.console()).entries.filter(e => e.level === 'error')).toHaveLength(0)
})


test('block shortcuts preserve continuous text entry', async({ app }) => {
  await app.locator('.mu-content').first().click()
  await app.keyboard.press('ctrl+alt+q')
  await app.keyboard.insertText('quoted text')
  await app.keyboard.press('ctrl+e')
  await expect.poll(() => app.evaluate(value)).toContain('> quoted text')
})
