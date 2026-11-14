import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyOperations, createSnapshot } from '../src/domain/collaboration.ts'
import { suggestReverseOperations } from '../src/domain/reverseProposal.ts'

const ref = { workspaceId: 'workspace', docId: 'doc', documentEpoch: 'epoch', revision: '2' }

test('later appended input is preserved in a new reverse proposal at the current version', () => {
  const after = createSnapshot(ref, 'suggested\n\noriginal tail\n')
  const current = createSnapshot({ ...ref, revision: '3' }, after.markdown + '\nnew user input😀\n')
  const inverse = [{ start: 0, end: 9, before: 'suggested', text: 'original' }]
  const operations = suggestReverseOperations(after, current, inverse)
  assert.equal(applyOperations(current, operations).markdown, 'original\n\noriginal tail\n\nnew user input😀\n')
  assert.equal(current.markdown, 'suggested\n\noriginal tail\n\nnew user input😀\n')
})

test('whole-block reversal preserves separators when a trailing newline becomes an inter-block gap', () => {
  const after = createSnapshot(ref, 'Suggested paragraph\n')
  const current = createSnapshot({ ...ref, revision: '3' }, 'Suggested paragraph\n\nLater independent paragraph\n')
  const inverse = [{ start: 0, end: 20, before: 'Suggested paragraph\n', text: 'Original paragraph\n' }]
  const operations = suggestReverseOperations(after, current, inverse)
  assert.equal(applyOperations(current, operations).markdown, 'Original paragraph\n\nLater independent paragraph\n')
})

test('disjoint preceding input shifts the inverse range using exact recorded text', () => {
  const after = createSnapshot(ref, 'before\n\nsuggested\n')
  const current = createSnapshot({ ...ref, revision: '4' }, 'added😀\n\n' + after.markdown)
  const start = after.markdown.indexOf('suggested')
  const operations = suggestReverseOperations(after, current, [{ start, end: start + 9, before: 'suggested', text: 'original' }])
  assert.equal(applyOperations(current, operations).markdown, 'added😀\n\nbefore\n\noriginal\n')
})

test('overlapping, ambiguous and rebuilt documents require manual comparison without overwriting input', () => {
  const after = createSnapshot(ref, 'suggested\n')
  const current = createSnapshot({ ...ref, revision: '3' }, 'user edited suggestion\n')
  const inverse = [{ start: 0, end: 9, before: 'suggested', text: 'original' }]
  assert.throws(() => suggestReverseOperations(after, current, inverse), { code: 'REVISION_CONFLICT' })
  assert.equal(current.markdown, 'user edited suggestion\n')
  const rebuilt = createSnapshot({ ...ref, documentEpoch: 'another', revision: '3' }, after.markdown)
  assert.throws(() => suggestReverseOperations(after, rebuilt, inverse), { code: 'REVISION_CONFLICT' })
})
