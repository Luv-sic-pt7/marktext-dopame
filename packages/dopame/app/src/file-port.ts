import type { AcdeFs, FinderRoot } from '@dopame/acde-api'
import { AgentError, LIMITS, boundedText, id } from '../../protocol'

export type Resource =
  { kind: 'root'; root: string; path: string } | { kind: 'handle'; key: string; name: string }
export interface Stamp {
  version?: string
  modifiedMs: number
  size: number
  base64: string
}
export interface Format {
  bom: boolean
  newline: 'lf' | 'crlf'
}
export interface ReadDocument {
  title: string
  text: string
  format: Format
  resource: Resource
  stamp: Stamp
  readOnly: boolean
}
export const toBase64 = (data: Uint8Array) => {
  let text = ''
  for (let n = 0; n < data.length; n += 8192)
    text += String.fromCharCode(...data.subarray(n, n + 8192))
  return btoa(text)
}
export const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0))
export function decodeFile(data: Uint8Array): { text: string; format: Format } {
  if (data.length > LIMITS.text)
    throw new AgentError('FILE_TOO_LARGE', '首版支持最多 2MiB 的文档，原文件未改动')
  const bom = data[0] === 239 && data[1] === 187 && data[2] === 191
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bom ? data.subarray(3) : data)
  } catch {
    throw new AgentError('UNSUPPORTED_ENCODING', '需要 UTF-8 文档，请转换编码后重新打开')
  }
  const newline = text.includes('\r\n') ? 'crlf' : 'lf'
  return { text: text.replace(/\r\n?/g, '\n'), format: { bom, newline } }
}
export function encodeFile(text: string, format: Format): Uint8Array {
  boundedText(text, '文档')
  let result = format.newline === 'crlf' ? text.replace(/\r?\n/g, '\r\n') : text
  if (format.bom) result = '\ufeff' + result
  const bytes = new TextEncoder().encode(result)
  if (bytes.length > LIMITS.text)
    throw new AgentError('FILE_TOO_LARGE', '保存后的文件将超过 2MiB（含 BOM 和换行），原文件未改动')
  return bytes
}
export function bytesForSave(text: string, format: Format, baseline: Stamp | null) {
  return baseline && decodeFile(fromBase64(baseline.base64)).text === text
    ? fromBase64(baseline.base64)
    : encodeFile(text, format)
}
const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((v, i) => v === b[i])
function ioError(error: any): never {
  if (error instanceof AgentError) throw error
  if (error?.name === 'AbortError') throw new AgentError('CANCELLED', '已取消文件选择')
  if (error?.code === 'ECONFLICT')
    throw new AgentError('FILE_CONFLICT', '磁盘内容已变化，当前草稿已保留，请载入磁盘版本或另存为')
  if (['EACCES', 'denied'].includes(error?.code) || error?.name === 'NotAllowedError')
    throw new AgentError('PERMISSION_DENIED', '文件不可写或授权已撤销，当前草稿已保留')
  throw new AgentError(
    error?.code === 'ENOSPC' ? 'DISK_FULL' : 'IO_ERROR',
    '文件操作失败，当前草稿已保留',
    undefined,
    true
  )
}

