/// <reference types="@dopame/acde-api/shell" />
import { apps } from 'acde:apps'
import * as namespaces from 'acde:marktext-agent'
const service = namespaces['marktext-agent']
const $ = (id) => document.getElementById(id)
let administrator = '',
  workerToken = '',
  view = { clients: [], grants: [], documents: [], tasks: [] },
  refreshing = false
const presets = {
  read: ['read'],
  review: ['read', 'propose'],
  edit: ['read', 'write', 'apply', 'save', 'export'],
  share: ['read', 'write', 'propose', 'apply', 'save', 'export', 'share']
}
const stateNames = {
  queued: '排队',
  'waiting-approval': '等待授权',
  running: '运行中',
  committing: '提交中',
  recovering: '核对恢复',
  succeeded: '成功',
  failed: '失败',
  cancelled: '已取消'
}
const actionNames = {
  read: '读取',
  write: '修改',
  create: '创建',
  propose: '建议',
  apply: '应用建议',
  save: '保存',
  export: '导出',
  share: '转交'
}
const time = (value) =>
  new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value))
function message(text, error = false) {
  $('message').hidden = false
  $('message').textContent = text
  $('message').className = error ? 'error' : ''
}
async function rpc(method, args = {}, token = administrator) {
  const r = await service.request({ method, token, args })
  if (!r.ok) throw new Error(r.error.code + ' · ' + r.error.message)
  return r.value
}
async function run(fn, button) {
  if (button) button.disabled = true
  try {
    return await fn()
  } catch (error) {
    message(error.message, true)
  } finally {
    if (button) button.disabled = false
  }
}
function cell(text) {
  const td = document.createElement('td')
  td.textContent = text ?? '—'
  return td
}
function action(text, fn, label) {
  const b = document.createElement('button')
  b.textContent = text
  if (label) b.setAttribute('aria-label', label)
  b.onclick = () => run(fn, b)
  return b
}
function empty(table, text, columns) {
  const row = document.createElement('tr'),
    td = cell(text)
  td.colSpan = columns
  td.className = 'empty'
  row.append(td)
  table.append(row)
}
function options(select, items, first) {
  const signature = JSON.stringify([items, first])
  if (select.dataset.signature === signature) return
  select.dataset.signature = signature
  const value = select.value
  select.replaceChildren()
  const placeholder = document.createElement('option')
  placeholder.value = ''
  placeholder.textContent = first
  select.append(placeholder)
  for (const item of items) {
    const option = document.createElement('option')
    option.value = item.id
    option.textContent = item.label
    select.append(option)
  }
  if (items.some((i) => i.id === value)) select.value = value
}
async function openEditor() {
  return apps.open('marktext-dopame', workerToken ? { kind: 'agent-wake', workerToken } : undefined)
}
function render() {
  options(
    $('grant-client'),
    view.clients
      .filter((c) => !c.revoked)
      .map((c) => ({ id: c.id, label: c.label + ' (' + c.id + ')' })),
    '选择调用方'
  )
  options(
    $('grant-resource'),
    [
      ...view.documents.map((d) => ({ id: d.id, label: d.title + ' · v' + d.revision })),
      { id: '*', label: '所有现有及未来文档' }
    ],
    '选择一份文档'
  )
  $('clients').replaceChildren()
  for (const client of view.clients) {
    const row = document.createElement('tr')
    row.append(
      cell(client.label),
      cell(client.id),
      cell(client.directApply ? '范围内直接执行' : '修改需批准'),
      cell(client.revoked ? '已撤销' : '有效')
    )
    const tools = cell('')
    if (!client.revoked)
      tools.append(
        action(
          '撤销配对',
          async () => {
            await rpc('admin.revoke', { clientId: client.id })
            message('该调用方的后续调用已被阻止')
            await refresh()
          },
          '撤销 ' + client.label + ' 的配对'
        )
      )
    row.append(tools)
    $('clients').append(row)
  }
  if (!view.clients.length) empty($('clients'), '还没有配对调用方', 5)
  $('grants').replaceChildren()
  const grants = view.grants.filter(
    (g) => g.live && ($('show-derived').checked || g.kind === 'workspace' || g.kind === 'document')
  )
  for (const grant of grants) {
    const row = document.createElement('tr'),
      client = view.clients.find((c) => c.id === grant.client_id),
      doc = view.documents.find((d) => d.id === grant.resource)
    const resource =
      grant.kind === 'workspace'
        ? '创建新文档'
        : (doc?.title ??
          (grant.resource === '*' ? '所有现有及未来文档' : grant.resource.slice(0, 12)))
    const rights =
      grant.actions.map((a) => actionNames[a] ?? a).join('、') +
      (grant.can_share && !grant.actions.includes('share') ? ' · 结果可转交' : '')
    row.append(
      cell(client?.label ?? grant.client_id),
      cell(resource),
      cell(rights),
      cell(grant.expires ? time(grant.expires) + ' 北京时间' : '长期')
    )
    const tools = cell('')
    tools.append(
      action(
        '撤销',
        async () => {
          await rpc('admin.revoke', { grantId: grant.id })
          message('授权已撤销，衍生授权也停止生效')
          await refresh()
        },
        '撤销 ' + (client?.label ?? grant.client_id) + ' 的 ' + grant.kind + ' 授权'
      )
    )
    row.append(tools)
    $('grants').append(row)
  }
  if (!grants.length) empty($('grants'), '当前没有此范围的有效授权', 5)
  $('tasks').replaceChildren()
  for (const task of view.tasks) {
    const row = document.createElement('tr'),
      name = cell(task.capability),
      sub = document.createElement('small')
    sub.textContent = task.source.label
    name.append(sub)
    row.append(
      name,
      cell(task.taskId.slice(0, 8)),
      cell((stateNames[task.state] ?? task.state) + ' · ' + task.stage),
      cell(time(task.updatedAt))
    )
    const tools = cell('')
    tools.append(
      action('详情', async () => {
        $('task-json').textContent = JSON.stringify(
          await rpc('admin.inspectTask', { taskId: task.taskId }),
          null,
          2
        )
        $('task-detail').hidden = false
      })
    )
    if (task.state === 'waiting-approval') {
      tools.append(
        action('允许修改', async () => {
          await rpc('admin.approve', { taskId: task.taskId, allow: true })
          await refresh()
        }),
        action('拒绝', async () => {
          await rpc('admin.approve', { taskId: task.taskId, allow: false })
          await refresh()
        })
      )
    } else if (['queued', 'running'].includes(task.state)) {
      tools.append(
        action('取消', async () => {
          const result = await rpc('admin.cancel', { taskId: task.taskId })
          message(
            result.task.state === 'cancelled'
              ? '任务已取消'
              : result.accepted
                ? '停止请求已发出，等待执行器确认'
                : '任务已进入提交或结束，保留实际结果'
          )
          await refresh()
        })
      )
    }
    row.append(tools)
    $('tasks').append(row)
  }
  if (!view.tasks.length) empty($('tasks'), '目前没有协作任务', 5)
}
async function refresh() {
  if (!administrator || refreshing) return
  refreshing = true
  try {
    view = await rpc('admin.list')
    render()
    const health = await rpc('health')
    const wake = await rpc('admin.wakeLog')
    $('wake-count').textContent = String(
      wake.events.filter((event) => event.kind === 'requested').length
    )
    $('service-status').textContent = health.workerOnline
      ? '编辑器已连接'
      : '服务运行中 · 编辑器离线'
  } finally {
    refreshing = false
  }
}
$('connect').onclick = () =>
  run(async () => {
    const [handle] = await window.showOpenFilePicker({
      types: [{ description: 'MarkText 管理员凭证', accept: { 'application/json': ['.json'] } }]
    })
    const data = JSON.parse(await (await handle.getFile()).text())
    if (
      data.clientId !== 'administrator' ||
      typeof data.token !== 'string' ||
      !/^[a-f0-9]{64}$/.test(data.token)
    )
      throw new Error('所选文件不是管理员凭证')
    const connected = await rpc('admin.connect', {}, data.token)
    administrator = data.token
    workerToken = connected.workerToken
    await rpc('admin.setWake', { callback: openEditor })
    $('management').hidden = false
    $('connection-title').textContent = '管理员已连接'
    $('connect').textContent = '重新选择凭证'
    message('可以配对调用方并授权。新任务会在需要时唤醒编辑器。')
    await refresh()
  }, $('connect'))
