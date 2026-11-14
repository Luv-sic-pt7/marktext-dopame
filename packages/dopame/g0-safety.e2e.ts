import { test, expect, type AppWindow } from 'acde/test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const sourceValue = `Array.from(document.querySelectorAll('.editor-panel'))
  .find(panel => getComputedStyle(panel).display !== 'none')
  .querySelector('.CodeMirror').CodeMirror.getValue()`

async function enterSource(app: AppWindow, text: string) {
  await app.getByRole('button', { name: '源码', exact: true }).click()
  await app.getByRole('textbox', { name: 'Markdown 源码' }).press('ctrl+a')
  await app.keyboard.insertText(text)
  await expect.poll(() => app.evaluate(sourceValue)).toBe(text)
}

test('close dialog traps focus, blocks background commands and restores source input', async({ app }) => {
  const window = app!
  await enterSource(window, 'keep this draft')
  await window.keyboard.press('ctrl+w')
  const cancel = window.getByRole('button', { name: '取消', exact: true })
  const save = window.getByRole('button', { name: '保存并关闭', exact: true })
  await expect(cancel).toBeFocused()
  await window.keyboard.press('shift+tab')
  await expect(save).toBeFocused()
  await window.keyboard.press('tab')
  await expect(cancel).toBeFocused()
  await window.keyboard.press('ctrl+n')
  await window.keyboard.press('Meta+s')
  await expect(window.getByRole('dialog')).toBeVisible()
  expect(await window.evaluate(sourceValue)).toBe('keep this draft')
  expect(await window.evaluate(`document.querySelectorAll('.tab').length`)).toBe(1)
  expect(await window.evaluate(`document.querySelector('.CodeMirror').CodeMirror.getOption('readOnly')`)).toBe('nocursor')
  await window.keyboard.press('Escape')
  await expect(window.getByRole('dialog')).toHaveCount(0)
  await expect(window.getByRole('textbox', { name: 'Markdown 源码' })).toBeFocused()
  await window.keyboard.insertText(' survives')
  await expect.poll(() => window.evaluate(sourceValue)).toBe('keep this draft survives')
})

test('file dialog blocks rich editor writes even if background focus is forced', async({ app }) => {
  const window = app!
  await window.locator('.mu-content').first().click()
  await window.keyboard.insertText('keep rich text')
  await window.getByRole('button', { name: '新建文件夹', exact: true }).click()
  await expect(window.getByRole('dialog')).toBeVisible()
  await window.evaluate(`document.querySelector('.mu-content').focus()`)
  await window.keyboard.insertText('should not enter the document')
  await window.getByRole('button', { name: '取消', exact: true }).click()
  await window.getByRole('button', { name: '源码', exact: true }).click()
  await expect.poll(() => window.evaluate(`${sourceValue}.trimEnd()`)).toBe('keep rich text')
})

test('save-and-close retains the authorized save path through the modal gate', async({ app, acde, home }) => {
  const window = app!
  await enterSource(window, 'saved before closing')
  await window.keyboard.press('ctrl+w')
  const target = join(home, 'saved-close.md')
  await acde.chooseSaveFile(target)
  await window.getByRole('button', { name: '保存并关闭', exact: true }).click()
  await expect(window.getByRole('dialog')).toHaveCount(0)
  expect(await readFile(target, 'utf8')).toBe('saved before closing')
  await expect(window.getByRole('tab')).toHaveCount(1)
  expect(await window.evaluate(sourceValue)).toBe('')
})

for (const sequence of ['end-only', 'cancelled', 'end-then-input']) {
  test(`composition ${sequence} preserves input and releases the command gate`, async({ app }) => {
    const window = app!
    await window.locator('.mu-content').first().click()
    await window.keyboard.insertText('committed')
    await window.evaluate(`document.querySelector('.mu-content').dispatchEvent(new Event('compositionstart', {bubbles:true}))`)
    await window.getByRole('button', { name: '源码', exact: true }).click()
    await expect(window.getByRole('button', { name: '编辑', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await window.keyboard.press('ctrl+w')
    await expect(window.getByRole('dialog')).toHaveCount(0)
    await window.evaluate(`(() => {
      const content = document.querySelector('.mu-content');
      const end = new Event('compositionend', {bubbles:true});
      Object.defineProperty(end, 'data', {value:${JSON.stringify(sequence === 'cancelled' ? '' : 'committed')}});
      content.dispatchEvent(end);
      ${sequence === 'end-then-input' ? "content.dispatchEvent(new InputEvent('input', {bubbles:true, inputType:'insertText', data:'committed', isComposing:false}));" : ''}
    })()`)
    await window.getByRole('button', { name: '源码', exact: true }).click()
    await expect.poll(() => window.evaluate(`${sourceValue}.trimEnd()`)).toBe('committed')
  })
}

test('malformed version-one session remains untouched after editing and reload', async({ app }) => {
  const window = app!
  const raw = JSON.stringify({ version: 1, activeId: 'broken', tabs: [{ id: 'broken', text: 'irreplaceable' }] })
  await window.evaluate(`import('acde:fs').then(({fs}) => fs.writeFile('private', '.marktext/session.json', ${JSON.stringify(raw)}, {mkdirs:true}))`)
  await window.reload()
  await expect(window.getByRole('alert')).toContainText('原记录未覆盖')
  await enterSource(window, 'fresh draft')
  await window.keyboard.press('ctrl+n')
  await expect.poll(() => window.evaluate(`import('acde:fs').then(({fs}) => fs.readText('private', '.marktext/session.json')).then(f => f.text)`)).toBe(raw)
  await window.reload()
  await expect(window.getByRole('alert')).toContainText('原记录未覆盖')
})
