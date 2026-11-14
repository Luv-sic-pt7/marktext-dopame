<script setup lang="ts">
import { computed, markRaw, nextTick, onMounted, reactive, ref, watch } from 'vue'
import { window as appWindow } from 'acde:window'
import Editor from './Editor.vue'
import { shortcut } from './shortcuts'
import { canonicalResource, registerDirectory, createNote, fs, openFiles, readResource, requireAvailablePath, type OpenedFile } from './files'
import { containsResource, entryPath, renamedResource } from './filePaths'
import { createDocument, documentController, isDirty, outline, updateDocument, type DocumentTab } from './document'
import { filePort } from './platform/filePort'
import { parseSession } from './session'

type EditorView = InstanceType<typeof Editor>
type Heading = { lvl: number; content: string; slug: string }
const tabs = reactive<DocumentTab[]>([])
const activeId = ref('')
const active = computed(() => tabs.find(tab => tab.id === activeId.value))
const editors = new Map<string, EditorView>()
const outlines = reactive<Record<string, Heading[]>>({})
const headings = computed(() => active.value?.mode === 'source'
  ? outline(active.value.text) : outlines[activeId.value] ?? [])
const error = ref('')
const status = ref('就绪')
const dark = ref(localStorage.getItem('theme') === 'dark')
const searchOpen = ref(false)
const search = ref('')
const replacement = ref('')
const roots = ref<Awaited<ReturnType<typeof fs.roots>>>([])
const root = ref('private')
const folder = ref('')
type FileEntry = { name: string; kind: string }
type FileAction = 'note' | 'folder' | 'rename' | 'delete'
const entries = ref<FileEntry[]>([])
const writableRoot = computed(() => roots.value.find(item => item.id === root.value)?.mode === 'writable')
const fileDialog = ref<{ action: FileAction; root: string; folder: string; entry?: FileEntry } | null>(null)
const fileName = ref('')
const fileError = ref('')
const fileBusy = ref(false)
const fileTitle = computed(() => ({ note: '新建笔记', folder: '新建文件夹', rename: '重命名', delete: '删除' })[fileDialog.value?.action ?? 'note'])
const truncated = ref(false)
const closing = ref<DocumentTab[] | null>(null)
const closeBusy = ref(false)
const modalOpen = computed(() => !!fileDialog.value || !!closing.value)
let modalReturnFocus: HTMLElement | null = null
let closeAction: (() => void) | null = null
let draftTimer: ReturnType<typeof setTimeout>
let draftQueue = Promise.resolve()
let sessionWritable = false

function report(reason: unknown) {
  if (reason instanceof Error && reason.name === 'AbortError') return
  error.value = reason instanceof Error ? reason.message : String(reason)
}

async function run(action: () => unknown | Promise<unknown>) {
  try { await action() } catch (reason) { report(reason) }
}

function remember() {
  clearTimeout(draftTimer)
  draftTimer = setTimeout(() => void persist(), 400)
}

function persist() {
  clearTimeout(draftTimer)
  if (!sessionWritable) return Promise.resolve()
  const snapshot = JSON.stringify({ version: 1, activeId: activeId.value,
    tabs: tabs.map(tab => ({ ...tab, saving: false,
      resource: tab.resource?.kind === 'root' ? tab.resource : null,
      savedText: tab.resource?.kind === 'handle' ? null : tab.savedText })) })
  draftQueue = draftQueue.then(async () => {
    await fs.writeFile('private', '.marktext/session.json', snapshot, { mkdirs: true })
  }).catch(report)
  return draftQueue
}

function attach(name: string, text = '', resource: OpenedFile['resource'] | null = null) {
  if (modalOpen.value || inputBusy()) return
  editors.get(activeId.value)?.flush()
  const tab = createDocument(name, text, resource ? markRaw(resource) : null)
  tabs.push(tab)
  activeId.value = tab.id
  remember()
  return tab
}

