import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseSession } from '../src/session.ts'

const tab = {
  id: 'document-1',
  name: 'note.md',
  text: '# Original',
  savedText: '# Original',
  resource: { kind: 'root', root: 'private', path: 'notes/note.md', version: 'v1' },
  mode: 'edit',
  revision: 2,
  saving: true,
  bom: false,
  eol: '\n'
}

function session (tabs = [tab]) {
  return JSON.stringify({ version: 1, activeId: tab.id, tabs })
}

test('restores complete known sessions without resuming an interrupted save', () => {
  const restored = parseSession(session())
  assert.equal(restored.tabs[0].text, tab.text)
  assert.deepEqual(restored.tabs[0].resource, tab.resource)
  assert.equal(restored.tabs[0].saving, false)
  assert.equal(tab.saving, true)
})

test('validates every tab before returning any recoverable document', () => {
  for (const invalid of [null, {}, { ...tab, text: 7 }, { ...tab, revision: -1 },
    { ...tab, mode: 'unknown' }, { ...tab, savedText: {} }, { ...tab, resource: { kind: 'handle' } },
    { ...tab, resource: { kind: 'root', root: 'private', path: '../note.md' } }]) {
    assert.throws(() => parseSession(session([tab, invalid])), /原记录未覆盖/)
  }
  assert.throws(() => parseSession(session([tab, { ...tab }])), /原记录未覆盖/)
})

test('unknown schemas and malformed JSON cannot enable session overwrites', () => {
  for (const raw of ['{', 'null', JSON.stringify({ version: 2, activeId: '', tabs: [] }),
    JSON.stringify({ version: 1, tabs: [tab] })]) {
    assert.throws(() => parseSession(raw), /原记录未覆盖/)
  }
})
