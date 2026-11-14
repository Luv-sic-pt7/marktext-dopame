import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSnapshot, applyOperations, assertRange, nextRevision } from '../src/domain/collaboration.ts'

const ref = { workspaceId: 'workspace', docId: 'document', documentEpoch: 'epoch', revision: '12' }

test('snapshot source positions bind repeated headings, Setext, code fences and Unicode to one version', () => {
  const raw = '\uFEFF# 重复\r\n\r\n# 重复\r\n\r\nTitle\r\n=====\r\n\r\n````md\r\n# fake\r\n````\r\n\r\n😀段落'
  const snapshot = createSnapshot(ref, raw)
  assert.equal(snapshot.rawText, raw)
  assert.deepEqual(snapshot.outline.map(item => item.text), ['重复', '重复', 'Title'])
  assert.equal(new Set(snapshot.blocks.map(item => item.blockId)).size, snapshot.blocks.length)
  for (const block of snapshot.blocks) assert.equal(snapshot.markdown.slice(block.start, block.end), block.markdown)
  assert.throws(() => assertRange(snapshot.markdown, snapshot.markdown.indexOf('😀') + 1, snapshot.markdown.length), { code: 'INVALID_ARGUMENT' })
})

test('non-overlapping operations apply together and stale, overlapping or duplicate operations apply nothing', () => {
  const snapshot = createSnapshot(ref, 'first\n\nsecond\n')
  const operations = snapshot.blocks.map((block, index) => ({ kind: 'replaceBlock', blockId: block.blockId, markdown: block.markdown.replace(/first|second/, String(index + 1)) }))
  assert.equal(applyOperations(snapshot, operations).markdown, '1\n\n2\n')
  assert.equal(snapshot.markdown, 'first\n\nsecond\n')
  assert.throws(() => applyOperations(snapshot, [...operations, operations[0]]), { code: 'INVALID_ARGUMENT' })
  const rebuilt = createSnapshot({ ...ref, revision: '13' }, snapshot.rawText)
  assert.throws(() => applyOperations(rebuilt, operations), { code: 'STALE_BLOCK_REF' })
})

test('exact byte snapshots survive no-op edits and edited BOM/CRLF use baseline serialization', () => {
  const raw = '\uFEFF# heading\r\n\nparagraph\r\n'
  const snapshot = createSnapshot(ref, raw)
  const first = snapshot.blocks[0]
  assert.equal(applyOperations(snapshot, [{ kind: 'replaceBlock', blockId: first.blockId, markdown: first.markdown }]).rawText, raw)
  const changed = applyOperations(snapshot, [{ kind: 'replaceBlock', blockId: first.blockId, markdown: first.markdown.replace('heading', 'changed') }])
  assert.equal(changed.rawText, '\uFEFF# changed\r\n\r\nparagraph\r\n')
})

test('empty insertion, Unicode validity, published limits and decimal revisions fail explicitly', () => {
  const empty = createSnapshot(ref, '')
  assert.equal(applyOperations(empty, [{ kind: 'insertAtStart', markdown: '开始😀' }]).markdown, '开始😀')
  assert.throws(() => applyOperations(empty, [{ kind: 'insertAtStart', markdown: '\ud800' }]), { code: 'INVALID_ARGUMENT' })
  assert.throws(() => createSnapshot(ref, '字'.repeat(700000)), { code: 'PAYLOAD_TOO_LARGE' })
  assert.equal(nextRevision('9007199254740993'), '9007199254740994')
})