async function addFile(file: OpenedFile) {
  if (modalOpen.value || inputBusy()) return
  file.resource = await canonicalResource(file.resource)
  for (const tab of tabs) {
    const current = tab.resource ? await canonicalResource(tab.resource) : null
    if (current?.kind === 'root' && file.resource.kind === 'root'
      && current.root === file.resource.root && current.path === file.resource.path) {
      select(tab.id)
      return
    }
    if (current?.kind === 'handle' && file.resource.kind === 'handle'
      && await current.handle.isSameEntry(file.resource.handle)) {
      select(tab.id)
      return
    }
  }
  attach(file.name, file.text, file.resource)
}

function select(id: string) {
  if (modalOpen.value || inputBusy()) return
  editors.get(activeId.value)?.flush()
  activeId.value = id
  remember()
}

function change(tab: DocumentTab, text: string) {
  updateDocument(tab, text)
  remember()
}

function setMode(mode: DocumentTab['mode']) {
  if (!active.value || modalOpen.value || inputBusy()) return
  editors.get(activeId.value)?.flush()
  active.value.mode = mode
  remember()
}

async function open() {
  if (modalOpen.value || inputBusy()) return
  for (const file of await openFiles()) await addFile(file)
}

function inputBusy() {
  return editors.get(activeId.value)?.isInputBusy() ?? false
}

async function save(tab = active.value, copy = false, fromCloseDialog = false) {
  if (!tab || tab.saving || fileBusy.value || (modalOpen.value && !fromCloseDialog) || inputBusy()) return
  const resource = tab.resource
  if (!copy && resource?.kind === 'root'
    && roots.value.find(item => item.id === resource.root)?.mode === 'read_only') {
    throw new Error('此文件所在位置为只读，请使用另存为。')
  }
  editors.get(tab.id)?.flush()
  const snapshot = documentController.captureSave(tab)
  tab.saving = true
  try {
    const saved = await filePort.save(snapshot, copy)
    documentController.acknowledgeSave(tab, snapshot, markRaw(saved.resource), saved.name)
    status.value = `已保存 ${tab.name}`
    await persist()
    await refreshFolder()
  } finally { tab.saving = false }
}

function newNote() {
  requestFileAction('note')
}

function requestFileAction(action: FileAction, entry?: FileEntry) {
  if (!writableRoot.value || fileBusy.value || modalOpen.value || inputBusy()) return
  editors.get(activeId.value)?.flush()
  fileDialog.value = { action, root: root.value, folder: folder.value, entry }
  fileName.value = entry?.name ?? (action === 'note' ? '未命名.md' : '新建文件夹')
  fileError.value = ''
  void nextTick(() => {
    const input = document.querySelector<HTMLInputElement>('#file-name')
    if (input) { input.focus(); input.select() }
    else document.querySelector<HTMLButtonElement>('#cancel-file-action')?.focus()
  })
}

function cancelFileAction() {
  if (!fileBusy.value) fileDialog.value = null
}

function fileDialogKey(event: KeyboardEvent) {
  if (event.key === 'Escape') { event.preventDefault(); cancelFileAction() }
  trapDialogFocus(event)
}

