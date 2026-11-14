import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FilePort, toBase64 } from '../app/src/file-port'
import { DocumentController } from '../app/src/document-controller'
import { StateStore } from '../state-store'
import { AgentError, PROTOCOL, documentRef, unwrap } from '../protocol'
type AcdeFs = FilePort['fs']

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}
async function until(check: () => boolean, timeout = 7000) {
  const end = Date.now() + timeout
  while (!check()) {
    if (Date.now() > end) throw new Error('Expected state was not reached')
    await Bun.sleep(15)
  }
}
function memoryCheckpointFs() {
  const records = new Map<string, { data: Uint8Array; version: string }>()
  let generation = 0
  const hooks: {
    before?: (path: string) => Promise<void>
    after?: (path: string, text: string) => Promise<void>
  } = {}
  const key = (root: string, path: string) => root + ':' + path
  const read = (root: string, path: string) => {
    const r = records.get(key(root, path))
    if (!r) throw { code: 'ENOENT' }
    return {
      data: r.data.slice(),
      text: new TextDecoder().decode(r.data),
      size: r.data.length,
      version: r.version,
      modifiedMs: Number(r.version)
    }
  }
  const methods = {
    async roots() {
      return [
        {
          id: 'private',
          label: '私有笔记',
          source: 'private',
          mode: 'writable',
          exists: true,
          reason: null
        }
      ]
    },
    async list(root: string, path = '') {
      const prefix = key(root, path + '/')
      return {
        entries: [...records.keys()]
          .filter((k) => k.startsWith(prefix))
          .map((k) => ({ name: k.slice(prefix.length), kind: 'file' })),
        truncated: false
      }
    },
    async readText(root: string, path: string) {
      return read(root, path)
    },
    async stat(root: string, path: string) {
      return read(root, path)
    },
    async readBytes(root: string, path: string) {
      return read(root, path)
    },
    async writeFile(root: string, path: string, data: string | Uint8Array, options: any = {}) {
      await hooks.before?.(path)
      const previous = records.get(key(root, path))
      if (options.ifVersion !== undefined && previous?.version !== options.ifVersion)
        throw { code: 'ECONFLICT' }
      if (options.create === 'new' && previous) throw { code: 'EEXIST' }
      const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data)
      const version = String(++generation)
      records.set(key(root, path), { data: bytes.slice(), version })
      await hooks.after?.(path, new TextDecoder().decode(bytes))
      return {
        name: path.split('/').at(-1),
        kind: 'file',
        size: bytes.length,
        modifiedMs: generation,
        version
      }
    }
  }
  const fs = new Proxy(methods, {
    get(target, name) {
      if (name in target) return (target as any)[name]
      return () => {
        throw new Error('Unexpected filesystem method ' + String(name))
      }
    }
  }) as unknown as AcdeFs
  return { fs, records, hooks }
}
let directory: string,
  store: StateStore,
  controller: DocumentController,
  memory: ReturnType<typeof memoryCheckpointFs>,
  token: string
let intercept: ((payload: any, result: any) => Promise<any>) | null = null
const call = (method: string, credential: string, args: any = {}) =>
  unwrap<any>(store.dispatch({ method, token: credential, args }))
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'marktext-controller-'))
  store = new StateStore(directory)
  memory = memoryCheckpointFs()
  intercept = null
  const paired = call('admin.pair', store.adminToken, {
    clientId: 'caller',
    label: '调用方',
    directApply: true
  })
  token = JSON.parse(readFileSync(paired.credentialPath, 'utf8')).token
  call('admin.grant', store.adminToken, {
    clientId: 'caller',
    kind: 'workspace',
    resource: '*',
    actions: ['create'],
    canShare: true
  })
  controller = new DocumentController(new FilePort(memory.fs), {
    async request(payload) {
      const result = store.dispatch(payload)
      return intercept ? intercept(payload, result) : result
    }
  })
  await controller.ready
  await controller.connectWorker(store.workerToken)
})
afterEach(async () => {
  intercept = null
  memory.hooks.before = undefined
  memory.hooks.after = undefined
  await controller.stopWorker()
  store.close()
  rmSync(directory, { recursive: true, force: true })
})
function submit(capability: string, input: any) {
  return call('submit', token, {
    request: {
      protocol: PROTOCOL,
      requestId: crypto.randomUUID(),
      capability,
      capabilityVersion: 1,
      input
    }
  })
}
const state = (taskId: string) => call('getTask', token, { taskId }).state

