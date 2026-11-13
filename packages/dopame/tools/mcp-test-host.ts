import { resolve } from 'node:path'
/** A deterministic stdio host for tests; this does not run a model or count as a real Agent session. */
export async function mcpTestHost(
  endpoint: string,
  credential: string,
  entry = resolve(import.meta.dir, 'mcp-server.ts')
) {
  const child = Bun.spawn(
    [process.execPath, entry, '--endpoint-file', endpoint, '--credential-file', credential],
    { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' }
  )
  let seq = 0,
    buffer = ''
  const pending = new Map<
    number,
    { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
  >()
  const reading = (async () => {
    const decoder = new TextDecoder()
    for await (const chunk of child.stdout) {
      buffer += decoder.decode(chunk, { stream: true })
      if (buffer.length > 16 * 1024 * 1024) throw new Error('MCP response exceeded the limit')
      let at: number
      while ((at = buffer.indexOf('\n')) >= 0) {
        const response = JSON.parse(buffer.slice(0, at))
        buffer = buffer.slice(at + 1)
        const item = pending.get(response.id)
        if (item) {
          clearTimeout(item.timer)
          pending.delete(response.id)
          item.resolve(response)
        }
      }
    }
  })()
  void reading.catch(() => {
    for (const item of pending.values()) {
      clearTimeout(item.timer)
      item.reject(new Error('MCP process stopped'))
    }
    pending.clear()
  })
  const stderr = new Response(child.stderr).text()
  const rpc = (method: string, params: any = {}) =>
    new Promise<any>((resolveReply, reject) => {
      const id = ++seq
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error('MCP test call timed out'))
      }, 15000)
      pending.set(id, { resolve: resolveReply, reject, timer })
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  await rpc('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'deterministic-verifier', version: '0.1.0' }
  })
  return {
    rpc,
    async call(name: string, args: any = {}) {
      const response = await rpc('tools/call', { name: 'marktext_' + name, arguments: args })
      if (response.error) throw new Error('MCP protocol error')
      const result = response.result.structuredContent
      if (!result.ok) {
        const error = new Error(result.error.message) as Error & { code: string }
        error.code = result.error.code
        throw error
      }
      return result.value
    },
    async close() {
      child.stdin.end()
      const timer = setTimeout(() => child.kill(), 3000)
      await child.exited
      clearTimeout(timer)
      await reading
      if ((await stderr).trim()) throw new Error('MCP process reported an error')
    }
  }
}