export class FilePort {
  private versions = new Map<string, string>()
  private handles = new Map<string, FileSystemFileHandle>()
  constructor(readonly fs: AcdeFs) {}
  private checkSize(size: number) {
    if (size > LIMITS.text)
      throw new AgentError('FILE_TOO_LARGE', '首版支持最多 2MiB 的文档，文件未改动')
  }
  async roots(): Promise<FinderRoot[]> {
    return this.fs.roots()
  }
  async list(root: string, path = '') {
    return this.fs.list(root, path, false)
  }
  async chooseFolder() {
    await window.showDirectoryPicker({ mode: 'readwrite' })
    return this.roots()
  }
  async revokeFolder(root: string) {
    return this.fs.revoke(root)
  }
  private async database(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const r = indexedDB.open('marktext-file-handles', 1)
      r.onupgradeneeded = () => r.result.createObjectStore('handles')
      r.onsuccess = () => resolve(r.result)
      r.onerror = () => reject(r.error)
    })
  }
  private async remember(key: string, handle: FileSystemFileHandle) {
    this.handles.set(key, handle)
    try {
      const db = await this.database()
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('handles', 'readwrite')
        tx.objectStore('handles').put(handle, key)
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
      db.close()
    } catch {
      /* The private draft is still durable when this runtime cannot clone a handle. */
    }
  }
  private async handle(resource: Extract<Resource, { kind: 'handle' }>) {
    let handle = this.handles.get(resource.key)
    if (!handle) {
      try {
        const db = await this.database()
        handle = await new Promise<FileSystemFileHandle | undefined>((resolve, reject) => {
          const r = db.transaction('handles').objectStore('handles').get(resource.key)
          r.onsuccess = () => resolve(r.result)
          r.onerror = () => reject(r.error)
        })
        db.close()
        if (handle?.kind === 'file' && typeof handle.getFile === 'function')
          this.handles.set(resource.key, handle)
      } catch {}
    }
    if (!handle || handle.kind !== 'file' || typeof handle.getFile !== 'function')
      throw new AgentError('RESELECT_FILE', '外部文件需要重新选择，已恢复的草稿可先另存为')
    return handle
  }
  async readRoot(root: string, path: string): Promise<ReadDocument> {
    try {
      this.checkSize((await this.fs.stat(root, path)).size)
      const data = await this.fs.readBytes(root, path)
      const parsed = decodeFile(data.data)
      const r = (await this.roots()).find((r) => r.id === root)
      return {
        title: path.split('/').at(-1) ?? '文档',
        ...parsed,
        resource: { kind: 'root', root, path },
        stamp: {
          version: data.version,
          modifiedMs: data.modifiedMs,
          size: data.size,
          base64: toBase64(data.data)
        },
        readOnly: r?.mode !== 'writable'
      }
    } catch (e) {
      return ioError(e)
    }
  }
  async readHandle(
    handle: FileSystemFileHandle,
    readOnly = false,
    existing: Resource[] = []
  ): Promise<ReadDocument> {
    try {
      const file = await handle.getFile()
      this.checkSize(file.size)
      const data = new Uint8Array(await file.arrayBuffer())
      const parsed = decodeFile(data)
      let key = ''
      for (const resource of existing) {
        if (resource.kind !== 'handle') continue
        let previous: FileSystemFileHandle
        try {
          previous = await this.handle(resource)
        } catch (error) {
          if (error instanceof AgentError && error.code === 'RESELECT_FILE') continue
          throw error
        }
        if (await handle.isSameEntry(previous)) {
          key = resource.key
          break
        }
      }
      if (!key) key = crypto.randomUUID()
      await this.remember(key, handle)
      return {
        title: file.name,
        ...parsed,
        resource: { kind: 'handle', key, name: file.name },
        stamp: { modifiedMs: file.lastModified, size: file.size, base64: toBase64(data) },
        readOnly
      }
    } catch (e) {
      return ioError(e)
    }
  }
  async openFiles(onError?: (error: unknown, name: string) => void, existing: Resource[] = []) {
    try {
      const handles = await window.showOpenFilePicker({
        multiple: true,
        types: [
          {
            description: 'Markdown 和文本',
            accept: { 'text/markdown': ['.md', '.markdown'], 'text/plain': ['.txt'] }
          }
        ]
      })
      const docs = []
      for (const h of handles) {
        try {
          docs.push(await this.readHandle(h, false, existing))
        } catch (error) {
          if (!onError) throw error
          onError(error, h.name)
        }
      }
      return docs
    } catch (e) {
      return ioError(e)
    }
  }
  async saveAsResource(title: string): Promise<{ resource: Resource; stamp: Stamp | null }> {
    try {
      const h = await window.showSaveFilePicker({
        suggestedName: /\.(md|markdown|txt)$/i.test(title) ? title : title + '.md',
        types: [{ description: 'Markdown', accept: { 'text/markdown': ['.md'] } }]
      })
      const key = crypto.randomUUID()
      await this.remember(key, h)
      let stamp: Stamp | null = null
      try {
        const file = await h.getFile()
        this.checkSize(file.size)
        const bytes = new Uint8Array(await file.arrayBuffer())
        stamp = { modifiedMs: file.lastModified, size: file.size, base64: toBase64(bytes) }
      } catch (error: any) {
        if (error?.name !== 'NotFoundError' && error?.code !== 'ENOENT') throw error
      }
      return {
        resource: { kind: 'handle', key, name: h.name },
        stamp
      }
    } catch (e) {
      return ioError(e)
    }
  }
  newPrivateResource(documentId: string): Resource {
    id(documentId)
    return { kind: 'root', root: 'private', path: 'notes/' + documentId + '.md' }
  }
  async current(resource: Resource): Promise<Stamp> {
    try {
      if (resource.kind === 'root') {
        this.checkSize((await this.fs.stat(resource.root, resource.path)).size)
        const r = await this.fs.readBytes(resource.root, resource.path)
        return {
          version: r.version,
          modifiedMs: r.modifiedMs,
          size: r.size,
          base64: toBase64(r.data)
        }
      }
      const f = await (await this.handle(resource)).getFile()
      this.checkSize(f.size)
      return {
        modifiedMs: f.lastModified,
        size: f.size,
        base64: toBase64(new Uint8Array(await f.arrayBuffer()))
      }
    } catch (e) {
      return ioError(e)
    }
  }
  async save(
    documentId: string,
    text: string,
    format: Format,
    resource: Resource,
    baseline: Stamp | null
  ): Promise<{ stamp: Stamp; inPlace: boolean; unchanged: boolean }> {
    try {
      const bytes = bytesForSave(text, format, baseline)
      if (baseline) {
        const disk = await this.current(resource)
        if (
          resource.kind === 'root'
            ? disk.version !== baseline.version
            : !sameBytes(fromBase64(disk.base64), fromBase64(baseline.base64))
        )
          throw new AgentError('FILE_CONFLICT', '磁盘内容已变化，当前草稿已保留')
        if (sameBytes(bytes, fromBase64(baseline.base64)))
          return { stamp: disk, inPlace: false, unchanged: true }
        await this.fs.writeFile(
          'private',
          'recovery/' + id(documentId) + '.bin',
          fromBase64(baseline.base64),
          { mkdirs: true }
        )
      }
      if (resource.kind === 'root') {
        const saved = await this.fs.writeFile(resource.root, resource.path, bytes, {
          mkdirs: true,
          ...(baseline
            ? { ifVersion: baseline.version, create: 'never' as const }
            : { create: 'new' as const })
        })
        const disk = await this.current(resource)
        if (!sameBytes(bytes, fromBase64(disk.base64)))
          throw new AgentError('FILE_CONFLICT', '保存后发现并发修改，草稿与恢复副本已保留')
        return { stamp: disk, inPlace: !!saved.inPlace, unchanged: false }
      }
      const writable = await (await this.handle(resource)).createWritable()
      try {
        await writable.write(bytes as Uint8Array<ArrayBuffer>)
        await writable.close()
      } catch (e) {
        try {
          await writable.abort()
        } catch {}
        throw e
      }
      const disk = await this.current(resource)
      if (!sameBytes(bytes, fromBase64(disk.base64)))
        throw new AgentError('FILE_CONFLICT', '文件在保存期间变化，当前草稿与恢复副本已保留')
      return { stamp: disk, inPlace: false, unchanged: false }
    } catch (e) {
      return ioError(e)
    }
  }
  async checkpoint<T>(documentId: string): Promise<T | null> {
    return this.jsonRead<T>('checkpoints/' + id(documentId) + '.json')
  }
  async putCheckpoint(documentId: string, value: any) {
    return this.jsonWrite('checkpoints/' + id(documentId) + '.json', value)
  }
  // A failed write may have committed; never roll back a different writer's checkpoint.
  async rollbackCheckpoint(documentId: string, expected: unknown, restored: unknown) {
    const path = 'checkpoints/' + id(documentId) + '.json'
    try {
      const current = await this.fs.readText('private', path)
      if (JSON.stringify(JSON.parse(current.text)) !== JSON.stringify(expected)) return false
      const saved = await this.fs.writeFile('private', path, JSON.stringify(restored), {
        ifVersion: current.version,
        create: 'never'
      })
      this.versions.set(path, saved.version ?? (await this.fs.readText('private', path)).version)
      return true
    } catch (error) {
      return ioError(error)
    }
  }
  async checkpointIds() {
    try {
      const r = await this.fs.list('private', 'checkpoints')
      return {
        ids: r.entries
          .filter((e) => e.kind === 'file' && /^[a-zA-Z0-9-]+\.json$/.test(e.name))
          .map((e) => e.name.slice(0, -5)),
        truncated: r.truncated
      }
    } catch (e: any) {
      if (e?.code === 'ENOENT') return { ids: [], truncated: false }
      return ioError(e)
    }
  }
  async jsonRead<T>(path: string): Promise<T | null> {
    try {
      const r = await this.fs.readText('private', path)
      this.versions.set(path, r.version)
      return JSON.parse(r.text)
    } catch (e: any) {
      if (e?.code === 'ENOENT') return null
      return ioError(e)
    }
  }
  async jsonWrite(path: string, value: any) {
    try {
      let version = this.versions.get(path)
      if (!version) {
        try {
          const old = await this.fs.readText('private', path)
          version = old.version
          this.versions.set(path, version)
        } catch (e: any) {
          if (e?.code !== 'ENOENT') throw e
        }
      }
      const r = await this.fs.writeFile('private', path, JSON.stringify(value), {
        mkdirs: true,
        ...(version ? { ifVersion: version } : { create: 'new' as const })
      })
      if (r.version) this.versions.set(path, r.version)
      else this.versions.set(path, (await this.fs.readText('private', path)).version)
    } catch (e) {
      return ioError(e)
    }
  }
  async relativeImage(
    resource: Resource | null,
    href: string
  ): Promise<{ url: string; size: number } | null> {
    if (!resource || resource.kind !== 'root' || /^(?:[a-z]+:|\/|#)/i.test(href)) return null
    let decoded: string
    try {
      decoded = decodeURIComponent(href.split(/[?#]/)[0])
    } catch {
      return null
    }
    const parts = resource.path.split('/').slice(0, -1)
    for (const part of decoded.split('/')) {
      if (part === '..') {
        if (!parts.length) return null
        parts.pop()
      } else if (part && part !== '.') parts.push(part)
    }
    const path = parts.join('/')
    const extension = path.split('.').at(-1)?.toLowerCase()
    const type = (
      {
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        gif: 'image/gif',
        webp: 'image/webp'
      } as Record<string, string>
    )[extension ?? '']
    if (!type) return null
    if ((await this.fs.stat(resource.root, path)).size > 8 * 1024 * 1024) return null
    const r = await this.fs.readBytes(resource.root, path)
    if (r.size > 8 * 1024 * 1024) return null
    return {
      url: 'data:' + type + ';base64,' + toBase64(r.data),
      size: r.size
    }
  }
}