test('dirty checks reuse decoding while undo, empty files and new save baselines remain correct', async () => {
  const d = await controller.create('脏状态缓存', '原文 😀')
  d.savedRevision = d.revision
  d.stamp = { base64: toBase64(new TextEncoder().encode(d.text)), modifiedMs: 0, size: 11 }
  d.text += ' 修改'
  d.revision++
  const originalAtob = globalThis.atob
  let decodes = 0
  globalThis.atob = (value) => {
    decodes++
    return originalAtob(value)
  }
  try {
    expect(controller.dirty(d)).toBe(true)
    for (let i = 0; i < 8; i++) {
      expect(controller.dirty(d)).toBe(true)
      expect(controller.rows[0].dirty).toBe(true)
    }
    expect(decodes).toBe(1)
    d.text = '原文 😀'
    d.revision++
    expect(controller.dirty(d)).toBe(false)
    expect(decodes).toBe(1)
    d.stamp = { base64: '', modifiedMs: 1, size: 0 }
    d.text = ''
    d.revision++
    expect(controller.dirty(d)).toBe(false)
    d.text = 'x\ny'
    expect(controller.dirty(d)).toBe(true)
    d.stamp = { base64: toBase64(new TextEncoder().encode('\ufeffx\r\ny')), modifiedMs: 2, size: 7 }
    expect(controller.dirty(d)).toBe(false)
    d.text += '!'
    expect(controller.dirty(d)).toBe(true)
    d.savedRevision = d.revision
    expect(controller.dirty(d)).toBe(false)
  } finally {
    globalThis.atob = originalAtob
  }
})

test('untrusted wake requests cannot replace a working execution credential', async () => {
  await expect(controller.connectWorker('f'.repeat(64))).rejects.toMatchObject({
    code: 'PERMISSION_DENIED'
  })
  expect(controller.connected).toBe(true)
  const receipt = submit('documents.create', { title: '仍可执行', markdown: '正文' })
  await until(() => state(receipt.taskId) === 'succeeded')
  expect(store.row('SELECT COUNT(*) AS n FROM documents').n).toBe(1)
})

test('a checkpoint committed before its acknowledgement is recovered from disk without repeating the mutation', async () => {
  let injected = false
  memory.hooks.after = async (path, text) => {
    if (!injected && path.startsWith('checkpoints/') && text.includes('"pendingCommit"')) {
      injected = true
      throw new AgentError('IO_ERROR', '模拟丢失已落盘写入的确认', undefined, true)
    }
  }
  const receipt = submit('documents.create', { title: '持久提交', markdown: '仅创建一次' })
  await until(() => state(receipt.taskId) === 'succeeded')
  const result = call('getResult', token, { taskId: receipt.taskId })
  expect(controller.docs.get(result.document.documentId)?.text).toBe('仅创建一次')
  expect(store.row('SELECT COUNT(*) AS n FROM documents').n).toBe(1)
  expect(store.row('SELECT COUNT(*) AS n FROM artifacts').n).toBe(1)
})

test('a lost committing receipt is fenced and safely retried under the same task identity', async () => {
  let injected = false
  intercept = async (payload, result) => {
    if (!injected && payload.method === 'worker.beginCommit' && result.ok) {
      injected = true
      throw new AgentError('TRANSPORT_TIMEOUT', '模拟提交许可回报丢失', undefined, true)
    }
    return result
  }
  const receipt = submit('documents.create', { title: '许可重试', markdown: '同一任务' })
  await until(() => state(receipt.taskId) === 'succeeded')
  const task = call('getTask', token, { taskId: receipt.taskId })
  expect(task.attempt).toBe(2)
  expect(store.row('SELECT COUNT(*) AS n FROM documents').n).toBe(1)
  expect(store.row('SELECT COUNT(*) AS n FROM artifacts').n).toBe(1)
})

test('a lost successful completion receipt does not create a second result', async () => {
  let injected = false
  intercept = async (payload, result) => {
    if (!injected && payload.method === 'worker.finish' && result.ok) {
      injected = true
      throw new AgentError('TRANSPORT_TIMEOUT', '模拟完成确认丢失', undefined, true)
    }
    return result
  }
  const receipt = submit('documents.create', { title: '完成重试', markdown: '已提交' })
  await until(() => state(receipt.taskId) === 'succeeded')
  await until(
    () =>
      controller.connected &&
      [...controller.docs.values()].some((d) => d.text === '已提交' && !d.pendingCommit)
  )
  expect(store.row('SELECT COUNT(*) AS n FROM artifacts').n).toBe(1)
})

