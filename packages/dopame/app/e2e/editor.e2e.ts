import { test, expect } from 'acde/test'
import { resolve, join } from 'node:path'
import { mkdirSync, readFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

const evidence =
  process.env.MARKTEXT_EVIDENCE ??
  resolve(import.meta.dir, '../../../../../work/marktext-mvp-evidence')
mkdirSync(evidence, { recursive: true })
const content = '# 中文测试 😀\n\n第一段内容。\n\n| 项目 | 数值 |\n| --- | --- |\n| 训练 | 12 |\n'

test('P0 native clipboard copy cut paste and undo preserve Unicode in both editing modes', async ({
  acde
}) => {
  await acde.open('marktext-dopame')
  const app = acde.window('marktext-dopame')
  const text = '剪贴板 中文 😀'
  for (const mode of ['源码', '富文本']) {
    await app.getByRole('button', { name: '新建', exact: true }).click()
    await app.getByRole('button', { name: mode, exact: true }).click()
    if (mode === '源码')
      await app.getByRole('textbox', { name: 'Markdown 源码', exact: true }).type(text)
    else {
      await app.locator('.mu-editor [contenteditable="true"]').first().click()
      await app.keyboard.insertText(text)
    }
    await app.keyboard.press('ctrl+a')
    await app.keyboard.press('ctrl+c')
    expect((await acde.clipboard()).trimEnd()).toBe(text)
    await app.keyboard.press('ctrl+x')
    if (mode === '源码')
      expect(
        await app.evaluate('document.querySelector(".CodeMirror").CodeMirror.getValue()')
      ).toBe('')
    else await expect(app.locator('.mu-editor')).toHaveText('')
    await app.getByRole('button', { name: '撤销', exact: true }).click()
    if (mode === '源码')
      expect(
        await app.evaluate('document.querySelector(".CodeMirror").CodeMirror.getValue()')
      ).toBe(text)
    else await expect(app.locator('.mu-editor')).toHaveText(text)
    await app.keyboard.press('ctrl+end')
    if (mode === '富文本') expect(await app.evaluate('getSelection().isCollapsed')).toBe(true)
    await acde.setClipboard(' 粘贴尾巴😀')
    await app.keyboard.press('ctrl+v')
    if (mode === '源码')
      expect(
        await app.evaluate('document.querySelector(".CodeMirror").CodeMirror.getValue()')
      ).toBe(text + ' 粘贴尾巴😀')
    else await expect(app.locator('.mu-editor')).toHaveText(text + ' 粘贴尾巴😀')
    await app.getByRole('button', { name: '撤销', exact: true }).click()
    if (mode === '富文本') await expect(app.locator('.mu-editor')).toHaveText(text)
    await app.keyboard.press('ctrl+end')
    await app.keyboard.insertText(' 继续输入')
    await acde.setClipboard(' 快速粘贴')
    await app.keyboard.press('ctrl+v')
    await app.getByRole('button', { name: '撤销', exact: true }).click()
    if (mode === '富文本') await expect(app.locator('.mu-editor')).toHaveText(text + ' 继续输入')
    await app.getByRole('button', { name: '源码', exact: true }).click()
    expect(
      (
        await app.evaluate<string>('document.querySelector(".CodeMirror").CodeMirror.getValue()')
      ).trimEnd()
    ).toBe(text + ' 继续输入')
  }
  expect((await app.console({ level: 'errors' })).entries).toEqual([])
})

test('P0 escapes entities and both CommonMark hard break forms render and round trip unchanged', async ({
  acde,
  home
}) => {
  const file = join(home, '语法保真.md')
  const original =
    '# 语法保真\n\n\\*字面星号\\* 与 &amp; 和 &#x1F600;。\n\n软换行一\n软换行二\n\n空格硬换行一  \n空格硬换行二\n\n反斜杠硬换行一\\\n反斜杠硬换行二\n'
  await Bun.write(file, original)
  await acde.open('marktext-dopame')
  const app = acde.window('marktext-dopame')
  await acde.chooseFiles(file)
  await app.getByRole('button', { name: '原位打开文件', exact: true }).click()
  await expect(app.locator('.mu-editor .mu-hard-line-break')).toHaveCount(2)
  await expect(app.locator('.mu-editor .mu-soft-line-break')).toHaveCount(1)
  expect(
    await app.evaluate(
      'Array.from(document.querySelectorAll(".mu-html-escape")).map(e=>e.getAttribute("data-character"))'
    )
  ).toEqual(['&', '😀'])
  await app.screenshot({ path: join(evidence, 'native-p0-escapes-rich.png') })
  let previewCaptured = false
  for (const mode of ['预览', '源码', '富文本', '预览', '源码']) {
    await app.getByRole('button', { name: mode, exact: true }).click()
    if (mode === '源码')
      expect(
        await app.evaluate('document.querySelector(".CodeMirror").CodeMirror.getValue()')
      ).toBe(original)
    else await expect(app.locator('.mu-editor .mu-hard-line-break')).toHaveCount(2)
    if (mode === '预览' && !previewCaptured) {
      await app.screenshot({ path: join(evidence, 'native-p0-escapes-preview.png') })
      previewCaptured = true
    }
  }
  await app.getByRole('button', { name: '保存', exact: true }).click()
  await expect(app.locator('.statusbar')).toContainText('已保存')
  expect(readFileSync(file, 'utf8')).toBe(original)
  await app.screenshot({ path: join(evidence, 'native-p0-escapes-breaks.png') })
  expect((await app.console({ level: 'errors' })).entries).toEqual([])
})

test('P0 ordered starts and loose nested list paragraphs retain their structure and original source', async ({
  acde,
  home
}) => {
  const file = join(home, '复杂列表.md')
  const original =
    '3. 第三项\n4. 第四项\n\n   第二段仍属于第四项。\n\n   - 内层一\n   - 内层二\n\n5. 第五项\n'
  await Bun.write(file, original)
  await acde.open('marktext-dopame')
  const app = acde.window('marktext-dopame')
  await acde.chooseFiles(file)
  await app.getByRole('button', { name: '原位打开文件', exact: true }).click()
  const list = app.locator('.mu-editor ol').first()
  await expect(list).toHaveAttribute('start', '3')
  await expect(list.locator(':scope > li')).toHaveCount(3)
  await expect(list.locator('ul li')).toHaveCount(2)
  await expect(list.locator(':scope > li').nth(1)).toContainText('第二段仍属于第四项。')
  await app.getByRole('button', { name: '预览', exact: true }).click()
  await expect(list).toHaveAttribute('start', '3')
  await app.getByRole('button', { name: '源码', exact: true }).click()
  expect(await app.evaluate('document.querySelector(".CodeMirror").CodeMirror.getValue()')).toBe(
    original
  )
  await app.getByRole('button', { name: '保存', exact: true }).click()
  await expect(app.locator('.statusbar')).toContainText('已保存')
  expect(readFileSync(file, 'utf8')).toBe(original)
})

test('P0 document boundary shortcuts collapse or extend a rich selection across blocks', async ({
  acde,
  home
}) => {
  const file = join(home, '边界导航.md')
  const original = '# 首段\n\n中段 😀\n\n末段 ~~划线~~ 文本\n'
  await Bun.write(file, original)
  await acde.open('marktext-dopame')
  const app = acde.window('marktext-dopame')
  await acde.chooseFiles(file)
  await app.getByRole('button', { name: '原位打开文件', exact: true }).click()
  await app
    .locator('.mu-editor .mu-content[contenteditable="true"]')
    .filter({ hasText: '中段' })
    .click()
  await app.keyboard.press('ctrl+end')
  expect(await app.evaluate('getSelection().isCollapsed')).toBe(true)
  expect(
    await app.evaluate('getSelection().focusNode.parentElement.closest(".mu-content").textContent')
  ).toContain('末段')
  await app.keyboard.press('ctrl+shift+home')
  const selected = await app.evaluate<string>('getSelection().toString()')
  expect(selected).toContain('首段')
  expect(selected).toContain('中段 😀')
  expect(selected).toContain('末段')
  await app.keyboard.press('ctrl+home')
  expect(await app.evaluate('getSelection().isCollapsed')).toBe(true)
  expect(
    await app.evaluate('getSelection().anchorNode.parentElement.closest(".mu-content").textContent')
  ).toContain('首段')
  await app.keyboard.press('ctrl+shift+end')
  expect(await app.evaluate('getSelection().toString()')).toContain('末段')
  await app.getByRole('button', { name: '源码', exact: true }).click()
  expect(await app.evaluate('document.querySelector(".CodeMirror").CodeMirror.getValue()')).toBe(
    original
  )
  expect(readFileSync(file, 'utf8')).toBe(original)
  for (const code of ['```js\nconst boundary = 1\n```\n', '    const boundary = 1\n']) {
    const input = app.getByRole('textbox', { name: 'Markdown 源码', exact: true })
    await input.press('ctrl+a')
    await input.type(code)
    await app.getByRole('button', { name: '富文本', exact: true }).click()
    await app
      .locator('.mu-editor .mu-content[contenteditable="true"]')
      .filter({ hasText: 'const boundary' })
      .click()
    await app.keyboard.press('ctrl+home')
    expect(await app.evaluate('document.activeElement.matches("input,textarea")')).toBe(false)
    expect(await app.evaluate('getSelection().anchorOffset')).toBe(0)
    expect(
      await app.evaluate(
        'getSelection().anchorNode.parentElement.closest(".mu-content").textContent'
      )
    ).toContain('const boundary')
    await app.getByRole('button', { name: '源码', exact: true }).click()
    expect(await app.evaluate('document.querySelector(".CodeMirror").CodeMirror.getValue()')).toBe(
      code
    )
  }
})

test('imported files save to private working copies and export to an explicit destination', async ({
  acde,
  home
}) => {
  const original = join(home, '导入源.md'),
    exported = join(home, '明确导出.md')
  await Bun.write(original, '# 导入内容\n\n原文件保留。\n')
  await acde.open('marktext-dopame')
  const app = acde.window('marktext-dopame')
  await acde.chooseFiles(original)
  await app.getByRole('button', { name: '导入文件', exact: true }).first().click()
  await expect(app.locator('.storage-location')).toContainText('保存到私有笔记')
  await expect(app.locator('.storage-location')).toContainText('导入来源：导入源.md')
  await app.getByRole('button', { name: '源码', exact: true }).click()
  await app.getByRole('textbox', { name: 'Markdown 源码' }).press('ctrl+end')
  await app.getByRole('textbox', { name: 'Markdown 源码' }).type('\n工作副本新输入 😀')
  await app.getByRole('button', { name: '保存', exact: true }).click()
  await expect(app.locator('.statusbar')).toContainText('已保存')
  expect(readFileSync(original, 'utf8')).toBe('# 导入内容\n\n原文件保留。\n')
  await acde.chooseSaveFile(exported)
  await app.getByRole('button', { name: '导出', exact: true }).click()
  await expect(app.getByRole('status', { name: '文档操作反馈', exact: true })).toContainText(
    '已导出'
  )
  expect(readFileSync(exported, 'utf8').includes('工作副本新输入 😀')).toBe(true)
  await expect(app.locator('.storage-location')).toContainText('保存到私有笔记')
  await app.screenshot({ path: join(evidence, 'native-import-export.png') })
})

test('Muya receives Unicode commits, selection replacement and native clipboard paste', async ({
  acde
}) => {
  await acde.open('marktext-dopame')
  const app = acde.window('marktext-dopame')
  await app.getByRole('button', { name: '新建', exact: true }).click()
  await app.locator('.mu-editor [contenteditable="true"]').first().click()
  await app.keyboard.insertText('中文 😀abcdef')
  await app.keyboard.press('shift+left')
  await Bun.write(
    join(evidence, 'native-selection.json'),
    JSON.stringify(
      await app.evaluate<any>(
        '(()=>{const s=getSelection();return {text:s.toString(),anchor:s.anchorOffset,focus:s.focusOffset}})()'
      ),
      null,
      2
    )
  )
  await app.keyboard.type('Z')
  await acde.setClipboard('\n粘贴的中文与 emoji 😀')
  await app.keyboard.press('ctrl+v')
  await app.getByRole('button', { name: '保存', exact: true }).click()
  await expect(app.locator('.statusbar')).toContainText('已保存')
  const text = await app.evaluate<string>(
    '(async()=>{const {fs}=await import("acde:fs");const files=await fs.list("private","notes");return (await fs.readText("private","notes/"+files.entries[0].name)).text})()'
  )
  await Bun.write(join(evidence, 'native-muya-input.json'), JSON.stringify({ text }, null, 2))
  expect(text).toContain('中文 😀abcdeZ')
  expect(text).toContain('粘贴的中文与 emoji 😀')
})

test('the native layout stays usable at desktop, tablet and narrow widths', async ({ acde }) => {
  await acde.open('marktext-dopame')
  const app = acde.window('marktext-dopame')
  await app.getByRole('button', { name: '打开示例文档', exact: true }).click()
  const measurements = []
  for (const [width, height] of [
    [1440, 900],
    [768, 1024],
    [390, 844]
  ]) {
    await app.resize(width, height)
    await expect(app.getByRole('button', { name: '保存', exact: true })).toBeVisible()
    const row = await app.evaluate<any>(
      '({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,bodyWidth:document.body.scrollWidth,editor:document.querySelector(".sheet").getBoundingClientRect().width})'
    )
    expect(row.scrollWidth).toBeLessThanOrEqual(row.width)
    expect(row.bodyWidth).toBeLessThanOrEqual(row.width)
    measurements.push(row)
    await app.screenshot({ path: join(evidence, 'native-layout-' + width + '.png') })
  }
  await Bun.write(
    join(evidence, 'native-layout.json'),
    JSON.stringify({ environment: 'local acdert 0.0.9', measurements }, null, 2)
  )
})

function pngPixel() {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data])
    let crc = 0xffffffff
    for (const byte of body) {
      crc ^= byte
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
    const length = Buffer.alloc(4),
      checksum = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
    return Buffer.concat([length, body, checksum])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(1, 0)
  header.writeUInt32BE(1, 4)
  header[8] = 8
  header[9] = 6
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from([0, 32, 128, 64, 255]))),
    chunk('IEND', Buffer.alloc(0))
  ])
}

