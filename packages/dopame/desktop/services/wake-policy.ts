type WakeContext = {
  ownerAppId: 'marktext-dopame'
  reason: 'queued-document-task'
  taskId: string | null
  attempt: number
}
type Health = {
  ok: boolean
  value?: { workerOnline: boolean; wakeNeeded: boolean; wakeTaskId?: string | null }
}
export class WakePolicy {
  readonly events: {
    at: number
    kind: string
    taskId: string | null
    attempt: number
    ownerAppId: string
  }[] = []
  private inFlight: Promise<void> | null = null
  private lastAttempt = -Infinity
  private attempts = 0
  private stopped = false
  constructor(
    private health: () => Promise<Health>,
    private wake: (context: WakeContext) => Promise<unknown>,
    private clock: () => number = Date.now
  ) {}
  reset() {
    this.attempts = 0
    this.lastAttempt = -Infinity
  }
  stop() {
    this.stopped = true
  }
  tick(taskId: string | null = null) {
    if (this.inFlight || this.stopped) return this.inFlight ?? Promise.resolve()
    const work = this.check(taskId).finally(() => {
      if (this.inFlight === work) this.inFlight = null
    })
    this.inFlight = work
    return work
  }
  private record(kind: string, context: WakeContext) {
    this.events.push({ at: this.clock(), kind, ...context })
    if (this.events.length > 100) this.events.shift()
  }
  private async check(taskId: string | null) {
    const health = await this.health()
    if (this.stopped || !health.ok || !health.value) return
    if (health.value.workerOnline || !health.value.wakeNeeded) {
      this.reset()
      return
    }
    if (this.attempts >= 3 || this.clock() - this.lastAttempt < 10000) return
    const context: WakeContext = {
      ownerAppId: 'marktext-dopame',
      reason: 'queued-document-task',
      taskId: taskId ?? health.value.wakeTaskId ?? null,
      attempt: ++this.attempts
    }
    this.lastAttempt = this.clock()
    this.record('requested', context)
    try {
      await this.wake(context)
      this.record('request-delivered', context)
    } catch {
      this.record('request-failed', context)
    }
  }
}
