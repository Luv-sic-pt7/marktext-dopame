import { expect, test } from 'bun:test'
import { canReuseOutline, outline } from '../protocol'

test('outline includes every ATX level, indentation and duplicate Unicode titles', () => {
  const lines = [
    '# 中文 😀',
    '  ## 中文 😀 ##',
    '### 第三级',
    '#### 第四级',
    '##### 第五级',
    '   ###### 第六级',
    '####### 不是标题',
    '#没有空格',
    '# 保留结尾#'
  ]
  const source = lines.join('\n\n')
  const headings = outline(source)
  expect(headings.map(({ level, text }) => ({ level, text }))).toEqual([
    { level: 1, text: '中文 😀' },
    { level: 2, text: '中文 😀' },
    { level: 3, text: '第三级' },
    { level: 4, text: '第四级' },
    { level: 5, text: '第五级' },
    { level: 6, text: '第六级' },
    { level: 1, text: '保留结尾#' }
  ])
  expect(headings.map(({ from, to }) => source.slice(from, to))).toEqual([
    ...lines.slice(0, 6),
    lines[8]
  ])
})

test('outline recognizes single and multiline Setext headings without treating rules as headings', () => {
  const source = '第一行\n第二行\n=====\n\n二级标题\n---\n\n---\n\n普通段落\n\n***\n'
  expect(outline(source)).toEqual([
    { level: 1, text: '第一行 第二行', from: 0, to: source.indexOf('\n\n') },
    {
      level: 2,
      text: '二级标题',
      from: source.indexOf('二级标题'),
      to: source.indexOf('二级标题') + '二级标题\n---'.length
    }
  ])
})

test('outline keeps longer fences open until a matching closing fence', () => {
  const source = [
    '````md',
    '# 代码伪标题',
    '```',
    '仍是代码',
    '---',
    '`````',
    '# 真标题',
    '',
    '~~~~',
    '# 波浪线代码',
    '~~~',
    'Setext 伪标题',
    '===',
    '~~~~',
    '## 第二个真标题',
    '',
    '```',
    '# 未闭合代码'
  ].join('\n')
  expect(outline(source).map(({ text }) => text)).toEqual(['真标题', '第二个真标题'])
})

test('outline excludes indented code, block HTML and comments', () => {
  const source = [
    '    # 缩进代码',
    '    伪 Setext',
    '    ===',
    '',
    '\t## Tab 代码',
    '',
    '<script>',
    '# 脚本里的文字',
    '</script>',
    '',
    '<!--',
    '# 注释里的文字',
    '-->',
    '',
    '<div>',
    '# HTML 里的文字',
    '</div>',
    '',
    '# 文档标题'
  ].join('\n')
  expect(outline(source).map(({ text }) => text)).toEqual(['文档标题'])
})

test('outline preserves original UTF-16 ranges across CRLF, LF and lone carriage returns', () => {
  const source =
    '前言 😀\r\n\r\n# 中文 😀\r\n\r\n多行\r\nSetext\r\n===\r\n\n## 末尾\r\n\r### 独立 CR\r'
  const headings = outline(source)
  expect(headings.map(({ text }) => text)).toEqual(['中文 😀', '多行 Setext', '末尾', '独立 CR'])
  expect(headings.map(({ from, to }) => source.slice(from, to))).toEqual([
    '# 中文 😀',
    '多行\r\nSetext\r\n===',
    '## 末尾',
    '### 独立 CR'
  ])
  expect(headings.map(({ from }) => from)).toEqual([
    source.indexOf('# 中文'),
    source.indexOf('多行'),
    source.indexOf('## 末尾'),
    source.indexOf('### 独立')
  ])
})

test('outline offsets stay correct after duplicate reference definitions', () => {
  const source =
    '[ref]: https://example.com\n\n[ref]: https://example.org "\n# 重复标题\n"\n\n# 重复标题\n'
  const headings = outline(source)
  expect(headings).toEqual([
    {
      level: 1,
      text: '重复标题',
      from: source.lastIndexOf('# 重复标题'),
      to: source.lastIndexOf('# 重复标题') + '# 重复标题'.length
    }
  ])
})

test('outline keeps the document hierarchy separate from quoted and list content', () => {
  const source = '> # 引用标题\n\n- ## 列表标题\n\n# 文档标题\n'
  expect(outline(source).map(({ text }) => text)).toEqual(['文档标题'])
})

test('outline skips the same YAML, TOML and JSON front matter forms as Muya', () => {
  for (const frontMatter of [
    '---\n# YAML 元数据\ntitle: 文档\n---\n\n',
    '+++\n# TOML 元数据\ntitle = "文档"\n+++\n\n',
    ';;;\n"title": "文档"\n;;;\n\n',
    '{\n"title": "文档"\n}\n\n'
  ]) {
    const source = frontMatter.replace(/\n/g, '\r\n') + '正文标题\r\n===\r\n\r\n## 继续\n'
    const headings = outline(source)
    expect(headings.map(({ text }) => text)).toEqual(['正文标题', '继续'])
    expect(headings.map(({ from, to }) => source.slice(from, to))).toEqual([
      '正文标题\r\n===',
      '## 继续'
    ])
    expect(headings[0].from).toBe(source.indexOf('正文标题'))
  }
})

test('unclosed front matter does not hide subsequent headings', () => {
  const source = '---\ntitle: 文档\n\n# 正文标题\n'
  expect(outline(source).map(({ text }) => text)).toEqual(['正文标题'])
})

test('empty documents produce no outline', () => {
  expect(outline('')).toEqual([])
  expect(outline('普通正文\n\n    # 代码')).toEqual([])
})

test('plain tail append reuse agrees with full Markdown analysis across block contexts', () => {
  for (const source of [
    '',
    '# 标题\n\n正文',
    '# 标题\r\n\r\n正文',
    '标题\n===\n\n正文',
    '> # 引用\n\n正文',
    '- # 列表\n\n正文',
    '```md\n# 隐藏标题\ncode',
    '<div>\n# HTML 中\ntext',
    '<!--\n# 注释中\ntext',
    '# [引用][r]\n\n正文',
    '---\ntitle: 未闭合\n# 正文标题\ntext',
    '{\n# 未闭合\ntext',
    '| 表头 |\n| --- |\ncell',
    '# 标题\n\n'
  ])
    for (const suffix of ['文字 😀', 'abc', '</div>', '-->', '---', '}', '`', '  ']) {
      const next = source + suffix
      if (canReuseOutline(source, next)) expect(outline(next)).toEqual(outline(source))
    }
  for (const [before, after] of [
    ['# 标题', '# 标题后缀'],
    ['[r]: /url "\n# 标题\ntext"', '[r]: /url "\n# 标题\ntext"x'],
    ['标题\n--', '标题\n---'],
    ['# 标题\n正文', '# 标题\n正文\n## 新标题'],
    ['正文', '其他正文'],
    ['    code', '    code more']
  ])
    expect(canReuseOutline(before, after)).toBe(false)
})
