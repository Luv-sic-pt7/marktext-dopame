<script setup lang="ts">
import { computed, nextTick, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { window as nativeWindow } from 'acde:window'
import { outline } from '../../protocol'
import { EditorAdapter } from './editor-adapter'
import { DocumentController } from './document-controller'
import { useUiStore } from './ui-store'

const props = defineProps<{ controller: DocumentController; nativeSelection?: boolean }>()
const c = props.controller,
  ui = useUiStore()
const active = computed(() => {
  ui.version
  return c.active ? { ...c.active } : null
})
const rows = computed(() => {
  ui.version
  return c.rows
})
const tabs = computed(() => {
  ui.version
  return c.openIds.map((id) => c.docs.get(id)).filter(Boolean)
})
const headings = computed(() => outline(active.value?.text ?? ''))
const selectionTick = ref(0)
const tableContext = computed(() => {
  ui.version
  selectionTick.value
  return adapter?.tableContext ?? null
})
const rich = ref<HTMLElement | null>(null),
  source = ref<HTMLElement | null>(null)
const findInput = ref<HTMLInputElement | null>(null),
  replacementInput = ref<HTMLInputElement | null>(null)
const titleDraft = ref(''),
  titleEditing = ref(false)
const roots = ref<any[]>([]),
  tree = ref<any[]>([]),
  expanded = ref(new Set<string>()),
  loadingFiles = ref(false)
const closeDialog = ref(false),
  closing = ref(false),
  tasks = ref<any[]>([]),
  diff = ref<any>(null),
  taskError = ref('')
let adapter: EditorAdapter | null = null,
  unsubscribe: () => void = () => {},
  activityTimer: ReturnType<typeof setInterval> | null = null
let lastId = '',
  lastMode = '',
  lastResource = '',
  lastFocusKey = ''
const sample =
  '# 开始写作\n\n这是一份可以编辑的示例文档。支持中文、**强调**、列表和表格。\n\n## 今日计划\n\n- [ ] 写下一个想法\n- [ ] 切换源码，查看 Markdown\n- [ ] 保存笔记\n\n## 资料记录\n\n| 内容 | 状态 |\n| --- | --- |\n| 本机编辑 | 可用 |\n| Agent 协作 | 连接后使用 |\n\n> 修改来自同一套文档命令，并保留独立的版本。\n'
const run = async (fn: () => any) => {
  try {
    return await fn()
  } catch (error) {
    c.error(error)
  }
}
async function focusActiveEditor() {
  const id = c.activeId
  const mode = c.active?.mode
  await nextTick()
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  if (
    !adapter ||
    c.activeId !== id ||
    c.active?.mode !== mode ||
    titleEditing.value ||
    diff.value ||
    closeDialog.value
  )
    return
  const focused = document.activeElement
  if (
    (focused instanceof HTMLInputElement ||
      focused instanceof HTMLTextAreaElement ||
      focused instanceof HTMLSelectElement) &&
    focused !== adapter.source.getInputField()
  )
    return
  adapter.focus()
}
const newDoc = () =>
  run(async () => {
    await c.create()
    await nextTick()
    adapter?.focus()
  })
const save = () => run(() => c.save())
const saveAs = () => run(() => c.save(undefined, true))
const exportFile = () => run(() => c.exportFile())
const switchMode = (mode: 'rich' | 'source' | 'preview') => run(() => c.mode(mode))
const open = () => run(() => c.openFiles())
const openInPlace = () => run(() => c.openFiles(true))
const storage = computed(() => {
  const d = active.value
  if (!d) return ''
  const target =
    !d.resource || (d.resource.kind === 'root' && d.resource.root === 'private')
      ? '保存到私有笔记'
      : '原位保存 · ' + (d.resource.kind === 'root' ? d.resource.path : d.resource.name)
  return (d.importSource ? '导入来源：' + d.importSource.title + ' · ' : '') + target
})
const recoveries = computed(() => {
  ui.version
  return c.recoveries
})
const status = computed(() => {
  ui.version
  const d = c.active
  if (!d) return '没有打开的文档'
  return d.readOnly ? '只读来源 · 可另存为' : c.dirty(d) ? '有未保存修改' : '已保存'
})
const wordCount = computed(() => [...(active.value?.text ?? '').replace(/\s/g, '')].length)
const safeDate = (date: string) => {
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    }).format(new Date(date))
  } catch {
    return '—'
  }
}
async function refreshRoots() {
  loadingFiles.value = true
  try {
    roots.value = (await c.files.roots()).filter((r) => r.id !== 'private')
  } finally {
    loadingFiles.value = false
  }
}
async function toggleFolder(root: string, path: string, name: string, depth: number) {
  const key = root + ':' + path
  if (expanded.value.has(key)) {
    expanded.value.delete(key)
    tree.value = tree.value.filter(
      (n) => !(n.root === root && n.path.startsWith(path ? path + '/' : '')) || n.key === key
    )
    return
  }
  const list = await c.files.list(root, path)
  expanded.value.add(key)
  const nodes = list.entries
    .filter((e) => e.kind === 'directory' || /\.(md|markdown|txt)$/i.test(e.name))
    .map((e) => ({
      key: root + ':' + (path ? path + '/' : '') + e.name,
      root,
      path: (path ? path + '/' : '') + e.name,
      name: e.name,
      kind: e.kind,
      depth: depth + 1
    }))
  const oldIndex = tree.value.findIndex((n) => n.key === key)
  if (oldIndex < 0) tree.value.push(...nodes)
  else tree.value.splice(oldIndex + 1, 0, ...nodes)
  if (list.truncated) c.message('info', '目录列表超过单次读取上限，其他文件仍可通过“打开文件”选择')
}
async function chooseFolder() {
  await c.files.chooseFolder()
  await refreshRoots()
}
async function chooseTree(node: any) {
  if (node.kind === 'directory') await toggleFolder(node.root, node.path, node.name, node.depth)
  else {
    await c.import(await c.files.readRoot(node.root, node.path), true)
    ui.mobilePanel = 'editor'
  }
}
async function activate(id: string) {
  await c.activate(id)
  ui.mobilePanel = 'editor'
}
async function closeTab(id: string) {
  await c.closeTab(id)
}
const reopenClosedTab = () =>
  run(async () => {
    await c.reopenClosedTab()
    await nextTick()
    adapter?.focus()
  })