test('relative images use the authorized folder and retain their Markdown paths after saving', async ({
  acde,
  home
}) => {
  const folder = join(home, '图片资料')
  mkdirSync(folder, { recursive: true })
  await Bun.write(join(folder, 'pixel.png'), pngPixel())
  const markdown = '# 本地图片\n\n![像素](./pixel.png)\n\n原路径应保留。\n'
  await Bun.write(join(folder, '图片笔记.md'), markdown)
  await acde.open('marktext-dopame')
  const app = acde.window('marktext-dopame')
  await acde.chooseFolder(folder)
  await app.getByRole('button', { name: '添加文件夹', exact: true }).click()
  await app.screenshot({ path: join(evidence, 'native-folder-picker.png') })
  await expect(app.locator('.root-row')).toHaveCount(1)
  await app.locator('.root-row').click()
  await app.getByRole('button', { name: '原位打开文件 图片笔记.md', exact: true }).click()
  await expect(app.getByRole('img', { name: '像素', exact: true })).toHaveCount(1)
  await expect(app.getByRole('img', { name: '像素', exact: true })).toHaveAttribute(
    'src',
    /^data:image\/png;base64,/
  )
  await expect
    .poll(() =>
      app.evaluate<number>('document.querySelector(".mu-editor img[alt=像素]").naturalWidth')
    )
    .toBe(1)
  await app.getByRole('button', { name: '源码', exact: true }).click()
  await app.getByRole('textbox', { name: 'Markdown 源码' }).press('ctrl+end')
  await app.getByRole('textbox', { name: 'Markdown 源码' }).type('\n增加一行')
  await app.getByRole('button', { name: '富文本', exact: true }).click()
  await app.getByRole('button', { name: '保存', exact: true }).click()
  await expect(app.locator('.statusbar')).toContainText('已保存')
  const saved = readFileSync(join(folder, '图片笔记.md'), 'utf8')
  expect(saved.includes('./pixel.png')).toBe(true)
  expect(saved.includes('blob:')).toBe(false)
})

