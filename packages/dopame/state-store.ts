import { Database } from 'bun:sqlite'
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import {
  CAPABILITIES,
  LIMITS,
  PROTOCOL,
  boundedText,
  canonical,
  documentRef,
  fail,
  fault,
  id,
  integer,
  isIsoTime,
  outline,
  patchText,
  strict,
  validateRequest,
  type ArtifactRef,
  type Envelope,
  type TaskRequest,
  type TaskState
} from './protocol'

const hash = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex')
const uuid = () => randomUUID()
const now = () => Date.now()
const json = (v: any) => JSON.stringify(v)
const parse = (v: string | null) => (v ? JSON.parse(v) : null)
const active = ['queued', 'waiting-approval', 'running', 'committing', 'recovering']
const mutating = new Set([
  'documents.create',
  'documents.patch',
  'documents.apply',
  'documents.save'
])
const actions = new Set([
  'read',
  'create',
  'write',
  'propose',
  'apply',
  'save',
  'export',
  'share',
  'task:read',
  'proposal:read'
])
type Snapshot = { id: string; title: string; text: string; revision: number; savedRevision: number }

export class StateStore {
  db: Database
  stateDir: string
  adminToken: string
  workerToken: string
  workerInstance = ''
  workerAt = 0
  constructor(stateDir: string) {
    this.stateDir = stateDir
    mkdirSync(stateDir, { recursive: true, mode: 0o700 })
    chmodSync(stateDir, 0o700)
    this.adminToken = this.credential('administrator.json', 'administrator')
    this.workerToken = this.credential('worker.json', 'marktext-worker')
    this.db = new Database(join(stateDir, 'collaboration.sqlite'), { create: true, strict: true })
    this.db.exec(
      'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;'
    )
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS clients(id TEXT PRIMARY KEY,label TEXT NOT NULL,token_hash TEXT NOT NULL UNIQUE,revoked INTEGER NOT NULL DEFAULT 0,direct_apply INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS grants(id TEXT PRIMARY KEY,client_id TEXT NOT NULL,kind TEXT NOT NULL,resource TEXT NOT NULL,actions TEXT NOT NULL,expires INTEGER,parent TEXT,revoked INTEGER NOT NULL DEFAULT 0,can_share INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS grants_client ON grants(client_id,kind,resource);
      CREATE TABLE IF NOT EXISTS grant_requests(issuer TEXT NOT NULL,request_id TEXT NOT NULL,digest TEXT NOT NULL,grant_id TEXT NOT NULL,PRIMARY KEY(issuer,request_id));
      CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY,title TEXT NOT NULL,revision INTEGER NOT NULL,saved_revision INTEGER NOT NULL,text TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS snapshots(doc TEXT NOT NULL,revision INTEGER NOT NULL,title TEXT NOT NULL,text TEXT NOT NULL,PRIMARY KEY(doc,revision));
      CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY,version TEXT NOT NULL,media TEXT NOT NULL,size INTEGER NOT NULL,data BLOB NOT NULL,created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS uploads(id TEXT PRIMARY KEY,client_id TEXT NOT NULL,media TEXT NOT NULL,size INTEGER NOT NULL,expected_hash TEXT,data BLOB NOT NULL,created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,client_id TEXT NOT NULL,request_id TEXT NOT NULL,digest TEXT NOT NULL,request TEXT NOT NULL,state TEXT NOT NULL,stage TEXT NOT NULL,cancel_requested INTEGER NOT NULL DEFAULT 0,lease TEXT,attempt INTEGER NOT NULL DEFAULT 0,lease_until INTEGER,created INTEGER NOT NULL,updated INTEGER NOT NULL,result TEXT,error TEXT,target_doc TEXT,expected_text TEXT,source_grant TEXT,UNIQUE(client_id,request_id));
      CREATE TABLE IF NOT EXISTS events(task TEXT NOT NULL,seq INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(task,seq));
      CREATE TABLE IF NOT EXISTS proposals(id TEXT PRIMARY KEY,doc TEXT NOT NULL,base_revision INTEGER NOT NULL,replacement TEXT NOT NULL,reason TEXT NOT NULL,diff TEXT NOT NULL);
    `)
    const columns = this.all('PRAGMA table_info(tasks)').map((c) => c.name)
    for (const column of ['expected_text', 'source_grant'])
      if (!columns.includes(column))
        this.db.exec('ALTER TABLE tasks ADD COLUMN ' + column + ' TEXT')
    chmodSync(join(stateDir, 'collaboration.sqlite'), 0o600)
    this.db.transaction(() => {
      for (const t of this.all("SELECT * FROM tasks WHERE state IN ('running','committing')"))
        this.transition(
          t,
          t.state === 'committing' ? 'recovering' : t.cancel_requested ? 'cancelled' : 'queued',
          '服务重启，核对提交状态',
          { lease: null, lease_until: null }
        )
    })()
  }
  close() {
    this.db.close()
  }
  credential(filename: string, clientId: string) {
    const path = join(this.stateDir, filename)
    if (existsSync(path)) {
      if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())
        fail('IO_ERROR', '凭证路径不是普通文件')
      chmodSync(path, 0o600)
      const d = JSON.parse(readFileSync(path, 'utf8'))
      if (d.clientId !== clientId || !/^[a-f0-9]{64}$/.test(d.token))
        fail('IO_ERROR', '本机凭证文件损坏')
      return d.token as string
    }
    const token = randomBytes(32).toString('hex')
    writeFileSync(path, json({ protocol: PROTOCOL, clientId, token }), { mode: 0o600, flag: 'wx' })
    return token
  }
  row(sql: string, ...values: any[]): any {
    return this.db.query(sql).get(...values)
  }
  all(sql: string, ...values: any[]): any[] {
    return this.db.query(sql).all(...values)
  }
  run(sql: string, ...values: any[]) {
    return this.db.query(sql).run(...values)
  }
  equal(a: any, b: string) {
    return (
      typeof a === 'string' &&
      a.length === b.length &&
      timingSafeEqual(Buffer.from(a), Buffer.from(b))
    )
  }
  admin(token: string) {
    if (!this.equal(token, this.adminToken)) fail('PERMISSION_DENIED', '需要管理员凭证')
  }
  worker(token: string) {
    if (!this.equal(token, this.workerToken)) fail('PERMISSION_DENIED', '需要执行器凭证')
  }
  client(token: string) {
    if (typeof token !== 'string' || token.length !== 64)
      fail('PERMISSION_DENIED', '调用方凭证无效')
    const c = this.row('SELECT * FROM clients WHERE token_hash=? AND revoked=0', hash(token))
    if (!c) fail('PERMISSION_DENIED', '调用方未配对或已撤销')
    return c
  }
  grantLive(g: any, depth = 0): boolean {
    if (
      !g ||
      g.revoked ||
      (g.expires !== null && g.expires <= now()) ||
      depth > LIMITS.grantDepth ||
      !this.row('SELECT 1 FROM clients WHERE id=? AND revoked=0', g.client_id)
    )
      return false
    return (
      !g.parent || this.grantLive(this.row('SELECT * FROM grants WHERE id=?', g.parent), depth + 1)
    )
  }
  allowed(clientId: string, kind: string, resource: string, action: string): any {
    return this.all(
      "SELECT * FROM grants WHERE client_id=? AND kind=? AND (resource=? OR resource='*')",
      clientId,
      kind,
      resource
    ).find((g) => this.grantLive(g) && parse(g.actions).includes(action))
  }
  need(clientId: string, kind: string, resource: string, action: string) {
    const g = this.allowed(clientId, kind, resource, action)
    if (!g) fail('PERMISSION_DENIED', '该内容或动作未获授权')
    return g
  }
  canDelegate(grant: any) {
    return !!grant?.can_share && parse(grant.actions).includes('share')
  }
  addGrant(
    clientId: string,
    kind: string,
    resource: string,
    list: string[],
    parent: string | null = null,
    expires: number | null = null,
    share = false
  ) {
    const gid = uuid()
    this.run(
      'INSERT INTO grants(id,client_id,kind,resource,actions,parent,expires,can_share) VALUES(?,?,?,?,?,?,?,?)',
      gid,
      clientId,
      kind,
      resource,
      json(list),
      parent,
      expires,
      share ? 1 : 0
    )
    return gid
  }
  ref(a: any): ArtifactRef {
    return { artifactId: a.id, version: a.version, mediaType: a.media, size: a.size }
  }
  artifact(clientId: string, ref: ArtifactRef, action = 'read') {
    strict(
      ref,
      ['artifactId', 'version', 'mediaType', 'size'],
      ['artifactId', 'version', 'mediaType', 'size']
    )
    id(ref.artifactId)
    this.need(clientId, 'artifact', ref.artifactId, action)
    const a = this.row('SELECT * FROM artifacts WHERE id=?', ref.artifactId)
    if (!a || a.version !== ref.version || a.media !== ref.mediaType || a.size !== ref.size)
      fail('ARTIFACT_NOT_FOUND', '指定产物版本不存在')
    return a
  }
  publishArtifact(
    clientId: string,
    text: string,
    media = 'text/markdown',
    parent: string | null = null
  ) {
    const data = Buffer.from(boundedText(text, '产物', LIMITS.artifact))
    const aid = uuid()
    const version = hash(data)
    this.run(
      'INSERT INTO artifacts VALUES(?,?,?,?,?,?)',
      aid,
      version,
      media,
      data.length,
      data,
      now()
    )
    const mayShare = parent
      ? this.canDelegate(this.row('SELECT * FROM grants WHERE id=?', parent))
      : true
    this.addGrant(
      clientId,
      'artifact',
      aid,
      mayShare ? ['read', 'share'] : ['read'],
      parent,
      null,
      mayShare
    )
    return { artifactId: aid, version, mediaType: media, size: data.length }
  }
  snapshot(ref: any): any {
    const d = this.row(
      'SELECT * FROM snapshots WHERE doc=? AND revision=?',
      ref.documentId,
      ref.revision
    )
    if (!d) fail('DOCUMENT_NOT_FOUND', '指定文档版本不存在')
    return d
  }
  validateSnapshot(s: any): Snapshot {
    strict(
      s,
      ['id', 'title', 'text', 'revision', 'savedRevision'],
      ['id', 'title', 'text', 'revision', 'savedRevision']
    )
    id(s.id)
    boundedText(s.title, '标题', 800)
    boundedText(s.text, '文档')
    integer(s.revision, 0, Number.MAX_SAFE_INTEGER, 'revision')
    integer(s.savedRevision, -1, s.revision, 'savedRevision')
    return s
  }
  publishSnapshot(s: Snapshot, expected: number) {
    this.validateSnapshot(s)
    const old = this.row('SELECT * FROM documents WHERE id=?', s.id)
    if ((old?.revision ?? -1) !== expected)
      fail('REVISION_CONFLICT', '文档版本已更新', { actualRevision: old?.revision ?? -1 })
    if (old && s.revision < old.revision)
      fail('REVISION_CONFLICT', '拒绝倒退文档版本', { actualRevision: old.revision })
    const prior = this.row('SELECT * FROM snapshots WHERE doc=? AND revision=?', s.id, s.revision)
    if (prior && (prior.text !== s.text || prior.title !== s.title))
      fail('REVISION_CONFLICT', '同一版本内容不可改变', { actualRevision: old?.revision })
    this.run(
      'INSERT INTO documents VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,revision=excluded.revision,saved_revision=excluded.saved_revision,text=excluded.text',
      s.id,
      s.title,
      s.revision,
      s.savedRevision,
      s.text
    )
    this.run('INSERT OR IGNORE INTO snapshots VALUES(?,?,?,?)', s.id, s.revision, s.title, s.text)
  }
  transition(t: any, state: TaskState, stage: string, extra: any = {}) {
    const changes = { state, stage, updated: now(), ...extra }
    const keys = Object.keys(changes)
    this.run(
      'UPDATE tasks SET ' + keys.map((k) => k + '=?').join(',') + ' WHERE id=?',
      ...keys.map((k) => changes[k]),
      t.id
    )
    const seq = this.row('SELECT COALESCE(MAX(seq),0)+1 AS seq FROM events WHERE task=?', t.id).seq
    this.run(
      'INSERT INTO events VALUES(?,?,?)',
      t.id,
      seq,
      json({ taskId: t.id, seq, state, stage, at: changes.updated })
    )
    return this.row('SELECT * FROM tasks WHERE id=?', t.id)
  }
  view(t: any) {
    return {
      taskId: t.id,
      state: t.state,
      stage: t.stage,
      createdAt: new Date(t.created).toISOString(),
      updatedAt: new Date(t.updated).toISOString(),
      cancelRequested: !!t.cancel_requested,
      attempt: t.attempt,
      error: parse(t.error),
      source: {
        clientId: t.client_id,
        label: this.row('SELECT label FROM clients WHERE id=?', t.client_id)?.label ?? t.client_id
      }
    }
  }
  requestPermission(c: any, r: TaskRequest) {
    const definition = CAPABILITIES.find((x) => x.id === r.capability)!
    const d = r.input.document
    if (r.capability === 'documents.create') this.need(c.id, 'workspace', '*', 'create')
    else if (d)
      for (const action of definition.permissions) this.need(c.id, 'document', d.documentId, action)
    if (r.input.artifact) this.artifact(c.id, r.input.artifact)
    if (r.capability === 'documents.apply') {
      this.need(c.id, 'proposal', r.input.proposalId, 'read')
      const proposal = this.row('SELECT * FROM proposals WHERE id=?', r.input.proposalId)
      if (
        !proposal ||
        proposal.doc !== d.documentId ||
        proposal.base_revision !== r.input.expectedRevision
      )
        fail('REVISION_CONFLICT', '建议基础版本不匹配')
    }
    if (r.parentTaskId) this.task(c, r.parentTaskId)
  }
  task(c: any, taskId: any) {
    id(taskId, 'taskId')
    const t = this.row('SELECT * FROM tasks WHERE id=?', taskId)
    if (!t) fail('PERMISSION_DENIED', '任务不可访问')
    if (t.client_id !== c.id) this.need(c.id, 'task', taskId, 'read')
    const r = parse(t.request)
    if (r.input.document) this.need(c.id, 'document', r.input.document.documentId, 'read')
    const result = parse(t.result)
    if (result?.document) this.need(c.id, 'document', result.document.documentId, 'read')
    return t
  }
  completeRead(t: any, c: any, r: TaskRequest) {
    let result: any = {
      taskId: t.id,
      artifacts: [],
      sources: r.input.artifact ? [r.input.artifact] : [],
      summary: ''
    }
    const action = r.capability.split('.')[1]
    const d = r.input.document
    let s: any
    if (d) s = this.snapshot(d)
    if (action === 'list') {
      const rows = this.all('SELECT id,title,revision FROM documents ORDER BY id')
        .filter((x) => this.allowed(c.id, 'document', x.id, 'read'))
        .filter((x) => !r.input.after || x.id > r.input.after)
      const page = rows.slice(0, r.input.limit ?? 50)
      result.documents = page.map((x) => ({
        document: documentRef(x.id, x.revision),
        title: x.title
      }))
      result.nextCursor = rows.length > page.length ? page.at(-1)?.id : null
      result.summary = '已列出获授权文档'
    } else if (action === 'read') {
      const from = r.input.from ?? 0
      const to = r.input.to ?? s.text.length
      integer(from, 0, s.text.length, 'from')
      integer(to, from, s.text.length, 'to')
      result.document = d
      result.text = s.text.slice(from, to)
      result.summary = '已读取固定版本'
    } else if (action === 'outline') {
      result.document = d
      result.outline = outline(s.text)
      result.summary = '已读取大纲'
    } else if (action === 'export') {
      const g = this.need(c.id, 'document', d.documentId, 'read')
      result.document = d
      result.artifacts = [this.publishArtifact(c.id, s.text, 'text/markdown', g.id)]
      result.summary = '已导出不可变版本'
    } else if (action === 'propose') {
      if (r.input.baseRevision !== d.revision)
        fail('REVISION_CONFLICT', '建议的基础版本不一致', { actualRevision: s.revision })
      const replacement = r.input.artifact
        ? new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
            this.artifact(c.id, r.input.artifact).data
          )
        : (r.input.replacement ?? patchText(s.text, r.input.edits))
      boundedText(replacement, '建议内容')
      const proposalId = uuid()
      const g = this.need(c.id, 'document', d.documentId, 'propose')
      const diff = this.publishArtifact(
        c.id,
        json({
          before: s.text,
          after: replacement,
          baseRevision: s.revision,
          reason: r.input.reason ?? ''
        }),
        'application/json',
        g.id
      )
      const mayShare = this.canDelegate(g)
      this.run(
        'INSERT INTO proposals VALUES(?,?,?,?,?,?)',
        proposalId,
        d.documentId,
        d.revision,
        replacement,
        r.input.reason ?? '',
        json(diff)
      )
      this.addGrant(
        c.id,
        'proposal',
        proposalId,
        mayShare ? ['read', 'share'] : ['read'],
        g.id,
        null,
        mayShare
      )
      result.document = d
      result.proposal = { proposalId, document: d, diff }
      result.artifacts = [diff]
      result.summary = '建议已提交，原文未改变'
    }
    this.transition(t, 'succeeded', '完成', { result: json(result) })
  }
  sweep() {
    this.db.transaction(() => {
      for (const t of this.all(
        "SELECT * FROM tasks WHERE state='running' AND lease_until<?",
        now()
      ))
        this.transition(t, t.cancel_requested ? 'cancelled' : 'queued', '执行器租约已失效', {
          lease: null,
          lease_until: null
        })
      for (const t of this.all(
        "SELECT * FROM tasks WHERE state='committing' AND lease_until<?",
        now()
      ))
        this.transition(t, 'recovering', '提交回报超时，等待核对', {
          lease: null,
          lease_until: null
        })
      for (const t of this.all(
        "SELECT * FROM tasks WHERE state IN ('queued','waiting-approval')"
      )) {
        const r = parse(t.request)
        if (r.deadlineAt && Date.parse(r.deadlineAt) <= now())
          this.transition(t, 'failed', '超过截止时间', {
            error: json({
              code: 'DEADLINE_EXCEEDED',
              message: '任务在提交前已过期',
              retryable: true
            })
          })
      }
      this.run('DELETE FROM uploads WHERE created<?', now() - 3600000)
    })()
  }
  handle(method: string, token: string, args: any): any {
    id(method, 'method')
    if (method === 'health') {
      this.sweep()
      return {
        protocol: PROTOCOL,
        workerOnline: now() - this.workerAt < LIMITS.leaseMs,
        wakeNeeded: !!this.row(
          "SELECT 1 FROM tasks WHERE state IN ('queued','recovering') LIMIT 1"
        ),
        credentialPath: join(this.stateDir, 'administrator.json'),
        wakeTaskId:
          this.row(
            "SELECT id FROM tasks WHERE state IN ('queued','recovering') ORDER BY created LIMIT 1"
          )?.id ?? null
      }
    }
    strict(args, Object.keys(args ?? {}))
    this.sweep()
    if (method.startsWith('admin.')) return this.adminCall(method, token, args)
    if (method.startsWith('worker.')) return this.workerCall(method, token, args)
    const c = this.client(token)
    if (method === 'listCapabilities') {
      strict(args, [])
      return this.catalogue(c).map((x) => ({
        ...x,
        available: true,
        requiresWorker: mutating.has(x.id),
        workerOnline: now() - this.workerAt < LIMITS.leaseMs
      }))
    }
    if (method === 'describeCapability') {
      strict(args, ['id'], ['id'])
      const x = CAPABILITIES.find((x) => x.id === args.id)
      if (!x) fail('UNSUPPORTED_VERSION', '能力不存在')
      if (!this.catalogue(c).includes(x)) fail('PERMISSION_DENIED', '当前身份未获授权使用该能力')
      return { ...x, available: true }
    }
    if (method === 'submit')
      return this.db.transaction(() => {
        strict(args, ['request'], ['request'])
        const r = validateRequest(args.request)
        const digest = hash(canonical(r))
        const previous = this.row(
          'SELECT * FROM tasks WHERE client_id=? AND request_id=?',
          c.id,
          r.requestId
        )
        if (previous) {
          if (previous.digest !== digest) fail('IDEMPOTENCY_MISMATCH', '同一请求 ID 的参数发生变化')
          this.requestPermission(c, r)
          return {
            taskId: previous.id,
            state: previous.state,
            acceptedAt: new Date(previous.created).toISOString()
          }
        }
        this.requestPermission(c, r)
        if (
          this.row(
            "SELECT COUNT(*) AS n FROM tasks WHERE client_id=? AND state IN ('queued','waiting-approval','running','committing','recovering')",
            c.id
          ).n >= LIMITS.queued
        )
          fail('QUEUE_LIMIT', '待处理任务超过限制', undefined, true)
        const tid = uuid(),
          at = now(),
          target =
            r.capability === 'documents.create' ? uuid() : (r.input.document?.documentId ?? null)
        this.run(
          'INSERT INTO tasks(id,client_id,request_id,digest,request,state,stage,created,updated,target_doc) VALUES(?,?,?,?,?,?,?,?,?,?)',
          tid,
          c.id,
          r.requestId,
          digest,
          json(r),
          'queued',
          '已接受',
          at,
          at,
          target
        )
        const taskParent = r.input.document
          ? this.need(c.id, 'document', r.input.document.documentId, 'read')
          : r.capability === 'documents.create'
            ? this.need(c.id, 'workspace', '*', 'create')
            : null
        const shareTask = taskParent
          ? taskParent.kind === 'workspace'
            ? !!taskParent.can_share
            : this.canDelegate(taskParent)
          : false
        this.addGrant(
          c.id,
          'task',
          tid,
          shareTask ? ['read', 'share'] : ['read'],
          taskParent?.id ?? null,
          null,
          shareTask
        )
        let t = this.row('SELECT * FROM tasks WHERE id=?', tid)
        t = this.transition(
          t,
          !c.direct_apply && ['documents.patch', 'documents.apply'].includes(r.capability)
            ? 'waiting-approval'
            : 'queued',
          '已接受'
        )
        if (!mutating.has(r.capability)) {
          try {
            this.transition(t, 'running', '读取固定版本')
            this.completeRead(t, c, r)
          } catch (e) {
            this.transition(t, 'failed', '执行失败', { error: json(fault(e)) })
          }
        }
        t = this.row('SELECT * FROM tasks WHERE id=?', tid)
        return { taskId: tid, state: t.state, acceptedAt: new Date(at).toISOString() }
      })()
    if (method === 'getTask') {
      strict(args, ['taskId'], ['taskId'])
      return this.view(this.task(c, args.taskId))
    }
    if (method === 'getResult') {
      strict(args, ['taskId'], ['taskId'])
      const t = this.task(c, args.taskId)
      if (active.includes(t.state))
        fail('RESULT_NOT_READY', '任务尚未结束', { state: t.state }, true)
      return t.state === 'succeeded'
        ? parse(t.result)
        : {
            taskId: t.id,
            state: t.state,
            error: parse(t.error),
            artifacts: [],
            summary: t.state === 'cancelled' ? '任务已取消' : '任务失败',
            sources: []
          }
    }
    if (method === 'cancelTask')
      return this.db.transaction(() => {
        strict(args, ['taskId'], ['taskId'])
        const t = this.task(c, args.taskId)
        if (t.client_id !== c.id) fail('PERMISSION_DENIED', '只有任务发起方可以请求取消')
        if (['committing', 'recovering', 'succeeded', 'failed', 'cancelled'].includes(t.state))
          return {
            accepted: false,
            reason: ['committing', 'recovering'].includes(t.state) ? 'too-late' : 'terminal',
            task: this.view(t)
          }
        const n = this.transition(
          t,
          t.state === 'running' ? 'running' : 'cancelled',
          t.state === 'running' ? '正在停止执行器' : '已取消',
          { cancel_requested: 1 }
        )
        return { accepted: true, task: this.view(n) }
      })()
    if (method === 'listEvents') {
      strict(args, ['taskId', 'afterSeq'], ['taskId', 'afterSeq'])
      const t = this.task(c, args.taskId)
      integer(args.afterSeq, 0, Number.MAX_SAFE_INTEGER, 'afterSeq')
      const events = this.all(
        'SELECT seq,payload FROM events WHERE task=? AND seq>? ORDER BY seq LIMIT ?',
        t.id,
        args.afterSeq,
        LIMITS.events
      ).map((e) => parse(e.payload))
      return { events, nextSeq: events.at(-1)?.seq ?? args.afterSeq, task: this.view(t) }
    }
    if (method === 'readArtifact') {
      strict(args, ['ref', 'offset', 'length'], ['ref', 'offset', 'length'])
      const a = this.artifact(c.id, args.ref)
      integer(args.offset, 0, a.size, 'offset')
      integer(args.length, 0, LIMITS.chunk, 'length')
      return {
        base64: Buffer.from(a.data)
          .subarray(args.offset, Math.min(a.size, args.offset + args.length))
          .toString('base64'),
        ref: this.ref(a)
      }
    }
    if (method.startsWith('artifacts.')) return this.artifactCall(method, c, args)
    if (method === 'grants.share' || method === 'grants.create')
      return this.db.transaction(() => this.share(c, args))()
    if (method === 'grants.revoke') {
      strict(args, ['grantId'], ['grantId'])
      const grant = this.row('SELECT * FROM grants WHERE id=?', id(args.grantId))
      const parent = grant?.parent
        ? this.row('SELECT * FROM grants WHERE id=?', grant.parent)
        : null
      if (!grant || (grant.client_id !== c.id && parent?.client_id !== c.id))
        fail('PERMISSION_DENIED', '不能撤销其他调用方的授权')
      this.run('UPDATE grants SET revoked=1 WHERE id=?', grant.id)
      return { revoked: true, grantId: grant.id }
    }
    fail('INVALID_ARGUMENT', '未知方法')
  }
  adminCall(method: string, token: string, args: any): any {
    this.admin(token)
    if (method === 'admin.connect') {
      strict(args, [])
      return {
        connected: true,
        workerToken: this.workerToken,
        workerOnline: now() - this.workerAt < LIMITS.leaseMs
      }
    }
    if (method === 'admin.pair')
      return this.db.transaction(() => {
        strict(args, ['clientId', 'label', 'directApply'], ['clientId', 'label'])
        id(args.clientId, 'clientId', 64)
        boundedText(args.label, '名称', 200)
        if (args.directApply !== undefined && typeof args.directApply !== 'boolean')
          fail('INVALID_ARGUMENT', 'directApply 需要布尔值')
        if (this.row('SELECT 1 FROM clients WHERE id=?', args.clientId))
          fail('INVALID_ARGUMENT', '调用方已存在；请显式撤销或更新授权')
        const path = join(this.stateDir, 'client-' + args.clientId + '.json')
        let secret: string
        if (existsSync(path)) {
          if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())
            fail('IO_ERROR', '调用方凭证文件无效')
          const existing = JSON.parse(readFileSync(path, 'utf8'))
          if (existing.clientId !== args.clientId || !/^[a-f0-9]{64}$/.test(existing.token))
            fail('IO_ERROR', '调用方凭证文件损坏')
          secret = existing.token
          chmodSync(path, 0o600)
        } else {
          secret = randomBytes(32).toString('hex')
          writeFileSync(
            path,
            json({ protocol: PROTOCOL, clientId: args.clientId, token: secret }),
            { mode: 0o600, flag: 'wx' }
          )
        }
        this.run(
          'INSERT INTO clients VALUES(?,?,?,?,?)',
          args.clientId,
          args.label,
          hash(secret),
          0,
          args.directApply ? 1 : 0
        )
        return { clientId: args.clientId, credentialPath: path }
      })()
    if (method === 'admin.grant')
      return this.db.transaction(() => {
        strict(
          args,
          ['clientId', 'kind', 'resource', 'actions', 'expiresAt', 'canShare', 'requestId'],
          ['clientId', 'kind', 'resource', 'actions']
        )
        const c = this.row('SELECT * FROM clients WHERE id=? AND revoked=0', args.clientId)
        if (!c) fail('INVALID_ARGUMENT', '调用方不存在')
        this.validateGrant(args)
        const payload = { ...args }
        delete payload.requestId
        payload.actions = [...args.actions].sort()
        const digest = hash(canonical(payload)),
          requestId = args.requestId === undefined ? digest : id(args.requestId, 'requestId')
        const previous = this.row(
          'SELECT * FROM grant_requests WHERE issuer=? AND request_id=?',
          'administrator',
          requestId
        )
        if (previous) {
          if (previous.digest !== digest) fail('IDEMPOTENCY_MISMATCH', '授权请求参数已变化')
          return {
            grantId: previous.grant_id,
            active: this.grantLive(this.row('SELECT * FROM grants WHERE id=?', previous.grant_id))
          }
        }
        const grantId = this.addGrant(
          c.id,
          args.kind,
          args.resource,
          args.actions,
          null,
          args.expiresAt ? Date.parse(args.expiresAt) : null,
          !!args.canShare
        )
        this.run(
          'INSERT INTO grant_requests VALUES(?,?,?,?)',
          'administrator',
          requestId,
          digest,
          grantId
        )
        return { grantId, active: true }
      })()
    if (method === 'admin.revoke') {
      strict(args, ['grantId', 'clientId'])
      if (!!args.grantId === !!args.clientId) fail('INVALID_ARGUMENT', '指定一种撤销目标')
      if (args.grantId) this.run('UPDATE grants SET revoked=1 WHERE id=?', id(args.grantId))
      else this.run('UPDATE clients SET revoked=1 WHERE id=?', id(args.clientId))
      return { revoked: true }
    }
    if (method === 'admin.list') {
      strict(args, [])
      return {
        clients: this.all('SELECT id,label,revoked,direct_apply AS directApply FROM clients'),
        grants: this.all('SELECT * FROM grants').map((g) => ({
          ...g,
          actions: parse(g.actions),
          live: this.grantLive(g)
        })),
        documents: this.all('SELECT id,title,revision FROM documents'),
        tasks: this.all('SELECT * FROM tasks ORDER BY created DESC LIMIT 100').map((t) => ({
          ...this.view(t),
          capability: parse(t.request).capability
        }))
      }
    }
    if (method === 'admin.approve')
      return this.db.transaction(() => {
        strict(args, ['taskId', 'allow'], ['taskId', 'allow'])
        const t = this.row('SELECT * FROM tasks WHERE id=?', id(args.taskId))
        if (!t || t.state !== 'waiting-approval' || typeof args.allow !== 'boolean')
          fail('INVALID_ARGUMENT', '没有待批准任务')
        return this.view(
          this.transition(
            t,
            args.allow ? 'queued' : 'cancelled',
            args.allow ? '用户已批准' : '用户已拒绝'
          )
        )
      })()
    if (method === 'admin.cancel')
      return this.db.transaction(() => {
        strict(args, ['taskId'], ['taskId'])
        const t = this.row('SELECT * FROM tasks WHERE id=?', id(args.taskId))
        if (!t) fail('INVALID_ARGUMENT', '任务不存在')
        if (['committing', 'recovering', 'succeeded', 'failed', 'cancelled'].includes(t.state))
          return { accepted: false, task: this.view(t) }
        return {
          accepted: true,
          task: this.view(
            this.transition(
              t,
              t.state === 'running' ? 'running' : 'cancelled',
              t.state === 'running' ? '用户正在请求停止' : '用户已取消',
              { cancel_requested: 1 }
            )
          )
        }
      })()
    if (method === 'admin.inspectTask') {
      strict(args, ['taskId'], ['taskId'])
      const t = this.row('SELECT * FROM tasks WHERE id=?', id(args.taskId))
      if (!t) fail('INVALID_ARGUMENT', '任务不存在')
      return { ...this.view(t), request: parse(t.request), result: parse(t.result) }
    }
    if (method === 'admin.inspectProposal') {
      strict(args, ['proposalId'], ['proposalId'])
      const p = this.row('SELECT * FROM proposals WHERE id=?', id(args.proposalId))
      if (!p) fail('INVALID_ARGUMENT', '建议不存在')
      return { ...p, before: this.snapshot({ documentId: p.doc, revision: p.base_revision }).text }
    }
    if (method === 'admin.authorizeWake') {
      strict(args, [])
      return { authorized: true }
    }
    fail('INVALID_ARGUMENT', '未知管理方法')
  }
  validateGrant(a: any) {
    if (!['workspace', 'document', 'artifact', 'task', 'proposal'].includes(a.kind))
      fail('INVALID_ARGUMENT', '资源种类无效')
    if (a.resource !== '*') id(a.resource, 'resource')
    if (
      !Array.isArray(a.actions) ||
      !a.actions.length ||
      a.actions.length > actions.size ||
      new Set(a.actions).size !== a.actions.length ||
      a.actions.some((x: any) => !actions.has(x))
    )
      fail('INVALID_ARGUMENT', '授权动作无效')
    if (a.expiresAt !== undefined && (!isIsoTime(a.expiresAt) || Date.parse(a.expiresAt) <= now()))
      fail('INVALID_ARGUMENT', '有效期无效')
    if (a.canShare !== undefined && typeof a.canShare !== 'boolean')
      fail('INVALID_ARGUMENT', 'canShare 无效')
  }
  catalogue(c: any) {
    const scopes = this.all("SELECT * FROM grants WHERE client_id=? AND kind='document'", c.id)
      .filter((g) => this.grantLive(g))
      .map((g) => g.resource)
    return CAPABILITIES.filter((capability) =>
      capability.id === 'documents.create'
        ? !!this.allowed(c.id, 'workspace', '*', 'create')
        : scopes.some((resource) =>
            capability.permissions.every((action) =>
              this.allowed(c.id, 'document', resource, action)
            )
          )
    )
  }
  share(c: any, a: any) {
    strict(
      a,
      ['clientId', 'kind', 'resource', 'actions', 'expiresAt', 'canShare', 'requestId'],
      ['clientId', 'kind', 'resource', 'actions']
    )
    this.validateGrant(a)
    if (a.resource === '*') fail('PERMISSION_DENIED', '转授权不能扩大到全部资源')
    const payload = { ...a }
    delete payload.requestId
    payload.actions = [...a.actions].sort()
    const digest = hash(canonical(payload)),
      requestId = a.requestId === undefined ? digest : id(a.requestId, 'requestId')
    const previous = this.row(
      'SELECT * FROM grant_requests WHERE issuer=? AND request_id=?',
      c.id,
      requestId
    )
    if (previous) {
      if (previous.digest !== digest) fail('IDEMPOTENCY_MISMATCH', '同一授权请求的参数发生变化')
      return {
        grantId: previous.grant_id,
        active: this.grantLive(this.row('SELECT * FROM grants WHERE id=?', previous.grant_id))
      }
    }
    if (!this.row('SELECT 1 FROM clients WHERE id=? AND revoked=0', a.clientId))
      fail('PERMISSION_DENIED', '下游未配对')
    const parent = this.need(c.id, a.kind, a.resource, 'share')
    if (!parent.can_share || a.actions.some((x: string) => !parse(parent.actions).includes(x)))
      fail('PERMISSION_DENIED', '不允许扩大授权范围')
    const expires = a.expiresAt ? Date.parse(a.expiresAt) : parent.expires
    if (parent.expires !== null && (expires === null || expires > parent.expires))
      fail('PERMISSION_DENIED', '不能扩大有效期')
    const grantId = this.addGrant(
      a.clientId,
      a.kind,
      a.resource,
      a.actions,
      parent.id,
      expires,
      !!a.canShare
    )
    if (a.kind === 'proposal' && a.actions.includes('read')) {
      const p = this.row('SELECT diff FROM proposals WHERE id=?', a.resource)
      if (p) {
        const diff = parse(p.diff)
        this.need(c.id, 'artifact', diff.artifactId, 'read')
        this.addGrant(a.clientId, 'artifact', diff.artifactId, ['read'], grantId, expires, false)
      }
    }
    this.run('INSERT INTO grant_requests VALUES(?,?,?,?)', c.id, requestId, digest, grantId)
    return { grantId, active: true }
  }
  artifactCall(method: string, c: any, a: any): any {
    if (method === 'artifacts.beginUpload') {
      strict(a, ['mediaType', 'size', 'sha256'], ['mediaType', 'size'])
      if (!['text/markdown', 'text/plain', 'application/json'].includes(a.mediaType))
        fail('INVALID_ARGUMENT', '产物类型无效')
      integer(a.size, 0, LIMITS.artifact, 'size')
      if (a.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(a.sha256))
        fail('INVALID_ARGUMENT', 'sha256 无效')
      if (this.row('SELECT COUNT(*) AS n FROM uploads WHERE client_id=?', c.id).n >= 4)
        fail('QUEUE_LIMIT', '未完成上传过多')
      const uid = uuid()
      this.run(
        'INSERT INTO uploads VALUES(?,?,?,?,?,?,?)',
        uid,
        c.id,
        a.mediaType,
        a.size,
        a.sha256 ?? null,
        Buffer.alloc(0),
        now()
      )
      return { uploadId: uid, chunkSize: LIMITS.chunk }
    }
    strict(
      a,
      method === 'artifacts.writeChunk' ? ['uploadId', 'offset', 'base64'] : ['uploadId'],
      method === 'artifacts.writeChunk' ? ['uploadId', 'offset', 'base64'] : ['uploadId']
    )
    const u = this.row('SELECT * FROM uploads WHERE id=? AND client_id=?', id(a.uploadId), c.id)
    if (!u) fail('PERMISSION_DENIED', '上传不存在或不可访问')
    if (method === 'artifacts.writeChunk') {
      integer(a.offset, 0, u.size, 'offset')
      if (
        typeof a.base64 !== 'string' ||
        a.base64.length > Math.ceil(LIMITS.chunk / 3) * 4 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(a.base64)
      )
        fail('INVALID_ARGUMENT', '分块编码无效')
      const bytes = Buffer.from(a.base64, 'base64')
      if (
        bytes.length > LIMITS.chunk ||
        a.offset !== u.data.length ||
        a.offset + bytes.length > u.size
      )
        fail('INVALID_ARGUMENT', '分块范围无效')
      this.run('UPDATE uploads SET data=? WHERE id=?', Buffer.concat([u.data, bytes]), u.id)
      return { offset: a.offset + bytes.length }
    }
    if (method === 'artifacts.commitUpload')
      return this.db.transaction(() => {
        if (u.data.length !== u.size || (u.expected_hash && hash(u.data) !== u.expected_hash))
          fail('INVALID_ARGUMENT', '上传长度或摘要不一致')
        let text: string
        try {
          text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(u.data)
        } catch {
          fail('INVALID_ARGUMENT', '只接受有效 UTF-8 文本')
        }
        const ref = this.publishArtifact(c.id, text!, u.media)
        this.run('DELETE FROM uploads WHERE id=?', u.id)
        return ref
      })()
    fail('INVALID_ARGUMENT', '未知产物方法')
  }
  workerTask(a: any, states: string[]) {
    id(a.taskId, 'taskId')
    id(a.lease, 'lease')
    const t = this.row('SELECT * FROM tasks WHERE id=?', a.taskId)
    if (!t || t.lease !== a.lease || !states.includes(t.state) || t.lease_until < now())
      fail('LEASE_EXPIRED', '执行器租约已失效')
    return t
  }
  workerCall(method: string, token: string, a: any): any {
    this.worker(token)
    if (method === 'worker.authenticate') {
      strict(a, ['instanceId'], ['instanceId'])
      id(a.instanceId)
      return {
        authenticated: true,
        sessionValid: this.workerInstance === a.instanceId && now() - this.workerAt < LIMITS.leaseMs
      }
    }
    if (method === 'worker.connect') {
      strict(a, ['instanceId'], ['instanceId'])
      id(a.instanceId)
      if (
        this.workerInstance &&
        this.workerInstance !== a.instanceId &&
        now() - this.workerAt < LIMITS.leaseMs
      )
        fail('WORKER_BUSY', '已有执行器在线')
      this.workerInstance = a.instanceId
      this.workerAt = now()
      return {
        connected: true,
        recovering: this.all("SELECT * FROM tasks WHERE state='recovering'").map((t) => ({
          ...this.view(t),
          request: parse(t.request),
          targetDocumentId: t.target_doc
        }))
      }
    }
    if (method === 'worker.heartbeat') {
      strict(a, ['instanceId'], ['instanceId'])
      if (a.instanceId !== this.workerInstance) fail('LEASE_EXPIRED', '执行器连接已失效')
      this.workerAt = now()
      this.run(
        "UPDATE tasks SET lease_until=? WHERE state='running' AND lease IS NOT NULL",
        now() + LIMITS.leaseMs
      )
      return { online: true }
    }
    if (method === 'worker.disconnect') {
      strict(a, ['instanceId'], ['instanceId'])
      if (a.instanceId !== this.workerInstance) fail('LEASE_EXPIRED', '执行器连接已失效')
      this.workerAt = 0
      this.workerInstance = ''
      return { disconnected: true }
    }
    if (
      a.instanceId !== this.workerInstance ||
      !this.workerInstance ||
      now() - this.workerAt >= LIMITS.leaseMs
    )
      fail('LEASE_EXPIRED', '执行器会话已失效')
    a = { ...a }
    delete a.instanceId
    if (method === 'worker.recoveryTasks') {
      strict(a, [])
      return this.all(
        "SELECT * FROM tasks WHERE state IN ('running','committing','recovering') ORDER BY created LIMIT 16"
      ).map((t) => ({
        ...this.view(t),
        request: parse(t.request),
        targetDocumentId: t.target_doc,
        lease: t.lease,
        result: parse(t.result)
      }))
    }
    if (method === 'worker.taskStatus') {
      strict(a, ['taskId'], ['taskId'])
      const t = this.row('SELECT * FROM tasks WHERE id=?', id(a.taskId))
      if (!t) fail('INVALID_ARGUMENT', '任务不存在')
      return {
        ...this.view(t),
        request: parse(t.request),
        targetDocumentId: t.target_doc,
        lease: t.lease,
        result: parse(t.result)
      }
    }
    if (method === 'worker.expectedCommit') {
      strict(a, ['taskId'], ['taskId'])
      const t = this.row('SELECT * FROM tasks WHERE id=?', id(a.taskId))
      if (!t || t.expected_text === null) fail('RESULT_NOT_READY', '任务尚未进入提交')
      const request = parse(t.request),
        create = request.capability === 'documents.create',
        base = create ? null : this.snapshot(request.input.document)
      return {
        id: t.target_doc,
        title: create ? request.input.title : base.title,
        text: t.expected_text,
        revision: create
          ? 0
          : request.capability === 'documents.save'
            ? base.revision
            : base.revision + 1,
        savedRevision: request.capability === 'documents.save' ? base.revision : -1
      }
    }
    if (method === 'worker.publish')
      return this.db.transaction(() => {
        strict(a, ['snapshot', 'expectedRevision'], ['snapshot', 'expectedRevision'])
        integer(a.expectedRevision, -1, Number.MAX_SAFE_INTEGER, 'expectedRevision')
        if (
          this.row(
            "SELECT 1 FROM tasks WHERE target_doc=? AND state IN ('committing','recovering')",
            a.snapshot?.id
          )
        )
          fail('DOCUMENT_BUSY', '正在核对文档提交', undefined, true)
        this.publishSnapshot(a.snapshot, a.expectedRevision)
        return { document: documentRef(a.snapshot.id, a.snapshot.revision) }
      })()
    if (method === 'worker.documentStatus') {
      strict(a, ['documentId'], ['documentId'])
      return this.row(
        'SELECT id,title,revision,saved_revision AS savedRevision FROM documents WHERE id=?',
        id(a.documentId)
      )
    }
    if (method === 'worker.jobStatus') {
      strict(a, ['taskId', 'lease'], ['taskId', 'lease'])
      return this.view(this.workerTask(a, ['running', 'committing']))
    }
    if (method === 'worker.activity') {
      strict(a, [])
      return this.all('SELECT * FROM tasks ORDER BY created DESC LIMIT 50').map((t) => ({
        ...this.view(t),
        capability: parse(t.request).capability,
        documentId: t.target_doc,
        proposalId: parse(t.result)?.proposal?.proposalId
      }))
    }
    if (method === 'worker.proposal') {
      strict(a, ['proposalId'], ['proposalId'])
      const p = this.row('SELECT * FROM proposals WHERE id=?', id(a.proposalId))
      if (!p) fail('ARTIFACT_NOT_FOUND', '建议不存在')
      return {
        proposalId: p.id,
        document: documentRef(p.doc, p.base_revision),
        baseRevision: p.base_revision,
        reason: p.reason,
        before: this.snapshot({ documentId: p.doc, revision: p.base_revision }).text,
        after: p.replacement
      }
    }
    if (method === 'worker.claim')
      return this.db.transaction(() => {
        strict(a, [])
        const t = this.all("SELECT * FROM tasks WHERE state='queued' ORDER BY created").find(
          (t) =>
            !this.row(
              "SELECT 1 FROM tasks WHERE target_doc=? AND state IN ('running','committing','recovering')",
              t.target_doc
            )
        )
        if (!t) return null
        const r = parse(t.request),
          c = this.row('SELECT * FROM clients WHERE id=? AND revoked=0', t.client_id)
        try {
          if (!c) fail('PERMISSION_DENIED', '调用方已撤销')
          this.requestPermission(c, r)
        } catch (e) {
          this.transition(t, 'failed', '授权已失效', { error: json(fault(e)) })
          return null
        }
        const lease = uuid()
        const claimed = this.transition(t, 'running', '执行文档命令', {
          lease,
          lease_until: now() + LIMITS.leaseMs,
          attempt: t.attempt + 1
        })
        const input = { ...r.input }
        if (input.artifact)
          input.markdown = new TextDecoder().decode(this.artifact(c.id, input.artifact).data)
        if (r.capability === 'documents.apply') {
          this.need(c.id, 'proposal', input.proposalId, 'read')
          const p = this.row('SELECT * FROM proposals WHERE id=?', input.proposalId)
          if (
            !p ||
            p.doc !== input.document.documentId ||
            p.base_revision !== input.expectedRevision
          ) {
            this.transition(claimed, 'failed', '建议版本冲突', {
              error: json({
                code: 'REVISION_CONFLICT',
                message: '建议基础版本不匹配',
                retryable: false
              })
            })
            return null
          }
          input.replacement = p.replacement
        }
        return {
          taskId: t.id,
          lease,
          attempt: claimed.attempt,
          request: { ...r, input },
          targetDocumentId: t.target_doc
        }
      })()
    if (method === 'worker.beginCommit')
      return this.db.transaction(() => {
        strict(a, ['taskId', 'lease'], ['taskId', 'lease'])
        const t = this.workerTask(a, ['running'])
        const r = parse(t.request)
        const c = this.row('SELECT * FROM clients WHERE id=? AND revoked=0', t.client_id)
        if (!c) fail('PERMISSION_DENIED', '调用方已撤销')
        this.requestPermission(c, r)
        if (t.cancel_requested) fail('CANCEL_REQUESTED', '取消已请求')
        if (r.deadlineAt && Date.parse(r.deadlineAt) <= now())
          fail('DEADLINE_EXCEEDED', '任务已过期')
        if (r.input.document) {
          const current = this.row(
            'SELECT revision FROM documents WHERE id=?',
            r.input.document.documentId
          )
          if (!current || current.revision !== r.input.document.revision)
            fail('REVISION_CONFLICT', '基础版本已变化', { actualRevision: current?.revision })
          if (
            (r.input.baseRevision !== undefined && r.input.baseRevision !== current.revision) ||
            (r.input.expectedRevision !== undefined &&
              r.input.expectedRevision !== current.revision)
          )
            fail('REVISION_CONFLICT', '基础版本不一致', { actualRevision: current.revision })
        }
        let expectedText: string, source: any
        if (r.capability === 'documents.create') {
          expectedText =
            r.input.markdown ?? new TextDecoder().decode(this.artifact(c.id, r.input.artifact).data)
          source = this.need(c.id, 'workspace', '*', 'create')
        } else {
          const snapshot = this.snapshot(r.input.document)
          source = this.need(c.id, 'document', r.input.document.documentId, 'read')
          expectedText =
            r.capability === 'documents.patch'
              ? patchText(snapshot.text, r.input.edits)
              : r.capability === 'documents.apply'
                ? this.row('SELECT * FROM proposals WHERE id=?', r.input.proposalId)?.replacement
                : snapshot.text
          if (typeof expectedText !== 'string') fail('INVALID_ARGUMENT', '建议不存在')
        }
        return this.view(
          this.transition(t, 'committing', '正在提交', {
            lease_until: now() + LIMITS.leaseMs,
            expected_text: expectedText,
            source_grant: source.id
          })
        )
      })()
    if (method === 'worker.finish')
      return this.db.transaction(() => {
        strict(a, ['taskId', 'lease', 'snapshot'], ['taskId', 'lease', 'snapshot'])
        const t = this.workerTask(a, ['committing'])
        return this.finish(t, a.snapshot)
      })()
    if (method === 'worker.abortCommit')
      return this.db.transaction(() => {
        strict(a, ['taskId', 'lease', 'actualRevision'], ['taskId', 'lease', 'actualRevision'])
        const t = this.workerTask(a, ['committing'])
        integer(a.actualRevision, 0, Number.MAX_SAFE_INTEGER, 'actualRevision')
        return this.view(
          this.transition(t, 'failed', '提交前检测到新输入，未修改文档', {
            error: json({
              code: 'REVISION_CONFLICT',
              message: '用户输入已变化，原文未被覆盖',
              retryable: false,
              details: { actualRevision: a.actualRevision }
            }),
            lease: null,
            lease_until: null
          })
        )
      })()
    if (method === 'worker.reject')
      return this.db.transaction(() => {
        strict(a, ['taskId', 'lease', 'error'], ['taskId', 'lease', 'error'])
        const t = this.workerTask(a, ['running'])
        strict(
          a.error,
          ['code', 'message', 'retryable', 'details'],
          ['code', 'message', 'retryable']
        )
        boundedText(a.error.message, '错误消息', 1000)
        id(a.error.code, 'code')
        const state =
          t.cancel_requested || a.error.code === 'CANCEL_REQUESTED' ? 'cancelled' : 'failed'
        return this.view(
          this.transition(t, state, state === 'cancelled' ? '已停止且未提交' : '执行失败', {
            error: state === 'failed' ? json(a.error) : null
          })
        )
      })()
    if (method === 'worker.recover')
      return this.db.transaction(() => {
        strict(
          a,
          ['taskId', 'committed', 'snapshot', 'lease', 'verifiedNotCommitted', 'failure'],
          ['taskId', 'committed']
        )
        const t = this.row('SELECT * FROM tasks WHERE id=?', id(a.taskId))
        const held =
          t &&
          ['running', 'committing'].includes(t.state) &&
          typeof a.lease === 'string' &&
          t.lease === a.lease &&
          t.lease_until >= now()
        if (!t || (!held && t.state !== 'recovering') || typeof a.committed !== 'boolean')
          fail('INVALID_ARGUMENT', '任务不在恢复状态')
        if (a.committed) return this.finish(t, a.snapshot)
        if (
          parse(t.request).capability === 'documents.save' &&
          t.state !== 'running' &&
          a.verifiedNotCommitted !== true
        )
          fail('RECOVERY_REQUIRED', '外部保存结果尚未核对，不能自动重做')
        if (a.failure) {
          strict(
            a.failure,
            ['code', 'message', 'retryable', 'details'],
            ['code', 'message', 'retryable']
          )
          id(a.failure.code, 'code')
          boundedText(a.failure.message, '错误消息', 1000)
          return this.view(
            this.transition(
              t,
              t.cancel_requested ? 'cancelled' : 'failed',
              '已核对未提交，保留失败信息',
              { error: t.cancel_requested ? null : json(a.failure), lease: null, lease_until: null }
            )
          )
        }
        return this.view(
          this.transition(t, t.cancel_requested ? 'cancelled' : 'queued', '已核对未提交', {
            lease: null,
            lease_until: null
          })
        )
      })()
    if (method === 'worker.abandonRecovery')
      return this.db.transaction(() => {
        strict(a, ['taskId', 'lease', 'preservedDocumentId'], ['taskId', 'preservedDocumentId'])
        const t = this.row('SELECT * FROM tasks WHERE id=?', id(a.taskId))
        if (!t) fail('INVALID_ARGUMENT', '任务不存在')
        if (t.state === 'failed' && parse(t.error)?.code === 'OUTCOME_UNKNOWN') return this.view(t)
        const held =
          ['running', 'committing'].includes(t.state) &&
          a.lease === t.lease &&
          t.lease_until >= now()
        if (!held && t.state !== 'recovering')
          fail('RECOVERY_REQUIRED', '任务已离开待核对状态，请重新查询')
        if (a.preservedDocumentId !== null) id(a.preservedDocumentId, 'preservedDocumentId')
        return this.view(
          this.transition(t, 'failed', '用户结束核对，写入结果仍未知', {
            error: json({
              code: 'OUTCOME_UNKNOWN',
              message: '用户已保留恢复记录并结束核对；写入结果未知，禁止自动重复该操作',
              retryable: false,
              details: { preservedDocumentId: a.preservedDocumentId }
            }),
            lease: null,
            lease_until: null
          })
        )
      })()
    fail('INVALID_ARGUMENT', '未知执行器方法')
  }
  finish(t: any, s: any) {
    this.validateSnapshot(s)
    const r = parse(t.request)
    const c = this.row('SELECT * FROM clients WHERE id=?', t.client_id)
    const isCreate = r.capability === 'documents.create'
    const expected = isCreate ? -1 : r.input.document.revision
    if (
      s.id !== t.target_doc ||
      s.revision !== (isCreate ? 0 : r.capability === 'documents.save' ? expected : expected + 1)
    )
      fail('INVALID_ARGUMENT', '提交文档或版本不匹配')
    const old = isCreate ? null : this.snapshot(r.input.document)
    const expectedText = t.expected_text
    if (s.text !== expectedText) fail('INVALID_ARGUMENT', '提交内容与任务不一致')
    if (s.title !== (isCreate ? r.input.title : old.title))
      fail('INVALID_ARGUMENT', '提交标题与任务不一致')
    this.publishSnapshot(s, expected)
    let g = this.allowed(c.id, 'document', s.id, 'read')
    if (isCreate) {
      const parent = this.row('SELECT * FROM grants WHERE id=?', t.source_grant),
        canShare = !!parent?.can_share
      const rights = ['read', 'write', 'propose', 'apply', 'save', 'export']
      if (canShare) rights.push('share')
      const gid = this.addGrant(c.id, 'document', s.id, rights, t.source_grant, null, canShare)
      g = this.row('SELECT * FROM grants WHERE id=?', gid)
    }
    const artifact = this.publishArtifact(c.id, s.text, 'text/markdown', g?.id ?? t.source_grant)
    const result = {
      taskId: t.id,
      document: documentRef(s.id, s.revision),
      artifacts: [artifact],
      sources: r.input.artifact ? [r.input.artifact] : [],
      summary: r.capability === 'documents.save' ? '文档已保存' : '文档修改已提交',
      ...(r.capability === 'documents.save' ? { savedRevision: s.savedRevision } : {})
    }
    return this.view(
      this.transition(t, 'succeeded', '完成', {
        result: json(result),
        lease: null,
        lease_until: null
      })
    )
  }
  dispatch(request: any): Envelope {
    try {
      strict(request, ['method', 'token', 'args'], ['method'])
      if (request.token !== undefined && typeof request.token !== 'string')
        fail('INVALID_ARGUMENT', '凭证格式无效')
      return {
        ok: true,
        value: this.handle(request.method, request.token ?? '', request.args ?? {})
      }
    } catch (e) {
      return { ok: false, error: fault(e) }
    }
  }
}
