import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
const root = import.meta.dir
const out = resolve(root, 'desktop/public/runtime')
await mkdir(out, { recursive: true })
const built = await Bun.build({
  entrypoints: [resolve(root, 'state-process.ts')],
  outdir: out,
  target: 'bun',
  format: 'esm',
  naming: 'state-process.js',
  minify: false
})
if (!built.success) {
  for (const log of built.logs) console.error(log)
  process.exit(1)
}
console.log('Built service state process (' + built.outputs[0].size + ' bytes)')
