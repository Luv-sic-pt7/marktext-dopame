import { test, expect } from 'bun:test'
import { WakePolicy } from '../desktop/services/wake-policy'

test('queries and an online executor never wake windows; concurrent cold requests coalesce with bounded retries', async () => {
  let now = 0,
    calls = 0,
    workerOnline = false,
    wakeNeeded = false
  const policy = new WakePolicy(
    async () => ({ ok: true, value: { workerOnline, wakeNeeded } }),
    async () => {
      calls++
    },
    () => now
  )
  await Promise.all([policy.tick(), policy.tick()])
  expect(calls).toBe(0)
  wakeNeeded = true
  await Promise.all([policy.tick('task-a'), policy.tick('task-b'), policy.tick()])
  expect(calls).toBe(1)
  now = 9999
  await policy.tick()
  expect(calls).toBe(1)
  now = 10000
  await policy.tick()
  now = 20000
  await policy.tick()
  now = 30000
  await policy.tick()
  expect(calls).toBe(3)
  workerOnline = true
  await policy.tick()
  expect(calls).toBe(3)
  workerOnline = false
  await policy.tick()
  expect(calls).toBe(4)
  policy.stop()
  now = 50000
  await policy.tick()
  expect(calls).toBe(4)
})
