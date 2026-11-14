import type { ServiceContext, ServiceFactory, ServiceProcess } from '@dopame/acde-api'
import type { DocumentsService } from '../src/agentClient'
import {
  failure, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES,
  transportError, type PublicMethod, type WorkerResponse
} from '../src/transport'

interface PendingCall {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

class WorkerBridge {
  private worker?: ServiceProcess
  private pending = new Map<string, PendingCall>()
  private sequence = 0
  private available = false
  private stopped = false
  private reason = 'Document state worker is starting.'
  private startupTimer?: ReturnType<typeof setTimeout>
  private ready: Promise<void>
  private resolveReady!: () => void
  private rejectReady!: (error: Error) => void

  constructor(ctx: ServiceContext) {
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve
      this.rejectReady = reject
    })
    // Status can be queried before any business call waits for startup.
    void this.ready.catch(() => {})
    const executable = ctx.env.MARKTEXT_BUN
    if (!executable || !/^(?:\/|[a-z]:[\\/])/i.test(executable)) {
      this.unavailable('A verified absolute Bun path must be configured in MARKTEXT_BUN.')
      return
    }
    this.startupTimer = setTimeout(() => {
      this.unavailable('Document state worker did not become ready.')
      this.worker?.kill('SIGTERM')
    }, 10000)
    try {
      this.worker = ctx.spawn([executable, `${ctx.package}/desktop/state-worker.js`, ctx.state], {
        cwd: ctx.state,
        onLine: line => this.receive(line),
        onExit: () => this.unavailable('Document state worker is unavailable; restart the desktop service.')
      })
    } catch {
      this.unavailable('The configured document state runtime could not be started.')
    }
  }

  status() {
    return {
      available: this.available,
      ...(!this.available ? { reason: this.reason } : {}),
      mode: 'proposal-preview' as const
    }
  }

  private unavailable(reason: string) {
    this.available = false
    this.stopped = true
    this.reason = reason
    clearTimeout(this.startupTimer)
    const error = failure('RESOURCE_UNAVAILABLE', reason, true)
    this.rejectReady(error)
    for (const call of this.pending.values()) {
      clearTimeout(call.timer)
      call.reject(error)
    }
    this.pending.clear()
  }

  private receive(line: string) {
    if (new TextEncoder().encode(line).length > MAX_RESPONSE_BYTES) {
      this.unavailable('Document state worker exceeded the response limit.')
      this.worker?.kill('SIGTERM')
      return
    }
    try {
      const message = JSON.parse(line)
      if (message?.type === 'ready' && !this.available && !this.stopped) {
        clearTimeout(this.startupTimer)
        this.available = true
        this.resolveReady()
        return
      }
      if (message?.type === 'unavailable') {
        this.unavailable('Document state storage could not be opened safely.')
        return
      }
      if (!message || typeof message.id !== 'string') throw failure('INVALID_ARGUMENT', 'Invalid worker response.')
      const response = message as WorkerResponse
      const call = this.pending.get(message.id)
      if (!call) return
      clearTimeout(call.timer)
      this.pending.delete(message.id)
      if ('error' in response) {
        const error = transportError(response.error)
        call.reject(Object.assign(new Error(error.message), error))
      } else call.resolve(response.result)
    } catch {
      this.unavailable('Document state worker returned an invalid response.')
      this.worker?.kill('SIGTERM')
    }
  }

  async call(method: PublicMethod, args: unknown[]) {
    await this.ready
    const worker = this.worker
    if (!this.available || !worker) throw failure('RESOURCE_UNAVAILABLE', this.reason, true)
    if (this.pending.size >= 64) throw failure('RATE_LIMITED', 'Too many document requests are pending.', true)
    const id = String(++this.sequence)
    const line = JSON.stringify({ id, method, args }) + '\n'
    if (new TextEncoder().encode(line).length > MAX_REQUEST_BYTES) {
      throw failure('PAYLOAD_TOO_LARGE', 'Document request exceeds the transport limit.')
    }
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(failure('RESULT_NOT_READY', 'The request timed out; query its requestId or task before retrying.', true))
      }, 15000)
      this.pending.set(id, { resolve, reject, timer })
      try {
        const accepted = worker.write(line)
        if (!accepted) this.unavailable('Document state worker is not accepting requests.')
      } catch {
        this.unavailable('Document state worker is unavailable.')
      }
    })
  }

  close() {
    this.unavailable('Document service was stopped.')
    this.worker?.end()
  }
}

const factory: ServiceFactory = ctx => {
  const bridge = new WorkerBridge(ctx)
  const api: DocumentsService = {
    status: async() => bridge.status(),
    describe: auth => bridge.call('describe', [auth]),
    invoke: (auth, request) => bridge.call('invoke', [auth, request]),
    getTask: (auth, taskId) => bridge.call('getTask', [auth, taskId]),
    cancelTask: (auth, taskId) => bridge.call('cancelTask', [auth, taskId]),
    listEvents: (auth, cursor, limit) => {
      const args: unknown[] = [auth]
      if (cursor !== undefined || limit !== undefined) args.push(cursor ?? null)
      if (limit !== undefined) args.push(limit)
      return bridge.call('listEvents', args)
    },
    requestPairing: input => bridge.call('requestPairing', [input]),
    claimPairing: (pairingId, claimSecret) => bridge.call('claimPairing', [pairingId, claimSecret])
  }
  return { api: { marktextdocs: api }, close: () => bridge.close() }
}

export default factory
