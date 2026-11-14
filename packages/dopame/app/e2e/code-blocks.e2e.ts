import { test, expect, type AppWindow } from 'acde/test'
import { mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const evidence =
  process.env.MARKTEXT_EVIDENCE ??
  resolve(import.meta.dir, '../../../../../work/marktext-mvp-evidence')
mkdirSync(evidence, { recursive: true })

const sourceText = (app: AppWindow) =>
  app.evaluate<string>('document.querySelector(".CodeMirror").CodeMirror.getValue()')

async function createSource(app: AppWindow, text: string) {
  await app.getByRole('button', { name: '新建', exact: true }).click()
  await app.getByRole('button', { name: '源码', exact: true }).click()
  await app.getByRole('textbox', { name: 'Markdown 源码', exact: true }).type(text)
}

test('source code-block insertion preserves selected Unicode and embedded fences as one undo step', async ({
  acde
}) => {
  await acde.open('marktext-dopame')
  const app = acde.window('marktext-dopame')
  const original = 'const value = "中文 😀";\nconst fence = "```";'
  await createSource(app, original)
  await app.getByRole('textbox', { name: 'Markdown 源码', exact: true }).press('ctrl+a')
  const insert = app.getByRole('button', { name: '代码块', exact: true })
  await insert.click()
  await expect.poll(() => sourceText(app)).toBe('````\n' + original + '\n````')
  await app.getByRole('button', { name: '撤销', exact: true }).click()
  await expect.poll(() => sourceText(app)).toBe(original)
  await app.getByRole('button', { name: '重做', exact: true }).click()
  await app.getByRole('button', { name: '富文本', exact: true }).click()
  await expect(app.locator('pre.mu-code-block')).toHaveCount(1)
  await expect(app.getByRole('textbox', { name: '代码正文', exact: true })).toHaveText(original)
  await app.getByRole('button', { name: '预览', exact: true }).click()
  await expect(insert).toBeDisabled()
  await app.getByRole('button', { name: '源码', exact: true }).click()
  expect(await sourceText(app)).toBe('````\n' + original + '\n````')
  expect((await app.console({ level: 'errors' })).entries).toEqual([])
  expect((await app.network({ failed: true })).entries).toEqual([])
})

test('rich code blocks accept language suggestions, continued input and a saved Markdown round trip', async ({
  acde,
  home
}) => {
  await acde.open('marktext-dopame')
  const app = acde.window('marktext-dopame')
  const paragraph = '代码示例：'
  const original = 'const value = "中文 😀";'
  await createSource(app, paragraph)
  await app.getByRole('button', { name: '富文本', exact: true }).click()
  await app.locator('.mu-editor p.mu-paragraph').click()
  await app.getByRole('button', { name: '代码块', exact: true }).click()
  const body = app.getByRole('textbox', { name: '代码正文', exact: true })
  await expect(app.locator('.mu-editor p.mu-paragraph')).toHaveText(paragraph)
  await expect(app.locator('pre.mu-code-block')).toHaveCount(1)
  await expect(body).toBeFocused()
  expect(
    await app.evaluate<boolean>(
      '(()=>{const n=getSelection()?.anchorNode;return !!(n?.nodeType===1?n:n?.parentElement)?.closest(".mu-codeblock-content")})()'
    )
  ).toBe(true)
  await app.getByRole('button', { name: '撤销', exact: true }).click()
  await expect(app.locator('pre.mu-code-block')).toHaveCount(0)
  await expect(app.locator('.mu-editor p.mu-paragraph')).toHaveText(paragraph)
  await app.getByRole('button', { name: '重做', exact: true }).click()
  await body.click()
  await app.keyboard.insertText(original)
  await expect.poll(() => body.evaluate((element) => element.textContent)).toBe(original)
  const language = app.getByRole('textbox', { name: '代码语言', exact: true })
  await language.click()
  await app.keyboard.type('javascript')
  const suggestions = app.getByRole('menu', { name: '代码语言建议', exact: true })
  await expect(suggestions.getByRole('menuitem', { name: 'javascript', exact: true })).toBeVisible()
  await app.screenshot({ path: join(evidence, 'native-code-language-picker.png') })
  await suggestions.getByRole('menuitem', { name: 'javascript', exact: true }).click()
  await expect(language).toHaveText('javascript')
  await app.keyboard.press('end')
  await app.keyboard.press('enter')
  await app.keyboard.insertText('// 继续输入 😀')
  const expected = original + '\n// 继续输入 😀'
  await expect.poll(() => body.evaluate((element) => element.textContent)).toBe(expected)
  await expect(app.locator('.mu-codeblock-content .token.keyword').first()).toHaveText('const')
  await language.click()
  await app.keyboard.press('home')
  await app.keyboard.press('shift+end')
  await app.keyboard.type('python')
  await suggestions.getByRole('menuitem', { name: 'python', exact: true }).click()
  await expect(language).toHaveText('python')
  await expect.poll(() => body.evaluate((element) => element.textContent)).toBe(expected)
  const exported = join(home, '代码块导出.md')
  await acde.chooseSaveFile(exported)
  await app.getByRole('button', { name: '导出', exact: true }).click()
  await expect(app.locator('.storage-location')).toContainText('代码块导出.md')
  const saved = readFileSync(exported, 'utf8')
  expect(saved).toContain('```python\n' + expected + '\n```')
  await app.getByRole('button', { name: '新建', exact: true }).click()
  await acde.chooseFiles(exported)
  await app.getByRole('button', { name: '导入文件', exact: true }).first().click()
  await body.click()
  await expect(language).toHaveText('python')
  await expect.poll(() => body.evaluate((element) => element.textContent)).toBe(expected)
  await app.getByRole('button', { name: '预览', exact: true }).click()
  await expect(app.getByRole('button', { name: '代码块', exact: true })).toBeDisabled()
  await app.getByRole('button', { name: '源码', exact: true }).click()
  expect(await sourceText(app)).toBe(saved)
  expect((await app.console({ level: 'errors' })).entries).toEqual([])
  expect((await app.network({ failed: true })).entries).toEqual([])
})

test('Python tilde fences, indented code and longer JavaScript fences preserve their source and highlight', async ({
  acde
}) => {
  await acde.open('marktext-dopame')
  const app = acde.window('marktext-dopame')
  const markdown =
    '~~~python\ndef hello():\n    return "中文 😀"\n~~~\n\n    indented 中文 😀\n    second line\n\n````javascript\nconst fence = "```";\n````\n'
  await createSource(app, markdown)
  await app.getByRole('button', { name: '富文本', exact: true }).click()
  const blocks = app.locator('pre.mu-code-block')
  await expect(blocks).toHaveCount(3)
  await expect(blocks.nth(0).locator('.token.keyword').first()).toHaveText('def')
  await expect(blocks.nth(1).locator('.mu-codeblock-content')).toContainText('indented 中文 😀')
  await expect(blocks.nth(2).locator('.token.keyword').first()).toHaveText('const')
  await app.screenshot({ path: join(evidence, 'native-code-languages.png') })
  await app.getByRole('button', { name: '预览', exact: true }).click()
  await expect(blocks).toHaveCount(3)
  await app.getByRole('button', { name: '源码', exact: true }).click()
  expect(await sourceText(app)).toBe(markdown)
  await app.getByRole('button', { name: '保存', exact: true }).click()
  await expect(app.locator('.statusbar')).toContainText('已保存')
  expect(
    await app.evaluate<string>(
      '(async()=>{const {fs}=await import("acde:fs");const list=await fs.list("private","notes");return (await fs.readText("private","notes/"+list.entries[0].name)).text})()'
    )
  ).toBe(markdown)
  expect((await app.console({ level: 'errors' })).entries).toEqual([])
  expect((await app.network({ failed: true })).entries).toEqual([])
})
