import { AgentError, boundedText, fault, id, patchText, unwrap } from '../../protocol'
import type { Transport } from '../../client'
import {
  FilePort,
  decodeFile,
  bytesForSave,
  fromBase64,
  toBase64,
  type Format,
  type Resource,
  type Stamp,
  type ReadDocument
} from './file-port'

export type Mode = 'rich' | 'source' | 'preview'
export interface EngineState {
  muya?: any
  source?: any
  muyaText?: string
  sourceText?: string
  cursor?: any
  scroll?: any
}
export interface ExternalStep {
  before: string
  after: string
  history: EngineState
}
export interface Session {
  id: string
  title: string
  text: string
  revision: number
  savedRevision: number
  format: Format
  resource: Resource | null
  importSource?: { title: string; resource: Resource }
  lastExport?: { name: string; revision: number }
  stamp: Stamp | null
  readOnly: boolean
  mode: Mode
  history: EngineState
  externalSteps: ExternalStep[]
  pendingCommit?: { taskId: string; snapshot: any }
}
export interface EditorBridge {
  flush(): void
  capture(): EngineState
  replaceExternal(documentId: string, text: string): EngineState | null
  load?(session: Session): void
}
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value))
const snapshot = (d: Session) => ({
  id: d.id,
  title: d.title,
  text: d.text,
  revision: d.revision,
  savedRevision: d.savedRevision
})

