import { test } from 'node:test'
import assert from 'node:assert/strict'
import factory from '../services/marktextdocs.ts'

test('unconfigured runtime returns safe availability and rejects every business call', async () => {
  let spawns = 0
  const service = factory({ env: {}, spawn () { spawns++; throw new Error('must not execute') } })
  const api = service.api.marktextdocs
  const status = await api.status()
  assert.equal(status.available, false)
  assert.equal(status.mode, 'proposal-preview')
  assert.equal(spawns, 0)
  await assert.rejects(() => api.describe('anything'), { code: 'RESOURCE_UNAVAILABLE' })
  await assert.rejects(() => api.requestPairing({ name: 'Researcher' }), { code: 'RESOURCE_UNAVAILABLE' })
  assert.deepEqual(Object.keys(api).sort(), ['cancelTask', 'claimPairing', 'describe', 'getTask', 'invoke', 'listEvents', 'requestPairing', 'status'].sort())
  service.close()
})

test('runtime start failure does not expose runtime paths or credentials', async () => {
  const service = factory({
    env: { MARKTEXT_BUN: '/private/test/runtime' },
    package: '/private/test/package',
    state: '/private/test/state',
    spawn () { throw new Error('secret runtime diagnostic') }
  })
  const api = service.api.marktextdocs
  const status = await api.status()
  assert.equal(status.available, false)
  assert.equal(JSON.stringify(status).includes('/private/'), false)
  assert.equal(JSON.stringify(status).includes('secret'), false)
  await assert.rejects(() => api.invoke('credential', {}), { code: 'RESOURCE_UNAVAILABLE' })
  service.close()
})

test('service uses a fixed worker and preserves business errors across its bounded transport', async () => {
  const sent = []
  let onLine
  let spawned
  const service = factory({
    env: { MARKTEXT_BUN: '/trusted/bun' },
    package: '/trusted/package',
    state: '/private/state',
    spawn (argv, options) {
      spawned = { argv, cwd: options.cwd }
      onLine = options.onLine
      return {
        write (line) {
          const request = JSON.parse(line)
          sent.push(request)
          if (request.method === 'getTask') {
            onLine(JSON.stringify({ id: request.id, error: { code: 'PERMISSION_DENIED', message: 'Access denied.', retryable: false } }))
          } else onLine(JSON.stringify({ id: request.id, result: { events: [] } }))
          return true
        },
        end () {}
      }
    }
  })
  onLine(JSON.stringify({ type: 'ready' }))
  assert.deepEqual(spawned, {
    argv: ['/trusted/bun', '/trusted/package/desktop/state-worker.js', '/private/state'], cwd: '/private/state'
  })
  const api = service.api.marktextdocs
  assert.equal((await api.status()).available, true)
  await api.listEvents('opaque-credential', undefined, 20)
  assert.deepEqual(sent[0].args, ['opaque-credential', null, 20])
  await assert.rejects(() => api.getTask('opaque-credential', 'task'), { code: 'PERMISSION_DENIED' })
  await assert.rejects(() => api.invoke('opaque-credential', { text: 'x'.repeat(600 * 1024) }), { code: 'PAYLOAD_TOO_LARGE' })
  assert.equal(sent.length, 2)
  service.close()
})
