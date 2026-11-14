import type { Resource } from './files'
import { Lexer } from 'marked'
import { DocumentController } from './domain/documentController.ts'
import { normalizeMarkdown } from './domain/collaboration.ts'

export const documentController = new DocumentController()

export interface DocumentTab {
  id: string
  name: string
  text: string
  savedText: string | null
  resource: Resource | null
  mode: 'edit' | 'source' | 'read'
  revision: number
  saving: boolean
  bom: boolean
  eol: '\n' | '\r\n'
}

export function createDocument(name: string, text = '', resource: Resource | null = null): DocumentTab {
  return { id: crypto.randomUUID(), name, text, savedText: resource ? text : null,
    resource, mode: 'edit', revision: 0, saving: false, bom: text.startsWith('\uFEFF'),
    eol: text.includes('\r\n') ? '\r\n' : '\n' }
}

export function editorText(text: string) {
  return normalizeMarkdown(text)
}

export function updateDocument(tab: DocumentTab, markdown: string) {
  documentController.update(tab, markdown)
}

export function isDirty(tab: DocumentTab) {
  return tab.savedText !== tab.text
}

export function outline(text: string) {
  let line = 0
  return Lexer.lex(editorText(text)).flatMap(token => {
    const start = line
    line += (token.raw.match(/\n/g) ?? []).length
    return token.type === 'heading'
      ? [{ lvl: token.depth, content: token.text, slug: '', line: start }] : []
  })
}
