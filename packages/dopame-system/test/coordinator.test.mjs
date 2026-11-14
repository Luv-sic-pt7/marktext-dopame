import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { Coordinator } from '../src/coordinator.ts'
import { canonical, digest, hostApprovalBinding } from '../src/auth.ts'

const resources = []
afterEach(() => {
  for (const resource of resources.splice(0)) {
    resource.close()
    rmSync(resource.path, { recursive: true, force: true })
  }
})

function setup () {
  const path = mkdtempSync(join(tmpdir(), 'marktext-coordinator-'))
  const clock = { value: Date.now() }
  const tickets = new Map()
  const port = {
    verify: (ticket, expected) => {
      const evidence = tickets.get(ticket)
      return evidence && canonical(evidence.binding) === canonical(expected) ? evidence : null
    }
  }
  const issue = (binding, principalId = 'test-author') => {
    const ticket = crypto.randomUUID()
    tickets.set(ticket, {
      ticketId: crypto.randomUUID(),
      principalId,
      expiresAt: new Date(clock.value + 24 * 60 * 60_000).toISOString(),
      policyVersion: 'test-only',
      binding
    })
    return ticket
  }
  let coordinator = new Coordinator(path, { approvalPort: port, now: () => clock.value })
  const credential = coordinator.connectAuthor(issue({
    action: 'author:connect',
    workspaceId: 'workspace',
    targetId: 'workspace',
    digest: digest({ workspaceId: 'workspace' }),
    sideEffects: ['author-session']
  }), 'workspace').credential
  const hostInput = (command, scope, action, input) => {
    const value = { requestId: crypto.randomUUID(), ...input }
    return { ...value, ticket: issue(hostApprovalBinding(command, value, scope, action).binding) }
  }
  const fixture = {
    path,
    clock,
    credential,
    issue,
    hostInput,
    get c () { return coordinator },
    restart () {
      coordinator.close()
      coordinator = new Coordinator(path, { approvalPort: port, now: () => clock.value })
    },
    close () { coordinator.close() },
  }
  resources.push(fixture)
  return fixture
}

function request (capability, input, requestId = crypto.randomUUID(), workflowId) {
  return {
    protocol: 'marktext-documents/1',
    requestId,
    capability,
    capabilityVersion: 1,
    input,
    ...(workflowId ? { workflowId } : {})
  }
}

