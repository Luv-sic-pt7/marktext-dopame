import { test, expect } from 'bun:test'
import { validateRequest, capabilitySchemas } from '../src/protocol.ts'

const base = { workspaceId: 'workspace', docId: 'doc', documentEpoch: 'epoch', revision: '1' }
const request = (capability, input) => ({ protocol: 'marktext-documents/1', requestId: 'req-1', capability, capabilityVersion: 1, input })

test('publishes strict capability schemas and rejects identity, paths and privileged commands', () => {
  expect(Object.keys(capabilitySchemas)).toContain('handoffs.acknowledge')
  expect(validateRequest(request('documents.read', { document: base })).input.document).toEqual(base)
  expect(validateRequest(request('documents.blocks', { document: base, cursor: '_-opaque_cursor' })).input.cursor).toBe('_-opaque_cursor')
  for (const value of [
    { ...request('documents.read', { document: base }), actorId: 'owner' },
    request('documents.read', { document: base, role: 'owner' }),
    request('documents.read', { document: { ...base, path: '/private/file' } }),
    request('proposals.accept', { proposalId: 'proposal' }),
    request('documents.read', { document: { ...base, revision: 1 } }),
    request('proposals.create', { base, operations: [{ kind: 'deleteBlock', blockId: 'block', markdown: 'hidden' }], reason: 'review' }),
  ]) expect(() => validateRequest(value)).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }))
})

test('negotiates protocol versions and bounds byte and page sizes before work is accepted', () => {
  expect(() => validateRequest({ ...request('documents.read', { document: base }), protocol: 'marktext-agent/1' }))
    .toThrow(expect.objectContaining({ code: 'UNSUPPORTED_VERSION' }))
  expect(() => validateRequest(request('artifacts.read', { artifactId: 'artifact', offset: 0, length: 65537 })))
    .toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }))
  expect(() => validateRequest(request('documents.createDraft', { workspaceId: 'workspace', title: 'Draft', markdown: '字'.repeat(180000) })))
    .toThrow(expect.objectContaining({ code: 'PAYLOAD_TOO_LARGE' }))
  expect(() => validateRequest(request('documents.blocks', { document: { ...base, revision: 'latest' } })))
    .toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }))
})