test('typing during a save keeps the saved snapshot and later dirty text separate', async () => {
  const d = await controller.create('保存竞争', '旧文本')
  const entered = deferred(),
    release = deferred()
  memory.hooks.before = async (path) => {
    if (path.startsWith('notes/')) {
      entered.resolve()
      await release.promise
    }
  }
  const saving = controller.save(d.id)
  await entered.promise
  controller.edit(d.id, '旧文本 + 新输入')
  release.resolve()
  await saving
  expect(d.text).toBe('旧文本 + 新输入')
  expect(controller.dirty(d)).toBe(true)
  expect(new TextDecoder().decode(memory.records.get('private:notes/' + d.id + '.md')!.data)).toBe(
    '旧文本'
  )
  expect(controller.notice?.message).toContain('新输入仍未保存')
})

test('typing while a committed Agent operation awaits its response publishes the correct later revision', async () => {
  const d = await controller.create('并发输入', '原文')
  call('admin.grant', store.adminToken, {
    clientId: 'caller',
    kind: 'document',
    resource: d.id,
    actions: ['read', 'write']
  })
  const entered = deferred(),
    release = deferred()
  intercept = async (payload, result) => {
    if (payload.method === 'worker.finish' && result.ok) {
      entered.resolve()
      await release.promise
    }
    return result
  }
  const receipt = submit('documents.patch', {
    document: documentRef(d.id, 0),
    baseRevision: 0,
    edits: [{ from: 0, to: 2, expectedText: '原文', text: 'Agent 内容' }]
  })
  await entered.promise
  controller.edit(d.id, 'Agent 内容 + 用户后续输入')
  release.resolve()
  await until(() => store.row('SELECT revision FROM documents WHERE id=?', d.id).revision === 2)
  expect(controller.docs.get(d.id)?.text).toBe('Agent 内容 + 用户后续输入')
  expect(call('getResult', token, { taskId: receipt.taskId }).document.revision).toBe(1)
  expect(store.row('SELECT text FROM snapshots WHERE doc=? AND revision=1', d.id).text).toBe(
    'Agent 内容'
  )
  expect(store.row('SELECT text FROM snapshots WHERE doc=? AND revision=2', d.id).text).toBe(
    'Agent 内容 + 用户后续输入'
  )
})

test('the execution session reconnects after the durable service restarts', async () => {
  store.close()
  store = new StateStore(directory)
  const receipt = submit('documents.create', { title: '服务恢复', markdown: '恢复后执行' })
  await until(() => state(receipt.taskId) === 'succeeded')
  expect(controller.connected).toBe(true)
})

test('unknown save outcomes preserve input and stop under an explicit unknown terminal result', async () => {
  const d = await controller.create('待核对保存', '需要保留的输入')
  call('admin.grant', store.adminToken, {
    clientId: 'caller',
    kind: 'document',
    resource: d.id,
    actions: ['read', 'write', 'save']
  })
  let injected = false
  memory.hooks.after = async (path, text) => {
    if (!injected && path.startsWith('notes/') && text === '需要保留的输入') {
      injected = true
      memory.records.set('private:' + path, {
        data: new TextEncoder().encode('另一个写入者留下的内容'),
        version: 'external-change'
      })
      throw new AgentError('IO_ERROR', '未取得保存结果', undefined, true)
    }
  }
  const receipt = submit('documents.save', { document: documentRef(d.id, 0), expectedRevision: 0 })
  await until(() => injected && controller.recoveries.length === 1)
  await controller.resolveUnknown(receipt.taskId)
  const task = call('getTask', token, { taskId: receipt.taskId })
  expect(task.state).toBe('failed')
  expect(task.error.code).toBe('OUTCOME_UNKNOWN')
  expect(task.error.retryable).toBe(false)
  expect(controller.active?.text).toBe('需要保留的输入')
  expect(controller.active?.id).not.toBe(d.id)
  expect(new TextDecoder().decode(memory.records.get('private:notes/' + d.id + '.md')!.data)).toBe(
    '另一个写入者留下的内容'
  )
  expect(memory.records.has('private:uncertain/' + receipt.taskId + '.json')).toBe(true)
  expect(controller.recoveries).toHaveLength(0)
  const attempts = task.attempt
  await Bun.sleep(300)
  expect(call('getTask', token, { taskId: receipt.taskId }).attempt).toBe(attempts)
})