test('untrusted Markdown cannot execute scripts or javascript image schemes', async ({
  acde,
  home
}) => {
  const path = join(home, '不可信内容.md')
  const markdown =
    '# 不可信内容\n\n<script>globalThis.__marktextXss=1</script>\n\n<img src=x onerror="globalThis.__marktextXss=2">\n\n![脚本](javascript:globalThis.__marktextXss=3)\n\n:::unknown-extension\n原样保留\n:::\n'
  await Bun.write(path, markdown)
  await acde.open('marktext-dopame')
  const app = acde.window('marktext-dopame')
  await acde.chooseFiles(path)
  await app.getByRole('button', { name: '导入文件', exact: true }).first().click()
  await app.getByRole('button', { name: '预览', exact: true }).click()
  expect(await app.evaluate<boolean>('typeof globalThis.__marktextXss === "undefined"')).toBe(true)
  expect(
    await app.evaluate<number>(
      'document.querySelectorAll(".mu-editor script,.mu-editor [onerror],.mu-editor img[src^=javascript]").length'
    )
  ).toBe(0)
  await app.getByRole('button', { name: '富文本', exact: true }).click()
  expect(await app.evaluate<boolean>('typeof globalThis.__marktextXss === "undefined"')).toBe(true)
  await app.getByRole('button', { name: '保存', exact: true }).click()
  await expect(app.locator('.statusbar')).toContainText('已保存')
  expect(readFileSync(path, 'utf8')).toBe(markdown)
})

