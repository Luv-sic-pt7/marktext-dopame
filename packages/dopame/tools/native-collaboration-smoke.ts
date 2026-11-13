import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { AcdeRpcTransport } from './acde-rpc-transport'
import { PROTOCOL, unwrap } from '../protocol'

const root = resolve(import.meta.dir, '..'),
  project = join(root, 'app')
const out = process.argv[2] ?? resolve(root, '../../../work/marktext-mvp-evidence')
mkdirSync(out, { recursive: true })
const host = new AcdeRpcTransport(project)
const health = unwrap<any>(await host.request({ method: 'health' }))
const administrator = JSON.parse(readFileSync(health.credentialPath, 'utf8')).token
const admin = async (method: string, args: any = {}) =>
  unwrap<any>(await host.request({ method, token: administrator, args }))
const connection = await admin('admin.connect')
await host.evaluate(
  '(async()=>{const {open}=await import("acde:open");return await open("marktext-dopame",{kind:"agent-wake",workerToken:' +
    JSON.stringify(connection.workerToken) +
    '})})()'
)
const until = Date.now() + 10000
while (Date.now() < until) {
  const h = unwrap<any>(await host.request({ method: 'health' }))
  if (h.workerOnline) break
  await Bun.sleep(200)
}
if (!unwrap<any>(await host.request({ method: 'health' })).workerOnline)
  throw new Error('Worker did not connect')
const suffix = crypto.randomUUID().slice(0, 8),
  a = 'researcher-' + suffix,
  b = 'reviewer-' + suffix
const ca = await admin('admin.pair', {
    clientId: a,
    label: '研究调用方 · 联调',
    directApply: true
  }),
  cb = await admin('admin.pair', { clientId: b, label: '审阅调用方 · 联调', directApply: false })