test('a user can apply a suggestion as one external edit, while stale suggestions preserve both texts', async () => {
  const d = await controller.create('用户确认', '初稿')
  call('admin.grant', store.adminToken, {
    clientId: 'caller',
    kind: 'document',
    resource: d.id,
    actions: ['read', 'propose']
  })
  const proposal = submit('documents.propose', {
    document: documentRef(d.id, 0),
    baseRevision: 0,
    replacement: '审阅后内容',
    reason: '补充信息'
  })
  const result = call('getResult', token, { taskId: proposal.taskId })
  await controller.applySuggestion(result.proposal.proposalId)
  expect(d.text).toBe('审阅后内容')
  expect(d.revision).toBe(1)
  expect(d.externalSteps).toHaveLength(1)
  await expect(controller.applySuggestion(result.proposal.proposalId)).rejects.toMatchObject({
    code: 'REVISION_CONFLICT'
  })
  expect(d.text).toBe('审阅后内容')
  expect((await controller.proposal(result.proposal.proposalId)).before).toBe('初稿')
})

test('title edits during a lost save completion response survive recovery as an input draft', async () => {
  const d = await controller.create('原题', '正文'),
    originalId = d.id
  call('admin.grant', store.adminToken, {
    clientId: 'caller',
    kind: 'document',
    resource: originalId,
    actions: ['read', 'write', 'save']
  })
  const entered = deferred(),
    release = deferred()
  let injected = false
  intercept = async (payload, result) => {
    if (!injected && payload.method === 'worker.finish' && result.ok) {
      injected = true
      entered.resolve()
      await release.promise
      throw new AgentError('TRANSPORT_TIMEOUT', '模拟完成回报丢失', undefined, true)
    }
    return result
  }
  submit('documents.save', { document: documentRef(originalId, 0), expectedRevision: 0 })
  await entered.promise
  const rename = controller.rename(originalId, '新题').catch(() => {})
  release.resolve()
  await rename
  await until(() =>
    [...controller.docs.values()].some(
      (item) => item.id !== originalId && item.title.includes('新题')
    )
  )
  expect(controller.docs.get(originalId)?.title).toBe('原题')
  expect(controller.active?.title).toContain('新题')
  expect(controller.active?.text).toBe('正文')
})

test('closed tabs retain unsaved text and engine state across restart and reopen in reverse order', async () => {
  const first = await controller.create('第一篇', '第一篇正文')
  const second = await controller.create('第二篇', '第二篇正文')
  const history = {
    sourceText: '第二篇草稿 😀',
    cursor: { anchor: { line: 0, ch: 2 }, focus: { line: 0, ch: 2 } }
  }
  controller.edit(second.id, history.sourceText, history)
  await controller.closeTab(first.id)
  await controller.closeTab(second.id)
  await controller.closeTab(second.id)
  expect(controller.openIds).toEqual([])
  expect(controller.closedIds).toEqual([first.id, second.id])
  const restored = new DocumentController(new FilePort(memory.fs), controller.transport)
  await restored.ready
  expect(restored.closedIds).toEqual([first.id, second.id])
  expect((await restored.reopenClosedTab())?.id).toBe(second.id)
  expect(restored.active?.text).toBe(history.sourceText)
  expect(restored.active?.history).toEqual(history)
  expect(restored.closedIds).toEqual([first.id])
  await restored.activate(first.id)
  expect(restored.closedIds).toEqual([])
  expect(restored.openIds).toEqual([second.id, first.id])
  expect(await restored.reopenClosedTab()).toBeNull()
  expect(restored.active?.text).toBe('第一篇正文')
})

