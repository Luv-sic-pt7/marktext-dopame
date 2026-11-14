<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import CommandMenu from './CommandMenu.vue'

interface Note {
  id: string
  title: string
  dirty: boolean
  open: boolean
  detail: string
  trashed?: boolean
  trashPending?: boolean
}

const props = defineProps<{ notes: Note[]; activeId: string; disabled?: boolean }>()
const emit = defineEmits<{
  activate: [id: string]
  create: []
  rename: [id: string, title: string]
  duplicate: [id: string]
  close: [id: string]
  trash: [id: string]
  restore: [id: string]
}>()

const root = ref<HTMLElement | null>(null)
const collapsed = ref(false)
const filtering = ref(false)
const query = ref('')
const scope = ref<'all' | 'open' | 'trash'>('all')
const renameId = ref('')
const renameDraft = ref('')

const visibleNotes = computed(() => {
  const term = query.value.trim().toLocaleLowerCase()
  return props.notes.filter(
    (note) =>
      (scope.value === 'trash'
        ? note.trashed
        : !note.trashed && (scope.value === 'all' || note.open)) &&
      (!term || `${note.title} ${note.detail}`.toLocaleLowerCase().includes(term))
  )
})
const duplicateTitles = computed(() => {
  const counts = new Map<string, number>()
  for (const note of visibleNotes.value) counts.set(note.title, (counts.get(note.title) ?? 0) + 1)
  return new Set([...counts].filter(([, count]) => count > 1).map(([title]) => title))
})

async function toggleFilter() {
  filtering.value = !filtering.value
  if (!filtering.value) {
    query.value = ''
    return
  }
  collapsed.value = false
  await nextTick()
  root.value?.querySelector<HTMLInputElement>('.note-filter-input')?.focus()
}

function setScope(value: 'all' | 'open' | 'trash') {
  scope.value = value
}
function toggleCollapsed() {
  collapsed.value = !collapsed.value
}
function closeFilter() {
  query.value = ''
  filtering.value = false
  root.value?.querySelector<HTMLButtonElement>('[aria-label="筛选笔记"]')?.focus()
}

async function startRename(note: Note) {
  renameId.value = note.id
  renameDraft.value = note.title
  await nextTick()
  const input = root.value?.querySelector<HTMLInputElement>('.note-rename')
  input?.focus()
  input?.select()
}

async function finishRename(save: boolean, restoreFocus = false) {
  const id = renameId.value
  if (!id) return
  const title = renameDraft.value.trim()
  renameId.value = ''
  if (save && title) emit('rename', id, title)
  if (restoreFocus) {
    await nextTick()
    const row = [...(root.value?.querySelectorAll<HTMLElement>('[data-note-id]') ?? [])].find(
      (entry) => entry.dataset.noteId === id
    )
    row?.querySelector<HTMLButtonElement>('.note-open')?.focus()
  }
}

const commonItems = [
  { id: 'rename', label: '重命名' },
  { id: 'duplicate', label: '创建副本' }
]
const trashItem = { id: 'trash', label: '移入回收站', separator: true }
const noteItems = [...commonItems, trashItem]
const openNoteItems = [...commonItems, { id: 'close', label: '关闭标签' }, trashItem]
const trashedItems = [
  { id: 'restore', label: '恢复' },
  { id: 'duplicate', label: '创建副本' }
]

function menuAction(action: string, note: Note) {
  if (action === 'rename') void startRename(note)
  else if (action === 'duplicate') emit('duplicate', note.id)
  else if (action === 'close') emit('close', note.id)
  else if (action === 'trash') emit('trash', note.id)
  else if (action === 'restore') emit('restore', note.id)
}
</script>