test('Unicode commits, rich/source handoff, table content, native save and undo/redo', async ({
  acde
}) => {
  await acde.open('marktext-dopame')
  const app = acde.window('marktext-dopame')
  await app!.getByRole('button', { name: '新建', exact: true }).click()
  await app!.getByRole('button', { name: '源码', exact: true }).click()
  await app!.getByRole('textbox', { name: 'Markdown 源码', exact: true }).type(content)
  await app!.getByRole('button', { name: '保存', exact: true }).click()
  await expect(app!.locator('.statusbar')).toContainText('已保存')
  const saved = await app!.evaluate<string>(
    '(async()=>{const {fs}=await import("acde:fs");const list=await fs.list("private","notes");return (await fs.readText("private","notes/"+list.entries[0].name)).text})()'
  )
  expect(saved).toBe(content)
  await app!.getByRole('button', { name: '富文本', exact: true }).click()
  await expect(app!.getByRole('table')).toHaveCount(1)
  expect(
    await app!.evaluate<boolean>(
      'document.querySelector(".mu-editor").textContent.includes("中文测试")'
    )
  ).toBe(true)
  await app!.getByRole('button', { name: '撤销', exact: true }).click()
  expect(
    await app!.evaluate<boolean>(
      'document.querySelector(".mu-editor").textContent.includes("中文测试")'
    )
  ).toBe(false)
  await app!.getByRole('button', { name: '重做', exact: true }).click()
  expect(
    await app!.evaluate<boolean>(
      'document.querySelector(".mu-editor").textContent.includes("中文测试")'
    )
  ).toBe(true)
  await app!.screenshot({ path: join(evidence, 'native-editor-unicode.png') })
})