test('trash moves active, inactive and closed same-name notes by ID and restores their complete sessions', async () => {
  const a = await controller.create('同名笔记', '第一份 😀')
  a.mode = 'source'
  a.history = {
    sourceText: a.text,
    cursor: { anchor: { line: 0, ch: 2 }, focus: { line: 0, ch: 2 } }
  }
  await controller.save(a.id)
  const resource = JSON.parse(JSON.stringify(a.resource)),
    history = JSON.parse(JSON.stringify(a.history))
  const saved = memory.records.get('private:notes/' + a.id + '.md')!.data.slice()
  const b = await controller.create('同名笔记', '第二份未保存')
  await controller.closeTab(a.id)
  await controller.trash(a.id)
  expect(controller.activeId).toBe(b.id)
  expect(controller.closedIds).not.toContain(a.id)
  expect(controller.rows.filter((row) => !row.trashed).map((row) => row.id)).toEqual([b.id])
  expect(controller.docs.get(a.id)?.trashed).toBe(true)
  expect(memory.records.get('private:notes/' + a.id + '.md')!.data).toEqual(saved)
  await controller.restoreTrash(a.id)
  expect(controller.activeId).toBe(a.id)
  expect(controller.docs.get(a.id)).toMatchObject({
    text: '第一份 😀',
    mode: 'source',
    resource,
    history,
    trashed: false
  })
  expect(controller.docs.get(b.id)?.text).toBe('第二份未保存')
  await controller.trash(a.id)
  expect(controller.activeId).toBe(b.id)
  expect(controller.notice?.restoreId).toBe(a.id)
  expect(controller.closedIds).not.toContain(a.id)
  await controller.restoreTrash(a.id)
  expect(controller.docs.get(a.id)?.history).toEqual(history)
})

test('offline trash and restoration survive restart and synchronize before new jobs', async () => {
  const d = await controller.create('离线回收', '保留输入')
  await controller.stopWorker()
  controller = new DocumentController(new FilePort(memory.fs), {
    async request(payload) {
      return store.dispatch(payload)
    }
  })
  await controller.ready
  await controller.trash(d.id)
  expect(controller.docs.get(d.id)?.trashPending?.baseRevision).toBe(0)
  expect(controller.openIds).not.toContain(d.id)
  call('admin.grant', store.adminToken, {
    clientId: 'caller',
    kind: 'document',
    resource: d.id,
    actions: ['read', 'write']
  })
  const queued = submit('documents.patch', {
    document: documentRef(d.id, 0),
    baseRevision: 0,
    edits: [{ from: 0, to: 0, expectedText: '', text: '不应执行' }]
  })
  await controller.stopWorker()
  controller = new DocumentController(new FilePort(memory.fs), {
    async request(payload) {
      return store.dispatch(payload)
    }
  })
  await controller.ready
  expect(controller.docs.get(d.id)?.trashed).toBe(true)
  expect(controller.closedIds).not.toContain(d.id)
  await controller.connectWorker(store.workerToken)
  expect(store.row('SELECT trashed FROM documents WHERE id=?', d.id).trashed).toBe(1)
  expect(state(queued.taskId)).toBe('cancelled')
  expect(controller.docs.get(d.id)?.text).toBe('保留输入')
  expect(controller.docs.get(d.id)?.trashPending).toBeUndefined()
  await controller.stopWorker()
  controller = new DocumentController(new FilePort(memory.fs), {
    async request(payload) {
      return store.dispatch(payload)
    }
  })
  await controller.ready
  await controller.restoreTrash(d.id)
  controller.edit(d.id, '离线恢复后继续输入 😀')
  await controller.save(d.id)
  expect(controller.docs.get(d.id)?.savedRevision).toBe(1)
  await controller.flush(d.id)
  expect(controller.docs.get(d.id)?.trashPending?.baseRevision).toBe(0)
  await controller.connectWorker(store.workerToken)
  expect(store.row('SELECT text,revision,trashed FROM documents WHERE id=?', d.id)).toEqual({
    text: '离线恢复后继续输入 😀',
    revision: 1,
    trashed: 0
  })
  expect(controller.docs.get(d.id)?.trashPending).toBeUndefined()
})