await admin('admin.grant', {
  clientId: a,
  kind: 'workspace',
  resource: '*',
  actions: ['create'],
  canShare: true
})
let processes = 0
async function actor(credential: string, method: string, args: any = {}): Promise<any> {
  processes++
  const child = Bun.spawn(
    [process.execPath, join(root, 'tools/caller-process.ts'), project, credential, method],
    { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' }
  )
  child.stdin.write(JSON.stringify(args))
  child.stdin.end()
  const [text, status] = await Promise.all([new Response(child.stdout).text(), child.exited])
  if (status !== 0) throw new Error('Independent caller failed')
  return unwrap<any>(JSON.parse(text))
}
async function submit(
  credential: string,
  capability: string,
  input: any,
  requestId = crypto.randomUUID()
) {
  return actor(credential, 'submit', {
    request: { protocol: PROTOCOL, requestId, capability, capabilityVersion: 1, input }
  })
}
async function complete(credential: string, taskId: string) {
  const end = Date.now() + 20000
  while (Date.now() < end) {
    const state = await actor(credential, 'getTask', { taskId })
    if (state.state === 'succeeded') return actor(credential, 'getResult', { taskId })
    if (['failed', 'cancelled'].includes(state.state))
      throw new Error('Task ' + state.state + ': ' + JSON.stringify(state.error))
    await Bun.sleep(200)
  }
  throw new Error('Task completion timeout')
}
const descriptions = await actor(ca.credentialPath, 'listCapabilities')
if (!descriptions.some((capability: any) => capability.id === 'documents.create')) throw new Error('Create permission is missing from the filtered catalogue')
const source = '# 联调报告\n\n研究调用方提交资料，审阅调用方提出建议。\n'
const bytes = Buffer.from(source),
  upload = await actor(ca.credentialPath, 'artifacts.beginUpload', {
    mediaType: 'text/markdown',
    size: bytes.length
  })
await actor(ca.credentialPath, 'artifacts.writeChunk', {
  uploadId: upload.uploadId,
  offset: 0,
  base64: bytes.toString('base64')
})
const inputArtifact = await actor(ca.credentialPath, 'artifacts.commitUpload', {
  uploadId: upload.uploadId
})
const createId = crypto.randomUUID(),
  created = await submit(
    ca.credentialPath,
    'documents.create',
    { title: '双调用方联调报告', artifact: inputArtifact },
    createId
  )
const createResult = await complete(ca.credentialPath, created.taskId)
const repeated = await submit(
  ca.credentialPath,
  'documents.create',
  { title: '双调用方联调报告', artifact: inputArtifact },
  createId
)
if (repeated.taskId !== created.taskId) throw new Error('Idempotency failed')
const outlineTask = await submit(ca.credentialPath, 'documents.outline', {
    document: createResult.document
  }),
  outlineResult = await complete(ca.credentialPath, outlineTask.taskId)
if (outlineResult.outline[0]?.text !== '联调报告') throw new Error('Outline mismatch')
await actor(ca.credentialPath, 'grants.share', {
  clientId: b,
  kind: 'document',
  resource: createResult.document.documentId,
  actions: ['read', 'propose', 'share'],
  canShare: true
})
await actor(ca.credentialPath, 'grants.share', {
  clientId: b,
  kind: 'artifact',
  resource: createResult.artifacts[0].artifactId,
  actions: ['read']
})
const original = await actor(cb.credentialPath, 'readArtifact', {
  ref: createResult.artifacts[0],
  offset: 0,
  length: 4096
})
if (Buffer.from(original.base64, 'base64').toString() !== source)
  throw new Error('Immutable handoff mismatch')
const replacement = source + '\n## 审阅意见\n\n已核对来源，并补充审阅结论。\n'
const proposed = await submit(cb.credentialPath, 'documents.propose', {
  document: createResult.document,
  baseRevision: 0,
  replacement,
  reason: '补充审阅结论'
})
const proposalResult = await complete(cb.credentialPath, proposed.taskId)
await actor(cb.credentialPath, 'grants.share', {
  clientId: a,
  kind: 'task',
  resource: proposed.taskId,
  actions: ['read']
})
await actor(cb.credentialPath, 'grants.share', {
  clientId: a,
  kind: 'proposal',
  resource: proposalResult.proposal.proposalId,
  actions: ['read']
})
const returned = await actor(ca.credentialPath, 'getResult', { taskId: proposed.taskId })
const applied = await submit(ca.credentialPath, 'documents.apply', {
    document: createResult.document,
    proposalId: returned.proposal.proposalId,
    expectedRevision: 0
  }),
  applyResult = await complete(ca.credentialPath, applied.taskId)
if (applyResult.document.revision !== 1) throw new Error('Revision did not advance exactly once')
const save = await submit(ca.credentialPath, 'documents.save', {
  document: applyResult.document,
  expectedRevision: 1
})
await complete(ca.credentialPath, save.taskId)
const exported = await submit(ca.credentialPath, 'documents.export', {
    document: applyResult.document
  }),
  exportResult = await complete(ca.credentialPath, exported.taskId)
const final = await actor(ca.credentialPath, 'readArtifact', {
  ref: exportResult.artifacts[0],
  offset: 0,
  length: 4096
})
if (Buffer.from(final.base64, 'base64').toString() !== replacement)
  throw new Error('Final artifact mismatch')
const report = {
  kind: 'native-acdert-service-rpc-smoke',
  officialMachine: false,
  deterministicCallers: true,
  independentCallerProcesses: processes,
  capabilities: descriptions.length,
  document: applyResult.document,
  tasks: {
    create: created.taskId,
    outline: outlineTask.taskId,
    propose: proposed.taskId,
    apply: applied.taskId,
    save: save.taskId,
    export: exported.taskId
  },
  idempotencyVerified: true,
  immutableHandoffVerified: true,
  versionedApplyVerified: true,
  finalContentVerified: true,
  screenReadingUsedForResults: false,
  checkedAt: new Date().toISOString()
}
writeFileSync(join(out, 'native-collaboration.json'), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report, null, 2))