const searchOptions = () => ({
  isCaseSensitive: ui.caseSensitive,
  isWholeWord: ui.wholeWord,
  isRegexp: ui.regexp
})
function search(direction?: 'previous' | 'next', reveal = true) {
  const result = adapter?.search(ui.find, searchOptions(), direction, reveal)
  ui.matches = result?.count ?? 0
  ui.matchIndex = result?.index ?? 0
  ui.searchError = result?.error ?? ''
}
async function openSearch(replace = false) {
  if (!c.active || diff.value || closeDialog.value) return
  ui.searchOpen = true
  await nextTick()
  const input = replace ? replacementInput.value : findInput.value
  input?.focus()
  input?.select()
}
function closeSearch() {
  adapter?.clearSearch()
  ui.searchOpen = false
  adapter?.focus()
}
function searchKey(event: KeyboardEvent) {
  if (event.isComposing) return
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    closeSearch()
  } else if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
    event.preventDefault()
    search(event.shiftKey ? 'previous' : 'next')
  }
}
function replaceCurrent() {
  adapter?.replace(ui.find, ui.replacement, searchOptions())
  search()
}
function replaceAll() {
  adapter?.replaceAll(ui.find, ui.replacement, searchOptions())
  search()
}
function undo() {
  adapter?.undo()
}
function redo() {
  adapter?.redo()
}
function format(type: 'strong' | 'em' | 'inline_code' | 'del') {
  adapter?.format(type)
}
function heading(level: number) {
  adapter?.heading(level)
}
function insertTable() {
  adapter?.insertTable()
}
function convertParagraph(event: Event) {
  const menu = event.target as HTMLSelectElement
  adapter?.convertParagraph(menu.value as Parameters<EditorAdapter['convertParagraph']>[0])
  menu.value = ''
}
function indentList(outdent = false) {
  adapter?.indentList(outdent)
}
function insertCodeBlock() {
  adapter?.insertCodeBlock()
}
function tableCommand(command: Parameters<EditorAdapter['tableCommand']>[0]) {
  adapter?.tableCommand(command)
}
function jumpTo(from: number) {
  adapter?.jumpTo(from)
}
async function activity() {
  if (!c.connected) return
  try {
    tasks.value = await c.activity()
    taskError.value = ''
  } catch (e: any) {
    taskError.value = e.message
  }
}
async function showDiff(proposalId: string) {
  diff.value = await c.proposal(proposalId)
}
async function applyDiff() {
  await c.applySuggestion(diff.value.proposalId)
  diff.value = null
}
async function openManager() {
  await nativeWindow.minimize()
}
function dismissNotice() {
  c.notice = null
  ui.touch()
}
function toggleCollaboration() {
  c.preferences.collaboration = !c.preferences.collaboration
  ui.touch()
  void activity()
}
function closeCollaboration() {
  c.preferences.collaboration = false
  ui.touch()
}
async function commitTitle() {
  titleEditing.value = false
  if (c.active) await run(() => c.rename(c.activeId, titleDraft.value))
  titleDraft.value = c.active?.title ?? ''
}
async function requestClose() {
  await c.flushActive()
  if (c.rows.some((d) => d.dirty)) closeDialog.value = true
  else await exitWithDrafts()
}
async function exitWithDrafts() {
  closing.value = true
  try {
    await c.flushAll()
    await c.stopWorker()
    nativeWindow.close()
  } catch (error) {
    c.error(error)
    closing.value = false
  }
}
async function saveAndExit() {
  closing.value = true
  try {
    for (const d of c.docs.values()) if (c.dirty(d)) await c.save(d.id)
    await exitWithDrafts()
  } catch (error) {
    c.error(error)
    closing.value = false
  }
}
function onActivate() {
  adapter?.setCaretActive(true)
  void c.checkExternal()
}
function keyboard(event: KeyboardEvent) {
  if (event.isComposing || c.composing || event.altKey || diff.value || closeDialog.value) return
  const modified = event.ctrlKey || event.metaKey
  const key = event.key.toLowerCase()
  let action: (() => any) | undefined
  if (modified) {
    if (key === 'n' && !event.shiftKey) action = newDoc
    else if (key === 'o' && !event.shiftKey) action = open
    else if (key === 's') action = event.shiftKey ? saveAs : save
    else if (key === 'f' && !event.shiftKey) action = () => openSearch()
    else if (key === 'h' && !event.shiftKey) action = () => openSearch(true)
    else if (key === 'w' && !event.shiftKey && c.active)
      action = () => run(() => closeTab(c.activeId))
    else if (key === 't' && event.shiftKey) action = reopenClosedTab
    else if (key === 'g')
      action = () => (ui.find ? search(event.shiftKey ? 'previous' : 'next') : openSearch())
    else if (
      event.target instanceof Node &&
      (rich.value?.contains(event.target) || source.value?.contains(event.target))
    ) {
      if (key === 'z') action = event.shiftKey ? redo : undo
      else if (key === 'y' && !event.shiftKey) action = redo
      else if (key === 'b' && !event.shiftKey) action = () => format('strong')
      else if (key === 'i' && !event.shiftKey) action = () => format('em')
      else if (key === 'x' && event.shiftKey) action = () => format('del')
    }
  } else if (key === 'f3') {
    action = () => (ui.find ? search(event.shiftKey ? 'previous' : 'next') : openSearch())
  } else if (key === 'escape' && ui.searchOpen) action = closeSearch
  if (!action) return
  event.preventDefault()
  event.stopImmediatePropagation()
  void action()
}
onMounted(async () => {
  unsubscribe = c.onChange(() => ui.touch())
  adapter = new EditorAdapter(
    c,
    rich.value!,
    source.value!,
    !!props.nativeSelection,
    () => selectionTick.value++
  )
  document.addEventListener('keydown', keyboard, true)
  await c.ready
  ui.touch()
  await refreshRoots()
  if (c.active) {
    lastId = c.active.id
    lastMode = c.active.mode
    lastResource = JSON.stringify(c.active.resource)
    adapter.load(c.active)
  }
  nativeWindow.setMenus([
    {
      id: 'file',
      label: '文件',
      items: [
        { id: 'new', label: '新建', shortcut: 'ctrl+n', onSelect: newDoc },
        { id: 'open', label: '导入文件', shortcut: 'ctrl+o', onSelect: open },
        { id: 'open-in-place', label: '原位打开文件', onSelect: openInPlace },
        { id: 'save', label: '保存', shortcut: 'ctrl+s', onSelect: save },
        { id: 'save-as', label: '另存为', shortcut: 'ctrl+shift+s', onSelect: saveAs },
        { id: 'export', label: '导出 Markdown', onSelect: exportFile },
        {
          id: 'reopen-tab',
          label: '恢复关闭标签',
          shortcut: 'ctrl+shift+t',
          onSelect: reopenClosedTab
        },
        { type: 'separator' },
        { id: 'exit', label: '退出', onSelect: () => void run(requestClose) }
      ]
    },
    {
      id: 'edit',
      label: '编辑',
      items: [
        {
          id: 'close-tab',
          label: '关闭标签',
          shortcut: 'ctrl+w',
          onSelect: () => c.active && run(() => closeTab(c.activeId))
        },
        { id: 'undo', label: '撤销', onSelect: undo },
        { id: 'redo', label: '重做', onSelect: redo },
        {
          id: 'find',
          label: '查找与替换',
          shortcut: 'ctrl+f',
          onSelect: () => openSearch()
        },
        { id: 'replace', label: '替换', shortcut: 'ctrl+h', onSelect: () => openSearch(true) }
      ]
    },
    {
      id: 'view',
      label: '视图',
      items: [
        { id: 'rich', label: '富文本', onSelect: () => switchMode('rich') },
        { id: 'source', label: '源码', onSelect: () => switchMode('source') },
        { id: 'preview', label: '阅读预览', onSelect: () => switchMode('preview') },
        {
          id: 'theme',
          label: '切换亮暗主题',
          onSelect: () => run(() => c.setTheme(c.preferences.theme === 'light' ? 'dark' : 'light'))
        }
      ]
    }
  ])
  nativeWindow.on('beforeclose', () => {
    void run(requestClose)
    return false
  })
  nativeWindow.on('activate', onActivate)
  nativeWindow.on('deactivate', () => adapter?.setCaretActive(false))
  activityTimer = setInterval(() => {
    if (c.preferences.collaboration) void activity()
  }, 1500)
})
watch(
  () => [ui.version, c.activeId, c.active?.mode],
  () => {
    document.documentElement.dataset.theme = c.preferences.theme
    const d = c.active
    const focusKey = d ? d.id + ':' + d.mode : ''
    const shouldFocus = focusKey !== lastFocusKey
    lastFocusKey = focusKey
    if (d?.id !== lastId || !titleEditing.value) titleDraft.value = d?.title ?? ''
    if (!d || !adapter) return
    if (d.id !== lastId || d.mode !== lastMode || JSON.stringify(d.resource) !== lastResource) {
      adapter.load(d)
      lastId = d.id
      lastMode = d.mode
      lastResource = JSON.stringify(d.resource)
    }
    if (shouldFocus) void focusActiveEditor()
    nativeWindow.setTitle((c.dirty(d) ? '• ' : '') + d.title + ' — MarkText')
  }
)
onBeforeUnmount(() => {
  document.removeEventListener('keydown', keyboard, true)
  unsubscribe()
  if (activityTimer) clearInterval(activityTimer)
  adapter?.destroy()
  adapter = null
})
watch(
  [
    () => ui.searchOpen,
    () => ui.find,
    () => ui.caseSensitive,
    () => ui.wholeWord,
    () => ui.regexp,
    () => active.value?.id,
    () => active.value?.mode,
    () => active.value?.text
  ],
  (values, previous) => {
    const reveal = values.slice(0, -1).some((value, index) => value !== previous[index])
    if (ui.searchOpen) search(undefined, reveal)
    else adapter?.clearSearch(false)
  },
  { flush: 'post' }
)
</script>

