import { test, expect } from 'acde/test'
import { readFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { mcpTestHost } from '../../tools/mcp-test-host'
import { HttpTransport } from '../../http-transport'
import { createClient } from '../../client'

const evidence =
  process.env.MARKTEXT_EVIDENCE ??
  resolve(import.meta.dir, '../../../../../work/marktext-mvp-evidence')
mkdirSync(evidence, { recursive: true })

test(
  'paired stdio callers, cold wake coalescing, user suggestion undo, service restart and offline result queries',
  { timeout: 90000 },
  async ({ acde }) => {
    const desktop = acde.desktop
    const administratorPath = await desktop.evaluate<string>(
      '(async()=>{const m=await import("acde:marktext-agent");return (await m["marktext-agent"].request({method:"health"})).value.credentialPath})()'
    )
    const state = dirname(administratorPath),
      endpoint = join(state, 'endpoint.json')
    await acde.chooseFiles(administratorPath)
    await desktop.getByRole('button', { name: '选择管理员凭证', exact: true }).click()
    await expect(desktop.getByRole('heading', { name: '管理员已连接', exact: true })).toBeVisible()
    for (const [id, direct] of [
      ['writer-session', true],
      ['reviewer-session', false]
    ] as const) {
      await desktop.getByRole('textbox', { name: '调用方 ID', exact: true }).fill(id)
      await desktop.getByRole('textbox', { name: '显示名称', exact: true }).fill(id)
      await desktop
        .getByRole('checkbox', { name: '允许在授权范围内直接应用修改', exact: true })
        .setChecked(direct)
      await desktop.getByRole('button', { name: '创建配对凭证', exact: true }).click()
      await expect(desktop.getByRole('status', { name: '操作反馈', exact: true })).toContainText(
        '已配对'
      )
      await desktop.getByRole('combobox', { name: '调用方', exact: true }).selectOption(id)
      await desktop
        .getByRole('combobox', { name: '资源类型', exact: true })
        .selectOption('workspace')
      await desktop.getByRole('checkbox', { name: '允许向下游转授权', exact: true }).check()
      await desktop.getByRole('button', { name: '授予所选权限', exact: true }).click()
      await expect(desktop.getByRole('status', { name: '操作反馈', exact: true })).toContainText(
        '已授予所选范围'
      )
    }
    const writerPath = join(state, 'client-writer-session.json'),
      reviewerPath = join(state, 'client-reviewer-session.json')
    const writer = await mcpTestHost(endpoint, writerPath),
      reviewer = await mcpTestHost(endpoint, reviewerPath)
    const source = '# 协作报告\n\n初稿内容包含中文与 emoji 😀。\n'
    const windowApps = async () =>
      (await acde.webs())
        .filter((web) => web.app)
        .map((web) => web.app)
        .sort()
    const initialWindows = await windowApps(),
      started = performance.now()
    const request = (
      host: typeof writer,
      capability: string,
      input: any,
      requestId = crypto.randomUUID()
    ) => host.call('documents_' + capability, { requestId, input })
    async function complete(host: typeof writer, taskId: string) {
      const end = Date.now() + 18000
      while (Date.now() < end) {
        const task = await host.call('get_task', { taskId })
        if (task.state === 'succeeded') return host.call('get_result', { taskId })
        if (['failed', 'cancelled'].includes(task.state))
          throw new Error('Task ended: ' + task.error?.code)
        await Bun.sleep(100)
      }
      throw new Error('Task completion timeout')
    }
    const doc = async (host: typeof writer, capability: string, input: any) =>
      complete(host, (await request(host, capability, input)).taskId)
    const traces: any[] = []
    try {
      const [accepted, second] = await Promise.all([
        request(writer, 'create', { title: '协作报告', markdown: source }, 'stable-native-create'),
        request(reviewer, 'create', { title: '审阅记录', markdown: '# 审阅记录\n' })
      ])
      const [created] = await Promise.all([
        complete(writer, accepted.taskId),
        complete(reviewer, second.taskId)
      ])
      const coldMs = performance.now() - started
      expect(
        (
          await request(
            writer,
            'create',
            { title: '协作报告', markdown: source },
            'stable-native-create'
          )
        ).taskId
      ).toBe(accepted.taskId)
      const hotWindows = await windowApps()
      expect(hotWindows).toEqual(['marktext-dopame'])
      await expect(desktop.locator('#wake-count')).toHaveText('1')
      await expect(request(reviewer, 'read', { document: created.document })).rejects.toMatchObject(
        { code: 'PERMISSION_DENIED' }
      )
      await writer.call('share', {
        clientId: 'reviewer-session',
        kind: 'document',
        resource: created.document.documentId,
        actions: ['read', 'propose', 'share'],
        canShare: true,
        requestId: 'share-report'
      })
      const outline = await doc(reviewer, 'outline', { document: created.document })
      expect(outline.outline[0].text).toBe('协作报告')
      const read = await doc(reviewer, 'read', { document: created.document })
      expect(read.text).toBe(source)
      const replacement = source + '\n## 审阅结论\n\n补充后的文档可以交付。\n'
      const proposed = await doc(reviewer, 'propose', {
        document: created.document,
        baseRevision: 0,
        replacement,
        reason: '增加明确的交付结论'
      })
      await expect(
        request(reviewer, 'apply', {
          document: created.document,
          expectedRevision: 0,
          proposalId: proposed.proposal.proposalId
        })
      ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
      const app = acde.window('marktext-dopame')
      await app.getByRole('listitem').filter({ hasText: '协作报告' }).click()
      await app.getByRole('button', { name: '协作任务', exact: true }).click()
      await app.getByRole('button', { name: '查看建议差异', exact: true }).click()
      await app.screenshot({ path: join(evidence, 'native-suggestion-diff.png') })
      await app.getByRole('button', { name: '确认应用建议', exact: true }).click()
      await expect(app.getByRole('status', { name: '文档操作反馈', exact: true })).toContainText(
        '建议已应用为 v1'
      )
      await app.getByRole('button', { name: '关闭协作任务', exact: true }).click()
      await app.getByRole('button', { name: '撤销', exact: true }).click()
      expect(
        await app.evaluate<boolean>(
          'document.querySelector(".mu-editor").textContent.includes("审阅结论")'
        )
      ).toBe(false)
      await app.getByRole('button', { name: '重做', exact: true }).click()
      expect(
        await app.evaluate<boolean>(
          'document.querySelector(".mu-editor").textContent.includes("审阅结论")'
        )
      ).toBe(true)
      const document = { ...created.document, revision: 3 }
      await app.getByRole('button', { name: '保存', exact: true }).click()
      await expect(app.locator('.statusbar')).toContainText('已保存')
      const saved = await doc(writer, 'save', { document, expectedRevision: 3 })
      expect(saved.document.revision).toBe(3)
      const exported = await doc(writer, 'export', { document })
      const chunk = await writer.call('read_artifact', {
        ref: exported.artifacts[0],
        offset: 0,
        length: 65536
      })
      expect(Buffer.from(chunk.base64, 'base64').toString()).toBe(replacement)
      const shared = await writer.call('share', {
        clientId: 'reviewer-session',
        kind: 'artifact',
        resource: exported.artifacts[0].artifactId,
        actions: ['read'],
        requestId: 'share-fixed-export'
      })
      await reviewer.call('read_artifact', { ref: exported.artifacts[0], offset: 0, length: 65536 })
      await writer.call('revoke', { grantId: shared.grantId })
      await expect(
        reviewer.call('read_artifact', { ref: exported.artifacts[0], offset: 0, length: 65536 })
      ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
      await app.screenshot({ path: join(evidence, 'native-suggestion-applied.png') })
      const closing = app.close()
      await app.getByRole('button', { name: '保留草稿并退出', exact: true }).click()
      await closing
      await expect.poll(async () => (await windowApps()).length).toBe(0)
      const direct = createClient(
        new HttpTransport(endpoint),
        JSON.parse(readFileSync(writerPath, 'utf8')).token
      )
      for (const mode of ['existing-direct-client', 'stdio-mcp-tools']) {
        for (let sample = 0; sample < 3; sample++) {
          const before = await windowApps(),
            at = performance.now()
          if (mode === 'existing-direct-client') {
            await direct.listCapabilities()
            await direct.getTask(accepted.taskId)
            await direct.getResult(accepted.taskId)
            await direct.readArtifact(
              exported.artifacts[0],
              0,
              Math.min(65536, exported.artifacts[0].size)
            )
          } else {
            await writer.rpc('tools/list')
            await writer.call('get_task', { taskId: accepted.taskId })
            await writer.call('get_result', { taskId: accepted.taskId })
            await writer.call('read_artifact', {
              ref: exported.artifacts[0],
              offset: 0,
              length: 65536
            })
          }
          traces.push({
            mode,
            state: 'editor-offline/fixed-results-published',
            sample,
            elapsedMs: performance.now() - at,
            before,
            after: await windowApps(),
            success: true,
            focusChanges: 'unknown',
            modelTokens: 'not-applicable/deterministic-host'
          })
        }
      }
      expect(await windowApps()).toEqual(initialWindows)
      const previousPid = JSON.parse(readFileSync(endpoint, 'utf8')).processId
      process.kill(previousPid, 'SIGKILL')
      await expect
        .poll(
          async () => {
            try {
              return JSON.parse(readFileSync(endpoint, 'utf8')).processId !== previousPid
            } catch {
              return false
            }
          },
          { timeout: 8000 }
        )
        .toBe(true)
      expect((await writer.call('get_result', { taskId: accepted.taskId })).document).toEqual(
        created.document
      )
      const afterRestart = await doc(writer, 'create', {
        title: '状态进程重启后',
        markdown: '# 已恢复\n'
      })
      expect(afterRestart.document.revision).toBe(0)
      await Bun.write(
        join(evidence, 'native-workflow-v11.json'),
        JSON.stringify(
          {
            environment: 'local macOS acdert/acde/SDK 0.0.9, Bun 1.4.4',
            officialMachine: false,
            realAgentSessions: false,
            deterministicIndependentStdioHosts: 2,
            screenReadingUsedForBusinessResults: false,
            initialWindows,
            coldMs,
            coldWakeRequests: 1,
            hotWindows,
            capabilityDiscovery: true,
            taskId: accepted.taskId,
            initialDocument: created.document,
            finalDocument: document,
            export: exported.artifacts[0],
            revocationDenied: true,
            userApplyUndoRedo: true,
            nativeStateProcessRestart: true,
            afterRestart: afterRestart.document,
            measurements: traces,
            performanceClaim:
              'Both paths already use direct service queries. No speedup claim; three samples per query path; focus not observable.'
          },
          null,
          2
        )
      )
    } finally {
      await Promise.allSettled([writer.close(), reviewer.close()])
    }
  }
)
