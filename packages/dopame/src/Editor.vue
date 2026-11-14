<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Muya, zhCN, InlineFormatToolbar, ParagraphFrontButton, ParagraphFrontMenu,
  ParagraphQuickInsertMenu, TableChessboard, TableColumnToolbar, TableDragBar,
  TableRowColumMenu, CodeBlockLanguageSelector, LinkTools } from '@muyajs/core'
import CodeMirror from 'codemirror'
import 'codemirror/lib/codemirror.css'
import 'codemirror/mode/gfm/gfm'
import 'codemirror/addon/search/searchcursor'
import { shortcutHint } from './shortcuts'
import { editorText, outline } from './document'
import { loadDocumentImage, type Resource } from './files'
import { attachNativeSelection } from './nativeSelection'

const props = defineProps<{ text: string; resource: Resource | null; mode: 'edit' | 'source' | 'read'; active: boolean; blocked?: boolean }>()
const emit = defineEmits<{ change: [text: string]; outline: [items: { lvl: number; content: string; slug: string }[]] }>()
const richHost = ref<HTMLElement>()
const sourceHost = ref<HTMLElement>()
let muya: Muya
let source: CodeMirror.Editor
let syncing = false
let richText = ''
let sourceText = ''
let searchText = ''
let composing = false
let detachSelection: (() => void) | undefined

function isInputBusy() {
  return composing
}

function compositionStart() {
  composing = true
}

function compositionEnd() {
  composing = false
}

function protectInput(event: Event) {
  if (!props.blocked) return
  event.preventDefault()
  event.stopImmediatePropagation()
}

function syncReadOnly() {
  if (!muya || !source) return
  muya.setReadOnly(props.mode === 'read' || !!props.blocked)
  source.setOption('readOnly', props.blocked ? 'nocursor' : false)
}

for (const plugin of [InlineFormatToolbar, ParagraphFrontButton, ParagraphFrontMenu,
  ParagraphQuickInsertMenu, TableChessboard, TableColumnToolbar, TableDragBar,
  TableRowColumMenu, CodeBlockLanguageSelector, LinkTools]) {
  if (!Muya.plugins.some(item => item.plugin === plugin)) Muya.use(plugin, { keyboardShortcuts: false, getShortcut: shortcutHint })
}

function publish() {
  if (syncing) return
  const text = props.mode === 'source' ? source.getValue() : muya.getMarkdown()
  if (props.mode === 'source') sourceText = text
  else richText = text
  emit('change', text)
  emit('outline', muya.getTOC())
}

async function syncMode() {
  if (!muya) return
  syncing = true
  const text = editorText(props.text)
  if (props.mode === 'source') {
    if (sourceText !== text) {
      source.operation(() => source.replaceRange(text, { line: 0, ch: 0 },
        { line: source.lastLine(), ch: source.getLine(source.lastLine()).length }, '+mode'))
      sourceText = text
    }
  } else {
    muya.setReadOnly(false)
    if (richText !== text) {
      muya.replaceContent(text)
      richText = text
    }
    muya.setReadOnly(props.mode === 'read' || !!props.blocked)
    muya.domNode.setAttribute('aria-label', props.mode === 'read' ? 'Markdown 阅读预览' : 'Markdown 编辑器')
    emit('outline', muya.getTOC())
  }
  syncing = false
  await nextTick()
  syncReadOnly()
  if (props.mode === 'source') { source.refresh(); if (props.active && !props.blocked) source.focus() }
}

function flush() {
  if (muya && props.mode === 'edit') muya.flush()
}

function undo() {
  if (props.blocked || isInputBusy()) return
  if (props.mode === 'source') { source.undo(); source.focus() }
  else if (props.mode === 'edit') { muya.flush(); muya.undo(); muya.focus() }
}

function redo() {
  if (props.blocked || isInputBusy()) return
  if (props.mode === 'source') { source.redo(); source.focus() }
  else if (props.mode === 'edit') { muya.redo(); muya.focus() }
}

