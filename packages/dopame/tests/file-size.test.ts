import { expect, test } from 'bun:test'
import { FilePort, bytesForSave, decodeFile, encodeFile, toBase64 } from '../app/src/file-port'
import { LIMITS } from '../protocol'

test('oversized external files and images are rejected before loading their contents', async () => {
  let reads = 0
  const files = new FilePort({
    async stat() {
      return { size: 9 * 1024 * 1024 }
    },
    async readBytes() {
      reads++
      throw new Error('Must not read an oversized file')
    }
  } as unknown as FilePort['fs'])
  await expect(files.readRoot('folder-test', 'huge.md')).rejects.toMatchObject({
    code: 'FILE_TOO_LARGE'
  })
  expect(
    await files.relativeImage({ kind: 'root', root: 'folder-test', path: 'notes.md' }, 'huge.png')
  ).toBeNull()
  const handle = {
    async getFile() {
      return {
        size: LIMITS.text + 1,
        async arrayBuffer() {
          reads++
          throw new Error('Must not load this file')
        }
      }
    }
  } as unknown as FileSystemFileHandle
  await expect(files.readHandle(handle)).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' })
  expect(reads).toBe(0)
})

test('the output limit includes BOM and CRLF before any file is written', async () => {
  let writes = 0
  const files = new FilePort({
    async writeFile() {
      writes++
      throw new Error('Must not write an oversized encoded document')
    }
  } as unknown as FilePort['fs'])
  for (const [text, format] of [
    ['a'.repeat(LIMITS.text), { bom: true, newline: 'lf' as const }],
    ['x\n'.repeat(Math.floor(LIMITS.text / 3) + 1), { bom: false, newline: 'crlf' as const }],
    ['😀'.repeat(LIMITS.text / 4), { bom: true, newline: 'lf' as const }]
  ] as const) {
    await expect(
      files.save(
        'encoded-limit',
        text,
        format,
        { kind: 'root', root: 'private', path: 'limit.md' },
        null
      )
    ).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' })
  }
  expect(writes).toBe(0)
})

test('exact encoded size boundaries remain readable with BOM, CRLF and Unicode', () => {
  const samples = [
    ['a'.repeat(LIMITS.text), { bom: false, newline: 'lf' as const }],
    ['a'.repeat(LIMITS.text - 3), { bom: true, newline: 'lf' as const }],
    ['😀'.repeat(LIMITS.text / 4), { bom: false, newline: 'lf' as const }],
    [
      'x\n'.repeat(Math.floor((LIMITS.text - 3) / 3)) + 'ab',
      { bom: true, newline: 'crlf' as const }
    ]
  ] as const
  for (const [text, format] of samples) {
    const bytes = encodeFile(text, format)
    expect(bytes.length).toBe(LIMITS.text)
    expect(decodeFile(bytes).text === text).toBe(true)
  }
})

test('mixed and lone carriage returns stay byte exact until the document is edited', () => {
  for (const raw of ['a\rb\rc\r', 'a\r\nb\rc\nd', '\ufeffa\r\nb\rc\n']) {
    const data = new TextEncoder().encode(raw)
    const { text, format } = decodeFile(data)
    expect(text).not.toContain('\r')
    expect(
      bytesForSave(text, format, { base64: toBase64(data), size: data.length, modifiedMs: 0 })
    ).toEqual(data)
    const edited = encodeFile(text + 'x', format)
    expect(decodeFile(edited).text).toBe(text + 'x')
  }
})
