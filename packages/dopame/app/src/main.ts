import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { fs } from 'acde:fs'
import { window as nativeWindow } from 'acde:window'
import * as services from 'acde:marktext-agent'
import { FilePort } from './file-port'
import { DocumentController } from './document-controller'
import App from './App.vue'
import './style.css'

const transport = (services as any)['marktext-agent']
const controller = new DocumentController(new FilePort(fs), transport)
nativeWindow.on('request', async (request: any) => {
  try {
    if (request.kind === 'agent-wake' && typeof request.workerToken === 'string')
      await controller.connectWorker(request.workerToken)
    if (request.kind === 'open-file' && request.handle?.kind === 'file')
      await controller.import(await controller.files.readHandle(request.handle))
  } catch (error) {
    controller.error(error)
  }
})
createApp(App, { controller, nativeSelection: true }).use(createPinia()).mount('#app')
