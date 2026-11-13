import { beforeEach, afterEach, test, expect } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { StateStore } from '../state-store'
import { startPublicGateway } from '../public-gateway'
import { HttpTransport } from '../http-transport'
import { McpBridge } from '../mcp-bridge'
import { unwrap } from '../protocol'

let directory: string,
  store: StateStore,
  gateway: ReturnType<typeof startPublicGateway>,
  token: string,
  credentialPath: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'marktext-gateway-'))
  store = new StateStore(directory)
  const paired = unwrap<any>(
    store.dispatch({
      method: 'admin.pair',
      token: store.adminToken,
      args: { clientId: 'writer', label: '写作会话' }
    })
  )
  credentialPath = paired.credentialPath
  token = JSON.parse(readFileSync(credentialPath, 'utf8')).token
  unwrap(
    store.dispatch({
      method: 'admin.grant',
      token: store.adminToken,
      args: { clientId: 'writer', kind: 'workspace', resource: '*', actions: ['create'] }
    })
  )
  gateway = startPublicGateway(store)
})
afterEach(() => {
  gateway.close()
  store.close()
  rmSync(directory, { recursive: true, force: true })
})

test('loopback ingress rejects browser origins, privileged credentials and forged method/identity fields', async () => {
  const send = (body: any, extra: Record<string, string> = {}, credential = token) =>
    fetch(gateway.endpoint.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + credential,
        ...extra
      },
      body: JSON.stringify(body)
    })
  expect(
    (await send({ method: 'listCapabilities' }, { Origin: 'https://untrusted.example' })).status
  ).toBe(403)
  expect((await send({ method: 'admin.connect' })).status).toBe(403)
  expect((await send({ method: 'listCapabilities' }, {}, store.adminToken)).status).toBe(403)
  expect((await send({ method: 'listCapabilities', token: store.adminToken })).status).toBe(400)
  const response = await send({ method: 'listCapabilities' })
  const body = (await response.json()) as any
  expect(body.value.map((c: any) => c.id)).toEqual(['documents.create'])
  expect(JSON.stringify(body).includes(token)).toBe(false)
  const badHost = await send({ method: 'listCapabilities' }, { Host: 'untrusted.example' })
  expect(badHost.status).toBe(403)
})

test('MCP business tools discover authorized schemas and preserve receipt/query semantics', async () => {
  const bridge = new McpBridge(new HttpTransport(gateway.path), token)
  const rpc = (id: number, method: string, params: any = {}) =>
    bridge.handle({ jsonrpc: '2.0', id, method, params })
  expect(
    (await rpc(1, 'initialize', { protocolVersion: '2025-11-25' })).result.serverInfo.name
  ).toBe('marktext-dopame')
  const tools = (await rpc(2, 'tools/list')).result.tools
  expect(tools.some((t: any) => t.name === 'marktext_documents_create')).toBe(true)
  expect(tools.some((t: any) => t.name === 'marktext_documents_apply')).toBe(false)
  expect(tools.some((t: any) => /eval|shell|administrator|worker/.test(t.name))).toBe(false)
  const args = { requestId: 'mcp-stable', input: { title: '工具创建', markdown: '# 中文 😀' } }
  const created = (
    await rpc(3, 'tools/call', { name: 'marktext_documents_create', arguments: args })
  ).result
  const repeated = (
    await rpc(4, 'tools/call', { name: 'marktext_documents_create', arguments: args })
  ).result
  expect(created.structuredContent.value.state).toBe('queued')
  expect(repeated.structuredContent.value.taskId).toBe(created.structuredContent.value.taskId)
  const unknown = (await rpc(5, 'tools/call', { name: 'marktext_documents_apply', arguments: {} }))
    .result
  expect(unknown.isError).toBe(true)
  const task = (
    await rpc(6, 'tools/call', {
      name: 'marktext_get_task',
      arguments: { taskId: created.structuredContent.value.taskId }
    })
  ).result.structuredContent.value
  expect(task.state).toBe('queued')
  expect(store.row('SELECT COUNT(*) AS n FROM tasks').n).toBe(1)
  gateway.close()
  gateway = startPublicGateway(store)
  const refreshed = (await rpc(7, 'tools/list')).result.tools
  expect(refreshed.some((t: any) => t.name === 'marktext_documents_create')).toBe(true)
})

test('the distributed stdio entry speaks JSON-RPC to an independent host process without credentials in output', async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      resolve(import.meta.dir, '../tools/mcp-server.ts'),
      '--endpoint-file',
      gateway.path,
      '--credential-file',
      credentialPath
    ],
    { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' }
  )
  child.stdin.write(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-11-25' }
    }) + '\n'
  )
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n')
  child.stdin.end()
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited
  ])
  expect(exit).toBe(0)
  expect(stderr).toBe('')
  expect(stdout.includes(token)).toBe(false)
  const lines = stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  expect(
    lines
      .find((line) => line.id === 2)
      .result.tools.some((t: any) => t.name === 'marktext_documents_create')
  ).toBe(true)
})
