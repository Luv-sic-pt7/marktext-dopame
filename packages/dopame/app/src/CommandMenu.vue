<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
import { claimCommandMenu, releaseCommandMenu, type CommandMenuItem } from './command-menu'

const props = defineProps<{
  label: string
  items: CommandMenuItem[]
  disabled?: boolean
  icon?: boolean
}>()
const emit = defineEmits<{ select: [id: string] }>()
const trigger = ref<HTMLButtonElement | null>(null)
const menu = ref<HTMLElement | null>(null)
const opened = ref(false)
const activeIndex = ref(-1)
const position = ref({ left: 0, top: 0, maxHeight: 440 })
const menuId = useId()
const enabledIndexes = computed(() =>
  props.items.flatMap((item, index) => (item.disabled ? [] : [index]))
)

function positionMenu() {
  if (!opened.value || !trigger.value || !menu.value) return
  const anchor = trigger.value.getBoundingClientRect()
  const bounds = menu.value.getBoundingClientRect()
  const maxHeight = Math.min(440, window.innerHeight - 16)
  const height = Math.min(bounds.height, maxHeight)
  const below = anchor.bottom + 4
  const top = below + height <= window.innerHeight - 8 ? below : anchor.top - height - 4
  position.value = {
    left: Math.max(8, Math.min(anchor.left, window.innerWidth - bounds.width - 8)),
    top: Math.max(8, Math.min(top, window.innerHeight - height - 8)),
    maxHeight
  }
}

function close(restoreFocus = false) {
  opened.value = false
  activeIndex.value = -1
  releaseCommandMenu(dismiss)
  if (restoreFocus) trigger.value?.focus()
}
function dismiss() {
  close()
}
function focusItem(index: number) {
  activeIndex.value = index
  menu.value?.querySelector<HTMLButtonElement>(`[data-command-index="${index}"]`)?.focus()
}
async function open(fromKeyboard = false, last = false) {
  if (props.disabled) return
  claimCommandMenu(dismiss)
  opened.value = true
  await nextTick()
  positionMenu()
  if (fromKeyboard) {
    const indexes = enabledIndexes.value
    const index = last ? indexes.at(-1) : indexes[0]
    if (index === undefined) menu.value?.focus()
    else focusItem(index)
  }
}
function toggle(event: MouseEvent) {
  if (opened.value) close(true)
  else void open(event.detail === 0)
}
function select(index: number) {
  const item = props.items[index]
  if (item.disabled) return
  close(true)
  emit('select', item.id)
}
function triggerKey(event: KeyboardEvent) {
  if (event.altKey || event.ctrlKey || event.metaKey) return
  if (['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(event.key)) {
    event.preventDefault()
    event.stopPropagation()
    if (opened.value && (event.key === 'Enter' || event.key === ' ')) close(true)
    else void open(true, event.key === 'ArrowUp')
  }
}
function menuKey(event: KeyboardEvent) {
  if (!opened.value || event.isComposing) return
  if (event.key === 'Tab') {
    close(true)
    return
  }
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    close(true)
    return
  }
  if (event.target === trigger.value) return
  if (event.altKey || event.ctrlKey || event.metaKey) return
  const indexes = enabledIndexes.value
  let next: number | undefined
  if (event.key === 'Home') next = indexes[0]
  else if (event.key === 'End') next = indexes.at(-1)
  else if (event.key === 'ArrowDown') {
    const current = indexes.indexOf(activeIndex.value)
    next = indexes[(current + 1) % indexes.length]
  } else if (event.key === 'ArrowUp') {
    const current = indexes.indexOf(activeIndex.value)
    next = indexes[(current < 0 ? indexes.length : current) - 1]
    if (next === undefined) next = indexes.at(-1)
  } else if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    event.stopPropagation()
    if (activeIndex.value >= 0) select(activeIndex.value)
    return
  } else return
  event.preventDefault()
  event.stopPropagation()
  if (next !== undefined) focusItem(next)
}
function outside(event: MouseEvent) {
  const target = event.target as Node
  if (opened.value && !trigger.value?.contains(target) && !menu.value?.contains(target)) close()
}

