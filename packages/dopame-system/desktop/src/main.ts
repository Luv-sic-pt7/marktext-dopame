import { apps } from 'acde:apps'
import { marktextdocs } from 'acde:marktextdocs'

function element<T extends HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector)
  if (!found) throw new Error('The development desktop entry is incomplete.')
  return found
}

async function refresh() {
  const status = element('#service-status')
  try {
    const result = await marktextdocs.status()
    status.textContent = result.available
      ? '文档状态进程已连接；当前仅提供提案辅助预览，人工批准未接通。'
      : `协作服务不可用：${result.reason ?? '请检查部署运行时。'}`
  } catch {
    status.textContent = '协作服务不可用；单机编辑版仍可独立使用。'
  }
}

element<HTMLButtonElement>('#refresh').onclick = () => { void refresh() }
element<HTMLButtonElement>('#open').onclick = async() => {
  const error = element('#open-error')
  try {
    await apps.open('marktext-dopame')
    error.hidden = true
  } catch {
    error.hidden = false
    error.textContent = '当前桌面未加载 MarkText 协作应用；请按 README 同时启动生成的协作应用与开发桌面。'
  }
}
void refresh()
