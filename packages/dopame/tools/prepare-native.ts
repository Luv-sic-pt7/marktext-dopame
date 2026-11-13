import { cp, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve, join } from 'node:path'

export const portRoot = resolve(import.meta.dir, '..')
export const evidenceRoot =
  process.env.MARKTEXT_EVIDENCE ?? resolve(portRoot, '../../../work/marktext-mvp-evidence')
export const acdeBinary = process.env.ACDE_CLI ?? join(homedir(), '.acde/bin/acde')
export const toolEnv = {
  ...process.env,
  PATH:
    join(homedir(), '.bun/bin') +
    ':' +
    join(homedir(), '.acde/bin') +
    ':' +
    (process.env.PATH ?? '')
}
export async function command(binary: string, args: string[], cwd = portRoot) {
  const child = Bun.spawn([binary, ...args], {
    cwd,
    env: toolEnv,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit'
  })
  const exit = await child.exited
  if (exit !== 0) throw new Error(binary + ' exited with code ' + exit)
}
export async function prepareNative() {
  await mkdir(evidenceRoot, { recursive: true })
  await command(process.execPath, ['build-state.ts'])
  await command(acdeBinary, ['check'], join(portRoot, 'desktop'))
  await command(acdeBinary, ['build'], join(portRoot, 'desktop'))
  const destination = join(
    evidenceRoot,
    'staged-desktop-' + Date.now() + '-' + crypto.randomUUID().slice(0, 6)
  )
  await cp(join(portRoot, 'desktop/.acde'), destination, {
    recursive: true,
    errorOnExist: true,
    force: false
  })
  await Bun.write(
    join(destination, '.marktext-stage.json'),
    JSON.stringify({
      source: portRoot,
      createdAt: new Date().toISOString(),
      purpose: 'immutable desktop package for native verification'
    })
  )
  return destination
}
if (import.meta.main) console.log(await prepareNative())
