import { chmodSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AgentError, PROTOCOL, fault, strict } from './protocol'
import type { StateStore } from './state-store'

const methods = new Set([
  'listCapabilities',
  'describeCapability',
  'submit',
  'getTask',
  'getResult',
  'cancelTask',
  'listEvents',
  'readArtifact',
  'artifacts.beginUpload',
  'artifacts.writeChunk',
  'artifacts.commitUpload',
  'artifacts.abortUpload',
  'grants.share',
  'grants.revoke'
])

/** A loopback ingress for paired clients; administrator and worker operations stay on the private pipe. */
export function startPublicGateway(store: StateStore) {
  let inFlight = 0
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    maxRequestBodySize: 128 * 1024,
    idleTimeout: 10,
    async fetch(request) {
      const reply = (value: unknown, status = 200) =>
        Response.json(value, {
          status,
          headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
        })
      try {
        const url = new URL(request.url)
        if (
          request.headers.has('origin') ||
          url.hostname !== '127.0.0.1' ||
          url.port !== String(server.port)
        )
          throw new AgentError('PERMISSION_DENIED', '该入口仅供本机配对工具进程使用')
        if (request.method !== 'POST' || url.pathname !== '/marktext-agent/v1' || url.search)
          return reply(
            {
              ok: false,
              error: { code: 'INVALID_ARGUMENT', message: '无效的服务路由', retryable: false }
            },
            404
          )
        if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json')
          throw new AgentError('INVALID_ARGUMENT', '需要 application/json')
        const authorization = request.headers.get('authorization') ?? ''
        if (!/^Bearer [a-f0-9]{64}$/.test(authorization))
          throw new AgentError('PERMISSION_DENIED', '需要配对凭证')
        const token = authorization.slice(7)
        store.client(token)
        if (inFlight >= 16) throw new AgentError('QUEUE_LIMIT', '工具请求过多', undefined, true)
        inFlight++
        try {
          const payload = await request.json()
          strict(payload, ['method', 'args'], ['method'])
          if (!methods.has(payload.method))
            throw new AgentError('PERMISSION_DENIED', '此入口不提供该方法')
          return reply(store.dispatch({ method: payload.method, token, args: payload.args ?? {} }))
        } finally {
          inFlight--
        }
      } catch (error) {
        const failure =
          error instanceof SyntaxError
            ? fault(new AgentError('INVALID_ARGUMENT', '请求 JSON 无效'))
            : fault(error)
        return reply(
          { ok: false, error: failure },
          failure.code === 'PERMISSION_DENIED' ? 403 : 400
        )
      }
    }
  })
  const path = join(store.stateDir, 'endpoint.json'),
    temporary = path + '.' + process.pid
  const endpoint = {
    protocol: PROTOCOL,
    url: 'http://127.0.0.1:' + server.port + '/marktext-agent/v1',
    processId: process.pid
  }
  writeFileSync(temporary, JSON.stringify(endpoint), { mode: 0o600 })
  renameSync(temporary, path)
  chmodSync(path, 0o600)
  return {
    endpoint,
    path,
    close() {
      server.stop(true)
      try {
        if (JSON.parse(readFileSync(path, 'utf8')).processId === process.pid) unlinkSync(path)
      } catch {}
    }
  }
}
