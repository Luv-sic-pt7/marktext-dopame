import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { mcpTestHost } from './mcp-test-host'
import { evidenceRoot, toolEnv } from './prepare-native'

const release = resolve(process.argv[2] ?? '')
if (!process.argv[2]) throw new Error('Pass the built release directory')
const driverPath =
  process.env.ACDE_DRIVER_MODULE ??
  join(homedir(), '.acde/versions/0.0.9/lib/acde/dist/driver/index.js')
const { Acde, expect } = await import(pathToFileURL(driverPath).href)
const { createClient } = await import(pathToFileURL(join(release, 'client/client.js')).href)
const { HttpTransport, readPrivateJson } = await import(
  pathToFileURL(join(release, 'client/http-transport.js')).href
)
const source =
  '# 调用路径对照\n\n中文与 emoji 😀。\n\n- 保留已知约束\n\n```js\nconst answer = 42\n```\n'
const replacement = source + '\n## 结论\n\n报告已完成审阅。\n'
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const observations: any[] = []

for (const mode of ['existing-direct-client', 'stdio-mcp-tools']) {
  for (let sample = 1; sample <= 3; sample++) {
    const stateHome = await mkdtemp(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'mtv-'))
    let session: any,
      host: Awaited<ReturnType<typeof mcpTestHost>> | null = null
    try {
      for (const name of ['data', 'config', 'state', 'cache', 'run'])
        await mkdir(join(stateHome, name), { mode: 0o700 })
      session = await Acde.launch({
        cwd: release,
        dirs: [join(release, 'packages/marktext-dopame')],
        desktop: join(release, 'packages/marktext-workspace'),
        headless: true,
        env: {
          ...toolEnv,
          ACDE_PATH: join(release, 'packages'),
          XDG_DATA_HOME: join(stateHome, 'data'),
          XDG_CONFIG_HOME: join(stateHome, 'config'),
          XDG_STATE_HOME: join(stateHome, 'state'),
          XDG_CACHE_HOME: join(stateHome, 'cache'),
          XDG_RUNTIME_DIR: join(stateHome, 'run'),
          MARKTEXT_BUN: process.execPath
        }
      })
      const desktop = session.desktop
      const administratorPath = await desktop.evaluate(
        '(async()=>{const m=await import("acde:marktext-agent");return (await m["marktext-agent"].request({method:"health"})).value.credentialPath})()'
      )
      await session.chooseFiles(administratorPath)
      await desktop.getByRole('button', { name: '选择管理员凭证', exact: true }).click()
      await desktop.getByRole('textbox', { name: '调用方 ID', exact: true }).fill('perf-writer')
      await desktop.getByRole('textbox', { name: '显示名称', exact: true }).fill('构建包验证调用方')
      await desktop
        .getByRole('checkbox', { name: '允许在授权范围内直接应用修改', exact: true })
        .check()
      await desktop.getByRole('button', { name: '创建配对凭证', exact: true }).click()
      await expect(desktop.getByRole('status', { name: '操作反馈', exact: true })).toContainText(
        '已配对'
      )
      await desktop
        .getByRole('combobox', { name: '调用方', exact: true })
        .selectOption('perf-writer')
      await desktop
        .getByRole('combobox', { name: '资源类型', exact: true })
        .selectOption('workspace')
      await desktop.getByRole('button', { name: '授予所选权限', exact: true }).click()
      await expect(desktop.getByRole('status', { name: '操作反馈', exact: true })).toContainText(
        '已授予所选范围'
      )
      const serviceState = dirname(administratorPath),
        endpoint = join(serviceState, 'endpoint.json'),
        credential = join(serviceState, 'client-perf-writer.json')
      let calls = 0
      const transport = new HttpTransport(endpoint)
      const direct = createClient(
        {
          async request(payload: any) {
            calls++
            return transport.request(payload)
          }
        },
        readPrivateJson(credential).token
      )
      if (mode === 'stdio-mcp-tools')
        host = await mcpTestHost(endpoint, credential, join(release, 'tools/marktext-mcp.js'))
      await desktop.evaluate(
        '(async()=>{const {windows}=await import("acde:windows");globalThis.__marktextVerificationEvents=[];for(const kind of ["open","close","activate"]){windows.on(kind,event=>globalThis.__marktextVerificationEvents.push({at:Date.now(),kind,window:event.window,appId:event.appId??null}))}return true})()'
      )
      const windows = async () =>
        (await session.webs())
          .filter((web: any) => web.app)
          .map((web: any) => ({ app: web.app, window: web.window }))
      const events = () => desktop.evaluate('globalThis.__marktextVerificationEvents')
      const call = async (name: string, args: any) => {
        if (host) {
          calls++
          return host.call(name, args)
        }
        const names: Record<string, string> = {
          get_task: 'getTask',
          get_result: 'getResult',
          read_artifact: 'readArtifact'
        }
        return direct.call(names[name], args)
      }
      async function document(capability: string, input: any, taskIds: string[]) {
        const requestId = crypto.randomUUID()
        let receipt: any
        if (host) {
          calls++
          receipt = await host.call('documents_' + capability, { requestId, input })
        } else receipt = await direct.request('documents.' + capability, input, requestId)
        taskIds.push(receipt.taskId)
        const end = Date.now() + 20000
        while (Date.now() < end) {
          const task = await call('get_task', { taskId: receipt.taskId })
          if (task.state === 'succeeded') return call('get_result', { taskId: receipt.taskId })
          if (['failed', 'cancelled'].includes(task.state))
            throw new Error('Verification task ended: ' + task.error?.code)
          await Bun.sleep(150)
        }
        throw new Error('Verification task timed out')
      }
      for (const state of ['cold', 'warm']) {
        const before = await windows(),
          startEvent = (await events()).length
        calls = 0
        const started = performance.now(),
          taskIds: string[] = []
        const created = await document(
          'create',
          { title: '调用路径对照报告', markdown: source },
          taskIds
        )
        const read = await document('read', { document: created.document }, taskIds)
        if (read.text !== source) throw new Error('Read did not match the fixed input')
        await document('outline', { document: created.document }, taskIds)
        const suggestion = await document(
          'propose',
          {
            document: created.document,
            baseRevision: 0,
            replacement,
            reason: '相同输入的路径对照'
          },
          taskIds
        )
        const applied = await document(
          'apply',
          {
            document: created.document,
            expectedRevision: 0,
            proposalId: suggestion.proposal.proposalId
          },
          taskIds
        )
        await document('save', { document: applied.document, expectedRevision: 1 }, taskIds)
        const exported = await document('export', { document: applied.document }, taskIds)
        const artifact = exported.artifacts[0]
        const chunk = await call('read_artifact', { ref: artifact, offset: 0, length: 65536 })
        if (Buffer.from(chunk.base64, 'base64').toString() !== replacement)
          throw new Error('Export did not match the final content')
        const elapsedMs = performance.now() - started,
          after = await windows(),
          activity = (await events()).slice(startEvent)
        if (after.some((window: any) => window.app !== 'marktext-dopame'))
          throw new Error('An unrelated application opened')
        const windowOpens = activity.filter((event: any) => event.kind === 'open').length
        if (windowOpens !== (state === 'cold' ? 1 : 0))
          throw new Error('Unexpected target window count')
        const app = session.window('marktext-dopame')
        if (!(await app.getByRole('button', { name: '新建', exact: true }).isVisible()))
          throw new Error('Built editor did not render')
        const diskText = await app.evaluate(
          '(async()=>{const {fs}=await import("acde:fs");return (await fs.readText("private",' +
            JSON.stringify('notes/' + applied.document.documentId + '.md') +
            ')).text})()'
        )
        if (diskText !== replacement)
          throw new Error('Built FilePort did not save the expected bytes')
        if (state === 'cold' && mode === 'existing-direct-client' && sample === 1)
          await app.screenshot({ path: join(evidenceRoot, 'built-package-running.png') })
        observations.push({
          mode,
          state,
          sample,
          initialDocumentRevision: 0,
          finalDocumentRevision: 1,
          inputSha256: digest(source),
          outputSha256: artifact.version,
          elapsedMs,
          calls,
          callUnit: host ? 'MCP tool invocations' : 'service requests',
          initialWindows: before,
          finalWindows: after,
          targetWindowOpens: windowOpens,
          focusEvents: activity.filter((event: any) => event.kind === 'activate').length,
          unrelatedWindowOpens: 0,
          windowEvents: activity,
          tasks: taskIds,
          success: true,
          recovery: 'not injected in timing; see native-workflow-v11.json',
          modelTokens: 'not applicable; deterministic host'
        })
      }
      await session.window('marktext-dopame').close()
      console.log('Verified ' + mode + ' pair ' + sample + ' (cold/warm)')
    } finally {
      if (host) await host.close()
      if (session) await session.close()
      await rm(stateHome, { recursive: true, force: true })
    }
  }
}
await mkdir(evidenceRoot, { recursive: true })
const manifest = await readFile(join(release, 'release-manifest.json'), 'utf8')
await writeFile(
  join(evidenceRoot, 'release-verification.json'),
  JSON.stringify(
    {
      environment: 'local macOS acdert 0.0.9, Bun 1.4.4',
      builtPackage: true,
      developmentServerUsed: false,
      officialMachine: false,
      realAgentSessions: false,
      manifestSha256: digest(manifest),
      samplesPerPathAndThermalState: 3,
      sameInputPermissionsAndVersions: true,
      initialDocumentCountPerPair: 0,
      observations,
      conclusion:
        'Both paths already access the service directly. No speedup claim. Focus counts are headless runtime activation events, not physical desktop observations.'
    },
    null,
    2
  )
)
console.log(
  'Built package verified: ' +
    observations.length +
    ' matched cold/warm workflows; no development server'
)
