import { Lexer } from 'marked'

export const limits = Object.freeze({
  documentBytes: 2 * 1024 * 1024,
  operations: 256,
  replacementBytes: 256 * 1024,
  requestBytes: 512 * 1024,
  artifactReadBytes: 64 * 1024,
  eventPage: 200,
})

export class ProtocolError extends Error {
  readonly code: string
  readonly retryable: boolean
  readonly details?: Record<string, unknown>

  constructor(
    code: string,
    message: string,
    retryable = false,
    details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'ProtocolError'
    this.code = code
    this.retryable = retryable
    this.details = details
  }
}

export interface DocumentRef {
  workspaceId: string
  docId: string
  documentEpoch: string
  revision: string
}

export interface MarkdownBlock {
  blockId: string
  type: string
  start: number
  end: number
  markdown: string
  heading?: { level: number; text: string; line: number }
}

export interface DocumentSnapshot {
  document: DocumentRef
  markdown: string
  rawText: string
  blocks: MarkdownBlock[]
  outline: Array<{ blockId: string; level: number; text: string; start: number; end: number; line: number }>
}

export type BlockOperation =
  | { kind: 'replaceBlock' | 'insertBeforeBlock' | 'insertAfterBlock'; blockId: string; markdown: string }
  | { kind: 'deleteBlock'; blockId: string }
  | { kind: 'insertAtStart'; markdown: string }

export interface TextChange {
  start: number
  end: number
  text: string
  before: string
}

/** Recovery is reserved for persisted transactions, not caller-supplied suggestions. */
export type EditQuota = 'proposal' | 'recovery'

export function normalizeMarkdown(text: string) {
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
}

export function byteLength(text: string) {
  return new TextEncoder().encode(text).byteLength
}

export function assertText(text: string, maximum = limits.documentBytes) {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(++i)
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new ProtocolError('INVALID_ARGUMENT', 'Markdown contains an incomplete Unicode character.')
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new ProtocolError('INVALID_ARGUMENT', 'Markdown contains an incomplete Unicode character.')
    }
  }
  if (byteLength(text) > maximum) throw new ProtocolError('PAYLOAD_TOO_LARGE', 'Markdown exceeds the published byte limit.')
}

export function assertRange(text: string, start: number, end: number) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > text.length) {
    throw new ProtocolError('INVALID_ARGUMENT', 'Invalid UTF-16 source range.')
  }
  for (const offset of [start, end]) {
    const code = text.charCodeAt(offset)
    if (offset > 0 && code >= 0xdc00 && code <= 0xdfff) throw new ProtocolError('INVALID_ARGUMENT', 'A source range cannot split a Unicode character.')
  }
}

export function sameDocument(left: DocumentRef, right: DocumentRef) {
  return left.workspaceId === right.workspaceId && left.docId === right.docId
    && left.documentEpoch === right.documentEpoch && left.revision === right.revision
}

export function nextRevision(revision: string) {
  if (!/^(0|[1-9]\d*)$/.test(revision)) throw new ProtocolError('INVALID_ARGUMENT', 'Invalid document revision.')
  return (BigInt(revision) + 1n).toString()
}

/** Source ranges and block identifiers belong only to this immutable snapshot. */
export function createSnapshot(document: DocumentRef, rawText: string): DocumentSnapshot {
  assertText(rawText)
  const markdown = normalizeMarkdown(rawText)
  const blocks: MarkdownBlock[] = []
  let offset = 0
  let line = 0
  for (const token of Lexer.lex(markdown)) {
    if (markdown.slice(offset, offset + token.raw.length) !== token.raw) {
      throw new ProtocolError('INVALID_ARGUMENT', 'This Markdown cannot be indexed without changing its source.')
    }
    const start = offset
    const startLine = line
    offset += token.raw.length
    line += (token.raw.match(/\n/g) ?? []).length
    if (token.type === 'space') continue
    const block: MarkdownBlock = { blockId: crypto.randomUUID(), type: token.type, start, end: offset, markdown: token.raw }
    if (token.type === 'heading') block.heading = { level: token.depth, text: token.text, line: startLine }
    blocks.push(block)
  }
  if (offset !== markdown.length) throw new ProtocolError('INVALID_ARGUMENT', 'Incomplete Markdown source index.')
  const outline = blocks.flatMap(block => block.heading
    ? [{ blockId: block.blockId, ...block.heading, start: block.start, end: block.end }] : [])
  return { document: { ...document }, markdown, rawText, blocks, outline }
}