export class DocumentController {
  docs = new Map<string, Session>()
  openIds: string[] = []
  closedIds: string[] = []
  activeId = ''
  loading = true
  connected = false
  workerError = ''
  notice: { kind: string; message: string } | null = null
  composing = false
  preferences = { theme: 'light', sidebar: true, collaboration: false }
  bridge: EditorBridge | null = null
  listeners = new Set<() => void>()
  private queues = new Map<string, Promise<any>>()
  private dirtyResults = new WeakMap<Session, { text: string; baseline?: string; dirty: boolean }>()
  private dirtyBaseline?: { ownerId: string; encoded: string; text: string }
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private metadataTail: Promise<any> = Promise.resolve()
  private workerToken = ''
  private instanceId = crypto.randomUUID()
  private running = false
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private pollTimer: ReturnType<typeof setTimeout> | null = null
  private shared = new Map<string, number>()
  private activeJob: any = null
  private activeWork: Promise<void> | null = null
  private connecting: Promise<void> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private shuttingDown = false
  private recoveryBlocked = new Set<string>()
  private uncertainJobs = new Map<string, any>()
  private recoveryErrors = new Map<string, ReturnType<typeof fault>>()
  private reconciling = false
  private lastRecoveryCheck = 0
  readonly ready: Promise<void>
  constructor(
    readonly files: FilePort,
    readonly transport: Transport
  ) {
    this.ready = this.restore()
  }
  onChange(fn: () => void) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
  emit() {
    for (const fn of this.listeners) fn()
  }
  get active() {
    return this.docs.get(this.activeId) ?? null
  }
  get rows() {
    return [...this.docs.values()].map((d) => ({
      id: d.id,
      title: d.title,
      revision: d.revision,
      savedRevision: d.savedRevision,
      dirty: this.dirty(d),
      mode: d.mode,
      readOnly: d.readOnly
    }))
  }
  dirty(d: Session) {
    if (d.revision === d.savedRevision) {
      this.dirtyResults.delete(d)
      if (this.dirtyBaseline?.ownerId === d.id) this.dirtyBaseline = undefined
      return false
    }
    const baseline = d.stamp?.base64
    const cached = this.dirtyResults.get(d)
    if (cached?.text === d.text && cached.baseline === baseline) return cached.dirty
    let dirty = true
    if (baseline !== undefined) {
      if (this.dirtyBaseline?.encoded !== baseline)
        this.dirtyBaseline = {
          ownerId: d.id,
          encoded: baseline,
          text: decodeFile(fromBase64(baseline)).text
        }
      else this.dirtyBaseline.ownerId = d.id
      dirty = this.dirtyBaseline.text !== d.text
    }
    this.dirtyResults.set(d, { text: d.text, baseline, dirty })
    return dirty
  }
  message(kind: string, message: string) {
    this.notice = { kind, message }
    this.emit()
  }
  error(error: any) {
    if (error?.code === 'CANCELLED') return
    this.message(
      error?.code === 'FILE_CONFLICT' ? 'conflict' : 'error',
      error instanceof AgentError ? error.message : '操作未完成，内容已保留'
    )
  }
  private enqueue<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve()
    const result = previous.catch(() => {}).then(run)
    this.queues.set(key, result)
    void result.then(
      () => {
        if (this.queues.get(key) === result) this.queues.delete(key)
      },
      () => {
        if (this.queues.get(key) === result) this.queues.delete(key)
      }
    )
    return result
  }
  private async restore() {
    try {
      const manifest = await this.files.jsonRead<any>('workspace.json')
      if (manifest?.preferences) {
        for (const k of ['sidebar', 'collaboration'] as const)
          if (typeof manifest.preferences[k] === 'boolean')
            this.preferences[k] = manifest.preferences[k]
        if (['light', 'dark'].includes(manifest.preferences.theme))
          this.preferences.theme = manifest.preferences.theme
      }
      const list = await this.files.checkpointIds()
      for (const docId of list.ids) {
        try {
          const record = await this.files.checkpoint<any>(docId)
          if (record?.recoveryFence && !record.session) continue
          if (record?.schema !== 1 || record.session?.id !== docId)
            throw new Error('Invalid checkpoint')
          const d = record.session as Session
          id(d.id)
          boundedText(d.text, '草稿')
          if (!Number.isSafeInteger(d.revision) || d.revision < 0 || !d.title)
            throw new Error('Invalid checkpoint')
          this.docs.set(d.id, d)
        } catch {
          this.message('error', '有一份草稿无法读取，原恢复文件已保留，未自动重写')
        }
      }
      this.openIds = (Array.isArray(manifest?.openIds) ? manifest.openIds : []).filter(
        (x: any) => typeof x === 'string' && this.docs.has(x)
      )
      this.closedIds = (Array.isArray(manifest?.closedIds) ? manifest.closedIds : []).filter(
        (x: any) => typeof x === 'string' && this.docs.has(x) && !this.openIds.includes(x)
      )
      this.activeId = this.openIds.includes(manifest?.activeId)
        ? manifest.activeId
        : (this.openIds[0] ?? '')
      if (list.truncated)
        this.message('error', '草稿目录条目超过单次读取上限，未显示的记录仍保留在磁盘')
    } catch (e) {
      this.error(e)
    } finally {
      this.loading = false
      this.emit()
    }
  }
  private saveMetadata() {
    const value = {
      schema: 1,
      openIds: [...this.openIds],
      closedIds: [...this.closedIds],
      activeId: this.activeId,
      preferences: { ...this.preferences }
    }
    const result = this.metadataTail
      .catch(() => {})
      .then(() => this.files.jsonWrite('workspace.json', value))
    this.metadataTail = result
    void result.catch((e) => this.error(e))
    return result
  }
  async setTheme(theme: 'light' | 'dark') {
    this.preferences.theme = theme
    this.emit()
    await this.saveMetadata()
  }
  async rename(docId: string, title: string) {
    const d = this.docs.get(docId)
    if (!d) return
    boundedText(title, '标题', 800)
    if (!title.trim() || title === d.title) return
    d.title = title.trim()
    d.revision++
    this.emit()
    await this.flush(docId)
  }
  async activate(docId: string) {
    await this.flushActive()
    if (!this.docs.has(docId)) throw new AgentError('DOCUMENT_NOT_FOUND', '文档不存在')
    if (!this.openIds.includes(docId)) this.openIds.push(docId)
    this.closedIds = this.closedIds.filter((id) => id !== docId)
    this.activeId = docId
    this.emit()
    await this.saveMetadata()
  }
  async create(title = '未命名文档', text = '', activate = true) {
    await this.ready
    boundedText(text, '文档')
    boundedText(title, '标题', 800)
    if (activate) await this.flushActive()
    const d: Session = {
      id: crypto.randomUUID(),
      title,
      text,
      revision: 0,
      savedRevision: -1,
      format: { bom: false, newline: 'lf' },
      resource: null,
      stamp: null,
      readOnly: false,
      mode: 'rich',
      history: {},
      externalSteps: []
    }
    await this.files.putCheckpoint(d.id, { schema: 1, session: d })
    this.docs.set(d.id, d)
    if (activate) {
      this.openIds.push(d.id)
      this.activeId = d.id
    }
    this.emit()
    await this.saveMetadata()
    await this.flush(d.id)
    return d
  }
  async import(read: ReadDocument, inPlace = false, mode?: Mode) {
    const target = read.resource
    const same =
      inPlace &&
      [...this.docs.values()].find((d) => {
        const resource = d.resource
        if (!resource || resource.kind !== target.kind) return false
        return resource.kind === 'handle' && target.kind === 'handle'
          ? resource.key === target.key
          : resource.kind === 'root' &&
              target.kind === 'root' &&
              resource.root === target.root &&
              resource.path === target.path
      })
    if (same) {
      await this.activate(same.id)
      if (mode) await this.mode(mode)
      return same
    }
    const d = await this.create(read.title, read.text, false)
    Object.assign(d, {
      ...(mode ? { mode } : {}),
      format: read.format,
      resource: inPlace ? read.resource : null,
      stamp: inPlace ? read.stamp : null,
      importSource: inPlace ? undefined : { title: read.title, resource: read.resource },
      readOnly: inPlace && read.readOnly,
      savedRevision: inPlace ? 0 : -1
    })
    if (inPlace) await this.persist(d)
    else await this.save(d.id)
    await this.activate(d.id)
    if (!inPlace)
      this.message('info', '已导入并保存到私有笔记。后续保存写入工作文档，导出可选择新的 .md 文件')
    return d
  }
  async openFiles(inPlace = false, mode?: Mode) {
    await this.ready
    const failures: string[] = []
    const report = (error: unknown, name: string) =>
      failures.push(name + ' · ' + (error instanceof Error ? error.message : String(error)))
    const resources = inPlace
      ? [...this.docs.values()].flatMap((d) => (d.resource ? [d.resource] : []))
      : []
    const docs = await this.files.openFiles(report, resources)
    for (const d of docs) {
      try {
        await this.import(d, inPlace, mode)
      } catch (error) {
        report(error, d.title)
      }
    }
    if (failures.length) this.message('error', '以下文件未能打开：' + failures.join('；'))
  }
  async openHandle(handle: FileSystemFileHandle) {
    await this.ready
    const resources = [...this.docs.values()].flatMap((d) => (d.resource ? [d.resource] : []))
    await this.import(await this.files.readHandle(handle, false, resources), true)
  }
  async closeTab(docId: string) {
    if (!this.openIds.includes(docId)) return
    if (this.activeId === docId) await this.flushActive()
    else await this.flush(docId)
    this.openIds = this.openIds.filter((x) => x !== docId)
    this.closedIds = [...this.closedIds.filter((id) => id !== docId), docId]
    if (this.activeId === docId) this.activeId = this.openIds.at(-1) ?? ''
    this.emit()
    await this.saveMetadata()
  }
  async reopenClosedTab() {
    const docId = this.closedIds.at(-1)
    if (!docId) return null
    await this.activate(docId)
    return this.active
  }
  edit(docId: string, text: string, history?: EngineState) {
    const d = this.docs.get(docId)
    if (!d || d.readOnly || d.mode === 'preview') return
    boundedText(text, '文档')
    if (history) d.history = history
    if (text === d.text) return
    d.text = text
    d.revision++
    if (d.mode !== 'source') d.externalSteps = []
    if (this.notice?.kind === 'success') this.notice = null
    this.emit()
    this.schedule(d)
  }
  updateHistory(docId: string, state: EngineState) {
    const d = this.docs.get(docId)
    if (d) d.history = state
  }
  private schedule(d: Session) {
    const previous = this.timers.get(d.id)
    if (previous) clearTimeout(previous)
    this.timers.set(
      d.id,
      setTimeout(() => {
        this.timers.delete(d.id)
        void this.enqueue(d.id, () => this.persist(d)).catch((e) => this.error(e))
      }, 120)
    )
  }
  private async persist(d: Session) {
    if (this.recoveryBlocked.has(d.id))
      throw new AgentError('RECOVERY_REQUIRED', '提交状态正在核对，当前输入保留在编辑器中')
    const saved = copy(d)
    await this.files.putCheckpoint(d.id, { schema: 1, session: saved })
    await this.sync(saved)
  }
  async flush(docId: string) {
    const d = this.docs.get(docId)
    if (!d) return
    const timer = this.timers.get(docId)
    if (timer) {
      clearTimeout(timer)
      this.timers.delete(docId)
    }
    await this.enqueue(docId, () => this.persist(d))
  }
  async flushActive() {
    await this.finishComposition()
    this.bridge?.flush()
    if (this.active) {
      this.active.history = this.bridge?.capture() ?? this.active.history
      await this.flush(this.active.id)
    }
  }
  async flushAll() {
    await this.finishComposition()
    this.bridge?.flush()
    for (const d of this.docs.values()) await this.flush(d.id)
    await this.metadataTail
  }
  async mode(mode: Mode) {
    const d = this.active
    if (!d) return
    await this.flushActive()
    d.mode = mode
    this.emit()
    await this.persist(d)
  }
  async checkExternal() {
    const d = this.active
    if (!d?.resource || !d.stamp) return
    try {
      const current = await this.files.current(d.resource)
      if (current.base64 === d.stamp.base64) return
      if (this.dirty(d)) {
        this.message(
          'conflict',
          '磁盘内容已变化，当前输入已保留。可以另存为，或保留草稿后载入磁盘版本'
        )
        return
      }
      await this.reloadExternal(d.id)
    } catch (e) {
      this.error(e)
    }
  }
  async reloadExternal(docId: string) {
    const d = this.docs.get(docId)
    if (!d?.resource) return
    await this.flush(docId)
    if (this.dirty(d)) {
      await this.create(d.title + ' · 磁盘冲突草稿', d.text, false)
      this.message('info', '当前输入已复制为独立草稿')
    }
    const stamp = await this.files.current(d.resource)
    const parsed = decodeFile(Uint8Array.from(atob(stamp.base64), (c) => c.charCodeAt(0)))
    d.text = parsed.text
    d.format = parsed.format
    d.stamp = stamp
    d.revision++
    d.savedRevision = d.revision
    d.history = {}
    d.externalSteps = []
    this.bridge?.load?.(d)
    this.emit()
    await this.persist(d)
  }
  async save(
    docId = this.activeId,
    as = false
  ): Promise<
    { snapshot: ReturnType<typeof snapshot>; resource: Resource; stamp: Stamp } | undefined
  > {
    await this.finishComposition()
    this.bridge?.flush()
    const d = this.docs.get(docId)
    if (!d) return
    if (this.recoveryBlocked.has(d.id)) {
      if (as) {
        const draft = await this.preserveInput(d.id)
        return this.save(draft.id, true)
      }
      throw new AgentError('RECOVERY_REQUIRED', '提交结果正在核对，可先保留输入副本或导出')
    }
    if (as || d.readOnly) {
      const selected = await this.files.saveAsResource(d.title)
      return this.enqueue(d.id, () => this.saveInside(d, selected))
    }
    return this.enqueue(d.id, () => this.saveInside(d))
  }
  async exportFile(docId = this.activeId) {
    await this.finishComposition()
    this.bridge?.flush()
    const d = this.docs.get(docId)
    if (!d) return
    const exported = copy(d)
    const selected = await this.files.saveAsResource(d.title)
    await this.files.save(
      crypto.randomUUID(),
      exported.text,
      exported.format,
      selected.resource,
      selected.stamp
    )
    if (!this.recoveryBlocked.has(docId)) {
      d.lastExport = {
        name: selected.resource.kind === 'handle' ? selected.resource.name : selected.resource.path,
        revision: exported.revision
      }
      await this.flush(docId)
    }
    this.message('success', '已导出 v' + exported.revision + ' · 工作文档仍保存到原有目标')
  }
  async preserveInput(docId = this.activeId) {
    await this.finishComposition()
    this.bridge?.flush()
    const original = this.docs.get(docId)
    if (!original) throw new AgentError('DOCUMENT_NOT_FOUND', '文档不存在')
    const draft = await this.create(original.title + ' · 输入副本', original.text, false)
    this.openIds.push(draft.id)
    this.activeId = draft.id
    this.emit()
    await this.saveMetadata()
    return draft
  }
  get recoveries() {
    return [...this.uncertainJobs.values()].map((job) => ({
      taskId: job.taskId,
      documentId: job.targetDocumentId,
      capability: job.request?.capability,
      state: job.state
    }))
  }
  async resolveUnknown(taskId: string) {
    await this.finishComposition()
    this.bridge?.flush()
    const known = this.uncertainJobs.get(taskId)
    if (!known) return
    const job = await this.rpc('worker.taskStatus', { taskId })
    if (['succeeded', 'failed', 'cancelled', 'queued'].includes(job.state)) {
      await this.reconcilePending()
      return
    }
    await this.enqueue(job.targetDocumentId, async () => {
      const checkpoint = await this.files.checkpoint<any>(job.targetDocumentId)
      if (checkpoint?.session?.pendingCommit?.taskId === taskId) {
        await this.reconcileOne(job)
        return
      }
      const draft = this.docs.has(job.targetDocumentId)
        ? await this.preserveInput(job.targetDocumentId)
        : null
      await this.files.jsonWrite('uncertain/' + id(taskId) + '.json', {
        schema: 1,
        taskId,
        outcome: 'unknown',
        checkpoint,
        preservedDocumentId: draft?.id ?? null,
        recordedAt: new Date().toISOString()
      })
      await this.rpc('worker.abandonRecovery', {
        taskId,
        lease: job.lease,
        preservedDocumentId: draft?.id ?? null
      })
      this.clearRecovery(job)
      this.message(
        'info',
        '已保留恢复记录和输入副本。该任务以 OUTCOME_UNKNOWN 结束；没有声称写入成功或回滚'
      )
    })
  }
  async applySuggestion(proposalId: string) {
    await this.finishComposition()
    this.bridge?.flush()
    const proposal = await this.proposal(proposalId)
    return this.enqueue(proposal.document.documentId, async () => {
      const d = this.docs.get(proposal.document.documentId)
      if (!d) throw new AgentError('DOCUMENT_NOT_FOUND', '请先打开建议对应的文档')
      if (this.recoveryBlocked.has(d.id))
        throw new AgentError('RECOVERY_REQUIRED', '请先核对待恢复提交')
      if (d.readOnly) throw new AgentError('PERMISSION_DENIED', '来源为只读，请先保存工作副本')
      if (d.revision !== proposal.baseRevision)
        throw new AgentError('REVISION_CONFLICT', '文档版本已变化，建议和当前输入均已保留')
      const before = copy(d)
      d.text = proposal.after
      d.revision++
      d.externalSteps.push({
        before: before.text,
        after: d.text,
        history: d.externalSteps.length ? {} : before.history
      })
      const history = this.bridge?.replaceExternal(d.id, d.text)
      if (history) {
        d.history = history
        if (d.mode !== 'source') d.externalSteps = []
      }
      this.emit()
      await this.persist(d)
      this.message('success', '建议已应用为 v' + d.revision + '，可用一次撤销还原')
      return snapshot(d)
    })
  }
  private async saveInside(d: Session, selected?: { resource: Resource; stamp: Stamp | null }) {
    if (this.recoveryBlocked.has(d.id))
      throw new AgentError('RECOVERY_REQUIRED', '请先核对提交结果，未覆盖当前草稿')
    const before = copy(d),
      resource = selected?.resource ?? d.resource ?? this.files.newPrivateResource(d.id),
      baseline = selected ? selected.stamp : d.stamp
    await this.files.putCheckpoint(d.id, { schema: 1, session: before })
    const saved = await this.files.save(d.id, before.text, before.format, resource, baseline)
    d.resource = resource
    d.stamp = saved.stamp
    d.savedRevision = before.revision
    d.readOnly = false
    await this.persist(d)
    this.message(
      'success',
      d.revision !== before.revision
        ? '已保存 v' + before.revision + '，新输入仍未保存'
        : saved.inPlace
          ? '已保存，原位写入的恢复副本已保留'
          : '已保存'
    )
    return {
      snapshot: { ...snapshot(before), savedRevision: before.revision },
      resource,
      stamp: saved.stamp
    }
  }
  private async rpc(method: string, args: any = {}) {
    return unwrap<any>(
      await this.transport.request({
        method,
        token: this.workerToken,
        args: { instanceId: this.instanceId, ...args }
      })
    )
  }
  private async sync(d: Session) {
    if (!this.connected || this.recoveryBlocked.has(d.id)) return
    const sent = snapshot(d)
    let expected = this.shared.get(sent.id)
    if (expected === undefined) {
      const current = await this.rpc('worker.documentStatus', { documentId: sent.id })
      expected = current?.revision ?? -1
      this.shared.set(sent.id, expected!)
    }
    if (expected! > sent.revision)
      throw new AgentError('REVISION_CONFLICT', '协作记录比本地草稿更新，需要核对后再同步', {
        actualRevision: expected
      })
    await this.rpc('worker.publish', { snapshot: sent, expectedRevision: expected })
    this.shared.set(sent.id, sent.revision)
  }
  private transportFailure(error: any) {
    this.workerError = error?.message ?? '协作连接暂时不可用'
    const transient = [
      'WORKER_UNAVAILABLE',
      'TRANSPORT_TIMEOUT',
      'TRANSPORT_ERROR',
      'LEASE_EXPIRED',
      'WORKER_BUSY'
    ]
    if (this.shuttingDown || !transient.includes(error?.code)) {
      this.emit()
      return
    }
    this.running = false
    this.connected = false
    if (this.heartbeat) {
      clearInterval(this.heartbeat)
      this.heartbeat = null
    }
    if (this.pollTimer) {
      clearTimeout(this.pollTimer)
      this.pollTimer = null
    }
    if (!this.reconnectTimer && this.workerToken) {
      this.reconnectTimer = setTimeout(async () => {
        this.reconnectTimer = null
        try {
          await this.activeWork
          await this.connectWorker(this.workerToken)
        } catch (e) {
          this.transportFailure(e)
        }
      }, 500)
    }
    this.emit()
  }
  async connectWorker(token: string) {
    if (!/^[a-f0-9]{64}$/.test(token))
      throw new AgentError('PERMISSION_DENIED', '无效的协作连接凭证')
    const proof = unwrap<any>(
      await this.transport.request({
        method: 'worker.authenticate',
        token,
        args: { instanceId: this.instanceId }
      })
    )
    if (this.shuttingDown) throw new AgentError('WORKER_CLOSING', '编辑器正在退出', undefined, true)
    if (this.connected && this.running && this.workerToken === token && proof.sessionValid) return
    if (this.connecting) return this.connecting
    const operation = this.establishWorker(token)
    this.connecting = operation
    try {
      await operation
    } catch (e) {
      this.transportFailure(e)
      throw e
    } finally {
      if (this.connecting === operation) this.connecting = null
    }
  }
  private async establishWorker(token: string) {
    await this.ready
    this.running = false
    if (this.pollTimer) {
      clearTimeout(this.pollTimer)
      this.pollTimer = null
    }
    await this.activeWork
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.workerToken = token
    await this.rpc('worker.connect')
    this.connected = true
    this.workerError = ''
    this.shared.clear()
    this.heartbeat = setInterval(
      () => void this.rpc('worker.heartbeat').catch((e) => this.transportFailure(e)),
      2000
    )
    await this.reconcilePending()
    for (const d of this.docs.values()) if (!this.recoveryBlocked.has(d.id)) await this.flush(d.id)
    this.running = true
    this.poll()
    this.emit()
  }
  private clearRecovery(job: any) {
    this.uncertainJobs.delete(job.taskId)
    this.recoveryErrors.delete(job.taskId)
    const other = [...this.uncertainJobs.values()].some(
      (t) => t.targetDocumentId === job.targetDocumentId
    )
    if (!other) this.recoveryBlocked.delete(job.targetDocumentId)
    const d = this.docs.get(job.targetDocumentId)
    if (d && !other && !this.shuttingDown) this.schedule(d)
  }
  private async adoptRecovered(session: Session) {
    const committed = copy(session)
    delete committed.pendingCommit
    let current = this.docs.get(committed.id)
    if (
      current &&
      (current.text !== committed.text || current.title !== committed.title) &&
      current.revision >= committed.revision
    ) {
      const originalId = current.id
      const timer = this.timers.get(originalId)
      if (timer) {
        clearTimeout(timer)
        this.timers.delete(originalId)
      }
      const fork = {
        ...copy(current),
        id: crypto.randomUUID(),
        title: current.title + ' · 恢复输入草稿',
        revision: 0,
        savedRevision: -1,
        resource: null,
        stamp: null,
        readOnly: false,
        pendingCommit: undefined
      }
      Object.assign(current, fork)
      this.docs.set(fork.id, current)
      this.docs.set(committed.id, committed)
      if (this.activeId === originalId) {
        this.openIds.push(fork.id)
        this.activeId = fork.id
      }
      await this.files.putCheckpoint(fork.id, { schema: 1, session: current })
      await this.sync(fork)
      current = committed
      this.message('conflict', '已核对提交结果，同时保留了恢复期间的新输入草稿')
    } else if (current) {
      const keepHistory = current.text === committed.text
      const history = keepHistory ? current.history : committed.history
      const steps = keepHistory ? current.externalSteps : committed.externalSteps
      const revision = keepHistory
        ? Math.max(current.revision, committed.revision)
        : committed.revision
      Object.assign(current, committed, { history, externalSteps: steps, revision })
    } else {
      current = committed
      this.docs.set(current.id, current)
    }
    delete current.pendingCommit
    const saved = copy(current)
    await this.files.putCheckpoint(saved.id, { schema: 1, session: saved })
    if (this.activeId === current.id) this.bridge?.load?.(current)
    this.shared.set(committed.id, committed.revision)
    this.emit()
    await this.saveMetadata()
  }
  private async reconcilePending() {
    if (this.reconciling) return
    this.reconciling = true
    this.lastRecoveryCheck = Date.now()
    try {
      const jobs = new Map<string, any>()
      for (const job of await this.rpc('worker.recoveryTasks')) jobs.set(job.taskId, job)
      for (const [taskId, known] of this.uncertainJobs)
        jobs.set(taskId, { ...known, ...(await this.rpc('worker.taskStatus', { taskId })) })
      for (const d of this.docs.values())
        if (d.pendingCommit && !jobs.has(d.pendingCommit.taskId))
          jobs.set(
            d.pendingCommit.taskId,
            await this.rpc('worker.taskStatus', { taskId: d.pendingCommit.taskId })
          )
      for (const job of jobs.values()) {
        this.uncertainJobs.set(job.taskId, job)
        this.recoveryBlocked.add(job.targetDocumentId)
        if (this.composing && this.activeId === job.targetDocumentId) continue
        try {
          await this.enqueue(job.targetDocumentId, () => this.reconcileOne(job))
        } catch (e: any) {
          this.workerError = e.message
          this.message(
            'conflict',
            e instanceof AgentError ? e.message : '恢复结果需要核对，未自动重做'
          )
        }
      }
    } finally {
      this.reconciling = false
    }
  }
  private async reconcileOne(job: any) {
    let record: any
    for (let attempt = 0; attempt < 3; attempt++) {
      record = await this.files.checkpoint<any>(job.targetDocumentId)
      const pending = record?.session?.pendingCommit
      if (pending?.taskId === job.taskId) {
        if (job.state === 'succeeded') {
          if (
            job.result?.document?.documentId !== pending.snapshot.id ||
            job.result.document.revision !== pending.snapshot.revision
          )
            throw new AgentError('RECOVERY_REQUIRED', '提交记录与结果版本不一致，未改写任何内容')
        } else
          await this.rpc('worker.recover', {
            taskId: job.taskId,
            lease: job.lease,
            committed: true,
            snapshot: pending.snapshot
          })
        await this.adoptRecovered(record.session)
        this.clearRecovery(job)
        return
      }
      if (['succeeded', 'failed', 'cancelled', 'queued', 'waiting-approval'].includes(job.state)) {
        this.clearRecovery(job)
        return
      }
      if (job.request.capability === 'documents.save' && job.state !== 'running') {
        const d = record?.session as Session | undefined
        if (d && d.revision === job.request.input.document.revision) {
          const expected = await this.rpc('worker.expectedCommit', { taskId: job.taskId })
          const resource = d.resource ?? this.files.newPrivateResource(d.id)
          try {
            const disk = await this.files.current(resource)
            if (disk.base64 === toBase64(bytesForSave(expected.text, d.format, d.stamp))) {
              const restored: Session = {
                ...copy(d),
                ...expected,
                resource,
                stamp: disk,
                pendingCommit: { taskId: job.taskId, snapshot: expected }
              }
              await this.files.putCheckpoint(d.id, { schema: 1, session: restored })
              await this.rpc('worker.recover', {
                taskId: job.taskId,
                lease: job.lease,
                committed: true,
                snapshot: expected
              })
              await this.adoptRecovered(restored)
              this.clearRecovery(job)
              return
            }
          } catch (e: any) {
            if (['TRANSPORT_TIMEOUT', 'LEASE_EXPIRED', 'WORKER_UNAVAILABLE'].includes(e?.code))
              throw e
          }
        }
        throw new AgentError(
          'RECOVERY_REQUIRED',
          '保存结果尚不能确定，已保留文档和任务，未自动再次写入'
        )
      }
      const base = job.request.input.document?.revision ?? -1
      if (
        job.state !== 'running' &&
        record?.session &&
        (job.request.capability === 'documents.create' || record.session.revision > base)
      )
        throw new AgentError('RECOVERY_REQUIRED', '恢复版本有冲突，已保留双方内容')
      try {
        await this.files.putCheckpoint(job.targetDocumentId, {
          ...record,
          schema: 1,
          recoveryFence: { taskId: job.taskId, epoch: crypto.randomUUID() }
        })
        break
      } catch (e: any) {
        if (e.code !== 'FILE_CONFLICT' || attempt === 2) throw e
      }
    }
    const failure = this.recoveryErrors.get(job.taskId)
    await this.rpc('worker.recover', {
      taskId: job.taskId,
      lease: job.lease,
      committed: false,
      ...(failure &&
      !['WORKER_UNAVAILABLE', 'TRANSPORT_TIMEOUT', 'TRANSPORT_ERROR', 'LEASE_EXPIRED'].includes(
        failure.code
      )
        ? { failure }
        : {})
    })
    this.clearRecovery(job)
  }
  private poll() {
    if (!this.running || this.pollTimer) return
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null
      const work = this.pollCycle()
      this.activeWork = work
      void work.then(
        () => {
          if (this.activeWork === work) this.activeWork = null
          this.poll()
        },
        () => {
          if (this.activeWork === work) this.activeWork = null
          this.poll()
        }
      )
    }, 250)
  }
  private async pollCycle() {
    try {
      if (this.recoveryBlocked.size && Date.now() - this.lastRecoveryCheck > 2500)
        await this.reconcilePending()
      const job = await this.rpc('worker.claim')
      if (job) {
        this.activeJob = job
        await this.execute(job)
      }
    } catch (e) {
      this.transportFailure(e)
    } finally {
      this.activeJob = null
    }
  }
  private async execute(job: any) {
    let began = false,
      durable = false,
      attempted = false
    try {
      while (this.composing) {
        if (this.shuttingDown)
          throw new AgentError('CANCEL_REQUESTED', '编辑器正在退出，任务尚未提交')
        await new Promise((r) => setTimeout(r, 100))
        const task = await this.rpc('worker.jobStatus', { taskId: job.taskId, lease: job.lease })
        if (task.cancelRequested) throw new AgentError('CANCEL_REQUESTED', '输入组合期间任务已取消')
      }
      this.bridge?.flush()
      const capability = job.request.capability
      const target = job.targetDocumentId
      await this.enqueue(target, async () => {
        let d = this.docs.get(target)
        const isCreate = capability === 'documents.create'
        if (!d && !isCreate)
          throw new AgentError('DOCUMENT_NOT_FOUND', '文档未在当前私有工作区中恢复')
        if (d) {
          const timer = this.timers.get(d.id)
          if (timer) {
            clearTimeout(timer)
            this.timers.delete(d.id)
          }
          await this.persist(d)
          if (d.revision !== job.request.input.document.revision)
            throw new AgentError('REVISION_CONFLICT', '用户输入已改变基础版本', {
              actualRevision: d.revision
            })
        }
        const base = d ? copy(d) : null
        const next: Session = isCreate
          ? {
              id: target,
              title: job.request.input.title,
              text: job.request.input.markdown,
              revision: 0,
              savedRevision: -1,
              resource: null,
              stamp: null,
              readOnly: false,
              format: { bom: false, newline: 'lf' },
              mode: 'rich',
              history: {},
              externalSteps: []
            }
          : copy(d!)
        if (capability === 'documents.patch')
          next.text = patchText(next.text, job.request.input.edits)
        if (capability === 'documents.apply') next.text = job.request.input.replacement
        if (['documents.patch', 'documents.apply'].includes(capability)) next.revision++
        if (d?.readOnly)
          throw new AgentError('PERMISSION_DENIED', '此文档来源为只读，需要用户另存为')
        this.recoveryBlocked.add(target)
        this.uncertainJobs.set(job.taskId, job)
        attempted = true
        await this.rpc('worker.beginCommit', { taskId: job.taskId, lease: job.lease })
        began = true
        if (d && (d.revision !== base!.revision || (this.composing && this.activeId === target))) {
          await this.rpc('worker.abortCommit', {
            taskId: job.taskId,
            lease: job.lease,
            actualRevision: d.revision
          })
          began = false
          this.clearRecovery(job)
          return
        }
        if (capability === 'documents.save') {
          if (d!.readOnly) throw new AgentError('PERMISSION_DENIED', '只读来源需要用户另存为')
          const resource = d!.resource ?? this.files.newPrivateResource(d!.id)
          const saved = await this.files.save(
            d!.id,
            base!.text,
            base!.format,
            resource,
            base!.stamp
          )
          next.resource = resource
          next.stamp = saved.stamp
          next.savedRevision = base!.revision
        } else if (base)
          next.externalSteps.push({
            before: base.text,
            after: next.text,
            history: next.externalSteps.length ? {} : copy(base.history)
          })
        boundedText(next.text, '任务结果')
        const committedSnapshot = snapshot(next)
        next.pendingCommit = { taskId: job.taskId, snapshot: committedSnapshot }
        await this.files.putCheckpoint(next.id, { schema: 1, session: next })
        durable = true
        const compositionDeadline = Date.now() + 8000
        while (
          this.composing &&
          this.activeId === target &&
          !this.shuttingDown &&
          Date.now() < compositionDeadline
        )
          await new Promise((r) => setTimeout(r, 80))
        if (this.composing && this.activeId === target)
          throw new AgentError('RECOVERY_REQUIRED', '已保留提交记录，等待输入组合结束后再核对')
        if (d && capability === 'documents.save') {
          d.resource = next.resource
          d.stamp = next.stamp
          d.savedRevision = next.savedRevision
          d.pendingCommit = next.pendingCommit
        } else if (d && d.revision !== base!.revision) {
          const fork = {
            ...copy(d),
            id: crypto.randomUUID(),
            title: d.title + ' · 输入冲突草稿',
            revision: 0,
            savedRevision: -1,
            resource: null,
            stamp: null,
            readOnly: false,
            pendingCommit: undefined
          } as Session
          const oldTimer = this.timers.get(d.id)
          if (oldTimer) {
            clearTimeout(oldTimer)
            this.timers.delete(d.id)
          }
          Object.assign(d, fork)
          this.docs.set(fork.id, d)
          this.docs.set(next.id, next)
          if (this.activeId === next.id) {
            this.openIds.push(fork.id)
            this.activeId = fork.id
          }
          this.emit()
          await this.files.putCheckpoint(fork.id, { schema: 1, session: fork })
          await this.sync(fork)
          this.message(
            'conflict',
            '提交期间出现新输入，已保留为独立冲突草稿；Agent 结果仍可按任务读取'
          )
        } else {
          this.docs.set(next.id, next)
          const history = this.bridge?.replaceExternal(next.id, next.text)
          if (history) {
            next.history = history
            if (next.mode !== 'source') next.externalSteps = []
          }
          this.emit()
        }
        await this.rpc('worker.finish', {
          taskId: job.taskId,
          lease: job.lease,
          snapshot: committedSnapshot
        })
        this.shared.set(next.id, committedSnapshot.revision)
        const current = this.docs.get(next.id)!
        delete current.pendingCommit
        const cleanup = copy(current)
        await this.files.putCheckpoint(cleanup.id, { schema: 1, session: cleanup })
        await this.saveMetadata()
        this.recoveryBlocked.delete(next.id)
        this.uncertainJobs.delete(job.taskId)
        this.recoveryErrors.delete(job.taskId)
        await this.sync(cleanup)
        this.emit()
        if (current.revision !== cleanup.revision) this.schedule(current)
      })
    } catch (e: any) {
      if (
        !began &&
        (!attempted ||
          !['WORKER_UNAVAILABLE', 'TRANSPORT_TIMEOUT', 'TRANSPORT_ERROR', 'LEASE_EXPIRED'].includes(
            e?.code
          ))
      ) {
        try {
          await this.rpc('worker.reject', { taskId: job.taskId, lease: job.lease, error: fault(e) })
        } catch {}
        this.clearRecovery(job)
      } else if (!durable) {
        this.workerError = '提交状态需核对，未自动重做'
        this.message('conflict', this.workerError)
      } else {
        this.workerError = '文档已记录，正在等待协作服务核对提交结果'
        this.message('info', this.workerError)
      }
      if (!began) this.error(e)
      if (attempted && this.uncertainJobs.has(job.taskId))
        this.recoveryErrors.set(job.taskId, fault(e))
      if (
        ['WORKER_UNAVAILABLE', 'TRANSPORT_TIMEOUT', 'TRANSPORT_ERROR', 'LEASE_EXPIRED'].includes(
          e?.code
        )
      )
        this.transportFailure(e)
    }
  }
  async stopWorker() {
    this.shuttingDown = true
    this.running = false
    if (this.pollTimer) clearTimeout(this.pollTimer)
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    await this.activeWork
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    if (this.heartbeat) clearInterval(this.heartbeat)
    if (this.workerToken) {
      try {
        await this.rpc('worker.disconnect')
      } catch {}
    }
    this.connected = false
    this.emit()
  }
  async activity() {
    return this.connected ? this.rpc('worker.activity') : []
  }
  async proposal(proposalId: string) {
    return this.rpc('worker.proposal', { proposalId })
  }
  private async finishComposition() {
    const end = Date.now() + 8000
    while (this.composing && Date.now() < end) await new Promise((r) => setTimeout(r, 40))
    if (this.composing)
      throw new AgentError('INPUT_IN_PROGRESS', '请先完成输入法组合，内容尚未切换')
  }
}
