import type { ServiceFactory } from '@dopame/acde-api'
import { WakePolicy } from './wake-policy'

const maximumMessage = 16 * 1024 * 1024
const unavailable = () => ({
  ok: false,
  error: {
    code: 'WORKER_UNAVAILABLE',
    message: '协作状态进程暂时不可用，请重试原 requestId',
    retryable: true
  }
})
const service: ServiceFactory = async (ctx) => {
  let child: ReturnType<typeof ctx.spawn> | null = null,
    closed = false,
    next = 0,
    bytesInFlight = 0,
    wake: ((context: unknown) => unknown) | null = null
  const waiting = new Map<
    number,
    { resolve: (value: any) => void; timer: ReturnType<typeof setTimeout>; size: number }
  >()
  let ready: Promise<void> = Promise.resolve(),
    restart: ReturnType<typeof setTimeout> | undefined,
    retries = 0
  const settle = (number: number, value: any) => {
    const p = waiting.get(number)
    if (p) {
      clearTimeout(p.timer)
      waiting.delete(number)
      bytesInFlight -= p.size
      p.resolve(value)
    }
  }
  const start = () => {
    ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('State process startup timed out')), 8000)
      const options = {
        onLine(line: string) {
          if (line.length > maximumMessage) {
            ctx.log('state response exceeded the message limit')
            child?.kill()
            return
          }
          try {
            const m = JSON.parse(line)
            if (m.ready === true) {
              clearTimeout(timer)
              resolve()
              return
            }
            if (Number.isSafeInteger(m.id)) settle(m.id, m.response)
          } catch {
            ctx.log('state process returned an invalid response')
          }
        },
        onExit() {
          clearTimeout(timer)
          child = null
          reject(new Error('State process stopped'))
          for (const key of waiting.keys()) settle(key, unavailable())
          if (!closed && retries++ < 3) {
            restart = setTimeout(() => {
              start()
              ready.catch(() => ctx.log('state process restart failed'))
            }, 1000)
          }
        }
      }
      const home = ctx.env.HOME ?? ctx.env.USERPROFILE
      const path = ctx.env.PATH ?? ctx.env.Path ?? '',
        windows = path.includes(';')
      const fromPath = path
        .split(windows ? ';' : ':')
        .filter(Boolean)
        .map((p) => p.replace(/[/\\]$/, '') + '/' + (windows ? 'bun.exe' : 'bun'))
      const candidates = [
        ctx.env.MARKTEXT_BUN,
        ...fromPath,
        ...(home ? [home + '/.bun/bin/bun'] : []),
        '/opt/homebrew/bin/bun',
        '/usr/local/bin/bun',
        '/usr/bin/bun',
        'bun'
      ].filter((x): x is string => !!x)
      for (const binary of candidates) {
        try {
          child = ctx.spawn(
            [binary, ctx.package + '/desktop/runtime/state-process.js', ctx.state],
            options
          )
          break
        } catch {}
      }
      if (!child) {
        clearTimeout(timer)
        reject(
          new Error(
            'Bun 1.4+ is required by the collaboration service; install Bun or configure MARKTEXT_BUN for the desktop'
          )
        )
      }
    })
  }
  start()
  await ready
  async function request(payload: any) {
    try {
      await ready
    } catch {
      return unavailable()
    }
    if (closed || !child) return unavailable()
    let line: string
    try {
      line = JSON.stringify({ id: next + 1, request: payload }) + '\n'
    } catch {
      return {
        ok: false,
        error: { code: 'INVALID_ARGUMENT', message: '请求不可序列化', retryable: false }
      }
    }
    const size = new TextEncoder().encode(line).length
    if (size > maximumMessage || waiting.size >= 32 || bytesInFlight + size > 32 * 1024 * 1024)
      return {
        ok: false,
        error: { code: 'QUEUE_LIMIT', message: '服务传输队列已满或消息过大', retryable: true }
      }
    const seq = ++next
    return new Promise<any>((resolve) => {
      const timer = setTimeout(
        () =>
          settle(seq, {
            ok: false,
            error: {
              code: 'TRANSPORT_TIMEOUT',
              message: '未收到确认，请用原 requestId 查询或重试',
              retryable: true
            }
          }),
        30000
      )
      waiting.set(seq, { resolve, timer, size })
      bytesInFlight += size
      try {
        if (!child!.write(line)) settle(seq, unavailable())
      } catch {
        settle(seq, unavailable())
      }
    })
  }
  const wakePolicy = new WakePolicy(
    () => request({ method: 'health' }),
    async (context) => {
      if (!wake) throw new Error('No authorized wake host')
      await wake(context)
    }
  )
  const maybeWake = (taskId: string | null = null) =>
    wake
      ? wakePolicy.tick(taskId).catch(() => ctx.log('wake status unavailable; tasks retained'))
      : Promise.resolve()
  const wakeTimer = setInterval(() => void maybeWake(), 1000)
  return {
    api: {
      'marktext-agent': {
        async request(payload: any) {
          if (['admin.setWake', 'admin.wakeLog'].includes(payload?.method)) {
            const authenticated = await request({
              method: 'admin.authorizeWake',
              token: payload.token,
              args: {}
            })
            if (!authenticated.ok) return authenticated
            if (payload.method === 'admin.wakeLog')
              return {
                ok: true,
                value: {
                  events: [...wakePolicy.events],
                  maxAttemptsPerOfflineWave: 3,
                  cooldownMs: 10000
                }
              }
            if (typeof payload.args?.callback !== 'function')
              return {
                ok: false,
                error: { code: 'INVALID_ARGUMENT', message: '需要唤醒回调', retryable: false }
              }
            wake = payload.args.callback
            wakePolicy.reset()
            return { ok: true, value: { registered: true } }
          }
          const result = await request(payload)
          if (
            result.ok &&
            (payload?.method === 'submit' || payload?.method === 'admin.approve') &&
            result.value?.state === 'queued'
          )
            void maybeWake(result.value?.taskId ?? null)
          return result
        }
      }
    },
    close() {
      closed = true
      clearInterval(wakeTimer)
      wakePolicy.stop()
      if (restart) clearTimeout(restart)
      for (const seq of waiting.keys()) settle(seq, unavailable())
      child?.end()
    }
  }
}
export default service
