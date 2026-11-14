import { expect, test } from 'bun:test'
import { convertParagraphLines, indentListLines } from '../app/src/paragraph-commands'

test('paragraph conversion preserves Unicode text and blank list separators', () => {
  expect(convertParagraphLines(['甲 😀', '', '乙'], 'ol-order').map((line) => line.text)).toEqual([
    '1. 甲 😀',
    '',
    '2. 乙'
  ])
})

test('switching paragraph kinds replaces only their block prefixes', () => {
  expect(
    convertParagraphLines(['- [x] 完成 **内容**', '## 中文标题', '> 引用文字'], 'ul-bullet').map(
      (line) => line.text
    )
  ).toEqual(['- 完成 **内容**', '- 中文标题', '- 引用文字'])
})

test('selecting an active list kind returns its items to plain paragraphs', () => {
  expect(convertParagraphLines(['- 甲', '- 乙'], 'ul-bullet').map((line) => line.text)).toEqual([
    '甲',
    '乙'
  ])
  expect(convertParagraphLines(['- [x] 完成'], 'ul-task')[0].text).toBe('完成')
})

test('an empty paragraph can become an editable list item', () => {
  expect(convertParagraphLines([''], 'ul-bullet')).toEqual([{ text: '- ', removed: 0, added: 2 }])
  expect(convertParagraphLines([''], 'ul-task')[0].text).toBe('- [ ] ')
})

test('blockquote conversion includes empty separator lines', () => {
  expect(
    convertParagraphLines(['首段', '', '次段'], 'blockquote').map((line) => line.text)
  ).toEqual(['> 首段', '> ', '> 次段'])
})

test('source indentation nests after the preceding bullet item', () => {
  expect(indentListLines(['- 首项', '- 次项'], 1, 1, false)?.[0].text).toBe('  - 次项')
})

test('source indentation uses the ordered parent marker width', () => {
  expect(indentListLines(['3. 首项', '4. 次项'], 1, 1, false)?.[0].text).toBe('   4. 次项')
})

test('the first item cannot indent under an unrelated paragraph', () => {
  expect(indentListLines(['- 首项'], 0, 0, false)).toBeNull()
  expect(indentListLines(['- 其他列表', '普通正文', '- 首项'], 2, 2, false)).toBeNull()
})

test('source outdent finds the ancestor across sibling items', () => {
  expect(indentListLines(['- 父项', '  - 子项甲', '  - 子项乙'], 2, 2, true)?.[0].text).toBe(
    '- 子项乙'
  )
})

test('moving a selected subtree preserves its relative levels', () => {
  expect(
    indentListLines(['- 前项', '- 当前', '  - 子项'], 1, 2, false)?.map((line) => line.text)
  ).toEqual(['  - 当前', '    - 子项'])
})