<template>
  <section ref="root" class="note-navigator" aria-label="笔记列表">
    <div class="note-section-heading">
      <button
        class="note-section-toggle"
        aria-label="私有笔记"
        :aria-expanded="!collapsed"
        @click="toggleCollapsed"
      >
        <svg
          class="note-chevron"
          :class="{ collapsed }"
          width="12"
          height="12"
          viewBox="0 0 16 16"
          aria-hidden="true"
        >
          <path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" />
        </svg>
        <span>私有笔记</span>
        <span class="note-count num">{{ visibleNotes.length }}</span>
      </button>
      <button
        class="note-header-action"
        aria-label="筛选笔记"
        title="筛选笔记"
        :aria-pressed="filtering"
        @click="toggleFilter"
      >
        <svg width="15" height="15" viewBox="0 0 20 20" aria-hidden="true">
          <circle cx="8" cy="8" r="4.75" fill="none" stroke="currentColor" stroke-width="1.5" />
          <path d="m11.5 11.5 4.75 4.75" fill="none" stroke="currentColor" stroke-width="1.5" />
        </svg>
      </button>
      <button
        class="note-header-action"
        aria-label="新建笔记"
        title="新建笔记"
        :disabled="disabled"
        @click="emit('create')"
      >
        <svg width="15" height="15" viewBox="0 0 20 20" aria-hidden="true">
          <path d="M10 3v14M3 10h14" fill="none" stroke="currentColor" stroke-width="1.5" />
        </svg>
      </button>
    </div>
    <div v-show="!collapsed" class="note-section-content">
      <div v-if="filtering" class="note-filter">
        <input
          v-model="query"
          class="note-filter-input"
          aria-label="筛选私有笔记"
          placeholder="查找笔记…"
          @keydown.esc.prevent.stop="closeFilter"
        />
      </div>
      <div class="note-scopes" aria-label="笔记范围">
        <button :aria-pressed="scope === 'all'" @click="setScope('all')">全部</button>
        <button :aria-pressed="scope === 'open'" @click="setScope('open')">已打开</button>
        <button :aria-pressed="scope === 'trash'" @click="setScope('trash')">回收站</button>
      </div>
      <div class="note-list" role="list">
        <div
          v-for="note in visibleNotes"
          :key="note.id"
          class="note-entry"
          :class="{ selected: note.id === activeId }"
          role="listitem"
          :aria-label="note.title"
          :aria-description="note.trashPending ? '协作待同步' : undefined"
          :data-note-id="note.id"
          @click="note.trashed ? undefined : emit('activate', note.id)"
        >
          <input
            v-if="renameId === note.id"
            v-model="renameDraft"
            class="note-rename"
            aria-label="重命名笔记"
            maxlength="800"
            @click.stop
            @blur="finishRename(true)"
            @keydown.enter.prevent.stop="finishRename(true, true)"
            @keydown.esc.prevent.stop="finishRename(false, true)"
          />
          <button
            v-else
            class="note-open"
            :aria-label="note.title"
            :aria-current="note.id === activeId ? 'true' : undefined"
            :disabled="note.trashed"
            :title="`${note.title} · ${note.detail}`"
            @click.stop="note.trashed ? undefined : emit('activate', note.id)"
          >
            <span
              class="note-status"
              :class="{ dirty: note.dirty }"
              :aria-label="note.dirty ? '未保存' : undefined"
            >
              <span v-if="note.dirty" aria-hidden="true">●</span>
            </span>
            <span class="note-label">
              <span class="note-title">{{ note.title }}</span>
              <small v-if="duplicateTitles.has(note.title)" class="note-detail">{{
                note.detail
              }}</small>
              <small v-if="note.trashPending" class="note-detail">协作待同步</small>
            </span>
          </button>
          <CommandMenu
            v-if="renameId !== note.id"
            class="note-more"
            :label="'笔记操作 ' + note.title"
            :items="note.trashed ? trashedItems : note.open ? openNoteItems : noteItems"
            :disabled="disabled"
            icon
            @click.stop
            @select="(action) => menuAction(action, note)"
          >
            <svg width="15" height="15" viewBox="0 0 20 20" aria-hidden="true">
              <circle cx="4" cy="10" r="1.3" fill="currentColor" />
              <circle cx="10" cy="10" r="1.3" fill="currentColor" />
              <circle cx="16" cy="10" r="1.3" fill="currentColor" />
            </svg>
          </CommandMenu>
        </div>
      </div>
      <p v-if="!visibleNotes.length" class="note-empty">
        {{
          query.trim()
            ? '没有匹配的笔记'
            : scope === 'trash'
              ? '回收站为空'
              : scope === 'open'
                ? '没有打开的笔记'
                : '还没有笔记'
        }}
      </p>
    </div>
  </section>