test('a claimed job blocks trash and a failed move leaves tabs and durable input available', async () => {
  const d = await controller.create('执行中的笔记', 'abc')
  call('admin.grant', store.adminToken, {
    clientId: 'caller',
    kind: 'document',
    resource: d.id,
    actions: ['read', 'write']
  })
  const entered = deferred(),
    release = deferred()
  intercept = async (payload, result) => {
    if (payload.method === 'worker.claim' && result.ok && result.value) {
      entered.resolve()
      await release.promise
    }
    return result
  }
  const receipt = submit('documents.patch', {
    document: documentRef(d.id, 0),
    baseRevision: 0,
    edits: [{ from: 0, to: 1, expectedText: 'a', text: 'A' }]
  })
  try {
    await entered.promise
    await expect(controller.trash(d.id)).rejects.toMatchObject({ code: 'DOCUMENT_BUSY' })
    expect(controller.docs.get(d.id)?.trashed).not.toBe(true)
    expect(controller.activeId).toBe(d.id)
    expect(controller.openIds).toContain(d.id)
    expect((await controller.files.checkpoint<any>(d.id)).session.trashed).not.toBe(true)
    expect(store.row('SELECT trashed FROM documents WHERE id=?', d.id).trashed).toBe(0)
  } finally {
    release.resolve()
  }
  await until(() => state(receipt.taskId) === 'succeeded')
  expect(controller.docs.get(d.id)?.text).toBe('Abc')
})

test('a lost trash acknowledgement keeps the intent and reconnects without reviving the document', async () => {
  const d = await controller.create('不确定确认', '原文 😀')
  let lost = false
  intercept = async (payload, result) => {
    if (!lost && payload.method === 'worker.setTrash' && result.ok) {
      lost = true
      throw new AgentError('TRANSPORT_TIMEOUT', '模拟回收确认丢失', undefined, true)
    }
    return result
  }
  await controller.trash(d.id)
  expect(controller.docs.get(d.id)?.trashed).toBe(true)
  expect(controller.docs.get(d.id)?.trashPending).toBeDefined()
  expect(store.row('SELECT trashed FROM documents WHERE id=?', d.id).trashed).toBe(1)
  await until(() => controller.connected && !controller.docs.get(d.id)?.trashPending)
  expect(controller.openIds).not.toContain(d.id)
  expect(store.row('SELECT text,trashed FROM documents WHERE id=?', d.id)).toEqual({
    text: '原文 😀',
    trashed: 1
  })
})

test('offline restoration never rebases its intent over concurrent remote edits', async () => {
  const d = await controller.create('冲突恢复', '基础内容')
  await controller.trash(d.id)
  await controller.stopWorker()
  controller = new DocumentController(new FilePort(memory.fs), {
    async request(payload) {
      return store.dispatch(payload)
    }
  })
  await controller.ready
  await controller.restoreTrash(d.id)
  controller.edit(d.id, '本地输入一')
  controller.edit(d.id, '本地输入二')
  await controller.flush(d.id)
  call('worker.connect', store.workerToken, { instanceId: 'peer' })
  call('worker.setTrash', store.workerToken, {
    instanceId: 'peer',
    snapshot: { id: d.id, title: d.title, text: '远端新版本', revision: 1, savedRevision: -1 },
    baseRevision: 0,
    trashed: false
  })
  call('worker.disconnect', store.workerToken, { instanceId: 'peer' })
  await controller.connectWorker(store.workerToken)
  expect(controller.connected).toBe(true)
  expect(controller.docs.get(d.id)).toMatchObject({
    text: '本地输入二',
    revision: 2,
    trashPending: { baseRevision: 0 }
  })
  expect(store.row('SELECT text,revision FROM documents WHERE id=?', d.id)).toEqual({
    text: '远端新版本',
    revision: 1
  })
  expect((await controller.files.checkpoint<any>(d.id)).session.text).toBe('本地输入二')
  expect(controller.workerError).toContain('待核对')
})

test('an unresolved commit prevents moving a note to trash', async () => {
  const d = await controller.create('待核对', '保存双方')
  d.pendingCommit = {
    taskId: crypto.randomUUID(),
    snapshot: {
      id: d.id,
      title: d.title,
      text: d.text,
      revision: d.revision,
      savedRevision: d.savedRevision
    }
  }
  await expect(controller.trash(d.id)).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' })
  expect(controller.docs.get(d.id)?.trashed).not.toBe(true)
  expect(controller.activeId).toBe(d.id)
  delete d.pendingCommit
})

