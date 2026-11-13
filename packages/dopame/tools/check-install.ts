import { mkdtemp, mkdir, readdir, lstat, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { evidenceRoot, toolEnv } from './prepare-native'

const release = resolve(process.argv[2] ?? '')
if (!process.argv[2]) throw new Error('Pass a built release directory')
const state = await mkdtemp(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'mti-'))
const env = {
  ...toolEnv,
  XDG_DATA_HOME: join(state, 'data'),
  XDG_CONFIG_HOME: join(state, 'config'),
  XDG_STATE_HOME: join(state, 'state'),
  XDG_CACHE_HOME: join(state, 'cache'),
  XDG_RUNTIME_DIR: join(state, 'run')
}
let installed: { name: string; symlink: boolean }[] = []
try {
  for (const name of ['data', 'config', 'state', 'cache', 'run'])
    await mkdir(join(state, name), { mode: 0o700 })
  const command = async (name: string) => {
    const child = Bun.spawn(['sh', join(release, 'scripts', name)], {
      cwd: release,
      env,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe'
    })
    const [out, error, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited
    ])
    if (code) throw new Error(name + ' failed: ' + (out + error).slice(-3000))
    console.log(out.trim())
  }
  await command('install.sh')
  const packages = join(state, 'data/acde/packages')
  for (const name of await readdir(packages))
    installed.push({ name, symlink: (await lstat(join(packages, name))).isSymbolicLink() })
  if (installed.length !== 2) throw new Error('Expected exactly the two project packages')
  await command('uninstall.sh')
  if ((await readdir(packages)).length) throw new Error('Project installation links remain')
  await writeFile(
    join(evidenceRoot, 'installation-check.json'),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        environment: 'local acde 0.0.9',
        isolatedXdg: true,
        userInstallationModified: false,
        release,
        installed,
        uninstalled: true,
        passed: true
      },
      null,
      2
    )
  )
  console.log('Isolated installation/uninstallation passed')
} finally {
  await rm(state, { recursive: true, force: true })
}