function trapDialogFocus(event: KeyboardEvent) {
  if (event.key !== 'Tab') return
  const controls = Array.from((event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('input:not(:disabled), button:not(:disabled)'))
  if (!controls.length) { event.preventDefault(); return }
  const next = event.shiftKey ? controls.at(-1) : controls[0]
  if (!controls.includes(document.activeElement as HTMLElement)
    || document.activeElement === (event.shiftKey ? controls[0] : controls.at(-1))) {
    event.preventDefault()
    next?.focus()
  }
}

function affectedDocuments(targetRoot: string, path: string) {
  const affected = tabs.filter(tab => containsResource(tab.resource, targetRoot, path))
  for (const tab of affected) editors.get(tab.id)?.flush()
  if (affected.some(tab => tab.saving || isDirty(tab))) {
    throw new Error('请先保存或关闭此文件（或文件夹内文档）的未保存修改，再重试。')
  }
  return affected
}

async function submitFileAction() {
  const dialog = fileDialog.value
  if (!dialog || fileBusy.value) return
  fileBusy.value = true
  document.querySelector<HTMLElement>('#file-dialog')?.focus()
  fileError.value = ''
  try {
    if (roots.value.find(item => item.id === dialog.root)?.mode !== 'writable') {
      throw new Error('此位置为只读或不可用，无法修改文件。')
    }
    const from = dialog.entry ? entryPath(dialog.folder, dialog.entry.name) : ''
    let name = fileName.value.trim()
    let path = dialog.action === 'delete' ? from : entryPath(dialog.folder, name)
    if (dialog.action === 'note' && !/\.(md|markdown|txt)$/i.test(name)) {
      name += '.md'
      path += '.md'
    }
    if (dialog.action === 'rename' && path === from) { fileDialog.value = null; return }
    if (dialog.action === 'rename' || dialog.action === 'folder') {
      await requireAvailablePath(dialog.root, path)
    }
    if (dialog.action === 'note') {
      const file = await createNote(dialog.root, path)
      fileDialog.value = null
      await addFile(file)
    } else if (dialog.action === 'folder') {
      await fs.mkdir(dialog.root, path)
      fileDialog.value = null
    } else {
      const affected = affectedDocuments(dialog.root, from)
      if (dialog.action === 'rename') {
        await fs.rename(dialog.root, from, path)
        for (const tab of affected) {
          tab.resource = markRaw(renamedResource(tab.resource!, dialog.root, from, path))
          if (tab.resource.kind === 'root') tab.name = tab.resource.path.split('/').at(-1)!
        }
        fileDialog.value = null
        remember()
        await refreshFolder()
        // A rename may change the version; only accept it for the same saved contents.
        for (const tab of affected) {
          const latest = await readResource(tab.resource!)
          if (latest.text !== tab.savedText) throw new Error(`${tab.name} 已在外部修改，请重新打开后再保存。`)
          tab.resource = markRaw(latest.resource)
        }
      } else {
        await fs.delete(dialog.root, from)
        fileDialog.value = null
        for (const tab of affected) removeTab(tab.id)
      }
    }
    status.value = `${fileTitleFor(dialog.action)} ${name}`
    await persist()
    await refreshFolder()
  } catch (reason) {
    if (fileDialog.value) fileError.value = reason instanceof Error ? reason.message : String(reason)
    else report(reason)
  } finally { fileBusy.value = false }
}

function fileTitleFor(action: FileAction) {
  return { note: '已创建', folder: '已创建', rename: '已重命名为', delete: '已删除' }[action]
}

async function refreshFolder() {
  const targetRoot = root.value
  const targetFolder = folder.value
  entries.value = []
  truncated.value = false
  const listing = await fs.list(targetRoot, targetFolder, false)
  if (root.value !== targetRoot || folder.value !== targetFolder) return
  entries.value = listing.entries.filter(item => item.kind === 'directory' || (item.kind === 'file' && /\.(md|markdown|txt)$/i.test(item.name)))
    .sort((a, b) => Number(b.kind === 'directory') - Number(a.kind === 'directory') || a.name.localeCompare(b.name))
  truncated.value = listing.truncated
}

async function enter(entry: FileEntry) {
  if (modalOpen.value || inputBusy()) return
  const path = entryPath(folder.value, entry.name)
  if (entry.kind === 'directory') {
    folder.value = path
    await refreshFolder()
  } else await addFile(await readResource({ kind: 'root', root: root.value, path }))
}

async function pickFolder() {
  if (modalOpen.value || inputBusy()) return
  const picker = window as unknown as Window & { showDirectoryPicker(options: { mode: string }): Promise<FileSystemDirectoryHandle> }
  const handle = await picker.showDirectoryPicker({ mode: 'readwrite' })
  roots.value = await fs.roots()
  const picked = roots.value.find(item => item.source === 'granted' && item.label === handle.name)
  if (!picked) throw new Error('已选择的文件夹未出现在系统授权列表中')
  registerDirectory(picked.id, handle)
  root.value = picked.id
  folder.value = ''
  await refreshFolder()
  status.value = `已打开 ${handle.name}`
}

function removeTab(id: string) {
  const index = tabs.findIndex(tab => tab.id === id)
  tabs.splice(index, 1)
  editors.delete(id)
  delete outlines[id]
  if (!tabs.length) attach('未命名.md')
  else if (activeId.value === id) activeId.value = tabs[Math.min(index, tabs.length - 1)].id
  remember()
}

function requestClose(tab: DocumentTab) {
  if (modalOpen.value || inputBusy()) return
  editors.get(tab.id)?.flush()
  if (!isDirty(tab)) { removeTab(tab.id); return }
  closing.value = [tab]
  closeAction = () => removeTab(tab.id)
}

function finishClose() {
  if (closeBusy.value) return
  const action = closeAction
  closing.value = null
  closeAction = null
  action?.()
}

async function saveAndClose() {
  const documents = closing.value
  if (!documents || closeBusy.value) return
  closeBusy.value = true
  try {
    for (const tab of documents) await save(tab, false, true)
    if (documents.some(isDirty)) return
    closeBusy.value = false
    finishClose()
  } finally { closeBusy.value = false }
}

function cancelClose() {
  if (closeBusy.value) return
  closing.value = null
  closeAction = null
}

function closeDialogKey(event: KeyboardEvent) {
  if (event.key === 'Escape') { event.preventDefault(); cancelClose() }
  trapDialogFocus(event)
}

async function checkExternal() {
  const tab = active.value
  if (!tab?.resource || tab.saving || modalOpen.value || fileBusy.value || inputBusy()) return
  editors.get(tab.id)?.flush()
  const resource = tab.resource
  const latest = await readResource(resource)
  if (fileBusy.value || modalOpen.value || inputBusy() || tab.saving
    || active.value !== tab || tab.resource !== resource || !tabs.includes(tab)) return
  editors.get(tab.id)?.flush()
  if (latest.text === tab.savedText) return
  if (isDirty(tab)) {
    error.value = `${tab.name} 已在外部修改，本地编辑已保留；请另存为，或先复制内容后重新打开。`
    return
  }
  const index = tabs.indexOf(tab)
  const refreshed = createDocument(latest.name, latest.text, markRaw(latest.resource))
  refreshed.mode = tab.mode
  tabs.splice(index, 1, refreshed)
  activeId.value = refreshed.id
  editors.delete(tab.id)
  remember()
}

function find(backwards = false) {
  editors.get(activeId.value)?.find(search.value, backwards)
}

watch(dark, value => {
  document.documentElement.dataset.theme = value ? 'dark' : 'light'
  document.documentElement.style.colorScheme = value ? 'dark' : 'light'
  localStorage.setItem('theme', value ? 'dark' : 'light')
}, { immediate: true })
watch(() => [active.value?.name, active.value?.text, active.value?.savedText], () => {
  document.title = `${active.value && isDirty(active.value) ? '● ' : ''}${active.value?.name ?? 'MarkText'} — MarkText · Dopame`
})
watch(search, () => find())
watch(modalOpen, async (opened) => {
  if (opened) {
    modalReturnFocus = document.activeElement as HTMLElement | null
    await nextTick()
    if (closing.value) document.querySelector<HTMLButtonElement>('#cancel-close')?.focus()
  } else {
    await nextTick()
    if (modalReturnFocus?.isConnected) modalReturnFocus.focus()
    modalReturnFocus = null
  }
})

onMounted(async () => {
  try {
    const { text } = await fs.readText('private', '.marktext/session.json')
    const session = parseSession(text)
    for (const tab of session.tabs) tabs.push({ ...tab, saving: false })
    activeId.value = tabs.some(tab => tab.id === session.activeId) ? session.activeId : tabs[0]?.id ?? ''
    sessionWritable = true
    if (tabs.length) status.value = '已恢复上次会话；外部单文件请另存为以重新授权'
  } catch (reason) {
    if ((reason as { code?: string }).code === 'ENOENT') sessionWritable = true
    else report(reason)
  }
  if (!tabs.length) attach('未命名.md')
  try {
    roots.value = await fs.roots()
    if (!roots.value.some(item => item.id === root.value)) root.value = 'private'
    await refreshFolder()
  } catch (reason) { report(reason) }
  appWindow.on('request', request => {
    if (request.kind !== 'open-file') return
    void run(async () => {
      const handle = (request as { handle: FileSystemFileHandle }).handle
      const file = await handle.getFile()
      await addFile(await readResource({ kind: 'handle', handle, modifiedMs: file.lastModified, size: file.size }))
    })
  })
  appWindow.on('activate', () => void run(checkExternal))
  appWindow.on('beforeclose', () => {
    if (fileBusy.value || modalOpen.value || inputBusy()) return false
    for (const editor of editors.values()) editor.flush()
    const dirty = tabs.filter(isDirty)
    if (!dirty.length) { void persist(); return true }
    closing.value = dirty
    closeAction = () => { void persist().then(() => appWindow.close()) }
    return false
  })
  appWindow.setMenus([{ id: 'file', label: '文件', items: [
    { id: 'new', label: '新建', onSelect: () => { attach('未命名.md') } },
    { id: 'open', label: '打开…', onSelect: () => void run(open) },
    { id: 'save', label: '保存', onSelect: () => void run(() => save()) },
    { id: 'save-as', label: '另存为…', onSelect: () => void run(() => save(active.value, true)) },
  ] }])
  document.addEventListener('keydown', event => {
    if (modalOpen.value) {
      const action = shortcut(event)
      if (!action) return
      if (!(event.target as Element).closest('[role="dialog"]') || !['undo', 'redo'].includes(action)) {
        event.preventDefault()
        event.stopImmediatePropagation()
      }
      return
    }
    if (event.isComposing) return
    const action = shortcut(event)
    if (!action) return
    const inEditor = !!(event.target as Element).closest('.editor-panel')
    const editorAction = action === 'undo' || action === 'redo' || action.includes(':')
    if (editorAction && !inEditor) return
    if (action.includes(':') && active.value?.mode !== 'edit') return
    event.preventDefault()
    event.stopImmediatePropagation()
    const editor = editors.get(activeId.value)
    if (action === 'undo') editor?.undo()
    else if (action === 'redo') editor?.redo()
    else if (action.includes(':')) editor?.command(action)
    else if (action === 'source') setMode(active.value?.mode === 'source' ? 'edit' : 'source')
    else if (action === 'read') setMode(active.value?.mode === 'read' ? 'edit' : 'read')
    else if (action === 'save' || action === 'saveAs') void run(() => save(active.value, action === 'saveAs'))
    else if (action === 'open') void run(open)
    else if (action === 'new') attach('未命名.md')
    else if (action === 'close' && active.value) requestClose(active.value)
    else if (action === 'nextTab' || action === 'previousTab') {
      const index = tabs.findIndex(tab => tab.id === activeId.value)
      select(tabs[(index + (action === 'nextTab' ? 1 : tabs.length - 1)) % tabs.length].id)
    } else if (action === 'find') {
      searchOpen.value = true
      void nextTick(() => document.querySelector<HTMLInputElement>('#find-text')?.focus())
    }
  }, true)
})
</script>

<template>
  <main class="app-shell">
    <header class="toolbar" aria-label="文档工具栏" :inert="modalOpen">
      <strong class="brand">MarkText <span>Dopame</span></strong>
      <button @click="attach('未命名.md')" title="Ctrl+N">新建</button>
      <button @click="run(open)" title="Ctrl+O">打开</button>
      <button :disabled="active?.saving" @click="run(() => save())" title="Ctrl+S">保存</button>
      <button @click="run(() => save(active, true))">另存为</button>
      <span class="divider" />
      <button :disabled="active?.mode === 'read'" @mousedown.prevent @click="editors.get(activeId)?.undo()">撤销</button>
      <button :disabled="active?.mode === 'read'" @mousedown.prevent @click="editors.get(activeId)?.redo()">重做</button>
      <button @click="searchOpen = !searchOpen">查找替换</button>
      <span class="spacer" />
      <div class="modes" aria-label="编辑模式">
        <button :disabled="!active" :aria-pressed="active?.mode === 'edit'" @click="setMode('edit')">编辑</button>
        <button :disabled="!active" :aria-pressed="active?.mode === 'source'" @click="setMode('source')">源码</button>
        <button :disabled="!active" :aria-pressed="active?.mode === 'read'" @click="setMode('read')">阅读</button>
      </div>
      <button @click="dark = !dark" aria-label="切换主题">{{ dark ? '浅色' : '深色' }}</button>
    </header>
    <div v-if="error" role="alert" class="error-banner"><span>{{ error }}</span><button @click="error = ''">关闭提示</button></div>
    <section class="workspace" :inert="modalOpen">
      <aside class="sidebar" aria-label="文件与大纲">
        <div class="section-heading">文件 <button @click="run(pickFolder)">添加文件夹</button></div>
        <select v-if="roots.length" v-model="root" aria-label="文件位置" @change="folder = ''; run(refreshFolder)">
          <option v-for="item in roots" :key="item.id" :value="item.id">{{ item.id === 'private' ? '我的笔记' : item.label }}{{ item.mode === 'read_only' ? '（只读）' : item.mode === 'unavailable' ? '（不可用）' : '' }}</option>
        </select>
        <div class="folder-actions"><button :disabled="!writableRoot || fileBusy" @click="newNote">新建笔记</button><button :disabled="!writableRoot || fileBusy" @click="requestFileAction('folder')">新建文件夹</button><button @click="run(refreshFolder)">刷新</button></div>
        <button v-if="folder" class="parent-folder" @click="folder = folder.split('/').slice(0, -1).join('/'); run(refreshFolder)">← {{ folder }}</button>
        <nav class="files" aria-label="文件列表">
          <div v-for="entry in entries" :key="entry.name" class="file-entry">
            <button @click="run(() => enter(entry))"><span>{{ entry.kind === 'directory' ? '▸' : '≡' }}</span>{{ entry.name }}</button>
            <button :disabled="!writableRoot || fileBusy" :aria-label="`重命名 ${entry.name}`" @click="requestFileAction('rename', entry)">改名</button>
            <button :disabled="!writableRoot || fileBusy" :aria-label="`删除 ${entry.name}`" @click="requestFileAction('delete', entry)">删除</button>
          </div>
          <p v-if="!entries.length" class="hint">此处没有 Markdown 文件</p>
          <p v-if="truncated" class="hint">目录内容过多，列表已截断</p>
        </nav>
        <div class="section-heading outline-title">文档大纲</div>
        <nav class="outline" aria-label="文档大纲">
          <button v-for="(item, index) in headings" :key="index" :style="{ paddingLeft: `${12 + (item.lvl - 1) * 12}px` }" @click="editors.get(activeId)?.reveal(item.slug, index)">{{ item.content }}</button>
          <p v-if="!headings.length" class="hint">标题会显示在这里</p>
        </nav>
      </aside>
      <section class="documents">
        <nav class="tabs" role="tablist" aria-label="打开的文档">
          <div v-for="tab in tabs" :key="tab.id" class="tab" :class="{ selected: tab.id === activeId }">
            <button role="tab" :aria-selected="tab.id === activeId" @click="select(tab.id)">{{ isDirty(tab) ? '● ' : '' }}{{ tab.name }}</button>
            <button :aria-label="`关闭 ${tab.name}`" @click="requestClose(tab)">×</button>
          </div>
        </nav>
        <div v-if="searchOpen" class="search-bar" aria-label="查找替换">
          <input id="find-text" v-model="search" aria-label="查找文本" placeholder="查找" @keydown.enter="find()">
          <button @click="find(true)">上一个</button><button @click="find()">下一个</button>
          <input v-model="replacement" aria-label="替换文本" placeholder="替换为">
          <button :disabled="active?.mode === 'read'" @click="editors.get(activeId)?.replace(replacement, false)">替换</button>
          <button :disabled="active?.mode === 'read'" @click="editors.get(activeId)?.replace(replacement, true)">全部替换</button>
          <button @click="searchOpen = false; search = ''">收起</button>
        </div>
        <Editor v-for="tab in tabs" v-show="tab.id === activeId" :key="tab.id"
          :ref="view => { if (view) editors.set(tab.id, view as EditorView) }"
          :text="tab.text" :resource="tab.resource" :mode="tab.mode" :active="tab.id === activeId" :blocked="modalOpen"
          @change="text => change(tab, text)" @outline="items => outlines[tab.id] = items" />
      </section>
    </section>
    <footer role="status"><span>{{ status }}</span><span v-if="active">{{ active.saving ? '保存中…' : isDirty(active) ? '未保存' : '已保存' }} · {{ active.text.length }} 字符 · UTF-8{{ active.bom ? ' BOM' : '' }} · {{ active.eol === '\r\n' ? 'CRLF' : 'LF' }}</span></footer>
    <div v-if="fileDialog" class="dialog-backdrop" @keydown="fileDialogKey">
      <form id="file-dialog" tabindex="-1" role="dialog" aria-modal="true" aria-labelledby="file-title" aria-describedby="file-location" class="dialog" @submit.prevent="submitFileAction">
        <h2 id="file-title">{{ fileTitle }}</h2>
        <p id="file-location" class="hint">{{ roots.find(item => item.id === fileDialog?.root)?.label }} / {{ fileDialog.folder }}</p>
        <template v-if="fileDialog.action === 'delete'">
          <p>永久删除「{{ fileDialog.entry?.name }}」？此操作无法撤销。</p>
          <p v-if="fileDialog.entry?.kind === 'directory'" class="hint">只能删除空文件夹，不会删除文件夹内的内容。</p>
        </template>
        <template v-else>
          <label for="file-name">{{ fileDialog.action === 'folder' ? '文件夹名称' : '名称' }}</label>
          <input id="file-name" v-model="fileName" :disabled="fileBusy" autocomplete="off" required>
        </template>
        <p v-if="fileError" role="alert">{{ fileError }}</p>
        <div class="dialog-actions">
          <button id="cancel-file-action" type="button" :disabled="fileBusy" @click="cancelFileAction">取消</button>
          <button type="submit" class="primary" :disabled="fileBusy">{{ fileBusy ? '处理中…' : fileDialog.action === 'delete' ? '永久删除' : fileDialog.action === 'rename' ? '重命名' : '创建' }}</button>
        </div>
      </form>
    </div>
    <div v-if="closing" class="dialog-backdrop">
      <section id="close-dialog" tabindex="-1" role="dialog" aria-modal="true" aria-labelledby="close-title" class="dialog" @keydown="closeDialogKey">
        <h2 id="close-title">保存未完成的修改？</h2><p>{{ closing.map(tab => tab.name).join('、') }}</p>
        <p class="hint">草稿保存在应用中；原文件只在保存成功后更新。</p>
        <div class="dialog-actions"><button id="cancel-close" :disabled="closeBusy" @click="cancelClose">取消</button><button :disabled="closeBusy" @click="finishClose">不保存并关闭</button><button :disabled="closeBusy" class="primary" @click="run(saveAndClose)">{{ closeBusy ? '保存中…' : '保存并关闭' }}</button></div>
      </section>
    </div>
  </main>
</template>

<style scoped>
.file-entry { display: flex; align-items: center; }
.file-entry > button:first-child { flex: 1; min-width: 0; }
.file-entry > button:not(:first-child) { width: auto; padding: 6px 4px; font-size: 11px; flex-shrink: 0; }
.folder-actions > button { padding: 7px 5px; }
#file-name { display: block; width: 100%; margin-top: 8px; }
#file-location { overflow-wrap: anywhere; }
</style>
