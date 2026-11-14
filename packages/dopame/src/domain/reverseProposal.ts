import {
  applyOperations, applyTextChanges, assertRange, ProtocolError,
  type BlockOperation, type DocumentSnapshot, type MarkdownBlock, type TextChange,
} from './collaboration.ts'

function conflict(): never {
  throw new ProtocolError('REVISION_CONFLICT', 'Later edits overlap the earlier suggestion or cannot be mapped to current blocks. Compare both versions before proposing a reversal.')
}

function isInsideCharacter(text: string, offset: number) {
  const code = text.charCodeAt(offset)
  return offset > 0 && code >= 0xdc00 && code <= 0xdfff
}

function minimalChange(change: TextChange): TextChange {
  let prefix = 0
  while (prefix < change.before.length && prefix < change.text.length && change.before[prefix] === change.text[prefix]) prefix++
  if (isInsideCharacter(change.before, prefix) || isInsideCharacter(change.text, prefix)) prefix--
  let suffix = 0
  while (suffix < change.before.length - prefix && suffix < change.text.length - prefix
    && change.before[change.before.length - 1 - suffix] === change.text[change.text.length - 1 - suffix]) suffix++
  if (isInsideCharacter(change.before, change.before.length - suffix)
    || isInsideCharacter(change.text, change.text.length - suffix)) suffix--
  return { start: change.start + prefix, end: change.end - suffix,
    before: change.before.slice(prefix, change.before.length - suffix), text: change.text.slice(prefix, change.text.length - suffix) }
}

/** Maps only provably disjoint changes; uncertainty becomes a reviewable conflict, never a rollback. */
export function suggestReverseOperations(after: DocumentSnapshot, current: DocumentSnapshot, inverse: TextChange[]): BlockOperation[] {
  for (const key of ['workspaceId', 'docId', 'documentEpoch'] as const) {
    if (after.document[key] !== current.document[key]) conflict()
  }
  if (BigInt(current.document.revision) < BigInt(after.document.revision)) conflict()
  let prefix = 0
  while (prefix < after.markdown.length && prefix < current.markdown.length
    && after.markdown[prefix] === current.markdown[prefix]) prefix++
  if (isInsideCharacter(after.markdown, prefix) || isInsideCharacter(current.markdown, prefix)) prefix--
  let suffix = 0
  while (suffix < after.markdown.length - prefix && suffix < current.markdown.length - prefix
    && after.markdown[after.markdown.length - 1 - suffix] === current.markdown[current.markdown.length - 1 - suffix]) suffix++
  if (isInsideCharacter(after.markdown, after.markdown.length - suffix)
    || isInsideCharacter(current.markdown, current.markdown.length - suffix)) suffix--
  const laterEnd = after.markdown.length - suffix
  const delta = current.markdown.length - after.markdown.length
  const unchanged = after.markdown === current.markdown
  // A paragraph's terminal newline may become a separate space token when another paragraph is appended.
  const translated = inverse.map(minimalChange).map(change => {
    assertRange(after.markdown, change.start, change.end)
    let shift = 0
    if (!unchanged) {
      if (laterEnd <= change.start) {
        if (prefix === laterEnd && change.start === change.end && change.start === prefix) conflict()
        shift = delta
      } else if (prefix < change.end) conflict()
    }
    const mapped = { ...change, start: change.start + shift, end: change.end + shift }
    assertRange(current.markdown, mapped.start, mapped.end)
    if (current.markdown.slice(mapped.start, mapped.end) !== change.before) conflict()
    return mapped
  })
  const expected = applyTextChanges(current.markdown, translated, 'recovery')
  const replacements = new Map<string, { block: MarkdownBlock; changes: TextChange[] }>()
  const insertions: BlockOperation[] = []
  for (const change of translated) {
    const block = current.blocks.find(candidate => candidate.start <= change.start && candidate.end >= change.end)
    if (block) {
      const group = replacements.get(block.blockId) ?? { block, changes: [] }
      group.changes.push({ ...change, start: change.start - block.start, end: change.end - block.start })
      replacements.set(block.blockId, group)
      continue
    }
    if (change.start !== change.end) conflict()
    const following = current.blocks.find(candidate => candidate.start === change.start)
    const previous = current.blocks.find(candidate => candidate.end === change.start)
    if (following) insertions.push({ kind: 'insertBeforeBlock', blockId: following.blockId, markdown: change.text })
    else if (previous) insertions.push({ kind: 'insertAfterBlock', blockId: previous.blockId, markdown: change.text })
    else if (!current.markdown.length && change.start === 0) insertions.push({ kind: 'insertAtStart', markdown: change.text })
    else conflict()
  }
  const operations: BlockOperation[] = [...replacements.values()].map(({ block, changes }) => ({
    kind: 'replaceBlock', blockId: block.blockId, markdown: applyTextChanges(block.markdown, changes, 'recovery'),
  }))
  operations.push(...insertions)
  if (applyOperations(current, operations, 'recovery').markdown !== expected) conflict()
  return operations
}
