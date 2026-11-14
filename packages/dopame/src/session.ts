import type { DocumentTab } from './document'

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validResource(value: unknown) {
  if (value === null) return true
  if (!record(value) || value.kind !== 'root' || typeof value.root !== 'string' || !value.root) return false
  if (typeof value.path !== 'string' || !value.path || /(^[/\\]|\\)/.test(value.path)) return false
  if (value.path.split('/').some(part => !part || part === '.' || part === '..')) return false
  return value.version === undefined || typeof value.version === 'string'
}

function validTab(value: unknown): value is DocumentTab {
  if (!record(value)) return false
  return typeof value.id === 'string' && value.id.length > 0
    && typeof value.name === 'string' && value.name.length > 0
    && typeof value.text === 'string'
    && (typeof value.savedText === 'string' || value.savedText === null)
    && validResource(value.resource)
    && ['edit', 'source', 'read'].includes(value.mode as string)
    && Number.isSafeInteger(value.revision) && (value.revision as number) >= 0
    && typeof value.saving === 'boolean' && typeof value.bom === 'boolean'
    && (value.eol === '\n' || value.eol === '\r\n')
}

export function parseSession(text: string): { version: 1; activeId: string; tabs: DocumentTab[] } {
  try {
    const session: unknown = JSON.parse(text)
    if (!record(session) || session.version !== 1 || typeof session.activeId !== 'string'
      || !Array.isArray(session.tabs) || !session.tabs.every(validTab)) throw new Error()
    const ids = session.tabs.map(tab => tab.id)
    if (new Set(ids).size !== ids.length) throw new Error()
    return { version: 1, activeId: session.activeId,
      tabs: session.tabs.map(tab => ({ ...tab, saving: false })) }
  } catch {
    throw new Error('无法读取草稿格式，原记录未覆盖')
  }
}