test('tabs retain independent text and history across repeated switches', async ({ acde }) => {
  await acde.open('marktext-dopame')
  const app = acde.window('marktext-dopame')
  await app!.getByRole('button', { name: '新建', exact: true }).click()
  await app!.getByRole('button', { name: '源码', exact: true }).click()
  await app!
    .getByRole('textbox', { name: 'Markdown 源码', exact: true })
    .type('# 第一篇\n\n甲方内容 😀')
  await app!.getByRole('button', { name: '新建', exact: true }).click()
  await app!.getByRole('button', { name: '源码', exact: true }).click()
  await app!
    .getByRole('textbox', { name: 'Markdown 源码', exact: true })
    .type('# 第二篇\n\n乙方内容')
  for (let n = 0; n < 3; n++) {
    await app!.getByRole('tab').nth(0).click()
    expect(
      await app!.evaluate<boolean>(
        'document.querySelector(".CodeMirror-code").textContent.includes("甲方内容")'
      )
    ).toBe(true)
    expect(
      await app!.evaluate<boolean>(
        'document.querySelector(".CodeMirror-code").textContent.includes("乙方内容")'
      )
    ).toBe(false)
    await app!.getByRole('tab').nth(1).click()
    expect(
      await app!.evaluate<boolean>(
        'document.querySelector(".CodeMirror-code").textContent.includes("乙方内容")'
      )
    ).toBe(true)
  }
  await app!.getByRole('button', { name: '撤销', exact: true }).click()
  await app!.getByRole('tab').nth(0).click()
  expect(
    await app!.evaluate<boolean>(
      'document.querySelector(".CodeMirror-code").textContent.includes("甲方内容")'
    )
  ).toBe(true)
})

