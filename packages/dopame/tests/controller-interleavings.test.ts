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
