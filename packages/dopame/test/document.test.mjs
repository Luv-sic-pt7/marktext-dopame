import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDocument, editorText, isDirty, outline, updateDocument } from '../src/document.ts'
import { DocumentController } from '../src/domain/documentController.ts'

test('outline records source lines and excludes fenced headings', () => {
  const text = '```md\n# fake\n```\n\n# real\n\n~~~\n## also fake\n~~~\n## next'
  assert.deepEqual(outline(text).map(({ content, line }) => ({ content, line })), [
    { content: 'real', line: 4 }, { content: 'next', line: 9 },
  ])
})

test('BOM and CRLF do not shift outline positions', () => {
  assert.deepEqual(outline('\uFEFF# First\r\n\r\n## Second').map(item => item.line), [0, 2])
  assert.equal(editorText('\uFEFF# First\r\n'), '# First\n')
})

test('editing preserves BOM and line endings and increments revision once', () => {
  const tab = createDocument('note.md', '\uFEFF# First\r\n', { kind: 'root', root: 'private', path: 'note.md', version: '1' })
  assert.equal(isDirty(tab), false)
  updateDocument(tab, '# First\n')
  assert.equal(tab.revision, 0)
  updateDocument(tab, '# Second\n')
  assert.equal(tab.text, '\uFEFF# Second\r\n')
  assert.equal(tab.revision, 1)
  assert.equal(isDirty(tab), true)
})

test('completion of an earlier save does not clear newer input', () => {
  const tab = createDocument('note.md', '# Before')
  const snapshot = tab.text
  updateDocument(tab, '# After')
  tab.savedText = snapshot
  assert.equal(isDirty(tab), true)
  assert.equal(tab.text, '# After')
})

test('Setext headings and fence lengths use Markdown block parsing', () => {
  assert.deepEqual(outline('Title\n=====\n\n````md\n```\n# fake\n````\n\n## Real').map(({ content, line }) => ({ content, line })), [{ content: 'Title', line: 0 }, { content: 'Real', line: 8 }])
})

test('unedited mixed line endings survive editor synchronization byte for byte', () => {
  const raw = '\uFEFF# First\r\n\nsecond\r\n'
  const tab = createDocument('mixed.md', raw)
  updateDocument(tab, editorText(raw))
  assert.equal(tab.text, raw)
  assert.equal(tab.revision, 0)
})

test('controller acknowledges only the captured save when newer input exists', () => {
  const controller = new DocumentController()
  const tab = createDocument('draft.md', 'before')
  const snapshot = controller.captureSave(tab)
  controller.update(tab, 'after')
  const resource = { kind: 'root', root: 'private', path: 'saved.md', version: '2' }
  controller.acknowledgeSave(tab, snapshot, resource, 'saved.md')
  assert.equal(tab.savedText, 'before')
  assert.equal(tab.text, 'after')
  assert.equal(isDirty(tab), true)
})