/** Unedited snapshots retain exact bytes; edited text follows the baseline BOM/EOL policy. */
export function serializeMarkdown(original: string, markdown: string, bom = original.startsWith('\uFEFF'), eol = original.includes('\r\n') ? '\r\n' : '\n') {
  const normalized = normalizeMarkdown(markdown)
  if (normalized === normalizeMarkdown(original)) return original
  return (bom ? '\uFEFF' : '') + normalized.replace(/\n/g, eol)
}

export function applyTextChanges(markdown: string, changes: TextChange[], quota: EditQuota = 'proposal') {
  const replacementLimit = quota === 'recovery' ? limits.documentBytes : limits.replacementBytes
  const ordered = [...changes].sort((a, b) => a.start - b.start || a.end - b.end)
  for (let i = 0; i < ordered.length; i++) {
    const change = ordered[i]
    assertRange(markdown, change.start, change.end)
    assertText(change.text, replacementLimit)
    if (markdown.slice(change.start, change.end) !== change.before) throw new ProtocolError('REVISION_CONFLICT', 'The change no longer matches its source.')
    const previous = ordered[i - 1]
    if (previous && (change.start < previous.end || (change.start === previous.start && change.end === previous.end))) {
      throw new ProtocolError('INVALID_ARGUMENT', 'Operations overlap or insert at the same source position.')
    }
  }
  let result = markdown
  for (const change of ordered.reverse()) result = result.slice(0, change.start) + change.text + result.slice(change.end)
  assertText(result)
  return result
}

/** Markdown payloads are exact source edits, including any desired paragraph separators. */
export function applyOperations(snapshot: DocumentSnapshot, operations: BlockOperation[], quota: EditQuota = 'proposal') {
  if (!operations.length || operations.length > limits.operations) throw new ProtocolError('INVALID_ARGUMENT', 'Invalid operation count.')
  const replacementLimit = quota === 'recovery' ? limits.documentBytes : limits.replacementBytes
  let replacementBytes = 0
  const changes = operations.map(operation => {
    const text = operation.kind === 'deleteBlock' ? '' : normalizeMarkdown(operation.markdown)
    assertText(text, replacementLimit)
    replacementBytes += byteLength(text)
    if (operation.kind === 'insertAtStart') {
      if (snapshot.markdown.length) throw new ProtocolError('INVALID_ARGUMENT', 'insertAtStart requires an empty document.')
      return { start: 0, end: 0, text, before: '' }
    }
    const block = snapshot.blocks.find(item => item.blockId === operation.blockId)
    if (!block) throw new ProtocolError('STALE_BLOCK_REF', 'The block does not belong to the requested document snapshot.')
    const start = operation.kind === 'insertAfterBlock' ? block.end : block.start
    const end = operation.kind === 'replaceBlock' || operation.kind === 'deleteBlock' ? block.end : start
    return { start, end, text, before: snapshot.markdown.slice(start, end) }
  })
  if (replacementBytes > replacementLimit) throw new ProtocolError('PAYLOAD_TOO_LARGE', 'Replacement text exceeds the published byte limit.')
  const markdown = applyTextChanges(snapshot.markdown, changes, quota)
  return { markdown, rawText: serializeMarkdown(snapshot.rawText, markdown), changes }
}
