import type { DocumentTab } from '../document'
import type { Resource } from '../files'
import { serializeMarkdown } from './collaboration.ts'

export interface SaveSnapshot {
  text: string
  revision: number
  resource: Resource | null
  name: string
}

/** Captures editor state once so an earlier save cannot acknowledge later input. */
export class DocumentController {
  update(tab: DocumentTab, markdown: string) {
    const text = serializeMarkdown(tab.text, markdown, tab.bom, tab.eol)
    if (text === tab.text) return
    tab.text = text
    tab.revision++
  }

  captureSave(tab: DocumentTab): SaveSnapshot {
    return { text: tab.text, revision: tab.revision, resource: tab.resource, name: tab.name }
  }

  acknowledgeSave(tab: DocumentTab, snapshot: SaveSnapshot, resource: Resource, name = snapshot.name) {
    tab.resource = resource
    tab.name = name
    tab.savedText = snapshot.text
  }
}