</template>

<style scoped>
.note-navigator {
  min-width: 0;
  margin-bottom: 4px;
}
.note-section-heading {
  display: flex;
  align-items: center;
  min-height: 30px;
  gap: 1px;
  color: var(--muted);
}
.note-section-toggle {
  display: flex;
  flex: 1;
  min-width: 0;
  align-items: center;
  gap: 5px;
  padding: 3px 3px;
  text-align: left;
  font-size: 12px;
  font-weight: 500;
}
.note-section-toggle:hover {
  background: transparent;
  color: var(--text);
}
.note-chevron {
  flex-shrink: 0;
}
.note-chevron.collapsed {
  transform: rotate(-90deg);
}
.note-count {
  margin-left: auto;
  font-size: 11px;
}
.note-header-action {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  min-height: 26px;
  padding: 4px;
  border-radius: 4px;
}
.note-filter {
  margin: 4px 3px 5px;
}
.note-filter-input {
  width: 100%;
  padding: 4px 7px;
  min-height: 30px;
  font-size: 12px;
}
.note-scopes {
  display: flex;
  gap: 12px;
  padding: 0 7px 5px 19px;
}
.note-scopes button {
  min-height: 24px;
  padding: 1px 0;
  border-radius: 0;
  border-bottom: 1px solid transparent;
  font-size: 11px;
  color: var(--muted);
}
.note-scopes button:hover {
  background: transparent;
  color: var(--text);
}
.note-scopes button[aria-pressed='true'] {
  color: var(--text);
  border-bottom-color: var(--muted);
}
.note-list {
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.note-entry {
  display: flex;
  position: relative;
  min-width: 0;
  align-items: center;
  border-radius: 4px;
}
.note-entry.selected {
  background: var(--active);
}
.note-entry:hover {
  background: var(--active);
}
.note-open {
  display: flex;
  flex: 1;
  gap: 7px;
  align-items: center;
  min-width: 0;
  min-height: 30px;
  padding: 4px 4px 4px 7px;
  text-align: left;
}
.note-open:disabled {
  opacity: 1;
}
.note-status {
  width: 5px;
  flex-shrink: 0;
  font-size: 7px;
  line-height: 1;
  color: var(--accent);
}
.note-label {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.note-title,
.note-detail {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.note-title {
  font-size: 12px;
}
.note-detail {
  font-size: 11px;
  color: var(--muted);
  line-height: 1.4;
}
.note-more {
  flex-shrink: 0;
  margin-right: 3px;
}
.note-more :deep(.command-trigger) {
  width: 24px;
  min-height: 24px;
  padding: 3px;
  color: var(--muted);
  opacity: 0;
  border-radius: 4px;
}
.note-entry:hover .note-more :deep(.command-trigger),
.note-entry:focus-within .note-more :deep(.command-trigger),
.note-more :deep(.command-trigger[aria-expanded='true']) {
  opacity: 1;
}
.note-rename {
  width: 100%;
  min-height: 28px;
  margin: 1px 4px;
  padding: 3px 6px;
  font-size: 12px;
}
.note-empty {
  padding: 4px 7px 8px 19px;
  margin: 0;
  color: var(--muted);
  font-size: 12px;
}
@media (hover: none) {
  .note-more :deep(.command-trigger) {
    opacity: 1;
  }
}
@media (max-width: 680px) {
  .note-open,
  .note-section-toggle,
  .note-header-action {
    min-height: 44px;
  }
  .note-title,
  .note-filter-input {
    font-size: 14px;
  }
  .note-more :deep(.command-trigger) {
    min-height: 36px;
    width: 32px;
    opacity: 1;
  }
}
</style>