function command(action: string) {
  if (props.mode !== 'edit' || props.blocked || isInputBusy()) return
  muya.flush()
  if (action.startsWith('format:')) muya.format(action.slice(7))
  else if (action.startsWith('paragraph:')) muya.updateParagraph(action.slice(10))
  muya.focus()
  const selection = muya.getSelectionState()
  const node = document.getSelection()?.focusNode
  const element = node?.nodeType === Node.ELEMENT_NODE ? node as Element : node?.parentElement
  element?.closest<HTMLElement>('[contenteditable="true"]')?.focus({ preventScroll: true })
  if (selection) muya.setSelection(selection)
}

function find(text: string, backwards = false) {
  if (props.blocked) return
  searchText = text
  if (props.mode !== 'source') {
    muya.search(text, { isRegexp: false })
    if (text) muya.find(backwards ? 'previous' : 'next')
    return
  }
  if (!text) return
  let cursor = source.getSearchCursor(text, source.getCursor(backwards ? 'from' : 'to'))
  if (!cursor.find(backwards)) {
    cursor = source.getSearchCursor(text, backwards
      ? { line: source.lastLine(), ch: source.getLine(source.lastLine()).length }
      : { line: 0, ch: 0 })
    if (!cursor.find(backwards)) return
  }
  source.setSelection(cursor.from(), cursor.to())
  source.scrollIntoView({ from: cursor.from(), to: cursor.to() })
}

function replace(text: string, all: boolean) {
  if (!searchText || props.mode === 'read' || props.blocked || isInputBusy()) return
  if (props.mode !== 'source') {
    muya.replace(text, { isSingle: !all, isRegexp: false })
    return
  }
  source.operation(() => {
    if (all) {
      const cursor = source.getSearchCursor(searchText, { line: 0, ch: 0 })
      while (cursor.findNext()) cursor.replace(text)
    } else if (source.getSelection() === searchText) source.replaceSelection(text)
  })
}

function reveal(slug: string, index: number) {
  if (props.blocked) return
  if (props.mode === 'source') {
    const heading = outline(source.getValue())[index]
    if (!heading) return
    source.focus()
    source.setCursor({ line: heading.line, ch: 0 })
    source.scrollIntoView(source.getCursor(), 80)
  } else {
    const heading = Array.from(richHost.value!.querySelectorAll('[id]')).find(node => node.id === slug)
    heading?.scrollIntoView({ block: 'center' })
  }
}

onMounted(() => {
  richText = sourceText = editorText(props.text)
  const container = document.createElement('div')
  richHost.value!.appendChild(container)
  muya = new Muya(container, { markdown: richText, fontSize: 17, lineHeight: 1.75,
    loadImage: src => loadDocumentImage(props.resource, src),
    spellcheckEnabled: false, disableHtml: true, autoPairMarkdownSyntax: true })
  muya.locale(zhCN)
  muya.init({ focus: false })
  detachSelection = attachNativeSelection(muya)
  muya.domNode.setAttribute('aria-label', 'Markdown 编辑器')
  source = CodeMirror(sourceHost.value!, { value: sourceText, mode: 'gfm', lineNumbers: true,
    lineWrapping: true, tabSize: 2, indentUnit: 2, inputStyle: 'textarea',
    extraKeys: { 'Ctrl-S': () => {}, 'Cmd-S': () => {} } })
  source.getInputField().setAttribute('aria-label', 'Markdown 源码')
  muya.on('json-change', publish)
  source.on('change', publish)
  emit('outline', muya.getTOC())
  void syncMode()
})
watch(() => props.mode, syncMode)
watch(() => props.blocked, syncReadOnly, { flush: 'sync' })
watch(() => props.resource, () => muya?.invalidateImageCache())
watch(() => props.active, async active => {
  if (!active) return
  await nextTick()
  if (props.mode === 'source') { source.refresh(); if (props.active && !props.blocked) source.focus() }
})
onBeforeUnmount(() => { detachSelection?.(); muya?.destroy() })
defineExpose({ flush, undo, redo, command, find, replace, reveal, isInputBusy })
</script>

<template>
  <section class="editor-panel" :aria-busy="blocked || undefined"
    @compositionstart.capture="compositionStart" @compositionend.capture="compositionEnd"
    @beforeinput.capture="protectInput"
    @paste.capture="protectInput" @cut.capture="protectInput" @drop.capture="protectInput">
    <div v-show="mode !== 'source'" ref="richHost" class="rich-editor" />
    <div v-show="mode === 'source'" ref="sourceHost" class="source-editor" />
  </section>
</template>
