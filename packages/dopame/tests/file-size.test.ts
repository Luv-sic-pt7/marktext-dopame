import { expect, test } from 'bun:test'
import { FilePort } from '../app/src/file-port'
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
