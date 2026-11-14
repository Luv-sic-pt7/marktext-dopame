<script setup lang="ts">
import { computed, onMounted, ref, shallowRef, watch } from 'vue'
import { window as appWindow } from 'acde:window'
import { createAgentClient, type DocumentsService } from '../../../dopame-system/src/agentClient'
import type { DocumentRef, MarkdownBlock, TextChange } from '../domain/collaboration'

const props = defineProps<{ service: DocumentsService }>()
type Item = Record<string, unknown>
function record(value: unknown): Item {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Item : {}
}
function records(value: unknown) { return Array.isArray(value) ? value.map(record) : [] }
const sections = ['Agent 收件箱', '建议面板', '任务中心', '连接与授权']
const section = ref('连接与授权')
const status = ref('正在连接文档服务…')
const error = ref('')
const busy = ref(false)
const available = ref(false)
const name = ref('')
const workspaceId = ref('')
const pairing = shallowRef<Item>()
const client = shallowRef<ReturnType<typeof createAgentClient>>()
const description = shallowRef<Item>({})
const capabilities = computed(() => records(description.value.capabilities))
const documents = shallowRef<Item[]>([])
const documentCursor = ref<string>()
const snapshot = shallowRef<{ document: DocumentRef; title: string; markdown: string; blocks: MarkdownBlock[]; pendingInput: boolean; saved?: boolean }>()
const proposals = shallowRef<Item[]>([])
const selectedProposal = shallowRef<Item>()
const tasks = shallowRef<Item[]>([])
const events = shallowRef<Item[]>([])
const eventCursor = ref<string>()
const draftTitle = ref('')
const draftText = ref('')
const blockId = ref('')
const replacement = ref('')
const reason = ref('')
const artifactId = ref('')
const recipient = ref('')
const purpose = ref('')
const handoffId = ref('')
const handoffStatus = shallowRef<Item>()
const proposalChanges = computed(() => {
  const diff = selectedProposal.value?.diff
  return (Array.isArray(diff) ? diff : records(record(diff).changes)) as TextChange[]
})
function can(capability: string) {
  return !!client.value && capabilities.value.some(item => item.id === capability && item.available !== false)
}
function stateLabel(value: unknown) {
  const labels: Record<string, string> = { queued: '排队中', running: '执行中', committing: '提交中', succeeded: '已完成', failed: '失败',
    cancelled: '已取消', recovering: '恢复核对中', awaiting_user: '等待用户', pending_review: '待审阅', applied: '已应用',
    rejected: '已拒绝', stale: '已过期', withdrawn: '已撤回', awaiting_receipt: '等待接收方回执', accepted: '接收方已接受' }
  return labels[String(value)] ?? String(value)
}
function message(reason: unknown) {
  const value = reason as { code?: string; message?: string }
  return `${value?.code ? `${value.code} · ` : ''}${value?.message ?? '操作未完成，请刷新后重试。'}`
}
async function run(action: () => Promise<void>) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try { await action() } catch (reason) { error.value = message(reason) }
  finally { busy.value = false }
}
async function invoke(capability: string, input: Item) {
  if (!client.value) throw new Error('请先完成系统配对。')
  return client.value.invoke({ protocol: 'marktext-documents/1', requestId: crypto.randomUUID(), capabilityVersion: 1, capability, input })
}
async function checkService() {
  const result = await props.service.status()
  available.value = result.available
  status.value = result.available ? '服务已连接 · 辅助预览' : result.reason ?? '协作服务不可用'
}
async function pair() {
  pairing.value = record(await props.service.requestPairing({ name: name.value.trim() }))
  status.value = '配对请求已登记。批准宿主尚未接通，请求保持待处理。'
}
async function claim() {
  if (!pairing.value) return
  const result = record(await props.service.claimPairing(String(pairing.value.pairingId), String(pairing.value.claimSecret)))
  if (typeof result.credential !== 'string') { status.value = '批准宿主尚未接通；本次配对保持待处理。'; return }
  client.value = createAgentClient(props.service, result.credential)
  pairing.value = undefined
  description.value = record(await client.value.describe())
  const grants = records(description.value.grants)
  workspaceId.value = String(record(grants[0]?.scope).workspaceId ?? '')
  status.value = '已配对 · 仅访问当前授权范围'
  await refreshEvents()
}
async function refreshDocuments(more = false) {
  const result = record(await invoke('documents.list', { workspaceId: workspaceId.value, limit: 100,
    ...(more && documentCursor.value ? { cursor: documentCursor.value } : {}) }))
  documents.value = more ? [...documents.value, ...records(result.documents)] : records(result.documents)
  documentCursor.value = typeof result.cursor === 'string' ? result.cursor : undefined
}
async function openDocument(item: Item) {
  const document = record(item.document) as unknown as DocumentRef
  const result = record(await invoke('documents.read', { document }))
  const indexed = can('documents.blocks') ? record(await invoke('documents.blocks', { document, limit: 100 })) : {}
  snapshot.value = { document, title: String(item.title), markdown: String(result.markdown ?? ''), blocks: records(indexed.blocks) as unknown as MarkdownBlock[],
    saved: typeof result.saved === 'boolean' ? result.saved : undefined,
    pendingInput: record(result.freshness).hasUnacknowledgedInput !== false }
  blockId.value = snapshot.value.blocks[0]?.blockId ?? ''
  const suggested = can('proposals.list') ? record(await invoke('proposals.list', { document })) : {}
  proposals.value = records(suggested.proposals)
  selectedProposal.value = undefined
}
async function openProposal(item: Item) {
  selectedProposal.value = record(await invoke('proposals.get', { proposalId: String(item.proposalId) }))
  section.value = '建议面板'
}
async function track(result: unknown) {
  const receipt = record(result)
  if (typeof receipt.taskId !== 'string' || !client.value) return
  const task = record(await client.value.getTask(receipt.taskId))
  tasks.value = [task, ...tasks.value.filter(item => item.taskId !== task.taskId)]
  section.value = '任务中心'
}
async function createDraft() {
  await track(await invoke('documents.createDraft', { workspaceId: workspaceId.value, title: draftTitle.value, markdown: draftText.value }))
}
async function propose() {
  const document = snapshot.value?.document
  if (!document) return
  await track(await invoke('proposals.create', {
    base: document, operations: [{ kind: 'replaceBlock', blockId: blockId.value, markdown: replacement.value }], reason: reason.value,
  }))
}
async function refreshTask(item: Item) {
  if (!client.value) return
  const task = record(await client.value.getTask(String(item.taskId)))
  tasks.value = tasks.value.map(old => old.taskId === item.taskId ? task : old)
  const result = record(task.result)
  if (typeof result.artifactId === 'string') artifactId.value = result.artifactId
  if (typeof result.handoffId === 'string') handoffId.value = result.handoffId
}
async function cancelTask(item: Item) {
  if (!client.value) return
  await client.value.cancelTask(String(item.taskId))
  await refreshTask(item)
}
async function refreshEvents(more = false) {
  if (!client.value) return
  const result = record(await client.value.listEvents(more ? eventCursor.value : undefined, 100))
  const incoming = records(result.events)
  const deduplicated = new Map((more ? events.value : []).map(event => [event.eventId ?? event.id, event]))
  for (const event of incoming) deduplicated.set(event.eventId ?? event.id, event)
  events.value = [...deduplicated.values()]
  eventCursor.value = typeof result.cursor === 'string' ? result.cursor : undefined
  const ids = new Set(incoming.map(event => record(event.data).taskId).filter(id => typeof id === 'string'))
  for (const id of ids) {
    const task = record(await client.value.getTask(id as string))
    tasks.value = [task, ...tasks.value.filter(item => item.taskId !== task.taskId)]
  }
}
async function share() {
  await track(await invoke('handoffs.create', {
    artifactId: artifactId.value, recipientPrincipalId: recipient.value, purpose: purpose.value,
    expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
  }))
}
async function queryHandoff() {
  handoffStatus.value = record(await invoke('handoffs.get', { handoffId: handoffId.value }))
}
watch(blockId, id => { replacement.value = snapshot.value?.blocks?.find(block => block.blockId === id)?.markdown ?? '' })
watch(workspaceId, () => { documents.value = []; documentCursor.value = undefined; snapshot.value = undefined; proposals.value = []; selectedProposal.value = undefined })
onMounted(() => {
  document.title = 'Agent 协作 — MarkText · Dopame'
  void run(checkService)
  appWindow.on('request', request => {
    if (request.kind !== 'marktext-review') return
    const input = record(request)
    if (typeof input.proposalId === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(input.proposalId)) {
      void run(() => openProposal({ proposalId: input.proposalId }))
    } else if (typeof input.taskId === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(input.taskId)) {
      section.value = '任务中心'
      void run(async () => { if (client.value) await track({ taskId: input.taskId }) })
    }
  })
})
</script>

