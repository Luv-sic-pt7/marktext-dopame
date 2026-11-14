import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StateStore } from '../state-store'
import { LIMITS, PROTOCOL, documentRef, patchText, unwrap } from '../protocol'

let store: StateStore, directory: string, researcher: string, reviewer: string
const worker = 'instance-1'
function call(method: string, token: string, args: any = {}) {
  if (method.startsWith('worker.')) args = { instanceId: worker, ...args }
  return unwrap(store.dispatch({ method, token, args }))
}
function denied(method: string, token: string, args: any = {}, code = 'PERMISSION_DENIED') {
  if (method.startsWith('worker.')) args = { instanceId: worker, ...args }
  const r = store.dispatch({ method, token, args })
  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.error.code).toBe(code)
}
function pair(name: string, directApply = true) {
  const p = call('admin.pair', store.adminToken, { clientId: name, label: name, directApply })
  return JSON.parse(readFileSync(p.credentialPath, 'utf8')).token as string
}
function grant(
  clientId: string,
  kind: string,
  resource: string,
  actions: string[],
  canShare = true
) {
  return call('admin.grant', store.adminToken, { clientId, kind, resource, actions, canShare })
    .grantId
}
function submit(
  token: string,
  capability: string,
  input: any,
  requestId: string = crypto.randomUUID()
) {
  return call('submit', token, {
    request: { protocol: PROTOCOL, requestId, capability, capabilityVersion: 1, input }
  })
}
function claim() {
  return call('worker.claim', store.workerToken, { instanceId: worker })
}
function connect() {
  return call('worker.connect', store.workerToken, { instanceId: worker })
}
function begin(job: any) {
  return call('worker.beginCommit', store.workerToken, { taskId: job.taskId, lease: job.lease })
}
function finish(job: any, snapshot: any) {
  return call('worker.finish', store.workerToken, {
    taskId: job.taskId,
    lease: job.lease,
    snapshot
  })
}
function create(text = '# 报告\n\n第一段。', requestId: string = crypto.randomUUID()) {
  const receipt = submit(
    researcher,
    'documents.create',
    { title: '训练报告', markdown: text },
    requestId
  )
  const job = claim()
  begin(job)
  const snapshot = {
    id: job.targetDocumentId,
    title: '训练报告',
    text,
    revision: 0,
    savedRevision: 0
  }
  finish(job, snapshot)
  return {
    receipt,
    snapshot,
    document: documentRef(snapshot.id, 0),
    result: call('getResult', researcher, { taskId: receipt.taskId })
  }
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'marktext-protocol-'))
  store = new StateStore(directory)
  researcher = pair('researcher')
  reviewer = pair('reviewer')
  grant('researcher', 'workspace', '*', ['create'], true)
  connect()
})
afterEach(() => {
  try {
    store.close()
  } catch {}
  rmSync(directory, { recursive: true, force: true })
})

