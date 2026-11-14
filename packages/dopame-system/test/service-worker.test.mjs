import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import factory from '../services/marktextdocs.ts'
import { Coordinator } from '../src/coordinator.ts'

test('real service and worker accept an omitted event cursor with an explicit page limit', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'marktext-service-worker-'))
  const state = join(temporary, 'state')
  const output = join(temporary, 'package')
  let service
  let exited
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
    const { credential } = coordinator.connectAuthor('test-only-host-ticket', 'event-workspace')
    coordinator.close()
    coordinator = undefined
    await mkdir(join(output, 'desktop'), { recursive: true })
    execFileSync('bun', ['build', fileURLToPath(new URL('../src/worker.ts', import.meta.url)),
      '--target', 'bun', '--outfile', join(output, 'desktop/state-worker.js')], { stdio: 'ignore' })
    service = factory({
      package: output,
      state,
      env: { MARKTEXT_BUN: process.execPath },
      spawn (argv, options) {
        const child = spawn(argv[0], argv.slice(1), { cwd: options.cwd, stdio: ['pipe', 'pipe', 'pipe'] })
        createInterface({ input: child.stdout }).on('line', options.onLine)
        exited = new Promise(resolve => child.on('exit', (code, signal) => { options.onExit(code, signal); resolve() }))
        return {
          pid: child.pid,
          write: text => child.stdin.write(text),
          end: () => child.stdin.end(),
          kill: signal => child.kill(signal)
        }
      }
    })
    const result = await service.api.marktextdocs.listEvents(credential, undefined, 100)
    assert.equal(Array.isArray(result.events), true)
    assert.equal((await service.api.marktextdocs.status()).available, true)
  } finally {
    coordinator?.close()
    service?.close()
    await exited
    await rm(temporary, { recursive: true, force: true })
  }
})
