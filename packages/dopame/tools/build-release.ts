import { cp, mkdir, chmod, readdir } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { acdeBinary, command, portRoot } from './prepare-native'

const output = resolve(
  process.argv[2] ?? join(portRoot, '../../../交付/MarkText-Dopame-MVP-0.1.0-' + Date.now())
)
if (existsSync(output))
  throw new Error('Release destination already exists; choose a new directory')
await command(process.execPath, ['build-state.ts'])
for (const name of ['app', 'desktop']) {
  await command(acdeBinary, ['check'], join(portRoot, name))
  await command(acdeBinary, ['build'], join(portRoot, name))
}
await mkdir(join(output, 'packages'), { recursive: true })
await cp(join(portRoot, 'app/.acde'), join(output, 'packages/marktext-dopame'), { recursive: true })
await cp(join(portRoot, 'desktop/.acde'), join(output, 'packages/marktext-workspace'), {
  recursive: true
})
await mkdir(join(output, 'tools'), { recursive: true })
for (const [entry, name] of [['tools/mcp-server.ts', 'marktext-mcp.js']] as const) {
  const built = await Bun.build({
    entrypoints: [join(portRoot, entry)],
    target: 'bun',
    format: 'esm',
    outdir: join(output, 'tools'),
    naming: name,
    minify: true
  })
  if (!built.success) throw new AggregateError(built.logs, 'Tool bridge build failed')
}
const client = join(output, 'client')
await mkdir(client, { recursive: true })
const built = await Bun.build({
  entrypoints: [join(portRoot, 'client.ts'), join(portRoot, 'http-transport.ts')],
  outdir: client,
  target: 'node',
  format: 'esm',
  minify: true,
  naming: '[name].js'
})
if (!built.success) throw new AggregateError(built.logs, 'Client build failed')
await command(process.execPath, [
  'node_modules/typescript/bin/tsc',
  '--ignoreConfig',
  'client.ts',
  'http-transport.ts',
  'protocol.ts',
  '--declaration',
  '--emitDeclarationOnly',
  '--outDir',
  client,
  '--target',
  'ES2022',
  '--module',
  'ESNext',
  '--moduleResolution',
  'bundler',
  '--skipLibCheck',
  '--types',
  'bun'
])
for (const name of (await readdir(client)).filter((name) => name.endsWith('.d.ts'))) {
  const path = join(client, name)
  const source = await Bun.file(path).text()
  await Bun.write(
    path,
    source.replace(
      /(from\s+['"])(\.\.?\/[^'"]+)(['"])/g,
      (_match, start, target, quote) =>
        start + (target.endsWith('.js') ? target : target + '.js') + quote
    )
  )
}
await Bun.write(
  join(client, 'package.json'),
  JSON.stringify(
    {
      name: '@marktext/dopame-client',
      version: '0.1.0',
      type: 'module',
      exports: {
        '.': { types: './client.d.ts', default: './client.js' },
        './http': { types: './http-transport.d.ts', default: './http-transport.js' }
      },
      license: 'MIT'
    },
    null,
    2
  )
)
await command(process.execPath, ['tools/generate-contract.ts', join(output, 'schema')])
for (const name of ['README.md', 'docs', 'scripts', 'samples'])
  if (existsSync(join(portRoot, name)))
    await cp(join(portRoot, name), join(output, name), { recursive: true })
await cp(resolve(portRoot, '../../LICENSE'), join(output, 'LICENSE'))
await cp(resolve(portRoot, '../../LICENSE'), join(client, 'LICENSE'))
if (process.env.MARKTEXT_PITCH_FILE) {
  await mkdir(join(output, 'materials'), { recursive: true })
  await cp(
    resolve(process.env.MARKTEXT_PITCH_FILE),
    join(output, 'materials/MarkText-Dopame-MVP路演.pptx')
  )
}
if (existsSync(join(portRoot, 'THIRD-PARTY-NOTICES.txt')))
  await cp(join(portRoot, 'THIRD-PARTY-NOTICES.txt'), join(output, 'THIRD-PARTY-NOTICES.txt'))
if (existsSync(join(portRoot, 'third-party-licenses')))
  await cp(join(portRoot, 'third-party-licenses'), join(output, 'third-party-licenses'), {
    recursive: true
  })
const publicAcceptance = join(portRoot, 'docs/acceptance-public.md')
if (existsSync(publicAcceptance)) {
  await mkdir(join(output, 'evidence'), { recursive: true })
  await cp(publicAcceptance, join(output, 'evidence/acceptance-public.md'))
}
for (const name of ['run.sh', 'install.sh', 'uninstall.sh'])
  await chmod(join(output, 'scripts', name), 0o755)
const files: { path: string; sha256: string; bytes: number }[] = []
async function walk(directory: string, prefix = '') {
  for (const file of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name)
  )) {
    const path = prefix + file.name,
      absolute = join(directory, file.name)
    if (file.isDirectory()) await walk(absolute, path + '/')
    else {
      if (file.isSymbolicLink() || /\.(node|dylib|so|exe)$/i.test(file.name))
        throw new Error('Release contains an unexpected native file: ' + path)
      const data = readFileSync(absolute)
      files.push({
        path,
        sha256: createHash('sha256').update(data).digest('hex'),
        bytes: data.length
      })
    }
  }
}
await walk(output)
const head = Bun.spawn(['git', 'rev-parse', 'HEAD'], {
  cwd: portRoot,
  stdout: 'pipe',
  stderr: 'pipe'
})
const sourceCommit = (await new Response(head.stdout).text()).trim()
if (await head.exited) throw new Error('Cannot record the source commit')
const status = Bun.spawn(['git', 'status', '--porcelain'], {
  cwd: portRoot,
  stdout: 'pipe',
  stderr: 'pipe'
})
const sourceWorkingTreeDirty = !!(await new Response(status.stdout).text()).trim()
if (await status.exited) throw new Error('Cannot inspect the source status')
await Bun.write(
  join(output, 'release-manifest.json'),
  JSON.stringify(
    {
      version: '0.1.0',
      builtAt: new Date().toISOString(),
      upstreamCommit: '18fdc1eddc7d36d9b205180d058982f71f4f6373',
      sourceCommit,
      sourceWorkingTreeDirty,
      acde: '0.0.9',
      runtime: 'acdert 0.0.9, Bun >=1.4.4',
      officialMachineValidated: false,
      files
    },
    null,
    2
  )
)
console.log('Release built: ' + output + ' (' + files.length + ' files; no native addons)')