describe('protocol boundaries', () => {
  test('invalid field names cannot amplify error responses', () => {
    const result = store.dispatch({
      method: 'listCapabilities',
      token: researcher,
      ['invalid'.repeat(20000)]: true
    })
    expect(result.ok).toBe(false)
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(1024)
    if (!result.ok) expect(result.error.code).toBe('INVALID_ARGUMENT')
  })
  test('malformed Unicode and deeply nested invalid fields are rejected before creating a task', () => {
    denied(
      'submit',
      researcher,
      {
        request: {
          protocol: PROTOCOL,
          requestId: 'bad-unicode',
          capability: 'documents.create',
          capabilityVersion: 1,
          input: { title: '拒绝损坏文本', markdown: 'x\ud800' }
        }
      },
      'INVALID_ARGUMENT'
    )
    let nested: any = 'x'
    for (let n = 0; n < 2000; n++) nested = { nested }
    denied(
      'submit',
      researcher,
      {
        request: {
          protocol: PROTOCOL,
          requestId: 'deep-invalid',
          capability: 'documents.create',
          capabilityVersion: 1,
          input: { title: '无效结构', markdown: nested }
        }
      },
      'INVALID_ARGUMENT'
    )
    expect(store.row('SELECT COUNT(*) AS n FROM tasks').n).toBe(0)
  })
  test('discovery describes every P0 action, schemas, permissions and cancellation', () => {
    grant('researcher', 'document', '*', ['read', 'write', 'propose', 'apply', 'save', 'export'])
    const caps = call('listCapabilities', researcher)
    expect(caps).toHaveLength(9)
    for (const c of caps) {
      expect(c.inputSchema.additionalProperties).toBe(false)
      expect(c.requiresModel).toBe(false)
      expect(c.permissions.length).toBeGreaterThan(0)
      expect(c.cancellation).toBe('before-commit')
    }
    denied('describeCapability', researcher, { id: 'writing.generate' }, 'UNSUPPORTED_VERSION')
  })
  test('the capability catalogue follows live permissions and stale tools cannot bypass revocation', () => {
    expect(call('listCapabilities', researcher).map((c: any) => c.id)).toEqual(['documents.create'])
    expect(call('listCapabilities', reviewer)).toEqual([])
    const created = create()
    const permission = grant('reviewer', 'document', created.document.documentId, [
      'read',
      'propose'
    ])
    expect(call('listCapabilities', reviewer).map((c: any) => c.id)).toEqual([
      'documents.list',
      'documents.read',
      'documents.outline',
      'documents.propose'
    ])
    call('admin.revoke', store.adminToken, { grantId: permission })
    expect(call('listCapabilities', reviewer)).toEqual([])
    denied('describeCapability', reviewer, { id: 'documents.propose' })
    denied('submit', reviewer, {
      request: {
        protocol: PROTOCOL,
        requestId: 'cached-tool',
        capability: 'documents.propose',
        capabilityVersion: 1,
        input: { document: created.document, baseRevision: 0, replacement: '无权覆盖' }
      }
    })
  })
  test('grant action bounds and strict timestamps reject ambiguous administrative input', () => {
    denied(
      'admin.grant',
      store.adminToken,
      { clientId: 'reviewer', kind: 'workspace', resource: '*', actions: ['create', 'create'] },
      'INVALID_ARGUMENT'
    )
    denied(
      'admin.grant',
      store.adminToken,
      {
        clientId: 'reviewer',
        kind: 'workspace',
        resource: '*',
        actions: ['create'],
        expiresAt: '2100'
      },
      'INVALID_ARGUMENT'
    )
    denied(
      'submit',
      researcher,
      {
        request: {
          protocol: PROTOCOL,
          requestId: 'bad-date',
          capability: 'documents.create',
          capabilityVersion: 1,
          input: { title: '日期', markdown: '' },
          deadlineAt: '2100'
        }
      },
      'INVALID_ARGUMENT'
    )
  })
  test('rejects unknown fields, forged identities, unsupported versions and oversized metadata', () => {
    const base = {
      protocol: PROTOCOL,
      requestId: 'test-1',
      capability: 'documents.create',
      capabilityVersion: 1,
      input: { title: 'test', markdown: 'x' }
    }
    denied(
      'submit',
      researcher,
      { request: { ...base, callerAppId: 'administrator' } },
      'INVALID_ARGUMENT'
    )
    denied(
      'submit',
      researcher,
      { request: { ...base, input: { ...base.input, path: '/etc/passwd' } } },
      'INVALID_ARGUMENT'
    )
    denied(
      'submit',
      researcher,
      { request: { ...base, capabilityVersion: 2 } },
      'UNSUPPORTED_VERSION'
    )
    denied(
      'submit',
      researcher,
      { request: { ...base, input: { title: 'test', markdown: 'x'.repeat(65536) } } },
      'INVALID_ARGUMENT'
    )
    const p = store.dispatch(JSON.parse('{"method":"health","__proto__":{"administrator":true}}'))
    expect(p.ok).toBe(false)
    denied('admin.pair', researcher, { clientId: 'attacker', label: 'x' })
    denied('worker.claim', researcher, { instanceId: worker })
  })
  test('UTF-16 edits preserve emoji and reject mismatches or overlapping edits', () => {
    expect(patchText('A😀中文', [{ from: 3, to: 5, expectedText: '中文', text: '测试' }])).toBe(
      'A😀测试'
    )
    expect(() =>
      patchText('A😀中文', [{ from: 1, to: 2, expectedText: '\ud83d', text: '' }])
    ).toThrow()
    expect(() =>
      patchText('abcd', [
        { from: 0, to: 3, expectedText: 'abc', text: 'x' },
        { from: 2, to: 4, expectedText: 'cd', text: 'y' }
      ])
    ).toThrow()
    expect(() => patchText('abcd', [{ from: 0, to: 1, expectedText: 'z', text: 'x' }])).toThrow()
  })
})
describe('durable tasks and document concurrency', () => {
  test('a read-only task handoff does not delegate cancellation authority', () => {
    const task = submit(researcher, 'documents.create', { title: '由写作方控制', markdown: '正文' })
    call('grants.share', researcher, {
      clientId: 'reviewer',
      kind: 'task',
      resource: task.taskId,
      actions: ['read']
    })
    expect(call('getTask', reviewer, { taskId: task.taskId }).state).toBe('queued')
    denied('cancelTask', reviewer, { taskId: task.taskId })
    expect(call('getTask', researcher, { taskId: task.taskId }).state).toBe('queued')
    expect(call('cancelTask', researcher, { taskId: task.taskId }).task.state).toBe('cancelled')
  })
  test('lost receipts can be retried without duplicate documents; parameter changes are refused', () => {
    const a = create(undefined, 'same-request')
    const b = submit(
      researcher,
      'documents.create',
      { title: '训练报告', markdown: a.snapshot.text },
      'same-request'
    )
    expect(b.taskId).toBe(a.receipt.taskId)
    expect(store.row('SELECT COUNT(*) AS n FROM documents').n).toBe(1)
    denied(
      'submit',
      researcher,
      {
        request: {
          protocol: PROTOCOL,
          requestId: 'same-request',
          capability: 'documents.create',
          capabilityVersion: 1,
          input: { title: '改名', markdown: 'x' }
        }
      },
      'IDEMPOTENCY_MISMATCH'
    )
    store.close()
    store = new StateStore(directory)
    expect(call('getResult', researcher, { taskId: a.receipt.taskId }).document).toEqual(a.document)
  })
  test('serializes same-document writers and reports a real revision conflict', () => {
    const a = create('abc')
    const input = {
      document: a.document,
      baseRevision: 0,
      edits: [{ from: 0, to: 1, expectedText: 'a', text: 'A' }]
    }
    const one = submit(researcher, 'documents.patch', input)
    const two = submit(researcher, 'documents.patch', input)
    const job = claim()
    expect(job.taskId).toBe(one.taskId)
    expect(claim()).toBeNull()
    begin(job)
    finish(job, { ...a.snapshot, text: 'Abc', revision: 1 })
    const next = claim()
    expect(next.taskId).toBe(two.taskId)
    denied(
      'worker.beginCommit',
      store.workerToken,
      { taskId: next.taskId, lease: next.lease },
      'REVISION_CONFLICT'
    )
    call('worker.reject', store.workerToken, {
      taskId: next.taskId,
      lease: next.lease,
      error: {
        code: 'REVISION_CONFLICT',
        message: '文档已更新',
        retryable: false,
        details: { actualRevision: 1 }
      }
    })
    expect(call('getResult', researcher, { taskId: two.taskId }).error.details.actualRevision).toBe(
      1
    )
  })
  test('queued cancellation is final; a running cancellation awaits worker confirmation', () => {
    const first = submit(researcher, 'documents.create', { title: '草稿', markdown: 'x' })
    expect(call('cancelTask', researcher, { taskId: first.taskId }).task.state).toBe('cancelled')
    expect(claim()).toBeNull()
    const second = submit(researcher, 'documents.create', { title: '草稿', markdown: 'x' })
    const job = claim()
    const cancel = call('cancelTask', researcher, { taskId: second.taskId })
    expect(cancel.task.state).toBe('running')
    expect(cancel.task.cancelRequested).toBe(true)
    denied(
      'worker.beginCommit',
      store.workerToken,
      { taskId: job.taskId, lease: job.lease },
      'CANCEL_REQUESTED'
    )
    call('worker.reject', store.workerToken, {
      taskId: job.taskId,
      lease: job.lease,
      error: { code: 'CANCEL_REQUESTED', message: '尚未修改', retryable: false }
    })
    expect(call('getTask', researcher, { taskId: second.taskId }).state).toBe('cancelled')
    expect(store.row('SELECT COUNT(*) AS n FROM documents').n).toBe(0)
  })
  test('cancel after commit begins never claims rollback or hides a completed result', () => {
    const receipt = submit(researcher, 'documents.create', { title: '训练报告', markdown: 'abc' })
    const job = claim()
    begin(job)
    expect(call('cancelTask', researcher, { taskId: receipt.taskId }).reason).toBe('too-late')
    finish(job, {
      id: job.targetDocumentId,
      title: '训练报告',
      text: 'abc',
      revision: 0,
      savedRevision: 0
    })
    expect(call('cancelTask', researcher, { taskId: receipt.taskId }).task.state).toBe('succeeded')
  })
  test('a service restart exposes uncertain commits and can recover an already durable checkpoint exactly once', () => {
    const receipt = submit(researcher, 'documents.create', { title: '训练报告', markdown: 'abc' })
    const job = claim()
    begin(job)
    const durableCheckpoint = {
      id: job.targetDocumentId,
      title: '训练报告',
      text: 'abc',
      revision: 0,
      savedRevision: 0
    }
    store.close()
    store = new StateStore(directory)
    expect(call('getTask', researcher, { taskId: receipt.taskId }).state).toBe('recovering')
    expect(connect().recovering).toHaveLength(1)
    expect(claim()).toBeNull()
    call('worker.recover', store.workerToken, {
      taskId: receipt.taskId,
      committed: true,
      snapshot: durableCheckpoint
    })
    expect(call('getResult', researcher, { taskId: receipt.taskId }).document.documentId).toBe(
      durableCheckpoint.id
    )
    denied(
      'worker.recover',
      store.workerToken,
      { taskId: receipt.taskId, committed: true, snapshot: durableCheckpoint },
      'INVALID_ARGUMENT'
    )
    expect(store.row('SELECT COUNT(*) AS n FROM documents').n).toBe(1)
  })
  test('a lease timeout moves committing to recovering and rejects stale completion', () => {
    const r = submit(researcher, 'documents.create', { title: '训练报告', markdown: 'x' })
    const job = claim()
    begin(job)
    store.run('UPDATE tasks SET lease_until=? WHERE id=?', Date.now() - 1, r.taskId)
    expect(call('getTask', researcher, { taskId: r.taskId }).state).toBe('recovering')
    denied(
      'worker.finish',
      store.workerToken,
      {
        taskId: job.taskId,
        lease: job.lease,
        snapshot: {
          id: job.targetDocumentId,
          title: '训练报告',
          text: 'x',
          revision: 0,
          savedRevision: 0
        }
      },
      'LEASE_EXPIRED'
    )
  })
  test('state and ordered events survive restart; event replay resumes after the saved sequence', () => {
    const a = create()
    const events = call('listEvents', researcher, { taskId: a.receipt.taskId, afterSeq: 0 }).events
    expect(events.map((x: any) => x.seq)).toEqual(events.map((_: any, i: number) => i + 1))
    expect(events.at(-1).state).toBe('succeeded')
    store.close()
    store = new StateStore(directory)
    const remaining = call('listEvents', researcher, { taskId: a.receipt.taskId, afterSeq: 2 })
    expect(remaining.events.every((e: any) => e.seq > 2)).toBe(true)
    expect(remaining.task.state).toBe('succeeded')
  })
  test('non-preauthorized changes wait for explicit approval and queue limits are enforced', () => {
    const a = create('abc')
    const untrusted = pair('approval-client', false)
    grant('approval-client', 'document', a.document.documentId, ['read', 'write'])
    const r = submit(untrusted, 'documents.patch', {
      document: a.document,
      baseRevision: 0,
      edits: [{ from: 0, to: 1, expectedText: 'a', text: 'z' }]
    })
    expect(r.state).toBe('waiting-approval')
    expect(claim()).toBeNull()
    call('admin.approve', store.adminToken, { taskId: r.taskId, allow: true })
    expect(claim().taskId).toBe(r.taskId)
    for (let n = 0; n < LIMITS.queued; n++)
      submit(researcher, 'documents.create', { title: '等待', markdown: 'x' })
    denied(
      'submit',
      researcher,
      {
        request: {
          protocol: PROTOCOL,
          requestId: crypto.randomUUID(),
          capability: 'documents.create',
          capabilityVersion: 1,
          input: { title: '超额', markdown: 'x' }
        }
      },
      'QUEUE_LIMIT'
    )
  })
})
describe('authorization and immutable handoffs', () => {
  test('a non-delegable document cannot be shared through its derived proposal, task or artifact', () => {
    const a = create()
    grant('reviewer', 'document', a.document.documentId, ['read', 'propose', 'export'], false)
    const proposal = submit(reviewer, 'documents.propose', {
      document: a.document,
      baseRevision: 0,
      replacement: '建议'
    })
    const result = call('getResult', reviewer, { taskId: proposal.taskId })
    for (const [kind, resource] of [
      ['proposal', result.proposal.proposalId],
      ['task', proposal.taskId],
      ['artifact', result.artifacts[0].artifactId]
    ])
      denied('grants.share', reviewer, {
        clientId: 'researcher',
        kind,
        resource,
        actions: ['read']
      })
    const exported = submit(reviewer, 'documents.export', { document: a.document })
    const artifact = call('getResult', reviewer, { taskId: exported.taskId }).artifacts[0]
    denied('grants.share', reviewer, {
      clientId: 'researcher',
      kind: 'artifact',
      resource: artifact.artifactId,
      actions: ['read']
    })
  })
  test('independent callers can return a shared proposal and task result, then apply it with one checked revision', () => {
    const a = create('原文')
    call('grants.share', researcher, {
      clientId: 'reviewer',
      kind: 'document',
      resource: a.document.documentId,
      actions: ['read', 'propose', 'share'],
      canShare: true
    })
    const receipt = submit(reviewer, 'documents.propose', {
      document: a.document,
      baseRevision: 0,
      replacement: '审阅后的内容',
      reason: '补充依据'
    })
    const proposed = call('getResult', reviewer, { taskId: receipt.taskId })
    call('grants.share', reviewer, {
      clientId: 'researcher',
      kind: 'task',
      resource: receipt.taskId,
      actions: ['read']
    })
    call('grants.share', reviewer, {
      clientId: 'researcher',
      kind: 'proposal',
      resource: proposed.proposal.proposalId,
      actions: ['read']
    })
    const returned = call('getResult', researcher, { taskId: receipt.taskId })
    expect(returned.proposal.proposalId).toBe(proposed.proposal.proposalId)
    const bytes = call('readArtifact', researcher, {
      ref: returned.proposal.diff,
      offset: 0,
      length: 1000
    })
    expect(JSON.parse(Buffer.from(bytes.base64, 'base64').toString()).after).toBe('审阅后的内容')
    const applied = submit(researcher, 'documents.apply', {
      document: a.document,
      proposalId: returned.proposal.proposalId,
      expectedRevision: 0
    })
    const job = claim()
    begin(job)
    finish(job, { ...a.snapshot, text: '审阅后的内容', revision: 1 })
    expect(call('getResult', researcher, { taskId: applied.taskId }).document.revision).toBe(1)
    const original = call('readArtifact', researcher, {
      ref: a.result.artifacts[0],
      offset: 0,
      length: 1000
    })
    expect(Buffer.from(original.base64, 'base64').toString()).toBe('原文')
  })
  test('knowing IDs or reporting another identity grants no document or task access', () => {
    const a = create()
    denied('getTask', reviewer, { taskId: a.receipt.taskId })
    denied('readArtifact', reviewer, { ref: a.result.artifacts[0], offset: 0, length: 100 })
    denied('submit', reviewer, {
      request: {
        protocol: PROTOCOL,
        requestId: 'read-unauthorized',
        capability: 'documents.read',
        capabilityVersion: 1,
        input: { document: a.document }
      }
    })
    expect(
      call('getResult', reviewer, { taskId: submit(reviewer, 'documents.list', {}).taskId })
        .documents
    ).toHaveLength(0)
  })
  test('a fixed artifact can be delegated, but parent revocation blocks downstream reads', () => {
    const a = create('固定内容')
    const ref = a.result.artifacts[0]
    call('grants.share', researcher, {
      clientId: 'reviewer',
      kind: 'artifact',
      resource: ref.artifactId,
      actions: ['read']
    })
    expect(
      Buffer.from(
        call('readArtifact', reviewer, { ref, offset: 0, length: 100 }).base64,
        'base64'
      ).toString()
    ).toBe('固定内容')
    const parent = store.row(
      "SELECT * FROM grants WHERE client_id=? AND kind='document' AND resource=?",
      'researcher',
      a.document.documentId
    )
    call('admin.revoke', store.adminToken, { grantId: parent.id })
    denied('readArtifact', reviewer, { ref, offset: 0, length: 100 })
    denied('getResult', researcher, { taskId: a.receipt.taskId })
  })
  test('sharing cannot amplify actions, wildcard scope or grant duration', () => {
    const a = create()
    denied('grants.share', researcher, {
      clientId: 'reviewer',
      kind: 'artifact',
      resource: a.result.artifacts[0].artifactId,
      actions: ['write']
    })
    denied('grants.share', researcher, {
      clientId: 'reviewer',
      kind: 'document',
      resource: '*',
      actions: ['read']
    })
    denied(
      'admin.pair',
      store.adminToken,
      { clientId: '../escape', label: 'x' },
      'INVALID_ARGUMENT'
    )
  })
  test('retrying a lost sharing receipt returns the same grant; revocation is not undone by replay', () => {
    const a = create()
    const args = {
      clientId: 'reviewer',
      kind: 'artifact',
      resource: a.result.artifacts[0].artifactId,
      actions: ['read'],
      requestId: 'share-once'
    }
    const first = call('grants.create', researcher, args),
      again = call('grants.create', researcher, args)
    expect(again.grantId).toBe(first.grantId)
    denied('grants.revoke', reviewer, {
      grantId: store.row('SELECT id FROM grants WHERE kind=?', 'workspace').id
    })
    call('grants.revoke', researcher, { grantId: first.grantId })
    expect(call('grants.create', researcher, args).active).toBe(false)
    denied('readArtifact', reviewer, { ref: a.result.artifacts[0], offset: 0, length: 10 })
    denied(
      'grants.create',
      researcher,
      { ...args, actions: ['read', 'share'] },
      'IDEMPOTENCY_MISMATCH'
    )
  })
  test('suggestions preserve original content and have independent access controls', () => {
    const a = create('原文')
    grant('reviewer', 'document', a.document.documentId, ['read', 'propose'])
    const r = submit(reviewer, 'documents.propose', {
      document: a.document,
      baseRevision: 0,
      replacement: '建议',
      reason: '更准确'
    })
    const result = call('getResult', reviewer, { taskId: r.taskId })
    expect(store.row('SELECT text FROM documents WHERE id=?', a.document.documentId).text).toBe(
      '原文'
    )
    denied('submit', researcher, {
      request: {
        protocol: PROTOCOL,
        requestId: crypto.randomUUID(),
        capability: 'documents.apply',
        capabilityVersion: 1,
        input: { document: a.document, proposalId: result.proposal.proposalId, expectedRevision: 0 }
      }
    })
  })
  test('grants revoked before execution prevent writes, while an already committed result remains an honest success', () => {
    const a = create('abc')
    const r = submit(researcher, 'documents.patch', {
      document: a.document,
      baseRevision: 0,
      edits: [{ from: 0, to: 1, expectedText: 'a', text: 'z' }]
    })
    const job = claim()
    begin(job)
    const g = store.row(
      "SELECT * FROM grants WHERE kind='document' AND client_id=? AND resource=?",
      'researcher',
      a.document.documentId
    )
    call('admin.revoke', store.adminToken, { grantId: g.id })
    finish(job, { ...a.snapshot, text: 'zbc', revision: 1 })
    expect(call('admin.inspectTask', store.adminToken, { taskId: r.taskId }).state).toBe(
      'succeeded'
    )
    denied('getResult', researcher, { taskId: r.taskId })
  })
  test('chunk uploads enforce lengths, UTF-8, immutable versions and independent client ownership', () => {
    const text = '中文😀'.repeat(20000)
    const bytes = Buffer.from(text)
    const u = call('artifacts.beginUpload', researcher, {
      mediaType: 'text/markdown',
      size: bytes.length
    })
    for (let offset = 0; offset < bytes.length; offset += LIMITS.chunk)
      call('artifacts.writeChunk', researcher, {
        uploadId: u.uploadId,
        offset,
        base64: bytes.subarray(offset, offset + LIMITS.chunk).toString('base64')
      })
    denied('artifacts.commitUpload', reviewer, { uploadId: u.uploadId })
    const ref = call('artifacts.commitUpload', researcher, { uploadId: u.uploadId })
    expect(ref.size).toBe(bytes.length)
    denied(
      'readArtifact',
      researcher,
      { ref: { ...ref, version: '0'.repeat(64) }, offset: 0, length: 1 },
      'ARTIFACT_NOT_FOUND'
    )
    denied(
      'readArtifact',
      researcher,
      { ref, offset: 0, length: LIMITS.chunk + 1 },
      'INVALID_ARGUMENT'
    )
    const invalid = call('artifacts.beginUpload', researcher, { mediaType: 'text/plain', size: 1 })
    call('artifacts.writeChunk', researcher, {
      uploadId: invalid.uploadId,
      offset: 0,
      base64: '/w=='
    })
    denied('artifacts.commitUpload', researcher, { uploadId: invalid.uploadId }, 'INVALID_ARGUMENT')
  })
  test('a valid UTF-8 BOM is retained in the exact uploaded artifact bytes', () => {
    const bytes = Buffer.from('\ufeff# 带 BOM 的材料\r\n')
    const upload = call('artifacts.beginUpload', researcher, {
      mediaType: 'text/markdown',
      size: bytes.length
    })
    call('artifacts.writeChunk', researcher, {
      uploadId: upload.uploadId,
      offset: 0,
      base64: bytes.toString('base64')
    })
    const ref = call('artifacts.commitUpload', researcher, { uploadId: upload.uploadId })
    expect(ref.size).toBe(bytes.length)
    const result = call('readArtifact', researcher, { ref, offset: 0, length: 1024 })
    expect(Buffer.from(result.base64, 'base64').equals(bytes)).toBe(true)
  })
})