<template>
  <main
    class="collaboration-shell"
    :aria-busy="busy"
  >
    <header class="collaboration-header">
      <strong>MarkText <span>Dopame</span></strong>
      <span role="status">{{ status }}</span>
      <button
        :disabled="busy"
        @click="run(checkService)"
      >
        刷新服务状态
      </button>
    </header>
    <div class="collaboration-body">
      <nav aria-label="Agent 协作导航">
        <button
          v-for="item in sections"
          :key="item"
          :aria-current="section === item ? 'page' : undefined"
          @click="section = item"
        >
          {{ item }}
        </button>
        <p>已授权快照与建议</p>
      </nav>
      <section
        class="collaboration-content"
        :aria-label="section"
      >
        <h1>{{ section }}</h1>
        <p
          v-if="error"
          role="alert"
          class="collaboration-error"
        >
          {{ error }}
        </p>
        <p class="preview-note">
          建议仅供预览。受保护的人工批准通道尚未接通，接受、撤销和外部保存暂不可用。
        </p>

        <template v-if="section === '连接与授权'">
          <section
            aria-labelledby="connection-title"
            class="collaboration-section"
          >
            <h2 id="connection-title">
              连接调用身份
            </h2>
            <p>研究与审阅分别配对。权限由系统中的用户批准，名称不代表已验证的系统身份。</p>
            <form
              v-if="!client"
              @submit.prevent="run(pair)"
            >
              <label for="principal-name">调用方名称</label>
              <input
                id="principal-name"
                v-model="name"
                maxlength="120"
                autocomplete="off"
                required
              >
              <button
                type="submit"
                :disabled="!available || busy || !!pairing"
              >
                申请配对
              </button>
            </form>
            <template v-if="pairing">
              <p>配对请求：<code>{{ pairing.pairingId }}</code></p>
              <button
                :disabled="busy"
                @click="run(claim)"
              >
                查询配对批准
              </button>
            </template>
            <p v-if="client">
              连接已建立。凭据仅在当前连接中使用，关闭窗口后需重新连接。
            </p>
          </section>
          <section
            aria-labelledby="grants-title"
            class="collaboration-section"
          >
            <h2 id="grants-title">
              当前权限
            </h2>
            <p v-if="!capabilities.length">
              尚无可用权限。批准配对后才能查看能力和文档。
            </p>
            <ul v-else>
              <li
                v-for="capability in capabilities"
                :key="String(capability.id)"
              >
                {{ capability.id }} · {{ capability.available === false ? '不可用' : '已授权' }}
              </li>
            </ul>
            <p>受保护的授权管理通道尚未接通，当前客户端不能自行扩大权限。</p>
          </section>
          <section
            class="collaboration-section"
            aria-label="系统能力状态"
          >
            <h2>系统能力</h2>
            <p>内置 AI：系统模型契约待验证。多窗口：保持单写窗口。</p>
            <p>系统通知与文件句柄交接尚未通过目标桌面验证，结果仍可在任务中心查询。</p>
          </section>
        </template>

        <template v-else-if="section === 'Agent 收件箱'">
          <form
            class="workspace-filter"
            @submit.prevent="run(refreshDocuments)"
          >
            <label for="workspace-id">工作区</label>
            <input
              id="workspace-id"
              v-model="workspaceId"
              :disabled="busy"
              maxlength="128"
              required
            >
            <button
              type="submit"
              :disabled="!can('documents.list') || busy"
            >
              读取已授权文档
            </button>
          </form>
          <div class="document-columns">
            <section
              aria-label="已授权草稿"
              class="collaboration-section"
            >
              <h2>草稿</h2>
              <ul
                v-if="documents.length"
                class="document-list"
              >
                <li
                  v-for="item in documents"
                  :key="String(record(item.document).docId)"
                >
                  <button
                    :disabled="busy"
                    :aria-label="`读取草稿：${item.title}`"
                    @click="run(() => openDocument(item))"
                  >
                    {{ item.title }}<small>版本 {{ record(item.document).revision }}</small>
                  </button>
                </li>
              </ul>
              <p v-else>
                当前没有已读取的授权草稿。
              </p>
              <button
                v-if="documentCursor"
                :disabled="busy"
                @click="run(() => refreshDocuments(true))"
              >
                读取下一页草稿
              </button>
            </section>
            <section
              class="collaboration-section"
              aria-label="固定版本预览"
            >
              <h2>{{ snapshot?.title ?? '固定版本预览' }}</h2>
              <template v-if="snapshot">
                <p>版本 {{ snapshot.document.revision }} · 服务已提交快照{{ snapshot.pendingInput ? ' · 窗口可能仍有未同步输入' : '' }}</p>
                <p>{{ snapshot.saved === true ? '外部文件已保存此版本' : snapshot.saved === false ? '私有草稿 · 此版本尚未保存到外部文件' : '外部保存状态未知' }}</p>
                <pre>{{ snapshot.markdown }}</pre>
                <button
                  :disabled="!can('artifacts.export') || busy"
                  @click="run(async () => track(await invoke('artifacts.export', { document: snapshot!.document, format: 'markdown' })))"
                >
                  导出此固定版本
                </button>
              </template>
              <p v-else>
                选择一份草稿查看内容，读取不会修改文档。
              </p>
            </section>
          </div>
          <form
            v-if="can('documents.createDraft')"
            class="collaboration-section"
            @submit.prevent="run(createDraft)"
          >
            <h2>投递独立草稿</h2>
            <label for="draft-title">草稿标题</label><input
              id="draft-title"
              v-model="draftTitle"
              maxlength="256"
              required
            >
            <label for="draft-markdown">Markdown 内容</label><textarea
              id="draft-markdown"
              v-model="draftText"
              rows="6"
            />
            <button
              type="submit"
              :disabled="busy || !workspaceId"
            >
              创建独立草稿
            </button>
          </form>
        </template>

        <template v-else-if="section === '建议面板'">
          <section
            aria-label="建议列表"
            class="collaboration-section"
          >
            <h2>文档建议</h2>
            <ul v-if="proposals.length">
              <li
                v-for="proposal in proposals"
                :key="String(proposal.proposalId)"
              >
                <button
                  :disabled="busy"
                  :aria-label="`审阅建议：${proposal.reason}`"
                  @click="run(() => openProposal(proposal))"
                >
                  {{ proposal.reason }} · {{ stateLabel(proposal.state) }}
                </button>
              </li>
            </ul>
            <p v-else>
              先在收件箱读取文档，查看该文档的建议。
            </p>
          </section>
          <section
            v-if="selectedProposal"
            aria-label="建议差异"
            class="collaboration-section"
          >
            <h2>{{ selectedProposal.reason }}</h2>
            <p>来源 {{ selectedProposal.authorPrincipalId }} · 基础版本 {{ record(selectedProposal.base).revision }} · {{ stateLabel(selectedProposal.state) }}</p>
            <div
              v-for="(change, index) in proposalChanges"
              :key="index"
              class="diff-pair"
            >
              <section aria-label="原文">
                <h3>原文</h3><pre>{{ change.before }}</pre>
              </section>
              <section aria-label="建议">
                <h3>建议</h3><pre>{{ change.text }}</pre>
              </section>
            </div>
            <button
              disabled
              :aria-label="`接受建议：${selectedProposal.reason}`"
              aria-describedby="approval-unavailable"
            >
              接受建议
            </button>
            <button disabled>
              拒绝建议
            </button>
            <button disabled>
              撤销本次接受
            </button>
            <p id="approval-unavailable">
              需要受保护的人工批准通道。
            </p>
          </section>
          <form
            v-if="snapshot && can('proposals.create')"
            class="collaboration-section"
            @submit.prevent="run(propose)"
          >
            <h2>提交块修改建议</h2>
            <p>基础版本 {{ snapshot.document.revision }}。原文保持不变，段落分隔按替换内容原样提交。</p>
            <label for="proposal-block">目标块</label><select
              id="proposal-block"
              v-model="blockId"
            >
              <option
                v-for="block in snapshot.blocks"
                :key="block.blockId"
                :value="block.blockId"
              >
                {{ block.type }} · {{ block.markdown.slice(0, 50) }}
              </option>
            </select>
            <label for="proposal-text">建议内容</label><textarea
              id="proposal-text"
              v-model="replacement"
              rows="6"
            />
            <label for="proposal-reason">建议理由</label><input
              id="proposal-reason"
              v-model="reason"
              maxlength="4096"
              required
            >
            <button
              type="submit"
              :disabled="busy || !blockId"
            >
              提交建议
            </button>
          </form>
        </template>

        <template v-else>
          <button
            :disabled="!client || busy"
            @click="run(refreshEvents)"
          >
            刷新任务与事件
          </button>
          <section
            aria-label="持久任务"
            class="collaboration-section"
          >
            <h2>任务</h2>
            <p v-if="!tasks.length">
              当前没有可见任务。任务结果以服务记录为准。
            </p>
            <ul
              v-else
              class="task-list"
            >
              <li
                v-for="task in tasks"
                :key="String(task.taskId)"
              >
                <span role="status">{{ stateLabel(task.state) }}</span><code>{{ task.taskId }}</code>
                <p
                  v-if="task.error"
                  role="alert"
                >
                  {{ record(task.error).code }} · {{ record(task.error).message }}
                </p>
                <pre v-if="task.result">{{ JSON.stringify(task.result, null, 2) }}</pre>
                <button
                  :disabled="busy"
                  :aria-label="`查询任务：${task.taskId}`"
                  @click="run(() => refreshTask(task))"
                >
                  查询结果
                </button>
                <button
                  :disabled="busy || !['queued', 'running', 'awaiting_user'].includes(String(task.state))"
                  :aria-label="`取消任务：${task.taskId}`"
                  @click="run(() => cancelTask(task))"
                >
                  取消任务
                </button>
              </li>
            </ul>
          </section>
          <form
            v-if="can('handoffs.create')"
            class="collaboration-section"
            @submit.prevent="run(share)"
          >
            <h2>交接固定产物</h2>
            <label for="artifact-id">产物 ID</label><input
              id="artifact-id"
              v-model="artifactId"
              required
            >
            <label for="recipient-id">已授权接收方 ID</label><input
              id="recipient-id"
              v-model="recipient"
              required
            >
            <label for="handoff-purpose">用途</label><input
              id="handoff-purpose"
              v-model="purpose"
              maxlength="256"
              required
            >
            <p>授权期限为 15 分钟；接收方返回业务回执后才标记已接受。</p>
            <button
              type="submit"
              :disabled="busy"
            >
              发起服务交接
            </button>
          </form>
          <form
            v-if="can('handoffs.get')"
            class="collaboration-section"
            @submit.prevent="run(queryHandoff)"
          >
            <h2>交接回执</h2>
            <label for="handoff-id">交接 ID</label><input
              id="handoff-id"
              v-model="handoffId"
              required
            >
            <button
              type="submit"
              :disabled="busy"
            >
              查询交接结果
            </button>
            <p
              v-if="handoffStatus"
              role="status"
            >
              {{ stateLabel(handoffStatus.state) }} · {{ handoffStatus.purpose }}
            </p>
          </form>
          <section
            aria-label="持久事件"
            class="collaboration-section"
          >
            <h2>事件</h2><ul>
              <li
                v-for="event in events"
                :key="String(event.eventId ?? event.id)"
              >
                {{ event.type }} · {{ event.createdAt }}
              </li>
            </ul><p v-if="!events.length">
              当前没有可见事件。
            </p>
            <button
              v-if="eventCursor"
              :disabled="busy"
              @click="run(() => refreshEvents(true))"
            >
              读取后续事件
            </button>
          </section>
        </template>
      </section>
    </div>
  </main>
