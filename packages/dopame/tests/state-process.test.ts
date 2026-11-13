import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PROTOCOL, unwrap } from '../protocol'

test('two independent state-process lifetimes retain receipts, queued tasks, events and authentication', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'marktext-process-'))
  const launchProcess = () =>
    Bun.spawn([process.execPath, resolve(import.meta.dir, '../state-process.ts'), dir], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe'
    })
  let processHandle: ReturnType<typeof launchProcess> | undefined
  async function start() {
    const handle = launchProcess()
    processHandle = handle
    const reader = handle.stdout.getReader()
    let buffer = ''
    const decoder = new TextDecoder()
    async function line() {
      while (true) {
        const n = buffer.indexOf('\n')
        if (n >= 0) {
          const value = JSON.parse(buffer.slice(0, n))
          buffer = buffer.slice(n + 1)
          return value
        }
        const r = await reader.read()
        if (r.done) throw new Error('State process ended')
        buffer += decoder.decode(r.value, { stream: true })
      }
    }
    expect((await line()).ready).toBe(true)
    let seq = 0
    return {
      async call(method: string, token: string, args: any = {}) {
        handle.stdin.write(JSON.stringify({ id: ++seq, request: { method, token, args } }) + '\n')
        const reply = await line()
        expect(reply.id).toBe(seq)
        return unwrap<any>(reply.response)
      },
      async stop(force = false) {
        if (force) handle.kill('SIGKILL')
        else handle.stdin.end()
        await handle.exited
      }
    }
  }
  try {
    let p = await start()
    const admin = JSON.parse(readFileSync(join(dir, 'administrator.json'), 'utf8')).token
    const pair = await p.call('admin.pair', admin, {
      clientId: 'external-researcher',
      label: '独立研究调用方',
      directApply: true
    })
    const token = JSON.parse(readFileSync(pair.credentialPath, 'utf8')).token
    await p.call('admin.grant', admin, {
      clientId: 'external-researcher',
      kind: 'workspace',
      resource: '*',
      actions: ['create']
    })
    const request = {
      protocol: PROTOCOL,
      requestId: 'lost-receipt',
      capability: 'documents.create',
      capabilityVersion: 1,
      input: { title: '待创建报告', markdown: '# 报告' }
    }
    const receipt = await p.call('submit', token, { request })
    expect(receipt.state).toBe('queued')
    await p.stop(true)
    p = await start()
    const retry = await p.call('submit', token, { request })
    expect(retry.taskId).toBe(receipt.taskId)
    const task = await p.call('getTask', token, { taskId: receipt.taskId })
    expect(task.state).toBe('queued')
    const events = await p.call('listEvents', token, { taskId: receipt.taskId, afterSeq: 0 })
    expect(events.events.length).toBeGreaterThan(0)
    await p.stop()
  } finally {
    try {
      processHandle?.kill()
    } catch {}
    rmSync(dir, { recursive: true, force: true })
  }
}, 15000)
