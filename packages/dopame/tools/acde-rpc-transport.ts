import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Transport } from '../client'
import { AgentError, type Envelope } from '../protocol'

export class AcdeRpcTransport implements Transport {
  constructor(
    readonly project: string,
    readonly web = 'desktop',
    readonly binary = process.env.ACDE_CLI ?? join(homedir(), '.acde/bin/acde')
  ) {}
  async evaluate(code: string): Promise<any> {
    const child = Bun.spawn([this.binary, 'eval', this.web, '-'], {
      cwd: this.project,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        PATH:
          join(homedir(), '.bun/bin') +
          ':' +
          join(homedir(), '.acde/bin') +
          ':' +
          (process.env.PATH ?? '')
      }
    })
    child.stdin.write(code)
    child.stdin.end()
    const [stdout, _stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited
    ])
    if (exit !== 0)
      throw new AgentError(
        'TRANSPORT_TIMEOUT',
        '无法连接 acde 服务会话；请核对会话及工具路径',
        { exit },
        true
      )
    try {
      return JSON.parse(stdout)
    } catch {
      throw new AgentError('TRANSPORT_ERROR', '调试传输未返回有效 JSON', undefined, true)
    }
  }
  async request(payload: any): Promise<Envelope> {
    const data = JSON.stringify(payload)
      .replaceAll('\u2028', '\\u2028')
      .replaceAll('\u2029', '\\u2029')
    return this.evaluate(
      '(async()=>{const namespaces=await import("acde:marktext-agent");return await namespaces["marktext-agent"].request(' +
        data +
        ')})()'
    )
  }
}
