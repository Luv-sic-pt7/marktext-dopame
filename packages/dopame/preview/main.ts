import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from '../app/src/App.vue'
import { DocumentController } from '../app/src/document-controller'
import { FilePort } from '../app/src/file-port'
import { AgentError } from '../protocol'
import '../app/src/style.css'

const records = new Map<string, { text: string; version: string }>()
let revision = 0
const read = (root: string, path: string) => {
  const record = records.get(root + ':' + path)
  if (!record) throw { code: 'ENOENT' }
  const data = new TextEncoder().encode(record.text)
  return { ...record, data, size: data.length, modifiedMs: 0 }
}
const memory = {
  async roots() {
    return [
      { id: 'private', label: '模拟私有笔记', source: 'private', mode: 'writable', exists: true }
    ]
  },
  async list(root: string, path = '') {
    const prefix = root + ':' + path + '/'
    return {
      entries: [...records.keys()]
        .filter((key) => key.startsWith(prefix))
        .map((key) => ({ name: key.slice(prefix.length), kind: 'file' })),
      truncated: false
    }
  },
  async readText(root: string, path: string) {
    return read(root, path)
  },
  async stat(root: string, path: string) {
    return read(root, path)
  },
  async readBytes(root: string, path: string) {
    return read(root, path)
  },
  async writeFile(root: string, path: string, data: string | Uint8Array, options: any = {}) {
    const key = root + ':' + path,
      old = records.get(key)
    if (
      (options.ifVersion && old?.version !== options.ifVersion) ||
      (options.create === 'new' && old)
    )
      throw { code: 'ECONFLICT' }
    const text = typeof data === 'string' ? data : new TextDecoder().decode(data)
    const version = String(++revision)
    records.set(key, { text, version })
    return {
      name: path.split('/').at(-1),
      version,
      size: new TextEncoder().encode(text).length,
      modifiedMs: 0
    }
  }
} as unknown as FilePort['fs']
class PreviewFiles extends FilePort {
  async openFiles(): Promise<never> {
    throw new AgentError('PREVIEW_ONLY', '模拟预览不连接真实文件，请使用原生应用')
  }
  async saveAsResource(): Promise<never> {
    throw new AgentError('PREVIEW_ONLY', '模拟预览不导出到磁盘，请使用原生应用')
  }
  async chooseFolder(): Promise<never> {
    throw new AgentError('PREVIEW_ONLY', '模拟预览不连接真实文件夹')
  }
}
const controller = new DocumentController(new PreviewFiles(memory), {
  async request() {
    return {
      ok: false,
      error: { code: 'WORKER_UNAVAILABLE', message: '模拟预览没有协作服务', retryable: false }
    }
  }
})
await controller.ready
await controller.create(
  '编辑预览 · 模拟文档',
  '# 让文字与版本一起前进\n\n这里复用真实的 **Muya** 编辑器与源码模式，文件和协作连接使用明确标记的模拟端口。\n\n## 交接资料\n\n- 写作保留版本\n- 审阅提供建议\n- 确认后保存结果\n\n> 这是开发预览，真实验收使用 acdert。\n'
)
createApp(App, { controller }).use(createPinia()).mount('#app')
const style = document.createElement('style')
style.textContent =
  '#preview-notice{height:28px;display:flex;align-items:center;justify-content:center;background:#e6ede8;color:#304d3d;font:12px system-ui;padding:0 12px}#app{height:calc(100% - 28px)}'
document.head.append(style)
