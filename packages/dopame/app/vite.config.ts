import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import acde from '@dopame/acde-api/vite'
import { fileURLToPath } from 'node:url'

const nativeImages = {
  name: 'marktext-authorized-image-sources',
  enforce: 'pre' as const,
  transform(code: string, filename: string) {
    if (!filename.split('?')[0].replaceAll('\\', '/').endsWith('/@muyajs/core/src/utils/image.ts'))
      return
    const start = code.indexOf('export function getImageSrc(src: string) {'),
      end = code.indexOf('// CSS Images default object dimensions', start)
    if (start < 0 || end < start)
      throw new Error('Muya image resolver changed; review the authorized-root adapter')
    const platform = fileURLToPath(new URL('./src/image-platform.ts', import.meta.url))
    const bitmap = fileURLToPath(new URL('./src/bitmap-loader.ts', import.meta.url))
    const loadStart = code.indexOf('export async function loadImage('),
      loadEnd = code.indexOf('// Cross-origin headers', loadStart)
    if (loadStart < end || loadEnd < loadStart) throw new Error('Muya bitmap-loader source changed')
    return {
      code:
        'import {resolveImageSource as __marktextImageSource} from ' +
        JSON.stringify(platform) +
        ';\n' +
        'import {loadBitmap as __marktextLoadBitmap} from ' +
        JSON.stringify(bitmap) +
        ';\n' +
        code.slice(0, start) +
        'export function getImageSrc(src: string) { return __marktextImageSource(src); }\n\n' +
        code.slice(end, loadStart) +
        'export async function loadImage(url: string, detectContentType = false) { return __marktextLoadBitmap(url); }\n\n' +
        code.slice(loadEnd),
      map: null
    }
  }
}

const bundledPrism = {
  name: 'marktext-bundled-prism-languages',
  enforce: 'pre' as const,
  transform(code: string, filename: string) {
    if (
      !filename
        .split('?')[0]
        .replaceAll('\\', '/')
        .endsWith('/@muyajs/core/src/utils/prism/loadLanguage.ts')
    )
      return
    if (
      !code.includes('../../../node_modules/prismjs/components/prism-') ||
      (code.match(/await import\(/g) ?? []).length !== 1
    )
      throw new Error('Muya language-loader source changed; review the bundled-language adapter')
    const loaders =
      "const __marktextPrismLanguages=import.meta.glob(['/node_modules/prismjs/components/prism-*.js','!/node_modules/prismjs/components/*.min.js']);\n"
    return {
      code:
        loaders +
        code.replace(
          /await import\([\s\S]*?\)/,
          "await __marktextPrismLanguages['/node_modules/prismjs/components/prism-'+lang+'.js']()"
        ),
      map: null
    }
  }
}
export default defineConfig({
  plugins: [nativeImages, bundledPrism, vue(), acde()],
  oxc: { decorator: { legacy: true } },
  build: {
    target: 'es2022',
    sourcemap: false,
    rolldownOptions: { transform: { decorator: { legacy: true } } }
  },
  server: { host: '127.0.0.1' }
})
