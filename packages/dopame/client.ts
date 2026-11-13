import {
  AgentError,
  LIMITS,
  PROTOCOL,
  unwrap,
  type ArtifactRef,
  type Envelope,
  type TaskRequest
} from './protocol'

export interface Transport {
  request(payload: { method: string; token?: string; args?: any }): Promise<Envelope>
}
const encode = (data: Uint8Array) => {
  let s = ''
  for (let i = 0; i < data.length; i += 8192)
    s += String.fromCharCode(...data.subarray(i, i + 8192))
  return btoa(s)
}
const decode = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0))
export function createClient(transport: Transport, token: string) {
  const call = async (method: string, args: any = {}) =>
    unwrap(await transport.request({ method, token, args }))
  const client = {
    call,
    listCapabilities: () => call('listCapabilities'),
    describeCapability: (id: string) => call('describeCapability', { id }),
    submit: (request: TaskRequest) => call('submit', { request }),
    getTask: (taskId: string) => call('getTask', { taskId }),
    getResult: (taskId: string) => call('getResult', { taskId }),
    cancelTask: (taskId: string) => call('cancelTask', { taskId }),
    listEvents: (taskId: string, afterSeq = 0) => call('listEvents', { taskId, afterSeq }),
    share: (grant: any) => call('grants.share', grant),
    revoke: (grantId: string) => call('grants.revoke', { grantId }),
    async readArtifact(ref: ArtifactRef, offset: number, length: number) {
      const r = await call('readArtifact', { ref, offset, length })
      return decode(r.base64)
    },
    async readText(ref: ArtifactRef) {
      const parts: Uint8Array[] = []
      for (let n = 0; n < ref.size; n += LIMITS.chunk)
        parts.push(await client.readArtifact(ref, n, Math.min(LIMITS.chunk, ref.size - n)))
      const joined = new Uint8Array(ref.size)
      let at = 0
      for (const p of parts) {
        joined.set(p, at)
        at += p.length
      }
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(joined)
    },
    async upload(text: string, mediaType = 'text/markdown'): Promise<ArtifactRef> {
      const bytes = new TextEncoder().encode(text)
      if (bytes.length > LIMITS.artifact) throw new AgentError('INVALID_ARGUMENT', '产物超过 2MiB')
      const u = await call('artifacts.beginUpload', { mediaType, size: bytes.length })
      for (let offset = 0; offset < bytes.length; offset += LIMITS.chunk)
        await call('artifacts.writeChunk', {
          uploadId: u.uploadId,
          offset,
          base64: encode(bytes.subarray(offset, offset + LIMITS.chunk))
        })
      return call('artifacts.commitUpload', { uploadId: u.uploadId })
    },
    async wait(taskId: string, options: { timeoutMs?: number; signal?: AbortSignal } = {}) {
      const end = Date.now() + (options.timeoutMs ?? 60000)
      let cancellationSent = false
      while (Date.now() < end) {
        if (options.signal?.aborted && !cancellationSent) {
          await client.cancelTask(taskId)
          cancellationSent = true
        }
        const task = await client.getTask(taskId)
        if (['succeeded', 'failed', 'cancelled'].includes(task.state))
          return { task, result: await client.getResult(taskId) }
        await new Promise((r) => setTimeout(r, 150))
      }
      throw new AgentError(
        'RESULT_NOT_READY',
        '任务仍在运行，可凭 taskId 继续查询',
        { taskId },
        true
      )
    },
    request(
      capability: string,
      input: any,
      requestId: string = crypto.randomUUID(),
      extra: Partial<TaskRequest> = {}
    ) {
      return client.submit({
        ...extra,
        protocol: PROTOCOL,
        requestId,
        capability,
        capabilityVersion: 1,
        input
      })
    }
  }
  return client
}
