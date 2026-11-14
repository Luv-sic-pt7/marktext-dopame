import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { Coordinator } from '../src/coordinator.ts'

function start (state) {
  const process = spawn('bun', [fileURLToPath(new URL('../src/worker.ts', import.meta.url)), state], { stdio: ['pipe', 'pipe', 'pipe'] })
  const output = createInterface({ input: process.stdout })
  const lines = []
  const waiting = []
  output.on('line', line => {
    const data = JSON.parse(line)
    if (waiting.length) waiting.shift()(data)
    else lines.push(data)
  })
  const next = () => lines.length
    ? Promise.resolve(lines.shift())
    : new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Worker response timed out')), 5000)
      waiting.push(result => { clearTimeout(timer); resolve(result) })
    })
  const exited = new Promise(resolve => process.on('exit', resolve))
  return {
    next,
    exited,
    send: message => process.stdin.write(JSON.stringify(message) + '\n'),
    stop: async () => { process.stdin.end(); await exited },
    kill: async () => { process.kill('SIGKILL'); await exited }
  }
}

test('worker rejects internal commands and actor spoofing; pairing survives process restart', async () => {
  const state = await mkdtemp(join(tmpdir(), 'marktext-worker-'))
  let worker
  try {
    worker = start(state)
    assert.deepEqual(await worker.next(), { type: 'ready' })
    worker.send({ id: 'spoof', method: 'connectAuthor', args: [] })
    assert.equal((await worker.next()).error.code, 'INVALID_ARGUMENT')
    worker.send({ id: 'unauth', method: 'describe', args: ['guessed-document-id'] })
    assert.equal((await worker.next()).error.code, 'UNAUTHENTICATED')
    worker.send({ id: 'pair', method: 'requestPairing', args: [{ name: 'Research Agent' }] })
    const paired = (await worker.next()).result
    assert.equal(paired.state, 'pending')
    assert.equal(typeof paired.claimSecret, 'string')
    await worker.kill()
    worker = start(state)
    assert.deepEqual(await worker.next(), { type: 'ready' })
    worker.send({ id: 'claim', method: 'claimPairing', args: [paired.pairingId, paired.claimSecret] })
    assert.deepEqual((await worker.next()).result, { state: 'pending' })
  } finally {
    await worker?.stop()
    await rm(state, { recursive: true, force: true })
  }
})

test('second worker cannot own the same state while first worker is live', async () => {
  const state = await mkdtemp(join(tmpdir(), 'marktext-owner-'))
  const first = start(state)
  let second
  try {
    assert.deepEqual(await first.next(), { type: 'ready' })
    second = start(state)
    const response = await second.next()
    assert.equal(response.type, 'unavailable')
    assert.equal(await second.exited, 1)
  } finally {
    await first.stop()
    if (second) await second.exited
    await rm(state, { recursive: true, force: true })
  }
})

test('public worker recovers a committed task without recreating its document', async () => {
  const state = await mkdtemp(join(tmpdir(), 'marktext-task-restart-'))
  let worker
  let coordinator
  try {
    coordinator = new Coordinator(state, {
      approvalPort: {
        verify: (_ticket, binding) => ({
          ticketId: crypto.randomUUID(),
          principalId: 'isolated-test-author',
          binding,
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
          policyVersion: 'test-only'
        })
      }
    })
    const { credential } = coordinator.connectAuthor('test-only-host-ticket', 'restart-workspace')
    const request = {
      protocol: 'marktext-documents/1',
      requestId: 'durable-draft',
      capabilityVersion: 1,
      capability: 'documents.createDraft',
      input: { workspaceId: 'restart-workspace', title: 'restart.md', markdown: '# Durable\n\nBody' }
    }
    const receipt = coordinator.invoke(credential, request)
    let task = coordinator.getTask(credential, receipt.taskId)
    for (let attempt = 0; task.state !== 'succeeded' && attempt < 100; attempt++) {
      if (task.state === 'failed') throw new Error(`Seed task failed: ${task.error.code}`)
      await new Promise(resolve => setTimeout(resolve, 5))
      task = coordinator.getTask(credential, receipt.taskId)
    }
    assert.equal(task.state, 'succeeded')
    coordinator.close()
    coordinator = undefined
    worker = start(state)
    assert.deepEqual(await worker.next(), { type: 'ready' })
    worker.send({ id: 'task', method: 'getTask', args: [credential, receipt.taskId] })
    assert.deepEqual((await worker.next()).result, task)
    worker.send({ id: 'retry', method: 'invoke', args: [credential, request] })
    assert.equal((await worker.next()).result.taskId, receipt.taskId)
    worker.send({
      id: 'read',
      method: 'invoke',
      args: [credential, {
        protocol: 'marktext-documents/1',
        requestId: 'read-durable',
        capabilityVersion: 1,
        capability: 'documents.read',
        input: { document: task.result.document }
      }]
    })
    const read = (await worker.next()).result
    assert.equal(read.markdown, '# Durable\n\nBody')
    assert.deepEqual(read.document, task.result.document)
    worker.send({
      id: 'list',
      method: 'invoke',
      args: [credential, {
        protocol: 'marktext-documents/1',
        requestId: 'list-durable',
        capabilityVersion: 1,
        capability: 'documents.list',
        input: { workspaceId: 'restart-workspace' }
      }]
    })
    assert.equal((await worker.next()).result.documents.length, 1)
    worker.send({ id: 'events', method: 'listEvents', args: [credential, null, 100] })
    assert.equal(Array.isArray((await worker.next()).result.events), true)
  } finally {
    coordinator?.close()
    await worker?.stop()
    await rm(state, { recursive: true, force: true })
  }
})
