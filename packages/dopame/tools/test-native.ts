import { existsSync } from 'node:fs'
import { mkdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { acdeBinary, evidenceRoot, portRoot, prepareNative, toolEnv } from './prepare-native'

let code = 1
let log = ''
await mkdir(evidenceRoot, { recursive: true })
const runId = String(Date.now())
async function capture(stream: ReadableStream<Uint8Array>, output: NodeJS.WriteStream) {
  const decoder = new TextDecoder()
  let buffer = ''
  const flush = (line: string) => {
    const safe = line.replace(/\b[a-f0-9]{64}\b/g, '[redacted-digest-or-secret]')
    output.write(safe)
    log += safe
  }
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true })
    let at: number
    while ((at = buffer.indexOf('\n')) >= 0) {
      flush(buffer.slice(0, at + 1))
      buffer = buffer.slice(at + 1)
    }
  }
  if (buffer) flush(buffer)
}
try {
  const stage = await prepareNative()
  const args = [
    'test',
    '--desktop',
    stage,
    '--workers',
    '1',
    '--timeout',
    '30000',
    ...process.argv.slice(2)
  ]
  const child = Bun.spawn([acdeBinary, ...args], {
    cwd: join(portRoot, 'app'),
    env: { ...toolEnv, MARKTEXT_BUN: process.execPath },
    stdin: 'inherit',
    stdout: 'pipe',
    stderr: 'pipe'
  })
  const streams = Promise.all([
    capture(child.stdout, process.stdout),
    capture(child.stderr, process.stderr)
  ])
  code = await child.exited
  await streams
} finally {
  await Bun.write(join(evidenceRoot, 'native-run-' + runId + '.log'), log)
  await Bun.write(
    join(evidenceRoot, 'native-run-latest.json'),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        exitCode: code,
        selected: process.argv.slice(2),
        log: 'native-run-' + runId + '.log',
        environment: 'local acdert 0.0.9',
        officialMachine: false,
        realAgentSessions: false
      },
      null,
      2
    )
  )
  const source = join(portRoot, 'app/.acde/test-results')
  if (existsSync(source)) {
    const parent = join(evidenceRoot, 'native-test-results')
    await mkdir(parent, { recursive: true })
    const out = join(parent, String(Date.now()))
    await rename(source, out)
    console.log('Native test artifacts: ' + out)
  }
}
process.exitCode = code