async function complete (c, credential, receipt) {
  for (let i = 0; i < 100; i++) {
    const task = c.getTask(credential, receipt.taskId)
    if (task.state === 'succeeded') return task.result
    if (task.state === 'failed' || task.state === 'cancelled') throw new Error(`Unexpected task state: ${JSON.stringify(task.error ?? task.state)}`)
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  throw new Error('The task did not finish')
}

async function draft (fixture, markdown = '# First\n\nRepeated\n\nRepeated\n', credential = fixture.credential, workflowId) {
  const receipt = fixture.c.invoke(credential, request('documents.createDraft', { workspaceId: 'workspace', title: 'draft.md', markdown }, undefined, workflowId))
  return complete(fixture.c, credential, receipt)
}

function scope (document) { return { workspaceId: document.workspaceId, docId: document.docId } }

function writer (fixture, document, windowSessionId = crypto.randomUUID()) {
  const lease = fixture.c.acquireWriter(fixture.credential, fixture.hostInput('writer:acquire', scope(document), 'writer:manage', { document, windowSessionId }))
  return { windowSessionId: lease.windowSessionId, writerFence: lease.writerFence, serviceEpoch: lease.serviceEpoch }
}

function pair (fixture, actions, grantScope = { workspaceId: 'workspace' }, delegationDepth = 0) {
  const pending = fixture.c.requestPairing({ name: 'Independent agent' })
  expect(fixture.c.claimPairing(pending.pairingId, pending.claimSecret).state).toBe('pending')
  const approved = fixture.c.approvePairing(fixture.credential, fixture.hostInput('pairing:approve', { workspaceId: 'workspace' }, 'grant:manage', {
    pairingId: pending.pairingId,
    grants: [{
      scope: grantScope,
      actions,
      expiresAt: new Date(fixture.clock.value + 60 * 60_000).toISOString(),
      delegationDepth
    }],
  }))
  const result = fixture.c.claimPairing(pending.pairingId, pending.claimSecret)
  expect(result.state).toBe('paired')
  expect(() => fixture.c.claimPairing(pending.pairingId, pending.claimSecret)).toThrow()
  return { ...result, grantId: approved.grantIds[0] }
}

function read (fixture, document, credential = fixture.credential, range) {
  return fixture.c.invoke(credential, request('documents.read', { document, ...(range ? { range } : {}) }))
}

function blocks (fixture, document, credential = fixture.credential) {
  return fixture.c.invoke(credential, request('documents.blocks', { document })).blocks
}

async function proposal (fixture, document, operations, credential = fixture.credential) {
  return complete(fixture.c, credential, fixture.c.invoke(credential, request('proposals.create', { base: document, operations, reason: 'Review clarity', sources: [{ uri: 'urn:test:source' }] })))
}

function accept (fixture, document, lease, suggestion) {
  return fixture.c.acceptProposal(fixture.credential, fixture.hostInput('proposal:accept', scope(document), 'proposal:approve', {
    document, ...lease, proposalId: suggestion.proposalId, proposalDigest: suggestion.proposalDigest,
  }))
}

function commit (fixture, document, lease, markdown, localOpSeq = 1) {
  return fixture.c.commitDocument(fixture.credential, fixture.hostInput('document:commit', scope(document), 'document:commit', {
    document, ...lease, markdown, localOpSeq,
  }))
}

test('default host approval fails closed and one SQLite owner holds the workspace', () => {
  const fixture = setup()
  expect(() => new Coordinator(fixture.path)).toThrow('locked or unavailable')
  fixture.close()
  const untrusted = new Coordinator(fixture.path)
  expect(() => untrusted.connectAuthor('human', 'workspace')).toThrow('protected host approval')
  expect(untrusted.describe(fixture.credential).approval).toEqual({ available: false, mode: 'manual-preview' })
  untrusted.close()
})

test('paired identities, scope filters and unknown actor fields cannot reveal private documents', async () => {
  const fixture = setup()
  const first = await draft(fixture, '# Authorized')
  const hidden = await draft(fixture, '# Private title')
  const reviewer = pair(fixture, ['document:read', 'task:read'], scope(first.document))
  const listed = fixture.c.invoke(reviewer.credential, request('documents.list', { workspaceId: 'workspace' }))
  expect(listed.documents.map(item => item.document.docId)).toEqual([first.document.docId])
  for (const document of [hidden.document, { ...hidden.document, docId: 'guessed-id' }]) {
    expect(() => read(fixture, document, reviewer.credential)).toThrow('not authorized')
  }
  expect(() => fixture.c.invoke(reviewer.credential, { ...request('documents.read', { document: first.document }), actorId: 'test-author' })).toThrow()
  expect(() => fixture.c.invoke(reviewer.credential, request('documents.read', { document: first.document, role: 'author' }))).toThrow()
  expect(() => fixture.c.invoke(reviewer.credential, request('proposals.accept', { document: first.document }))).toThrow()
  expect(fixture.c.describe(reviewer.credential).capabilities.map(item => item.id)).not.toContain('proposals.create')
})

test('range reads return only approved UTF-16 text and reject split Unicode characters', async () => {
  const fixture = setup()
  const markdown = '# Public\n\nSecret 🦊 content\n'
  const { document } = await draft(fixture, markdown)
  const result = read(fixture, document, fixture.credential, { start: 0, end: 8 })
  expect(result.markdown).toBe('# Public')
  expect(JSON.stringify(result)).not.toContain('Secret')
  expect(result).not.toHaveProperty('rawText')
  const emoji = markdown.indexOf('🦊')
  expect(() => read(fixture, document, fixture.credential, { start: emoji + 1, end: emoji + 2 })).toThrow('Unicode character')
  expect(() => fixture.c.invoke(fixture.credential, request('documents.read', { document, start: 0, end: 8 }))).toThrow()
})

test('workflow-bound creation creates a separate inbox draft and does not infer broader reads', async () => {
  const fixture = setup()
  const original = await draft(fixture, 'Untouched original')
  const research = pair(fixture, ['document:create', 'task:read'], { workspaceId: 'workspace', workflowId: 'research' })
  expect(() => fixture.c.invoke(research.credential, request('documents.createDraft', { workspaceId: 'workspace', title: 'no.md', markdown: 'no' }))).toThrow('not authorized')
  const created = await draft(fixture, 'Agent draft', research.credential, 'research')
  expect(created.inbox).toBe(true)
  expect(created.document.docId).not.toBe(original.document.docId)
  expect(read(fixture, original.document).markdown).toBe('Untouched original')
  expect(() => read(fixture, created.document, research.credential)).toThrow('not authorized')
})

test('durable task retries are idempotent, mismatched payloads fail and cancellation respects commit', async () => {
  const fixture = setup()
  const input = request('documents.createDraft', { workspaceId: 'workspace', title: 'one.md', markdown: 'one' }, 'same-request')
  const first = fixture.c.invoke(fixture.credential, input)
  expect(first.state).toBe('queued')
  expect(fixture.c.invoke(fixture.credential, input).taskId).toBe(first.taskId)
  expect(() => fixture.c.invoke(fixture.credential, { ...input, input: { ...input.input, markdown: 'different' } })).toThrow('different arguments')
  const result = await complete(fixture.c, fixture.credential, first)
  expect(fixture.c.invoke(fixture.credential, input).taskId).toBe(first.taskId)
  expect(() => fixture.c.cancelTask(fixture.credential, first.taskId)).toThrow('cancellation point')
  const queued = fixture.c.invoke(fixture.credential, request('documents.createDraft', { workspaceId: 'workspace', title: 'cancel.md', markdown: 'cancel' }))
  expect(fixture.c.cancelTask(fixture.credential, queued.taskId).state).toBe('cancelled')
  await new Promise(resolve => setTimeout(resolve, 10))
  expect(fixture.c.getTask(fixture.credential, queued.taskId).state).toBe('cancelled')
  const listed = fixture.c.invoke(fixture.credential, request('documents.list', { workspaceId: 'workspace' }))
  expect(listed.documents.map(item => item.document.docId)).toEqual([result.document.docId])
})

test('read request ids bind the capability and a repeated latest read retains its first fixed snapshot', async () => {
  const fixture = setup()
  const { document } = await draft(fixture, 'First fixed snapshot')
  const readRequest = request('documents.read', { document: { ...document, revision: 'latest' } }, 'fixed-read-request')
  const first = fixture.c.invoke(fixture.credential, readRequest)
  const lease = writer(fixture, document)
  const later = commit(fixture, document, lease, 'Later canonical snapshot')
  const replay = fixture.c.invoke(fixture.credential, readRequest)
  expect(replay.document).toEqual(first.document)
  expect(replay.markdown).toBe('First fixed snapshot')
  expect(read(fixture, { ...document, revision: 'latest' }).document).toEqual(later.snapshot.document)
  expect(() => fixture.c.invoke(fixture.credential, request('documents.createDraft', {
    workspaceId: 'workspace', title: 'must-not-create.md', markdown: 'Different operation',
  }, readRequest.requestId))).toThrow('different arguments')
})

test('replaying a fixed document list removes newly revoked titles without recomputing unauthorized counts', async () => {
  const fixture = setup()
  const first = await complete(fixture.c, fixture.credential, fixture.c.invoke(fixture.credential, request('documents.createDraft', {
    workspaceId: 'workspace', title: 'Revoked Confidential Title', markdown: 'Revoked document',
  })))
  const second = await complete(fixture.c, fixture.credential, fixture.c.invoke(fixture.credential, request('documents.createDraft', {
    workspaceId: 'workspace', title: 'Still Authorized Title', markdown: 'Authorized document',
  })))
  const reader = pair(fixture, ['document:read'], scope(first.document))
  fixture.c.setGrant(fixture.credential, fixture.hostInput('grant:create', scope(second.document), 'grant:manage', {
    principalId: reader.principalId,
    scope: scope(second.document),
    actions: ['document:read'],
    expiresAt: new Date(fixture.clock.value + 60 * 60_000).toISOString(),
  }))
  const listRequest = request('documents.list', { workspaceId: 'workspace' }, 'fixed-document-list')
  expect(fixture.c.invoke(reader.credential, listRequest).documents).toHaveLength(2)
  fixture.c.revokeGrant(fixture.credential, fixture.hostInput('grant:revoke', { workspaceId: 'workspace' }, 'grant:manage', {
    workspaceId: 'workspace', grantId: reader.grantId,
  }))
  const replay = fixture.c.invoke(reader.credential, listRequest)
  expect(replay.documents.map(item => item.document.docId)).toEqual([second.document.docId])
  expect(JSON.stringify(replay)).not.toContain('Revoked Confidential Title')
  expect(JSON.stringify(replay)).not.toContain(first.document.docId)
  expect(replay).not.toHaveProperty('total')
  expect(replay).not.toHaveProperty('cursor')
})

test('proposal creation is immutable and multi-block acceptance plus immediate undo are single revisions', async () => {
  const fixture = setup()
  const { document } = await draft(fixture)
  const indexed = blocks(fixture, document)
  const suggestion = await proposal(fixture, document, [
    { kind: 'replaceBlock', blockId: indexed[0].blockId, markdown: indexed[0].markdown.replace('First', 'Revised') },
    { kind: 'replaceBlock', blockId: indexed[2].blockId, markdown: indexed[2].markdown.replace('Repeated', 'Last') },
  ])
  expect(read(fixture, document).markdown).toBe('# First\n\nRepeated\n\nRepeated\n')
  const lease = writer(fixture, document)
  const accepted = accept(fixture, document, lease, suggestion)
  expect(accepted.snapshot.document.revision).toBe('1')
  expect(accepted.snapshot.markdown).toContain('# Revised')
  expect(accepted.snapshot.markdown).toContain('Last')
  expect(read(fixture, accepted.snapshot.document).saved).toBe(false)
  const undoInput = fixture.hostInput('proposal:undo', scope(document), 'proposal:approve', {
    document: accepted.snapshot.document, ...lease, transactionId: accepted.transactionId,
  })
  const undone = fixture.c.undoProposal(fixture.credential, undoInput)
  expect(undone.snapshot.document.revision).toBe('2')
  expect(undone.snapshot.markdown).toBe('# First\n\nRepeated\n\nRepeated\n')
  expect(fixture.c.undoProposal(fixture.credential, undoInput).snapshot.document.revision).toBe('2')
  expect(fixture.c.invoke(fixture.credential, request('proposals.get', { proposalId: suggestion.proposalId })).state).toBe('applied')
})

test('undo restores a replacement combined with an insertion at the same block start', async () => {
  const fixture = setup()
  const { document } = await draft(fixture, 'A\n')
  const block = blocks(fixture, document)[0]
  const suggestion = await proposal(fixture, document, [
    { kind: 'replaceBlock', blockId: block.blockId, markdown: 'B\n' },
    { kind: 'insertBeforeBlock', blockId: block.blockId, markdown: 'X\n\n' },
  ])
  const lease = writer(fixture, document)
  const accepted = accept(fixture, document, lease, suggestion)
  expect(accepted.snapshot.markdown).toBe('X\n\nB\n')
  const undone = fixture.c.undoProposal(fixture.credential, fixture.hostInput('proposal:undo', scope(document), 'proposal:approve', {
    document: accepted.snapshot.document, ...lease, transactionId: accepted.transactionId,
  }))
  expect(undone.snapshot.markdown).toBe('A\n')
  expect(undone.snapshot.document.revision).toBe('2')
})

test('undo restores adjacent deleted blocks in their original source order', async () => {
  const fixture = setup()
  const original = '# H\nP\n'
  const { document } = await draft(fixture, original)
  const indexed = blocks(fixture, document)
  expect(indexed).toHaveLength(2)
  const suggestion = await proposal(fixture, document, [...indexed].reverse().map(block => ({ kind: 'deleteBlock', blockId: block.blockId })))
  const lease = writer(fixture, document)
  const accepted = accept(fixture, document, lease, suggestion)
  expect(accepted.snapshot.markdown).toBe('')
  const undone = fixture.c.undoProposal(fixture.credential, fixture.hostInput('proposal:undo', scope(document), 'proposal:approve', {
    document: accepted.snapshot.document, ...lease, transactionId: accepted.transactionId,
  }))
  expect(undone.snapshot.markdown).toBe(original)
  expect(undone.snapshot.rawText).toBe(original)
  expect(undone.snapshot.document.revision).toBe('2')
})

for (const kind of ['deleteBlock', 'replaceBlock']) {
  test(`immediate undo restores a 300 KiB paragraph after ${kind}`, async () => {
    const fixture = setup()
    const original = 'a'.repeat(300 * 1024 - 1) + '\n'
    const { document } = await draft(fixture, original)
    const block = blocks(fixture, document)[0]
    const operation = kind === 'deleteBlock'
      ? { kind, blockId: block.blockId }
      : { kind, blockId: block.blockId, markdown: 'Small replacement\n' }
    const suggestion = await proposal(fixture, document, [operation])
    const lease = writer(fixture, document)
    const accepted = accept(fixture, document, lease, suggestion)
    expect(accepted.snapshot.markdown).toBe(kind === 'deleteBlock' ? '' : operation.markdown)
    const undone = fixture.c.undoProposal(fixture.credential, fixture.hostInput('proposal:undo', scope(document), 'proposal:approve', {
      document: accepted.snapshot.document, ...lease, transactionId: accepted.transactionId,
    }))
    expect(undone.snapshot.markdown).toBe(original)
    expect(undone.snapshot.rawText).toBe(original)
    expect(undone.snapshot.document.revision).toBe('2')
  })

  test(`reverse proposal restores a 300 KiB paragraph after ${kind} and preserves a later independent edit`, async () => {
    const fixture = setup()
    const paragraph = 'a'.repeat(300 * 1024 - 1) + '\n'
    const { document } = await draft(fixture, '# Anchor\n' + paragraph)
    const block = blocks(fixture, document)[1]
    const operation = kind === 'deleteBlock'
      ? { kind, blockId: block.blockId }
      : { kind, blockId: block.blockId, markdown: 'Small replacement\n' }
    const suggestion = await proposal(fixture, document, [operation])
    const lease = writer(fixture, document)
    const accepted = accept(fixture, document, lease, suggestion)
    const laterMarkdown = accepted.snapshot.markdown.replace('# Anchor\n', '# Edited anchor\n')
    const edited = commit(fixture, accepted.snapshot.document, lease, laterMarkdown)
    const reversed = fixture.c.undoProposal(fixture.credential, fixture.hostInput('proposal:undo', scope(document), 'proposal:approve', {
      document: edited.snapshot.document, ...lease, transactionId: accepted.transactionId,
    }))
    expect(reversed.state).toBe('pending_review')
    expect(read(fixture, edited.snapshot.document).markdown).toBe(laterMarkdown)
    const restored = accept(fixture, edited.snapshot.document, lease, reversed.reverseProposal)
    expect(restored.snapshot.markdown).toBe('# Edited anchor\n' + paragraph)
    expect(restored.snapshot.document.revision).toBe('3')
  })
}

test('external proposals still reject replacement text larger than 256 KiB', async () => {
  const fixture = setup()
  const { document } = await draft(fixture, 'Original\n')
  const block = blocks(fixture, document)[0]
  await expect(proposal(fixture, document, [
    { kind: 'replaceBlock', blockId: block.blockId, markdown: 'a'.repeat(256 * 1024 + 1) },
  ])).rejects.toThrow('PAYLOAD_TOO_LARGE')
  expect(read(fixture, document).markdown).toBe('Original\n')
  expect(fixture.c.invoke(fixture.credential, request('proposals.list', { document })).proposals).toHaveLength(0)
})

test('stale bases, replayed approval and pending input cannot silently apply a second suggestion', async () => {
  const fixture = setup()
  const { document } = await draft(fixture, 'Original\n')
  const block = blocks(fixture, document)[0]
  const suggestion = await proposal(fixture, document, [{ kind: 'replaceBlock', blockId: block.blockId, markdown: 'First change\n' }])
  const second = await proposal(fixture, document, [{ kind: 'replaceBlock', blockId: block.blockId, markdown: 'Second change\n' }])
  const lease = writer(fixture, document)
  fixture.c.updateWindowState(fixture.credential, { document, ...lease, localOpSeq: 1, pendingInput: true })
  const acceptInput = fixture.hostInput('proposal:accept', scope(document), 'proposal:approve', {
    document,
    ...lease,
    proposalId: suggestion.proposalId,
    proposalDigest: suggestion.proposalDigest
  })
  expect(() => fixture.c.acceptProposal(fixture.credential, acceptInput)).toThrow('acknowledged')
  fixture.c.updateWindowState(fixture.credential, { document, ...lease, localOpSeq: 1, pendingInput: false })
  const accepted = fixture.c.acceptProposal(fixture.credential, acceptInput)
  expect(fixture.c.acceptProposal(fixture.credential, acceptInput).transactionId).toBe(accepted.transactionId)
  expect(() => fixture.c.acceptProposal(fixture.credential, { ...acceptInput, requestId: 'different-request' })).toThrow('protected host approval')
  expect(() => accept(fixture, accepted.snapshot.document, lease, second)).toThrow('new review')
  expect(read(fixture, accepted.snapshot.document).markdown).toBe('First change\n')
  expect(fixture.c.invoke(fixture.credential, request('proposals.get', { proposalId: second.proposalId })).state).toBe('stale')
})

test('invalid multi-block edits fail atomically and cannot alias repeated paragraphs', async () => {
  const fixture = setup()
  const { document } = await draft(fixture)
  const indexed = blocks(fixture, document)
  const receipt = fixture.c.invoke(fixture.credential, request('proposals.create', {
    base: document,
    reason: 'Invalid repeated deletion',
    operations: [
      { kind: 'deleteBlock', blockId: indexed[1].blockId }, { kind: 'deleteBlock', blockId: indexed[1].blockId },
    ]
  }))
  await new Promise(resolve => setTimeout(resolve, 15))
  expect(fixture.c.getTask(fixture.credential, receipt.taskId).state).toBe('failed')
  expect(read(fixture, document).markdown).toBe('# First\n\nRepeated\n\nRepeated\n')
  expect(fixture.c.invoke(fixture.credential, request('proposals.list', { document })).proposals).toHaveLength(0)
  expect(blocks(fixture, document).map(block => block.blockId)).toEqual(indexed.map(block => block.blockId))
})

test('undo after an independent later edit creates a new reverse proposal and retains that input', async () => {
  const fixture = setup()
  const { document } = await draft(fixture, 'Original paragraph\n')
  const original = blocks(fixture, document)[0]
  const suggestion = await proposal(fixture, document, [{ kind: 'replaceBlock', blockId: original.blockId, markdown: 'Suggested paragraph\n' }])
  const lease = writer(fixture, document)
  const accepted = accept(fixture, document, lease, suggestion)
  const edited = commit(fixture, accepted.snapshot.document, lease, 'Suggested paragraph\n\nLater independent paragraph\n')
  const reversed = fixture.c.undoProposal(fixture.credential, fixture.hostInput('proposal:undo', scope(document), 'proposal:approve', {
    document: edited.snapshot.document, ...lease, transactionId: accepted.transactionId,
  }))
  expect(reversed.state).toBe('pending_review')
  expect(reversed.reverseProposal.base.revision).toBe('2')
  expect(read(fixture, edited.snapshot.document).markdown).toBe('Suggested paragraph\n\nLater independent paragraph\n')
  const restored = accept(fixture, edited.snapshot.document, lease, reversed.reverseProposal)
  expect(restored.snapshot.markdown).toBe('Original paragraph\n\nLater independent paragraph\n')
  expect(restored.snapshot.document.revision).toBe('3')
})

test('undo refuses overlapping later input and preserves a comparison instead of rolling back', async () => {
  const fixture = setup()
  const { document } = await draft(fixture, 'Original paragraph\n')
  const original = blocks(fixture, document)[0]
  const suggestion = await proposal(fixture, document, [{ kind: 'replaceBlock', blockId: original.blockId, markdown: 'Suggested paragraph\n' }])
  const lease = writer(fixture, document)
  const accepted = accept(fixture, document, lease, suggestion)
  const edited = commit(fixture, accepted.snapshot.document, lease, 'Manually rewritten paragraph\n')
  expect(() => fixture.c.undoProposal(fixture.credential, fixture.hostInput('proposal:undo', scope(document), 'proposal:approve', {
    document: edited.snapshot.document, ...lease, transactionId: accepted.transactionId,
  }))).toThrow('overlap')
  expect(read(fixture, edited.snapshot.document).markdown).toBe('Manually rewritten paragraph\n')
})

test('expired, invalid and numerically typed approval expiries never issue credentials', () => {
  const path = mkdtempSync(join(tmpdir(), 'marktext-invalid-approval-'))
  for (const expiresAt of [undefined, 'not-a-date', 9999, new Date(Date.now() - 1).toISOString()]) {
    const coordinator = new Coordinator(path, {
      approvalPort: {
        verify: (_ticket, binding) => ({
          ticketId: crypto.randomUUID(), principalId: 'test-author', policyVersion: 'test-only', binding, expiresAt,
        })
      }
    })
    expect(() => coordinator.connectAuthor('test-only', 'workspace')).toThrow('protected host approval')
    coordinator.close()
  }
  rmSync(path, { recursive: true, force: true })
})

test('expired and restarted writer fences reject writes while retaining recovery drafts', async () => {
  const fixture = setup()
  const { document } = await draft(fixture, 'Base')
  const first = writer(fixture, document, 'window-one')
  expect(() => writer(fixture, document, 'window-two')).toThrow('Another window')
  fixture.clock.value += 11_000
  const second = writer(fixture, document, 'window-two')
  expect(BigInt(second.writerFence)).toBeGreaterThan(BigInt(first.writerFence))
  expect(() => commit(fixture, document, first, 'Old unsynchronized input')).toThrow('synchronize')
  expect(fixture.c.getRecoveryDrafts(fixture.credential, document)[0].markdown).toBe('Old unsynchronized input')
  const fresh = commit(fixture, document, second, 'Current canonical input')
  fixture.restart()
  expect(() => fixture.c.renewWriter(fixture.credential, { document: fresh.snapshot.document, ...second })).toThrow('synchronize')
  expect(fixture.c.getRecoveryDrafts(fixture.credential, fresh.snapshot.document)[0].markdown).toBe('Old unsynchronized input')
})

test('fixed artifacts survive edits and restart; handoff receipts require current receiver authorization', async () => {
  const fixture = setup()
  const { document } = await draft(fixture, '\uFEFF# Artifact\r\n')
  const exported = await complete(fixture.c, fixture.credential, fixture.c.invoke(fixture.credential, request('artifacts.export', { document, format: 'markdown' })))
  const lease = writer(fixture, document)
  const edited = commit(fixture, document, lease, '# Newer\n')
  fixture.restart()
  const bytes = fixture.c.invoke(fixture.credential, request('artifacts.read', { artifactId: exported.artifactId, offset: 0, length: 65536 }))
  expect(new TextDecoder('utf-8', { ignoreBOM: true }).decode(new Uint8Array(bytes.bytes))).toBe('\uFEFF# Artifact\r\n')
  expect(bytes.document.revision).toBe('0')
  expect(read(fixture, edited.snapshot.document).markdown).toBe('# Newer\n')
  const receiver = pair(fixture, ['task:read'])
  expect(() => fixture.c.invoke(receiver.credential, request('artifacts.read', { artifactId: exported.artifactId, offset: 0, length: 1 }))).toThrow('not authorized')
  const transfer = await complete(fixture.c, fixture.credential, fixture.c.invoke(fixture.credential, request('handoffs.create', {
    artifactId: exported.artifactId,
    recipientPrincipalId: receiver.principalId,
    purpose: 'review-delivery',
    expiresAt: new Date(fixture.clock.value + 10 * 60_000).toISOString(),
  })))
  expect(transfer.state).toBe('awaiting_receipt')
  const shared = fixture.c.invoke(receiver.credential, request('artifacts.read', { artifactId: exported.artifactId, handoffId: transfer.handoffId, offset: 0, length: 2 }))
  expect(shared.bytes).toHaveLength(2)
  const ack = request('handoffs.acknowledge', { handoffId: transfer.handoffId, status: 'accepted', artifactDigest: exported.digest })
  expect(() => fixture.c.invoke(fixture.credential, ack)).toThrow('not authorized')
  const receipt = await complete(fixture.c, receiver.credential, fixture.c.invoke(receiver.credential, ack))
  expect(receipt.state).toBe('accepted')
  expect(fixture.c.invoke(fixture.credential, request('handoffs.get', { handoffId: transfer.handoffId })).state).toBe('accepted')
  fixture.c.revokePrincipal(fixture.credential, fixture.hostInput('principal:revoke', { workspaceId: 'workspace' }, 'grant:manage', { workspaceId: 'workspace', principalId: receiver.principalId }))
  expect(() => fixture.c.invoke(receiver.credential, request('artifacts.read', { artifactId: exported.artifactId, handoffId: transfer.handoffId, offset: 0, length: 1 }))).toThrow('authentication')
})

test('revocation blocks old request retries, task results and queued side effects', async () => {
  const fixture = setup()
  const research = pair(fixture, ['document:create', 'task:read'])
  const input = request('documents.createDraft', { workspaceId: 'workspace', title: 'revoked.md', markdown: 'must not commit' })
  const receipt = fixture.c.invoke(research.credential, input)
  fixture.c.revokeGrant(fixture.credential, fixture.hostInput('grant:revoke', { workspaceId: 'workspace' }, 'grant:manage', { workspaceId: 'workspace', grantId: research.grantId }))
  expect(() => fixture.c.invoke(research.credential, input)).toThrow('not authorized')
  expect(() => fixture.c.getTask(research.credential, receipt.taskId)).toThrow('not authorized')
  await new Promise(resolve => setTimeout(resolve, 15))
  expect(fixture.c.invoke(fixture.credential, request('documents.list', { workspaceId: 'workspace' })).documents).toHaveLength(0)
})

test('purpose-scoped sharing grants permit only the approved handoff purpose and revoke descendants', async () => {
  const fixture = setup()
  const { document } = await draft(fixture, 'Purpose limited artifact')
  const artifact = await complete(fixture.c, fixture.credential, fixture.c.invoke(fixture.credential, request('artifacts.export', { document, format: 'markdown' })))
  const sender = pair(fixture, ['artifact:share', 'task:read'], { workspaceId: 'workspace', artifactId: artifact.artifactId, purpose: 'approved-purpose' }, 1)
  expect(fixture.c.describe(sender.credential).capabilities.map(capability => capability.id)).toContain('handoffs.get')
  const receiver = pair(fixture, ['task:read'])
  const handoffInput = {
    artifactId: artifact.artifactId,
    recipientPrincipalId: receiver.principalId,
    purpose: 'approved-purpose',
    expiresAt: new Date(fixture.clock.value + 60_000).toISOString()
  }
  expect(() => fixture.c.invoke(sender.credential, request('handoffs.create', { ...handoffInput, purpose: 'different-purpose' }))).toThrow('not authorized')
  const handoff = await complete(fixture.c, sender.credential, fixture.c.invoke(sender.credential, request('handoffs.create', handoffInput)))
  const allowedRead = request('artifacts.read', { artifactId: artifact.artifactId, handoffId: handoff.handoffId, offset: 0, length: 1 })
  expect(fixture.c.invoke(receiver.credential, allowedRead).bytes).toHaveLength(1)
  fixture.c.revokeGrant(fixture.credential, fixture.hostInput('grant:revoke', { workspaceId: 'workspace' }, 'grant:manage', {
    workspaceId: 'workspace', grantId: sender.grantId,
  }))
  expect(() => fixture.c.invoke(receiver.credential, allowedRead)).toThrow('not authorized')
})

test('event cursors are opaque, identity-bound, resumable and never expose unauthorized titles', async () => {
  const fixture = setup()
  const { document } = await draft(fixture, '# Visible')
  const reader = pair(fixture, ['document:read'], scope(document))
  await draft(fixture, '# Hidden')
  const first = fixture.c.listEvents(reader.credential, undefined, 1)
  expect(first.events).toHaveLength(1)
  expect(first.events[0]).not.toHaveProperty('sequence')
  expect(JSON.stringify(first)).not.toContain('Hidden')
  const second = fixture.c.listEvents(reader.credential, first.cursor)
  expect(second.events).toHaveLength(0)
  expect(() => fixture.c.listEvents(fixture.credential, first.cursor)).toThrow('event stream')
  expect(() => fixture.c.listEvents(reader.credential, undefined, 201)).toThrow('page size')
  fixture.clock.value += 24 * 60 * 60_000 + 1
  expect(() => fixture.c.listEvents(reader.credential, second.cursor)).toThrow()
})

test('save outbox records a fixed snapshot and never marks later edits as externally saved', async () => {
  const fixture = setup()
  const imported = fixture.c.importDocument(fixture.credential, fixture.hostInput('document:import', { workspaceId: 'workspace' }, 'document:commit', {
    workspaceId: 'workspace',
    title: 'external.md',
    rawText: 'Disk baseline',
    binding: { kind: 'root', alias: 'authorized-root:note.md', resourceVersion: 'version-one', consistency: 'conditional-write', needsReauthorization: false },
  }))
  const document = imported.snapshot.document
  const lease = writer(fixture, document)
  const changed = commit(fixture, document, lease, 'First saved snapshot')
  const binding = fixture.c.bindResource(fixture.credential, fixture.hostInput('resource:bind', scope(document), 'document:save', {
    document: changed.snapshot.document,
    ...lease,
    binding: { kind: 'root', alias: 'authorized-root:note.md', resourceVersion: 'version-one', consistency: 'conditional-write', needsReauthorization: false },
  }))
  const save = fixture.c.beginSave(fixture.credential, fixture.hostInput('save:begin', scope(document), 'document:save', {
    document: changed.snapshot.document, ...lease, bindingId: binding.bindingId,
  }))
  expect(() => fixture.c.cancelTask(fixture.credential, save.taskId)).toThrow('cancellation point')
  const later = commit(fixture, changed.snapshot.document, lease, 'Later unsaved input', 2)
  const finish = fixture.c.finishSave(fixture.credential, fixture.hostInput('save:finish', scope(document), 'document:save', {
    document: save.document, ...lease, saveId: save.saveId, outcome: 'saved', observedRawText: 'First saved snapshot', resourceVersion: 'version-two', inPlace: true,
  }))
  expect(finish.saved).toBe(true)
  expect(finish.inPlace).toBe(true)
  const latest = read(fixture, later.snapshot.document)
  expect(latest.savedRevision).toBe(changed.snapshot.document.revision)
  expect(latest.saved).toBe(false)
  expect(latest.markdown).toBe('Later unsaved input')
})

test('uncertain external save remains recoverable across restart without rewriting the file', async () => {
  const fixture = setup()
  const { document } = await draft(fixture, 'Private draft')
  const lease = writer(fixture, document)
  const binding = fixture.c.bindResource(fixture.credential, fixture.hostInput('resource:bind', scope(document), 'document:save', {
    document, ...lease, binding: { kind: 'root', consistency: 'conditional-write', needsReauthorization: false },
  }))
  const save = fixture.c.beginSave(fixture.credential, fixture.hostInput('save:begin', scope(document), 'document:save', { document, ...lease, bindingId: binding.bindingId }))
  const outcome = fixture.c.finishSave(fixture.credential, fixture.hostInput('save:finish', scope(document), 'document:save', {
    document, ...lease, saveId: save.saveId, outcome: 'unknown',
  }))
  expect(outcome.code).toBe('SAVE_OUTCOME_UNKNOWN')
  fixture.restart()
  expect(fixture.c.getPendingSaves(fixture.credential, document)[0].state).toBe('recovering')
  expect(read(fixture, document).markdown).toBe('Private draft')
  expect(fixture.c.getTask(fixture.credential, save.taskId).state).toBe('recovering')
  expect(fixture.c.getTask(fixture.credential, save.taskId).cancellable).toBe(false)
  expect(() => fixture.c.cancelTask(fixture.credential, save.taskId)).toThrow('cancellation point')
})

test('a save to an old binding cannot mark a newly selected target as saved', async () => {
  const fixture = setup()
  const { document } = await draft(fixture, 'Fixed snapshot')
  const lease = writer(fixture, document)
  const bind = alias => fixture.c.bindResource(fixture.credential, fixture.hostInput('resource:bind', scope(document), 'document:save', {
    document, ...lease, binding: { kind: 'root', alias, consistency: 'conditional-write', needsReauthorization: false },
  }))
  const first = bind('first-target')
  const save = fixture.c.beginSave(fixture.credential, fixture.hostInput('save:begin', scope(document), 'document:save', {
    document, ...lease, bindingId: first.bindingId,
  }))
  expect(() => fixture.c.beginSave(fixture.credential, fixture.hostInput('save:begin', scope(document), 'document:save', {
    document, ...lease, bindingId: first.bindingId,
  }))).toThrow('previous external save')
  bind('second-target')
  const completed = fixture.c.finishSave(fixture.credential, fixture.hostInput('save:finish', scope(document), 'document:save', {
    document, ...lease, saveId: save.saveId, outcome: 'saved', observedRawText: 'Fixed snapshot', resourceVersion: 'new-file-version',
  }))
  expect(completed.saved).toBe(true)
  expect(read(fixture, document).savedRevision).toBeNull()
  expect(read(fixture, document).saved).toBe(false)
})

test('external third-party content produces a save conflict while preserving the canonical draft', async () => {
  const fixture = setup()
  const { document } = await draft(fixture, 'Preserved canonical draft')
  const lease = writer(fixture, document)
  const binding = fixture.c.bindResource(fixture.credential, fixture.hostInput('resource:bind', scope(document), 'document:save', {
    document, ...lease, binding: { kind: 'root', consistency: 'conditional-write', needsReauthorization: false },
  }))
  const save = fixture.c.beginSave(fixture.credential, fixture.hostInput('save:begin', scope(document), 'document:save', { document, ...lease, bindingId: binding.bindingId }))
  const outcome = fixture.c.finishSave(fixture.credential, fixture.hostInput('save:finish', scope(document), 'document:save', {
    document, ...lease, saveId: save.saveId, outcome: 'unknown', observedRawText: 'External third-party content',
  }))
  expect(outcome.code).toBe('SAVE_CONFLICT')
  expect(outcome.state).toBe('failed')
  expect(read(fixture, document).markdown).toBe('Preserved canonical draft')
  expect(read(fixture, document).saved).toBe(false)
})

for (const crashStage of ['before-commit', 'after-commit']) {
  test(`SIGKILL ${crashStage} preserves exactly one recoverable task and result`, async () => {
    const fixture = setup()
    const input = request('documents.createDraft', { workspaceId: 'workspace', title: 'crash.md', markdown: 'Committed before response' }, 'crash-request')
    fixture.close()
    const modulePath = resolve(import.meta.dir, '../src/coordinator.ts')
    const script = `import {Coordinator} from ${JSON.stringify(modulePath)};
    const c=new Coordinator(${JSON.stringify(fixture.path)});
    const data=await Bun.stdin.text();const {credential,request}=JSON.parse(data);
    const receipt=c.invoke(credential,request);
    ${crashStage === 'before-commit' ? "process.kill(process.pid,'SIGKILL');" : ''}
    for(let i=0;i<100;i++){if(c.getTask(credential,receipt.taskId).state==='succeeded')process.kill(process.pid,'SIGKILL');await new Promise(r=>setTimeout(r,2));}
    process.exit(2);`
    const child = spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'pipe'] })
    child.stdin.end(JSON.stringify({ credential: fixture.credential, request: input }))
    const exit = await new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })))
    expect(exit.signal).toBe('SIGKILL')
    fixture.restart()
    const repeated = fixture.c.invoke(fixture.credential, input)
    await complete(fixture.c, fixture.credential, repeated)
    expect(fixture.c.getTask(fixture.credential, repeated.taskId).state).toBe('succeeded')
    expect(fixture.c.invoke(fixture.credential, request('documents.list', { workspaceId: 'workspace' })).documents).toHaveLength(1)
  })
}