</template>

<style scoped>
.collaboration-shell { height: 100vh; display: flex; flex-direction: column; --muted: #606975; }
.collaboration-header { display: flex; align-items: center; gap: 24px; padding: 14px 22px; border-bottom: 1px solid var(--line); }
.collaboration-header strong { font-size: 16px; white-space: nowrap; }
.collaboration-header strong span { color: var(--muted); font-weight: 400; font-size: 12px; margin-left: 6px; }
.collaboration-header [role='status'] { flex: 1; color: var(--muted); }
.collaboration-body { flex: 1; min-height: 0; display: grid; grid-template-columns: 224px minmax(0, 1fr); }
.collaboration-body > nav { background: var(--panel); border-right: 1px solid var(--line); padding: 20px 12px; }
.collaboration-body > nav button { display: block; width: 100%; text-align: left; margin-bottom: 4px; }
.collaboration-body > nav button[aria-current='page'] { background: var(--line); font-weight: 600; }
.collaboration-body > nav p { padding: 20px 10px; font-size: 12px; color: var(--muted); }
.collaboration-content { min-width: 0; overflow: auto; padding: 24px 32px; }
h1 { margin: 0 0 16px; font-size: 24px; font-weight: 600; }
h2 { font-size: 16px; margin: 0 0 12px; } h3 { font-size: 13px; margin: 0 0 8px; }
p { color: var(--muted); line-height: 1.7; } ul { padding-left: 20px; line-height: 1.8; }
.preview-note { padding: 12px 16px; background: var(--panel); border-left: 2px solid var(--accent); }
.collaboration-section { padding: 20px 0; border-bottom: 1px solid var(--line); }
.collaboration-error { color: #a32835; }
form label { display: block; margin: 14px 0 8px; font-weight: 500; }
form input, form select, form textarea { display: block; width: 100%; max-width: 660px; margin-bottom: 12px; }
textarea { font: inherit; color: inherit; padding: 10px; background: var(--surface); border: 1px solid var(--line); border-radius: 5px; resize: vertical; }
button { border: 1px solid var(--line); min-height: 34px; }
button:disabled { color: var(--muted); background: var(--panel); opacity: 1; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; font-family: ui-monospace, monospace; line-height: 1.7; padding: 14px; background: var(--panel); max-height: 420px; overflow: auto; }
code { overflow-wrap: anywhere; font-family: ui-monospace, monospace; }
.document-columns { display: grid; grid-template-columns: minmax(180px, 1fr) minmax(0, 2fr); gap: 24px; }
.document-list { list-style: none; padding: 0; } .document-list button { width: 100%; text-align: left; margin-bottom: 8px; }
small { display: block; font-size: 12px; color: var(--muted); margin-top: 6px; }
.diff-pair { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.task-list { list-style: none; padding: 0; } .task-list > li { padding: 16px 0; border-bottom: 1px solid var(--line); }
.task-list code { display: block; margin: 8px 0; font-size: 12px; }
@media (max-width: 800px) {
  .collaboration-body { grid-template-columns: 1fr; grid-template-rows: auto minmax(0, 1fr); }
  .collaboration-body > nav { display: flex; overflow-x: auto; padding: 8px; border-right: 0; border-bottom: 1px solid var(--line); }
  .collaboration-body > nav button { white-space: nowrap; width: auto; margin: 0 4px 0 0; }
  .collaboration-body > nav p { display: none; }
  .collaboration-content { padding: 20px; } .document-columns, .diff-pair { grid-template-columns: 1fr; }
  .collaboration-header { flex-wrap: wrap; gap: 10px; padding: 12px 20px; }
}
</style>