test('a failed trash checkpoint leaves the note and its source available', async () => {
  const d = await controller.create('写入失败', '未丢失的输入 😀')
  await controller.save(d.id)
  const saved = memory.records.get('private:notes/' + d.id + '.md')!.data.slice()
  let failed = false
  memory.hooks.before = async (path) => {
    if (!failed && path === 'checkpoints/' + d.id + '.json' && d.trashed) {
      failed = true
      throw new AgentError('IO_ERROR', '模拟checkpoint写入失败', undefined, true)
    }
  }
  await expect(controller.trash(d.id)).rejects.toMatchObject({ code: 'IO_ERROR' })
  expect(controller.activeId).toBe(d.id)
  expect(controller.openIds).toContain(d.id)
  expect(controller.docs.get(d.id)).toMatchObject({ text: '未丢失的输入 😀', savedRevision: 0 })
  expect(controller.docs.get(d.id)?.trashed).not.toBe(true)
  expect((await controller.files.checkpoint<any>(d.id)).session.trashed).not.toBe(true)
  expect(store.row('SELECT trashed FROM documents WHERE id=?', d.id).trashed).toBe(0)
  expect(memory.records.get('private:notes/' + d.id + '.md')!.data).toEqual(saved)
})

test('a lost checkpoint acknowledgement rolls back only its own trash intent', async () => {
  const d = await controller.create('落盘确认丢失', '唯一正文 😀')
  let lost = false
  memory.hooks.after = async (path, text) => {
    if (!lost && path === 'checkpoints/' + d.id + '.json' && text.includes('"trashed":true')) {
      lost = true
      throw new AgentError('IO_ERROR', '模拟已落盘确认丢失', undefined, true)
    }
  }
  await expect(controller.trash(d.id)).rejects.toMatchObject({ code: 'IO_ERROR' })
  expect(controller.docs.get(d.id)?.trashed).not.toBe(true)
  const record = await controller.files.checkpoint<any>(d.id)
  expect(record.session.trashed).not.toBe(true)
  expect(record.session.text).toBe('唯一正文 😀')
  expect(store.row('SELECT trashed FROM documents WHERE id=?', d.id).trashed).toBe(0)
  await controller.flush(d.id)
})

test('rollback never replaces a checkpoint changed by another writer', async () => {
  const d = await controller.create('并发恢复记录', '本地原文')
  let changed = false
  memory.hooks.after = async (path, text) => {
    if (!changed && path === 'checkpoints/' + d.id + '.json' && text.includes('"trashed":true')) {
      changed = true
      const record = JSON.parse(text)
      record.session.text = '另一写入者的记录'
      record.session.revision++
      memory.records.set('private:' + path, {
        data: new TextEncoder().encode(JSON.stringify(record)),
        version: '999'
      })
      throw new AgentError('IO_ERROR', '模拟并发写入', undefined, true)
    }
  }
  await expect(controller.trash(d.id)).rejects.toMatchObject({ code: 'IO_ERROR' })
  await until(() => controller.notice?.kind === 'conflict')
  expect(controller.docs.get(d.id)?.text).toBe('本地原文')
  expect(
    JSON.parse(
      new TextDecoder().decode(memory.records.get('private:checkpoints/' + d.id + '.json')!.data)
    ).session.text
  ).toBe('另一写入者的记录')
})

test('a trash write failure resumes the debounce for input not yet checkpointed', async () => {
  const d = await controller.create('未落盘输入', 'T0')
  controller.edit(d.id, 'T1 新输入 😀')
  let failed = false
  memory.hooks.before = async (path) => {
    if (!failed && path === 'checkpoints/' + d.id + '.json' && d.trashed) {
      failed = true
      throw new AgentError('IO_ERROR', '在intent写入前失败', undefined, true)
    }
  }
  await expect(controller.trash(d.id)).rejects.toMatchObject({ code: 'IO_ERROR' })
  expect(controller.docs.get(d.id)?.trashed).not.toBe(true)
  await until(() => {
    const record = memory.records.get('private:checkpoints/' + d.id + '.json')
    return (
      !!record && JSON.parse(new TextDecoder().decode(record.data)).session.text === 'T1 新输入 😀'
    )
  })
  await until(
    () => store.row('SELECT text FROM documents WHERE id=?', d.id)?.text === 'T1 新输入 😀'
  )
  expect(controller.docs.get(d.id)?.text).toBe('T1 新输入 😀')
  expect(controller.activeId).toBe(d.id)
})