describe('recoverable document trash', () => {
  const setTrash = (snapshot: any, trashed: boolean, baseRevision = snapshot.revision) =>
    call('worker.setTrash', store.workerToken, { snapshot, trashed, baseRevision })

  test('trash hides new document operations while delivered artifacts and results remain readable', () => {
    const a = create('不可变历史 😀')
    const readId = 'read-before-trash'
    const read = submit(researcher, 'documents.read', { document: a.document }, readId)
    const proposed = submit(researcher, 'documents.propose', {
      document: a.document,
      baseRevision: 0,
      replacement: '建议内容'
    })
    const proposal = call('getResult', researcher, { taskId: proposed.taskId }).proposal
    setTrash(a.snapshot, true)
    const listed = submit(researcher, 'documents.list', {})
    expect(call('getResult', researcher, { taskId: listed.taskId }).documents).toEqual([])
    for (const [capability, input] of [
      ['documents.read', { document: a.document }],
      ['documents.outline', { document: a.document }],
      ['documents.export', { document: a.document }],
      ['documents.propose', { document: a.document, baseRevision: 0, replacement: '新建议' }],
      [
        'documents.patch',
        {
          document: a.document,
          baseRevision: 0,
          edits: [{ from: 0, to: 0, expectedText: '', text: 'x' }]
        }
      ],
      ['documents.save', { document: a.document, expectedRevision: 0 }],
      [
        'documents.apply',
        { document: a.document, proposalId: proposal.proposalId, expectedRevision: 0 }
      ]
    ] as const)
      denied(
        'submit',
        researcher,
        {
          request: {
            protocol: PROTOCOL,
            requestId: crypto.randomUUID(),
            capability,
            capabilityVersion: 1,
            input
          }
        },
        'DOCUMENT_NOT_FOUND'
      )
    denied(
      'worker.publish',
      store.workerToken,
      { snapshot: { ...a.snapshot, text: '不能复活', revision: 1 }, expectedRevision: 0 },
      'DOCUMENT_NOT_FOUND'
    )
    expect(submit(researcher, 'documents.read', { document: a.document }, readId).taskId).toBe(
      read.taskId
    )
    expect(call('getResult', researcher, { taskId: read.taskId }).text).toBe('不可变历史 😀')
    const artifact = call('readArtifact', researcher, {
      ref: a.result.artifacts[0],
      offset: 0,
      length: 1000
    })
    expect(Buffer.from(artifact.base64, 'base64').toString()).toBe('不可变历史 😀')
    setTrash(a.snapshot, false)
    const restored = submit(researcher, 'documents.read', { document: a.document })
    expect(call('getResult', researcher, { taskId: restored.taskId }).text).toBe('不可变历史 😀')
  })

  test('trash cancels queued and unapproved writers without deleting their historical receipts', () => {
    const a = create('abc')
    const queued = submit(researcher, 'documents.patch', {
      document: a.document,
      baseRevision: 0,
      edits: [{ from: 0, to: 0, expectedText: '', text: 'Q' }]
    })
    const guarded = pair('guarded', false)
    grant('guarded', 'document', a.snapshot.id, ['read', 'write'])
    const waiting = submit(guarded, 'documents.patch', {
      document: a.document,
      baseRevision: 0,
      edits: [{ from: 0, to: 0, expectedText: '', text: 'W' }]
    })
    expect(waiting.state).toBe('waiting-approval')
    setTrash(a.snapshot, true)
    expect(call('getTask', researcher, { taskId: queued.taskId }).state).toBe('cancelled')
    expect(call('getTask', guarded, { taskId: waiting.taskId }).state).toBe('cancelled')
    expect(claim()).toBeNull()
    expect(store.row('SELECT text FROM documents WHERE id=?', a.snapshot.id).text).toBe('abc')
    expect(store.row('SELECT COUNT(*) AS n FROM tasks').n).toBe(3)
  })

  test.each(['running', 'committing', 'recovering'])('trash is blocked by a %s write', (phase) => {
    const a = create('abc')
    const receipt = submit(researcher, 'documents.patch', {
      document: a.document,
      baseRevision: 0,
      edits: [{ from: 0, to: 0, expectedText: '', text: 'x' }]
    })
    const job = claim()
    if (phase !== 'running') begin(job)
    if (phase === 'recovering')
      store.run('UPDATE tasks SET lease_until=0 WHERE id=?', receipt.taskId)
    denied(
      'worker.setTrash',
      store.workerToken,
      { snapshot: a.snapshot, baseRevision: 0, trashed: true },
      'DOCUMENT_BUSY'
    )
    expect(store.row('SELECT trashed FROM documents WHERE id=?', a.snapshot.id).trashed).toBe(0)
    expect(store.row('SELECT text FROM documents WHERE id=?', a.snapshot.id).text).toBe('abc')
  })

  test('an offline restoration keeps its original base and cannot overwrite a newer remote document', () => {
    const a = create('基础版本')
    setTrash(a.snapshot, true)
    const peer = { ...a.snapshot, text: '其它执行器的新内容', revision: 1 }
    setTrash(peer, false, 0)
    denied(
      'worker.setTrash',
      store.workerToken,
      {
        snapshot: { ...a.snapshot, text: '离线恢复后又编辑', revision: 2 },
        baseRevision: 0,
        trashed: false
      },
      'REVISION_CONFLICT'
    )
    expect(store.row('SELECT text,revision FROM documents WHERE id=?', a.snapshot.id)).toEqual({
      text: peer.text,
      revision: 1
    })
  })

  test('retrying a lost restore acknowledgement is idempotent at its already published snapshot', () => {
    const a = create('原版本')
    setTrash(a.snapshot, true)
    const restored = { ...a.snapshot, text: '离线恢复后的输入', revision: 1 }
    const first = setTrash(restored, false, 0)
    expect(setTrash(restored, false, 0)).toEqual(first)
    expect(store.row('SELECT COUNT(*) AS n FROM snapshots WHERE doc=?', a.snapshot.id).n).toBe(2)
    expect(store.row('SELECT trashed FROM documents WHERE id=?', a.snapshot.id).trashed).toBe(0)
  })

  test('adding the trash column migrates existing document rows without changing their content', () => {
    const a = create('迁移前的原文')
    store.db.exec('ALTER TABLE documents DROP COLUMN trashed')
    store.close()
    store = new StateStore(directory)
    connect()
    expect(
      store.row('SELECT text,revision,trashed FROM documents WHERE id=?', a.snapshot.id)
    ).toEqual({ text: '迁移前的原文', revision: 0, trashed: 0 })
    const read = submit(researcher, 'documents.read', { document: a.document })
    expect(call('getResult', researcher, { taskId: read.taskId }).text).toBe('迁移前的原文')
  })
})
