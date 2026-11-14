import { Acde, expect, test } from 'acde/test'
import { readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const available = process.env.MARKTEXT_NATIVE_EXPECT_AVAILABLE === '1'
const readStatus = `import('acde:marktextdocs').then(({marktextdocs})=>marktextdocs.status())`

async function findDatabase(directory: string): Promise<string | undefined> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isFile() && entry.name === 'documents.sqlite') return path
    if (entry.isDirectory()) {
      const found = await findDatabase(path)
      if (found) return found
    }
  }
}

test.if(available)('service survives last app close and persists pairing across desktop restart', async({ acde, home }) => {
  await expect.poll(async() => (await acde.desktop.evaluate<{ available: boolean }>(readStatus)).available).toBe(true)
  const app = await acde.open('marktext-service-test-reader')
  await expect(app.getByText('Independent reader')).toBeVisible()
  const pairing = await acde.desktop.evaluate<{ pairingId: string; claimSecret: string }>(
    `import('acde:marktextdocs').then(({marktextdocs})=>marktextdocs.requestPairing({name:'Isolated test reviewer'}))`
  )
  await app.evaluate('window.close()')
  const claim = `import('acde:marktextdocs').then(({marktextdocs})=>marktextdocs.claimPairing(${JSON.stringify(pairing.pairingId)},${JSON.stringify(pairing.claimSecret)}))`
  expect(await acde.desktop.evaluate(claim)).toEqual({ state: 'pending' })
  const isolatedRoot = dirname(home)
  const database = await findDatabase(isolatedRoot)
  expect(database).toBeDefined()
  if (!database) throw new Error('The isolated service database was not created.')
  const serviceState = dirname(database)
  const marker = serviceState.lastIndexOf('/acde/')
  expect(marker).toBeGreaterThan(0)
  await acde.close()
  const restarted = await Acde.launch({
    dirs: [process.cwd()], desktop: process.cwd(), cwd: process.cwd(), headless: true,
    env: {
      ...process.env,
      HOME: home,
      XDG_STATE_HOME: serviceState.slice(0, marker),
      XDG_CONFIG_HOME: join(isolatedRoot, 'config'),
      XDG_DATA_HOME: join(isolatedRoot, 'data'),
      XDG_CACHE_HOME: join(isolatedRoot, 'cache'),
      ACDE_STORAGE: '', ACDE_AUTOSTART: '0', ACDE_AUDIO: 'null',
      MARKTEXT_BUN: process.execPath
    }
  })
  try {
    await expect.poll(async() => (await restarted.desktop.evaluate<{ available: boolean }>(readStatus)).available).toBe(true)
    expect(await restarted.desktop.evaluate(claim)).toEqual({ state: 'pending' })
  } finally { await restarted.close() }
})

test.if(!available)('missing runtime fails closed while apps without service dependencies still open', async({ acde }) => {
  const status = await acde.desktop.evaluate<{ available: boolean; mode: string }>(readStatus)
  expect(status.available).toBe(false)
  expect(status.mode).toBe('proposal-preview')
  const error = await acde.desktop.evaluate(
    `import('acde:marktextdocs').then(({marktextdocs})=>marktextdocs.describe('unpaired').catch(error=>({code:error.code,retryable:error.retryable})))`
  )
  expect(error).toEqual({ code: 'RESOURCE_UNAVAILABLE', retryable: true })
  const app = await acde.open('marktext-service-test-reader')
  await expect(app.getByText('Independent reader')).toBeVisible()
  await app.evaluate('window.close()')
})
