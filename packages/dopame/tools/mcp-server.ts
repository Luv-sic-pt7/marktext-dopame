import { McpBridge } from '../mcp-bridge'
import { HttpTransport, readPrivateJson } from '../http-transport'
import { PROTOCOL } from '../protocol'

const options = new Map<string, string>()
for (let n = 2; n < process.argv.length; n += 2) {
  if (!['--endpoint-file', '--credential-file'].includes(process.argv[n]) || !process.argv[n + 1])
    throw new Error('Use --endpoint-file PATH --credential-file PATH')
  options.set(process.argv[n], process.argv[n + 1])
}
const endpoint = options.get('--endpoint-file'),
  credentialPath = options.get('--credential-file')
if (!endpoint || !credentialPath) throw new Error('Both endpoint and credential files are required')
const credential = readPrivateJson(credentialPath)
if (
  credential.protocol !== PROTOCOL ||
  !/^[a-f0-9]{64}$/.test(credential.token) ||
  ['administrator', 'marktext-worker'].includes(credential.clientId)
)
  throw new Error('A paired client credential is required')
const bridge = new McpBridge(new HttpTransport(endpoint), credential.token)
let buffer = Buffer.alloc(0)
const pending = new Set<Promise<void>>()
function send(message: any) {
  if (message !== null) process.stdout.write(JSON.stringify(message) + '\n')
}
for await (const chunk of process.stdin) {
  buffer = Buffer.concat([buffer, Buffer.from(chunk)])
  let index: number
  while ((index = buffer.indexOf(10)) >= 0) {
    const line = buffer.subarray(0, index)
    buffer = buffer.subarray(index + 1)
    if (line.length > 128 * 1024) throw new Error('MCP input exceeded the message limit')
    if (!line.length) continue
    if (pending.size >= 16) await Promise.race(pending)
    const work = (async () => {
      try {
        send(
          await bridge.handle(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)))
        )
      } catch {
        send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
      }
    })()
    pending.add(work)
    void work.finally(() => pending.delete(work))
  }
  if (buffer.length > 128 * 1024) throw new Error('MCP input exceeded the message limit')
}
await Promise.allSettled(pending)