test('untouched BOM/CRLF bytes survive mode changes and save; conflicting disk changes are preserved', async ({
  acde,
  home
}) => {
  await acde.open('marktext-dopame')
  const app = acde.window('marktext-dopame')
  const path = join(home, '字节往返.md'),
    original = Buffer.from('\ufeff' + content.replace(/\n/g, '\r\n'))
  await Bun.write(path, original)
  await acde.chooseFiles(path)
  await app!.getByRole('button', { name: '原位打开文件', exact: true }).click()
  await expect(app!.getByRole('textbox', { name: '笔记标题' })).toHaveValue('字节往返.md')
  await app!.getByRole('button', { name: '源码', exact: true }).click()
  await app!.getByRole('button', { name: '预览', exact: true }).click()
  await app!.getByRole('button', { name: '富文本', exact: true }).click()
  await app!.getByRole('button', { name: '保存', exact: true }).click()
  await expect(app!.locator('.statusbar')).toContainText('已保存')
  expect(readFileSync(path).equals(original)).toBe(true)
  await app!.getByRole('button', { name: '源码', exact: true }).click()
  await app!.getByRole('textbox', { name: 'Markdown 源码' }).press('ctrl+end')
  await app!.getByRole('textbox', { name: 'Markdown 源码' }).type('\n第一次修改')
  await app!.getByRole('button', { name: '保存', exact: true }).click()
  await expect(app!.locator('.statusbar')).toContainText('已保存')
  expect(
    readFileSync(path)
      .subarray(0, 3)
      .equals(Buffer.from([239, 187, 191]))
  ).toBe(true)
  expect(readFileSync(path).toString().includes('\r\n第一次修改')).toBe(true)
  await app!.getByRole('textbox', { name: 'Markdown 源码' }).press('ctrl+end')
  await app!.getByRole('textbox', { name: 'Markdown 源码' }).type('\n本机尚未保存的输入')
  const external = Buffer.from('# 外部已经修改\n')
  await Bun.write(path, external)
  await app!.getByRole('button', { name: '保存', exact: true }).click()
  await expect(app!.getByRole('status', { name: '文档操作反馈', exact: true })).toContainText(
    '磁盘内容已变化'
  )
  expect(readFileSync(path).equals(external)).toBe(true)
  expect(
    await app!.evaluate<boolean>(
      'document.querySelector(".CodeMirror-code").textContent.includes("本机尚未保存的输入")'
    )
  ).toBe(true)
})

test('administrator pairing exposes no credentials in DOM and grants only explicitly selected scope', async ({
  acde
}) => {
  const desktop = acde.desktop
  const path = await desktop.evaluate<string>(
    '(async()=>{const m=await import("acde:marktext-agent");return (await m["marktext-agent"].request({method:"health"})).value.credentialPath})()'
  )
  await acde.chooseFiles(path)
  await desktop.getByRole('button', { name: '选择管理员凭证', exact: true }).click()
  await expect(desktop.getByRole('heading', { name: '管理员已连接', exact: true })).toBeVisible()
  await desktop.getByRole('textbox', { name: '调用方 ID', exact: true }).fill('gui-caller')
  await desktop.getByRole('textbox', { name: '显示名称', exact: true }).fill('界面测试调用方')
  await desktop.getByRole('button', { name: '创建配对凭证', exact: true }).click()
  await expect(desktop.getByRole('status', { name: '操作反馈', exact: true })).toContainText(
    '尚未自动获得任何已有文档的权限'
  )
  expect(
    await desktop.evaluate<boolean>('/\\b[a-f0-9]{64}\\b/.test(document.body.textContent)')
  ).toBe(false)
  await desktop.getByRole('combobox', { name: '调用方', exact: true }).selectOption('gui-caller')
  await desktop.getByRole('combobox', { name: '资源类型', exact: true }).selectOption('workspace')
  await desktop.getByRole('button', { name: '授予所选权限', exact: true }).click()
  await expect(desktop.getByRole('status', { name: '操作反馈', exact: true })).toContainText(
    '已授予所选范围'
  )
  await expect(desktop.locator('#grants')).toContainText('创建新文档')
  await desktop
    .getByRole('button', { name: '撤销 界面测试调用方 的 workspace 授权', exact: true })
    .click()
  await expect(desktop.locator('#grants')).toContainText('当前没有此范围的有效授权')
  await desktop.screenshot({ path: join(evidence, 'native-permissions.png') })
})
