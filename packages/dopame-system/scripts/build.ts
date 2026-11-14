import { execFileSync } from 'node:child_process'
import { cp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { capabilitySchemas, protocolSchema } from '../src/protocol'
import { verifyPackages } from './verify-packages'

const system = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repository = resolve(system, '../..')
const editor = join(repository, 'packages/dopame')
const output = join(system, '.acde')
const inputs = join(output, 'inputs')

function run(command: string, args: string[], cwd = system) {
  execFileSync(command, args, { cwd, stdio: 'inherit' })
}

async function copyEditor(variant: 'standalone' | 'collaboration') {
  const destination = join(inputs, variant)
  await mkdir(destination, { recursive: true })
  const config = JSON.parse(await readFile(join(editor, 'acde.config.jsonc'), 'utf8'))
  if (variant === 'collaboration') {
    config.services = ['marktextdocs']
    config.requests = ['marktext-review']
    config.label = 'MarkText · 协作预览'
    config.capabilities = {}
    delete config.mimeTypes
  } else {
    delete config.services
    delete config.requests
  }
  config.multiple = false
  delete config.$schema
  await writeFile(join(destination, 'acde.config.jsonc'), JSON.stringify(config, null, 2) + '\n')
  let html = await readFile(join(editor, 'index.html'), 'utf8')
  if (variant === 'collaboration') {
    html = html.replace('/src/main.ts', '/collaboration.ts')
    await writeFile(join(destination, 'collaboration.ts'),
      "import { marktextdocs } from 'acde:marktextdocs'\nimport { mountCollaboration } from './src/collaboration/mount'\nmountCollaboration(marktextdocs)\n")
  }
  await writeFile(join(destination, 'index.html'), html)
  await cp(join(editor, 'package.json'), join(destination, 'package.json'))
  await cp(join(editor, 'vite.config.ts'), join(destination, 'vite.config.ts'))
  // Source symlinks retain workspace package resolution; only compiled JS enters the output package.
  await symlink(join(editor, 'src'), join(destination, 'src'), 'dir')
  await symlink(join(editor, 'node_modules'), join(destination, 'node_modules'), 'dir')
}

async function copyDesktop() {
  const destination = join(inputs, 'desktop')
  await cp(join(system, 'desktop'), destination, { recursive: true })
  const config = JSON.parse(await readFile(join(destination, 'acde.config.jsonc'), 'utf8'))
  config.services.marktextdocs = 'services/marktextdocs.ts'
  await writeFile(join(destination, 'acde.config.jsonc'), JSON.stringify(config, null, 2) + '\n')
  await cp(join(system, 'package.json'), join(destination, 'package.json'))
  await symlink(join(system, 'services'), join(destination, 'services'), 'dir')
  await symlink(join(system, 'node_modules'), join(destination, 'node_modules'), 'dir')
  await mkdir(join(destination, 'public'), { recursive: true })
  run('bun', ['build', join(system, 'src/worker.ts'), '--target', 'bun', '--outfile', join(destination, 'public/state-worker.js')])
  return destination
}

await mkdir(output, { recursive: true })
await rm(inputs, { recursive: true, force: true })
await mkdir(inputs, { recursive: true })
await copyEditor('standalone')
await copyEditor('collaboration')
const desktop = await copyDesktop()
await writeFile(join(desktop, 'public/protocol.schema.json'), JSON.stringify(protocolSchema, null, 2) + '\n')
await writeFile(join(desktop, 'public/capabilities.schema.json'), JSON.stringify(capabilitySchemas, null, 2) + '\n')
const metadata = {
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim(),
  sourceHasUncommittedChanges: execFileSync('git', ['status', '--porcelain'], { cwd: repository, encoding: 'utf8' }).trim().length > 0,
  sdk: '0.0.9',
  protocol: 'marktext-documents/1',
  minimumStateRuntime: 'Bun with bun:sqlite; target runtime must pass SP-01',
  mode: 'proposal-preview',
  approval: 'unavailable',
  productionAgentRegistration: 'unverified',
  multiple: false
}
await writeFile(join(desktop, 'public/release.json'), JSON.stringify(metadata, null, 2) + '\n')
for (const variant of ['standalone', 'collaboration', 'desktop']) {
  const publicDirectory = join(inputs, variant, 'public')
  await mkdir(publicDirectory, { recursive: true })
  await cp(join(repository, 'LICENSE'), join(publicDirectory, 'LICENSE'))
  await cp(join(repository, 'packages/desktop/build/THIRD-PARTY-LICENSES.txt'), join(publicDirectory, 'THIRD-PARTY-LICENSES.txt'))
  await writeFile(join(inputs, variant, '.gitignore'), '.acde/\n')
}

if (!process.argv.includes('--inputs-only')) {
  for (const variant of ['standalone', 'collaboration', 'desktop']) {
    const directory = join(inputs, variant)
    run('acde', ['check', directory])
    run('acde', ['build', directory])
  }
  await verifyPackages(inputs)
}
process.stdout.write(`Generated standard inputs in ${inputs}\n`)
