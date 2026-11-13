import { lstatSync, readFileSync } from 'node:fs'
import { AgentError, PROTOCOL, type Envelope } from './protocol'
import type { Transport } from './client'

export function readPrivateJson(path: string) {
  const stat = lstatSync(path)
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    (process.platform !== 'win32' && stat.mode & 0o077)
  )
    throw new AgentError('PERMISSION_DENIED', '配置文件必须为仅当前用户可读的普通文件')
  if (stat.size > 8192) throw new AgentError('INVALID_ARGUMENT', '配置文件过大')
  return JSON.parse(readFileSync(path, 'utf8'))
}

/** Re-read the private endpoint for each request so service restarts need no credential re-pairing. */
export class HttpTransport implements Transport {
  constructor(readonly endpointFile: string) {}
  async request(payload: { method: string; token?: string; args?: any }): Promise<Envelope> {
    try {
      const endpoint = readPrivateJson(this.endpointFile)
      const url = new URL(endpoint.url)
      if (
        endpoint.protocol !== PROTOCOL ||
        url.protocol !== 'http:' ||
        url.hostname !== '127.0.0.1' ||
        !url.port ||
        url.pathname !== '/marktext-agent/v1' ||
        url.search ||
        url.hash ||
        url.username ||
        url.password
      )
        throw new AgentError('PERMISSION_DENIED', '服务入口必须是本机 MarkText 端点')
      const response = await fetch(url, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + payload.token },
        body: JSON.stringify({ method: payload.method, args: payload.args ?? {} })
      })
      if (Number(response.headers.get('content-length') ?? 0) > 16 * 1024 * 1024)
        throw new AgentError('TRANSPORT_ERROR', '服务响应超过上限')
      const text = await response.text()
      if (text.length > 16 * 1024 * 1024)
        throw new AgentError('TRANSPORT_ERROR', '服务响应超过上限')
      const value = JSON.parse(text)
      if (typeof value?.ok !== 'boolean')
        throw new AgentError('TRANSPORT_ERROR', '服务响应格式无效')
      return value
    } catch (error) {
      if (error instanceof AgentError) throw error
      throw new AgentError(
        'WORKER_UNAVAILABLE',
        '本机协作服务暂不可用；保留原 requestId 后继续查询或重试',
        undefined,
        true
      )
    }
  }
}