watch(
  () => props.disabled,
  (disabled) => {
    if (disabled) close()
  }
)
onMounted(() => {
  document.addEventListener('mousedown', outside)
  document.addEventListener('keydown', menuKey, true)
  window.addEventListener('resize', positionMenu)
  window.addEventListener('scroll', positionMenu, true)
  window.addEventListener('blur', dismiss)
})
onBeforeUnmount(() => {
  releaseCommandMenu(dismiss)
  document.removeEventListener('mousedown', outside)
  document.removeEventListener('keydown', menuKey, true)
  window.removeEventListener('resize', positionMenu)
  window.removeEventListener('scroll', positionMenu, true)
  window.removeEventListener('blur', dismiss)
})
</script>

<template>
  <span class="command-menu">
    <button
      ref="trigger"
      type="button"
      class="command-trigger"
      :class="{ 'icon-trigger': icon }"
      :aria-label="label"
      aria-haspopup="menu"
      :aria-expanded="opened"
      :aria-controls="opened ? menuId : undefined"
      :disabled="disabled"
      @mousedown.prevent
      @click="toggle"
      @keydown="triggerKey"
    >
      <slot>{{ label }}</slot>
      <svg v-if="!icon" width="10" height="10" viewBox="0 0 12 12" aria-hidden="true">
        <path d="m3 4.5 3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.4" />
      </svg>
    </button>
    <Teleport to="body">
      <div
        v-if="opened"
        :id="menuId"
        ref="menu"
        class="command-popup"
        role="menu"
        :aria-label="label"
        tabindex="-1"
        :style="{
          left: position.left + 'px',
          top: position.top + 'px',
          maxHeight: position.maxHeight + 'px'
        }"
      >
        <template v-for="(item, index) in items" :key="item.id">
          <div v-if="item.separator" class="command-divider" role="separator"></div>
          <button
            type="button"
            class="command-item"
            :class="{ current: activeIndex === index }"
            :role="item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'"
            :aria-label="item.label"
            :aria-checked="item.checked"
            :disabled="item.disabled"
            :data-command-index="index"
            tabindex="-1"
            @mousedown.prevent
            @mouseenter="activeIndex = item.disabled ? -1 : index"
            @focus="activeIndex = index"
            @click.stop="select(index)"
          >
            <span class="command-check" aria-hidden="true">
              <svg v-if="item.checked" width="12" height="12" viewBox="0 0 16 16">
                <path d="m3 8 3 3 7-7" fill="none" stroke="currentColor" stroke-width="1.5" />
              </svg>
            </span>
            <span class="command-label">{{ item.label }}</span>
            <kbd v-if="item.shortcut" aria-hidden="true">{{ item.shortcut }}</kbd>
          </button>
        </template>
      </div>
    </Teleport>
  </span>
</template>

<style scoped>
.command-menu {
  display: inline-flex;
  flex: 0 0 auto;
  min-width: 0;
}
.command-trigger {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 30px;
  color: var(--text);
}
.command-trigger[aria-expanded='true'] {
  background: var(--active);
}
.command-trigger.icon-trigger {
  width: 32px;
  padding: 4px;
}
.command-popup {
  position: fixed;
  z-index: 1000;
  width: max-content;
  min-width: 190px;
  max-width: calc(100vw - 16px);
  overflow-y: auto;
  padding: 5px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--surface);
  color: var(--text);
  box-shadow: 0 5px 18px rgb(0 0 0 / 14%);
  font: 13px/1.4 var(--font);
  outline: none;
}
.command-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 32px;
  padding: 6px 8px;
  border-radius: 4px;
  color: var(--text);
  text-align: left;
  background: var(--surface);
}
.command-item.current:not(:disabled),
.command-item:hover:not(:disabled) {
  background: var(--active);
}
.command-item:focus-visible {
  outline: 1px solid var(--accent);
  outline-offset: -1px;
}
.command-item:disabled {
  color: var(--muted);
  background: var(--surface);
  opacity: 0.7;
}
.command-check {
  flex: 0 0 12px;
  width: 12px;
  color: var(--accent);
}
.command-label {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
}
.command-item kbd {
  margin-left: 18px;
  color: var(--muted);
  font: 11px/1.4 var(--font);
  white-space: nowrap;
}
.command-divider {
  margin: 5px 4px;
  height: 1px;
  background: var(--border);
}
@media (max-width: 640px) {
  .command-trigger {
    min-height: 36px;
  }
  .command-item {
    min-height: 40px;
  }
}
</style>