<template>
  <div class="workspace" :data-version="ui.version" :data-mobile-panel="ui.mobilePanel">
    <header class="topbar">
      <button
        class="mobile-menu"
        aria-label="查看文件"
        @click="ui.mobilePanel = ui.mobilePanel === 'files' ? 'editor' : 'files'"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 6h16M4 12h16M4 18h16" fill="none" stroke="currentColor" stroke-width="1.5" />
        </svg>
      </button>
      <div class="brand">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M3 19V5l9 8 9-8v14M3 5l9 14L21 5"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          />
        </svg>
        <h1>MarkText</h1>
        <span class="edition">Dopame</span>
      </div>
      <div class="top-actions">
        <button @click="open">导入文件</button><button @click="newDoc">新建</button
        ><button :disabled="!active" class="primary" @click="save">
          {{ active?.readOnly ? '另存为' : '保存' }}</button
        ><button :disabled="!active" @click="exportFile">导出</button>
      </div>
    </header>
    <aside class="sidebar" aria-label="文档导航">
      <div class="section-label">
        私有笔记 <span class="num">{{ rows.length }}</span>
      </div>
      <div class="notes" role="list">
        <button
          v-for="d in rows"
          :key="d.id"
          role="listitem"
          class="note"
          :class="{ selected: d.id === active?.id }"
          @click="run(() => activate(d.id))"
        >
          <span class="file-symbol" aria-hidden="true">≡</span
          ><span class="note-name">{{ d.title }}</span
          ><span v-if="d.dirty" class="unsaved" aria-label="未保存">•</span>
        </button>
        <p v-if="!rows.length" class="quiet">还没有笔记</p>
      </div>
      <div class="section-label folder-heading">
        文件夹 <button aria-label="添加文件夹" @click="run(chooseFolder)">＋</button>
      </div>
      <p v-if="loadingFiles" class="quiet">正在读取文件夹…</p>
      <p v-else-if="!roots.length" class="quiet">添加一个文件夹以浏览 Markdown 文件</p>
      <div v-for="root in roots" :key="root.id" class="root-group">
        <button
          class="tree-row root-row"
          :aria-label="root.label"
          @click="run(() => toggleFolder(root.id, '', root.label, -1))"
        >
          <span aria-hidden="true">⌄</span><span>{{ root.label }}</span
          ><small v-if="root.mode !== 'writable'">只读</small>
        </button>
        <button
          v-for="node in tree.filter((n) => n.root === root.id)"
          :key="node.key"
          class="tree-row"
          :aria-label="(node.kind === 'directory' ? '展开文件夹 ' : '原位打开文件 ') + node.name"
          :style="{ paddingLeft: 14 + node.depth * 14 + 'px' }"
          @click="run(() => chooseTree(node))"
        >
          <span aria-hidden="true">{{ node.kind === 'directory' ? '›' : '≡' }}</span
          ><span>{{ node.name }}</span>
        </button>
      </div>
      <div class="sidebar-bottom">
        <button aria-label="原位打开文件" @click="openInPlace">
          原位打开文件<span>回写所选文件</span>
        </button>
        <button @click="run(openManager)">
          协作中心
          <span :class="{ live: c.connected }">{{
            c.connected ? '已连接' : '待配对'
          }}</span></button
        ><button @click="run(() => c.setTheme(c.preferences.theme === 'light' ? 'dark' : 'light'))">
          {{ c.preferences.theme === 'light' ? '深色主题' : '浅色主题' }}
        </button>
      </div>
    </aside>
    <main class="sheet" :class="{ 'with-tasks': c.preferences.collaboration }">
      <nav class="tabs" aria-label="打开的文档">
        <div
          v-for="(d, index) in tabs"
          :key="d!.id"
          class="tab"
          :class="{ active: d!.id === active?.id }"
        >
          <button
            role="tab"
            :aria-selected="d!.id === active?.id"
            @click="run(() => activate(d!.id))"
          >
            {{ d!.title }}<span v-if="c.dirty(d!)"> •</span></button
          ><button
            class="close-tab"
            :aria-label="'关闭 ' + d!.title + '，第 ' + (index + 1) + ' 个标签'"
            @click="run(() => closeTab(d!.id))"
          >
            ×
          </button>
        </div>
        <button class="add-tab" aria-label="新建文档" @click="newDoc">＋</button>
        <button
          class="reopen-tab"
          aria-label="恢复关闭标签"
          title="恢复关闭标签 · Ctrl+Shift+T"
          :disabled="!c.closedIds.length"
          @click="reopenClosedTab"
        >
          ↶
        </button>
      </nav>
      <div v-if="c.notice" class="notice" :class="c.notice.kind" role="status">
        <span>{{ c.notice.message }}</span
        ><button
          v-if="c.notice.kind === 'conflict' && active?.resource"
          @click="run(() => c.reloadExternal(active!.id))"
        >
          保留草稿并载入磁盘版本</button
        ><button v-if="c.notice.kind === 'conflict' && active" @click="saveAs">另存为</button
        ><button aria-label="关闭提示" @click="dismissNotice">×</button>
      </div>
      <div
        v-for="recovery in recoveries"
        :key="recovery.taskId"
        class="notice conflict"
        role="status"
        aria-label="待核对提交"
      >
        <span
          >任务
          {{ recovery.taskId.slice(0, 8) }}
          的提交结果待核对。输入和恢复记录均保留，任务不会自动重复写入。</span
        >
        <button @click="run(() => c.preserveInput(recovery.documentId))">保留输入副本</button>
        <button @click="run(() => c.resolveUnknown(recovery.taskId))">保留副本并结束核对</button>
      </div>
      <div v-show="active" class="editor-body">
        <div class="document-bar">
          <div class="document-name">
            <input
              v-if="active"
              aria-label="笔记标题"
              v-model="titleDraft"
              @focus="titleEditing = true"
              @blur="commitTitle"
              @keydown.enter="($event.target as HTMLInputElement).blur()"
            /><span class="revision num">v{{ active?.revision }}</span>
          </div>
          <div class="mode-switch" aria-label="编辑模式">
            <button :aria-pressed="active?.mode === 'rich'" @click="switchMode('rich')">
              富文本</button
            ><button :aria-pressed="active?.mode === 'source'" @click="switchMode('source')">
              源码</button
            ><button :aria-pressed="active?.mode === 'preview'" @click="switchMode('preview')">
              预览
            </button>
          </div>
        </div>
        <p class="storage-location" aria-label="保存目标">
          <span
            >{{ storage
            }}<template v-if="active?.lastExport">
              · 上次导出 v{{ active.lastExport.revision }}：{{ active.lastExport.name }}</template
            ></span
          >
          <button class="storage-action" :disabled="!active" @click="saveAs">另存为</button>
        </p>
        <div class="format-toolbar" aria-label="编辑命令">
          <button
            aria-label="撤销"
            :disabled="active?.readOnly || active?.mode === 'preview'"
            @click="undo"
          >
            撤销</button
          ><button
            aria-label="重做"
            :disabled="active?.readOnly || active?.mode === 'preview'"
            @click="redo"
          >
            重做
          </button>
          <span class="toolbar-separator"></span>
          <select
            aria-label="段落类型"
            class="paragraph-menu"
            value=""
            :disabled="active?.readOnly || active?.mode === 'preview'"
            @change="convertParagraph"
          >
            <option value="" disabled>段落</option>
            <option value="paragraph">正文</option>
            <option value="blockquote">引用</option>
            <option value="ul-bullet">无序列表</option>
            <option value="ol-order">有序列表</option>
            <option value="ul-task">任务列表</option>
          </select>
          <button
            aria-label="加粗"
            :disabled="active?.readOnly || active?.mode === 'preview'"
            @mousedown.prevent
            @click="format('strong')"
          >
            <strong>B</strong></button
          ><button
            aria-label="斜体"
            :disabled="active?.readOnly || active?.mode === 'preview'"
            @mousedown.prevent
            @click="format('em')"
          >
            <em>I</em></button
          ><button
            aria-label="删除线"
            title="删除线 · Ctrl+Shift+X"
            :disabled="active?.readOnly || active?.mode === 'preview'"
            @mousedown.prevent
            @click="format('del')"
          >
            <s>删除线</s></button
          ><button
            aria-label="行内代码"
            :disabled="active?.readOnly || active?.mode === 'preview'"
            @mousedown.prevent
            @click="format('inline_code')"
          >
            〈〉</button
          ><button
            aria-label="一级标题"
            :disabled="active?.readOnly || active?.mode === 'preview'"
            @mousedown.prevent
            @click="heading(1)"
          >
            H1</button
          ><button
            aria-label="代码块"
            :disabled="active?.readOnly || active?.mode === 'preview'"
            @mousedown.prevent
            @click="insertCodeBlock"
          >
            代码块</button
          ><button
            aria-label="增加缩进"
            :disabled="active?.readOnly || active?.mode === 'preview'"
            @mousedown.prevent
            @click="indentList()"
          >
            缩进</button
          ><button
            aria-label="减少缩进"
            :disabled="active?.readOnly || active?.mode === 'preview'"
            @mousedown.prevent
            @click="indentList(true)"
          >
            减少缩进</button
          ><button
            aria-label="插入表格"
            :disabled="active?.readOnly || active?.mode === 'preview'"
            @mousedown.prevent
            @click.stop="insertTable"
          >
            表格
          </button>
          <span class="toolbar-spacer"></span
          ><button
            :aria-pressed="ui.searchOpen"
            title="查找与替换 · Ctrl+F"
            @click="ui.searchOpen ? closeSearch() : openSearch()"
          >
            查找</button
          ><button :aria-pressed="c.preferences.collaboration" @click="toggleCollaboration">
            协作任务
          </button>
        </div>
        <div v-if="tableContext" class="table-tools" role="toolbar" aria-label="表格编辑">
          <span class="table-position"
            >表格 · 第 {{ tableContext.row + 1 }} 行，第 {{ tableContext.column + 1 }} 列</span
          >
          <button
            aria-label="表格下方插入行"
            @mousedown.prevent
            @click="tableCommand('insert-row')"
          >
            添加行
          </button>
          <button
            aria-label="删除表格行"
            :disabled="!tableContext.canDeleteRow"
            @mousedown.prevent
            @click="tableCommand('delete-row')"
          >
            删除行
          </button>
          <button
            aria-label="表格右侧插入列"
            @mousedown.prevent
            @click="tableCommand('insert-column')"
          >
            添加列
          </button>
          <button
            aria-label="删除表格列"
            :disabled="!tableContext.canDeleteColumn"
            @mousedown.prevent
            @click="tableCommand('delete-column')"
          >
            删除列
          </button>
          <span class="toolbar-separator"></span>
          <button
            aria-label="表格左对齐"
            :aria-pressed="tableContext.align === 'left'"
            @mousedown.prevent
            @click="tableCommand('align-left')"
          >
            左对齐
          </button>
          <button
            aria-label="表格居中对齐"
            :aria-pressed="tableContext.align === 'center'"
            @mousedown.prevent
            @click="tableCommand('align-center')"
          >
            居中
          </button>
          <button
            aria-label="表格右对齐"
            :aria-pressed="tableContext.align === 'right'"
            @mousedown.prevent
            @click="tableCommand('align-right')"
          >
            右对齐
          </button>
        </div>
        <form
          v-if="ui.searchOpen"
          class="search-bar"
          aria-label="查找与替换"
          @submit.prevent="search('next')"
          @keydown="searchKey"
        >
          <div class="search-row">
            <label class="search-field"
              >查找<input
                ref="findInput"
                v-model="ui.find"
                aria-label="查找文本"
                autocomplete="off"
                :aria-invalid="!!ui.searchError"
            /></label>
            <div class="search-actions">
              <button type="button" :disabled="!ui.matches" @click="search('previous')">
                上一处
              </button>
              <button type="submit" :disabled="!ui.matches">下一处</button>
              <output class="num" aria-label="查找结果" aria-live="polite"
                >{{ ui.matchIndex }} / {{ ui.matches }}</output
              >
              <button type="button" aria-label="关闭查找" @click="closeSearch">×</button>
            </div>
          </div>
          <div class="search-row">
            <label class="search-field"
              >替换<input
                ref="replacementInput"
                v-model="ui.replacement"
                aria-label="替换为"
                autocomplete="off"
            /></label>
            <div class="search-actions">
              <button
                type="button"
                :disabled="active?.readOnly || active?.mode === 'preview' || !ui.matches"
                @click="replaceCurrent"
              >
                替换当前
              </button>
              <button
                type="button"
                :disabled="active?.readOnly || active?.mode === 'preview' || !ui.matches"
                @click="replaceAll"
              >
                全部替换
              </button>
            </div>
          </div>
          <div class="search-options">
            <label><input v-model="ui.caseSensitive" type="checkbox" />区分大小写</label>
            <label><input v-model="ui.wholeWord" type="checkbox" />全词匹配</label>
            <label><input v-model="ui.regexp" type="checkbox" />正则表达式</label>
          </div>
          <p v-if="ui.searchError" class="search-error" role="alert">{{ ui.searchError }}</p>
        </form>
        <div class="writing-area">
          <section class="editor-content" aria-label="文档编辑区域">
            <div ref="rich" class="rich-host"></div>
            <div ref="source" class="source-host" hidden></div>
          </section>
          <aside class="outline" aria-label="文档大纲">
            <div class="section-label">大纲</div>
            <p v-if="!headings.length" class="quiet">文档标题会显示在这里</p>
            <button
              v-for="h in headings"
              :key="h.from"
              :style="{ paddingLeft: (h.level - 1) * 10 + 'px' }"
              @click="jumpTo(h.from)"
            >
              {{ h.text || '未命名标题' }}
            </button>
          </aside>
        </div>
        <footer class="statusbar" aria-label="文档状态">
          <span>{{ status }}</span
          ><span class="num">{{ wordCount.toLocaleString('zh-CN') }} 字符</span
          ><span
            >UTF-8{{ active?.format.bom ? ' BOM' : '' }} ·
            {{ active?.format.newline === 'crlf' ? 'CRLF' : 'LF' }}</span
          ><span class="status-spacer"></span
          ><span :title="active?.id">文档 {{ active?.id.slice(0, 8) }}</span>
        </footer>
      </div>
      <section v-if="!active" class="empty-workspace">
        <span class="empty-mark" aria-hidden="true">M</span>
        <h2>给下一个想法留一页</h2>
        <p>Markdown 编辑、文件保存与 Agent 协作，从一份文档开始。</p>
        <div>
          <button class="primary" @click="newDoc">新建文档</button
          ><button @click="open">导入文件</button>
        </div>
        <button class="text-button" @click="run(() => c.create('开始写作 · 示例', sample))">
          打开示例文档
        </button>
      </section>
      <aside v-if="c.preferences.collaboration" class="task-drawer" aria-label="协作任务">
        <div class="drawer-heading">
          <h2>协作任务</h2>
          <button aria-label="关闭协作任务" @click="closeCollaboration">×</button>
        </div>
        <p v-if="!c.connected" class="quiet">先在协作中心完成配对。文件编辑和保存可以继续使用。</p>
        <p v-else-if="taskError" role="status">{{ taskError }}</p>
        <p v-else-if="!tasks.length" class="quiet">目前没有协作任务</p>
        <div v-for="task in tasks" :key="task.taskId" class="task-row">
          <div>
            <strong>{{ task.capability }}</strong
            ><span class="task-state">{{ task.state }}</span>
          </div>
          <p>{{ task.source.label }} · {{ task.stage }}</p>
          <small class="num">{{ safeDate(task.updatedAt) }} · {{ task.taskId.slice(0, 8) }}</small>
          <p v-if="task.error" class="error-text">
            {{ task.error.code }} · {{ task.error.message }}
          </p>
          <button v-if="task.proposalId" @click="run(() => showDiff(task.proposalId))">
            查看建议差异
          </button>
        </div>
      </aside>
    </main>
    <div v-if="diff" class="modal-backdrop">
      <section class="dialog diff-dialog" role="dialog" aria-modal="true" aria-label="建议差异">
        <div class="drawer-heading">
          <h2>建议差异</h2>
          <button aria-label="关闭建议差异" @click="diff = null">×</button>
        </div>
        <p>{{ diff.reason || '没有附加说明' }} · 基础版本 v{{ diff.baseRevision }}</p>
        <div class="diff-columns">
          <div>
            <h3>原文</h3>
            <pre>{{ diff.before }}</pre>
          </div>
          <div>
            <h3>建议</h3>
            <pre>{{ diff.after }}</pre>
          </div>
        </div>
        <p class="quiet">原文未改变。应用建议的调用方仍需具备文档修改权限和建议读取权限。</p>
        <div class="dialog-actions">
          <button class="primary" @click="run(applyDiff)">确认应用建议</button>
        </div>
      </section>
    </div>
    <div v-if="closeDialog" class="modal-backdrop">
      <section class="dialog" role="dialog" aria-modal="true" aria-label="关闭前处理草稿">
        <h2>还有未保存的修改</h2>
        <p>可以先保存，或保留私有草稿并退出，下次打开继续编辑。</p>
        <div class="dialog-actions">
          <button :disabled="closing" @click="closeDialog = false">继续编辑</button
          ><button :disabled="closing" @click="run(exitWithDrafts)">保留草稿并退出</button
          ><button class="primary" :disabled="closing" @click="run(saveAndExit)">
            保存全部并退出
          </button>
        </div>
      </section>
    </div>
  </div>
</template>
