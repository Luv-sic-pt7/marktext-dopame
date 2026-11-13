import { readFileSync } from 'node:fs'
import { AcdeRpcTransport } from './acde-rpc-transport'
import { fault } from '../protocol'

const [project, credentialFile, method] = process.argv.slice(2)
try {
  if (!project || !credentialFile || !method) throw new Error('Missing caller arguments')
  const credential = JSON.parse(readFileSync(credentialFile, 'utf8'))
  if (typeof credential.token !== 'string' || !/^[a-f0-9]{64}$/.test(credential.token))
    throw new Error('Invalid credential')
  const data = await Bun.stdin.text()
  if (data.length > 4 * 1024 * 1024) throw new Error('Oversized caller input')
  const transport = new AcdeRpcTransport(project)
  const result = await transport.request({
    method,
    token: credential.token,
    args: data ? JSON.parse(data) : {}
  })
  process.stdout.write(JSON.stringify(result) + '\n')
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: fault(error) }) + '\n')
  process.exitCode = 1
}