test.each(['autosave', 'explicit flush', 'explicit save'] as const)(
  'a queued %s uses the session left by an Agent commit and later trash',
  async (kind) => {
    const d = await controller.create('排队自动保存', 'abc')
    call('admin.grant', store.adminToken, {
      clientId: 'caller',
      kind: 'document',
      resource: d.id,
      actions: ['read', 'write']
    })
    const claimed = deferred(),
      releaseClaim = deferred(),
      saving = deferred(),
      releaseSave = deferred()
    intercept = async (payload, result) => {
      if (payload.method === 'worker.claim' && result.ok && result.value) {
        claimed.resolve()
        await releaseClaim.promise
      }
      return result
    }
    const receipt = submit('documents.patch', {
      document: documentRef(d.id, 0),
      baseRevision: 0,
      edits: [{ from: 0, to: 1, expectedText: 'a', text: 'A' }]
    })
    let save: Promise<unknown> | undefined,
      trash: Promise<unknown> | undefined,
      flushing: Promise<unknown> | undefined
    try {
      await claimed.promise
      await expect(controller.trash(d.id)).rejects.toMatchObject({ code: 'DOCUMENT_BUSY' })
      memory.hooks.before = async (path) => {
        if (path === 'notes/' + d.id + '.md') {
          saving.resolve()
          await releaseSave.promise
        }
      }
      save = controller.save(d.id)
      await saving.promise
      releaseClaim.resolve()
      await Bun.sleep(0)
      trash = controller.trash(d.id)
      // Let trash enqueue behind the held save before adding a later explicit operation.
      await Bun.sleep(0)
      if (kind === 'explicit flush') flushing = controller.flush(d.id)
      if (kind === 'explicit save')
        flushing = controller.save(d.id).then(
          () => 'saved',
          (error) => error.code
        )
      await Bun.sleep(170)
      releaseSave.resolve()
      await save
      await trash
      const outcome = await flushing
      if (kind === 'explicit save') expect(outcome).toBe('DOCUMENT_NOT_FOUND')
      await Bun.sleep(25)
      expect(state(receipt.taskId)).toBe('succeeded')
      const record = JSON.parse(
        new TextDecoder().decode(memory.records.get('private:checkpoints/' + d.id + '.json')!.data)
      )
      expect(record.session).toMatchObject({ text: 'Abc', revision: 1, trashed: true })
      expect(controller.docs.get(d.id)).toMatchObject({ text: 'Abc', revision: 1, trashed: true })
      expect(
        new TextDecoder().decode(memory.records.get('private:notes/' + d.id + '.md')!.data)
      ).toBe('abc')
      expect(store.row('SELECT text,revision,trashed FROM documents WHERE id=?', d.id)).toEqual({
        text: 'Abc',
        revision: 1,
        trashed: 1
      })
    } finally {
      releaseClaim.resolve()
      releaseSave.resolve()
      await Promise.allSettled([save, trash, flushing])
    }
  }
)

test.each(['trash', 'Agent update'] as const)(
  'a delayed disk reload cannot replace the editor after %s',
  async (kind) => {
    const d = await controller.create('迟到的磁盘载入', '原文')
    await controller.save(d.id)
    const entered = deferred(),
      release = deferred()
    const current = controller.files.current.bind(controller.files)
    controller.files.current = async (resource) => {
      const stamp = await current(resource)
      entered.resolve()
      await release.promise
      return stamp
    }
    let loads = 0
    controller.bridge = {
      flush() {},
      capture: () => ({}),
      replaceExternal: () => null,
      load() {
        loads++
      }
    }
    const loading = controller.reloadExternal(d.id).then(
      () => 'loaded',
      (error) => error.code
    )
    try {
      await entered.promise
      if (kind === 'trash') await controller.trash(d.id)
      else {
        call('admin.grant', store.adminToken, {
          clientId: 'caller',
          kind: 'document',
          resource: d.id,
          actions: ['read', 'write']
        })
        const receipt = submit('documents.patch', {
          document: documentRef(d.id, 0),
          baseRevision: 0,
          edits: [{ from: 0, to: 2, expectedText: '原文', text: 'Agent新文' }]
        })
        await until(() => state(receipt.taskId) === 'succeeded')
      }
      release.resolve()
      expect(await loading).toBe('REVISION_CONFLICT')
      expect(loads).toBe(0)
      const record = JSON.parse(
        new TextDecoder().decode(memory.records.get('private:checkpoints/' + d.id + '.json')!.data)
      )
      if (kind === 'trash') expect(record.session.trashed).toBe(true)
      else expect(record.session.text).toBe('Agent新文')
    } finally {
      release.resolve()
      await loading
    }
  }
)
