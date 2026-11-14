import CodeMirror from 'codemirror'
import 'codemirror/lib/codemirror.css'
import 'codemirror/mode/gfm/gfm'

export function createSourceEditor(host: HTMLElement, save: () => void) {
  const editor = CodeMirror(host, {
    value: '',
    mode: 'gfm',
    lineNumbers: true,
    lineWrapping: true,
    tabSize: 2,
    indentUnit: 2,
    inputStyle: 'textarea',
    extraKeys: { 'Ctrl-S': save }
  })
  editor.getInputField().setAttribute('aria-label', 'Markdown 源码')
  return editor
}
