import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAgentClient } from '../src/agentClient.ts'

test('Agent tools inject credentials outside model arguments and exclude approval tools', async () => {
  const calls = []
  const service = {
    describe: async auth => { calls.push(['describe', auth]); return {} },
    invoke: async (auth, request) => { calls.push(['invoke', auth, request]); return { taskId: 'task-1' } },
    getTask: async (auth, id) => { calls.push(['task', auth, id]); return { state: 'succeeded' } }
  }
  const client = createAgentClient(service, 'test-only-opaque-credential')
  const tools = client.tools({ type: 'object', additionalProperties: false })
  assert.equal(JSON.stringify(tools).includes('test-only-opaque-credential'), false)
  assert.deepEqual(tools.map(tool => tool.name), ['marktext_documents_invoke', 'marktext_documents_get_task'])
  assert.equal(client.registration.available, false)
  const request = { requestId: 'test-request', capability: 'documents.createDraft' }
  assert.deepEqual(await tools[0].execute(request), { taskId: 'task-1' })
  await tools[1].execute({ taskId: 'task-1' })
  assert.deepEqual(calls, [
    ['invoke', 'test-only-opaque-credential', request],
    ['task', 'test-only-opaque-credential', 'task-1']
  ])
  await assert.rejects(() => tools[1].execute({ taskId: 'task-1', auth: 'spoof' }), { code: 'INVALID_ARGUMENT' })
})
