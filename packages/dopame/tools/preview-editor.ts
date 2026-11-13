import { symlink, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { portRoot } from './prepare-native'

const link = join(portRoot, 'preview/node_modules')
try {
  await lstat(link)
} catch (error: any) {
  if (error.code !== 'ENOENT') throw error
  await symlink(
    process.platform === 'win32' ? join(portRoot, 'app/node_modules') : '../app/node_modules',
    link,
    process.platform === 'win32' ? 'junction' : 'dir'
  )
}
const build = Bun.spawn(
  [
    process.execPath,
    join(portRoot, 'app/node_modules/vite/bin/vite.js'),
    'build',
    '--config',
    join(portRoot, 'preview/vite.config.ts'),
    '--logLevel',
    'warn'
  ],
  { cwd: portRoot, stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' }
)
if (await build.exited) throw new Error('Editor preview build failed')
const child = Bun.spawn(
  [
    process.execPath,
    join(portRoot, 'app/node_modules/vite/bin/vite.js'),
    'preview',
    '--config',
    join(portRoot, 'preview/vite.config.ts'),
    ...process.argv.slice(2)
  ],
  { cwd: portRoot, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' }
)
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal))
process.exitCode = await child.exited
