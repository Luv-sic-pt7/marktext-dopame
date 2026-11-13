import { StateStore } from './state-store'
import { startPublicGateway } from './public-gateway'

process.umask(0o077)
const directory = process.argv[2]
if (!directory) throw new Error('A service-owned state directory is required')
const store = new StateStore(directory)
const gateway = startPublicGateway(store)
let closed = false
function close() {
  if (!closed) {
    closed = true
    gateway.close()
    store.close()
  }
}
process.on('SIGTERM', () => {
  close()
  process.exit(0)
})
process.on('SIGINT', () => {
  close()
  process.exit(0)
})
const maximum = 16 * 1024 * 1024
let buffer = Buffer.alloc(0)
const output = (value: any) => process.stdout.write(JSON.stringify(value) + '\n')
output({ ready: true, protocol: 'marktext-agent/1' })
for await (const chunk of process.stdin) {
  buffer = Buffer.concat([buffer, Buffer.from(chunk)])
  if (buffer.length > maximum) {
    output({
      id: null,
      response: {
        ok: false,
        error: { code: 'INVALID_ARGUMENT', message: '服务消息超过上限', retryable: false }
      }
    })
    process.exitCode = 1
    break
  }
  let index: number
  while ((index = buffer.indexOf(10)) !== -1) {
    const line = buffer.subarray(0, index)
    buffer = buffer.subarray(index + 1)
    if (!line.length) continue
    let seq: any = null
    try {
      const message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line))
      if (
        !Number.isSafeInteger(message.id) ||
        message.id < 1 ||
        Object.keys(message).some((k) => !['id', 'request'].includes(k))
      )
        throw new Error('Invalid pipe envelope')
      seq = message.id
      output({ id: seq, response: store.dispatch(message.request) })
    } catch {
      output({
        id: seq,
        response: {
          ok: false,
          error: { code: 'INVALID_ARGUMENT', message: '无法解析服务消息', retryable: false }
        }
      })
    }
  }
}
close()