$('open-editor').onclick = () => run(openEditor, $('open-editor'))
$('refresh').onclick = () => run(refresh, $('refresh'))
$('show-derived').onchange = render
$('hide-detail').onclick = () => {
  $('task-detail').hidden = true
}
$('grant-kind').onchange = () => {
  const document = $('grant-kind').value === 'document'
  $('document-label').hidden = !document
  $('actions-label').hidden = !document
}
$('pair-form').onsubmit = (event) => {
  event.preventDefault()
  void run(async () => {
    const created = await rpc('admin.pair', {
      clientId: $('client-id').value,
      label: $('client-label').value,
      directApply: $('direct-apply').checked
    })
    $('paired-result').hidden = false
    $('paired-path').textContent = created.credentialPath
    message('调用方已配对，尚未自动获得任何已有文档的权限')
    await refresh()
  }, event.submitter)
}
$('grant-form').onsubmit = (event) => {
  event.preventDefault()
  void run(async () => {
    const workspace = $('grant-kind').value === 'workspace',
      resource = workspace ? '*' : $('grant-resource').value
    if (!resource) throw new Error('请明确选择授权文档')
    const hours = $('grant-hours').value,
      canShare = $('can-share').checked,
      actions = workspace ? ['create'] : [...presets[$('grant-actions').value]]
    if (canShare && !workspace && !actions.includes('share')) actions.push('share')
    await rpc('admin.grant', {
      clientId: $('grant-client').value,
      kind: workspace ? 'workspace' : 'document',
      resource,
      actions,
      canShare,
      requestId: crypto.randomUUID(),
      ...(hours ? { expiresAt: new Date(Date.now() + Number(hours) * 3600000).toISOString() } : {})
    })
    message('已授予所选范围，范围内不再重复确认')
    await refresh()
  }, event.submitter)
}
const dock = $('dock')
for (const app of (await apps.list()).filter((app) => app.id !== 'marktext-dopame'))
  dock.append(
    action(app.label, () => (app.id === 'marktext-dopame' ? openEditor() : apps.open(app.id)))
  )
setInterval(() => {
  if (administrator) void run(refresh)
}, 2000)
try {
  const health = await rpc('health', {}, '')
  $('credential-path').textContent = health.credentialPath
  $('service-status').textContent = '协作服务运行中'
} catch (error) {
  message(error.message, true)
  $('service-status').textContent = '服务暂不可用'
}
