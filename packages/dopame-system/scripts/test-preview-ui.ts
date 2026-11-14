import { execFileSync } from 'node:child_process'
import { copyFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const system = resolve(dirname(fileURLToPath(import.meta.url)), '..')
execFileSync('bun', ['scripts/build.ts', '--inputs-only'], { cwd: system, stdio: 'inherit' })
const preview = join(system, '.acde/inputs/collaboration')
await copyFile(join(system, 'test/preview-ui.e2e.ts'), join(preview, 'preview-ui.e2e.ts'))
execFileSync('acde', ['test', '--desktop', join(system, '.acde/inputs/desktop'), '--workers', '1'], {
  cwd: preview,
  env: { ...process.env, MARKTEXT_BUN: process.execPath },
  stdio: 'inherit',
})
