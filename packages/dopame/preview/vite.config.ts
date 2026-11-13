import base from '../app/vite.config.ts'
import { fileURLToPath } from 'node:url'
export default {
  ...base,
  root: fileURLToPath(new URL('.', import.meta.url)),
  resolve: {
    alias: {
      'acde:window': fileURLToPath(new URL('./native-stub.ts', import.meta.url)),
      vue: fileURLToPath(
        new URL('../app/node_modules/vue/dist/vue.esm-bundler.js', import.meta.url)
      ),
      pinia: fileURLToPath(new URL('../app/node_modules/pinia/dist/pinia.js', import.meta.url))
    }
  },
  server: { host: '127.0.0.1', port: 5198 },
  preview: { host: '127.0.0.1', port: 5198 },
  build: { ...base.build, outDir: '.preview-dist' }
}
