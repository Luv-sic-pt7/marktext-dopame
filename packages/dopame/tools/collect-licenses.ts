import { mkdir, readdir, copyFile } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
const root = resolve(import.meta.dir, '..')
const licenses = join(root, 'third-party-licenses')
await mkdir(licenses, { recursive: true })
const packages = new Map<
  string,
  { name: string; version: string; license: unknown; files: string[] }
>()
for (const project of ['', 'app', 'desktop']) {
  const modules = join(root, project, 'node_modules')
  for await (const relative of new Bun.Glob('**/package.json').scan({
    cwd: modules,
    dot: true,
    followSymlinks: false
  })) {
    const path = join(modules, relative)
    let manifest: any
    try {
      manifest = await Bun.file(path).json()
    } catch {
      continue
    }
    if (!manifest.name || !manifest.version || !manifest.license) continue
    const key = manifest.name + '@' + manifest.version
    if (packages.has(key)) continue
    const record = {
      name: manifest.name,
      version: manifest.version,
      license: manifest.license,
      files: [] as string[]
    }
    for (const file of await readdir(dirname(path), { withFileTypes: true })) {
      if (!file.isFile() || !/^(?:licen[sc]e|copying|notice)(?:\.|$)/i.test(file.name)) continue
      const name = key.replaceAll('/', '__').replace(/^@/, '') + '-' + file.name
      await copyFile(join(dirname(path), file.name), join(licenses, name))
      record.files.push('third-party-licenses/' + name)
    }
    packages.set(key, record)
  }
}
const records = [...packages.values()].sort(
  (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version)
)
const bundledAssets = [
  {
    name: 'Open Sans',
    source: '../muya/src/assets/styles/fonts/open-sans-LICENSE.txt',
    file: 'assets-OpenSans-LICENSE.txt'
  },
  {
    name: 'DejaVu Sans Mono',
    source: '../muya/src/assets/styles/fonts/DejaVuSansMono_LICENSE',
    file: 'assets-DejaVuSansMono-LICENSE.txt'
  }
]
for (const asset of bundledAssets)
  await copyFile(resolve(root, asset.source), join(licenses, asset.file))
await Bun.write(
  join(root, 'docs/dependency-inventory.json'),
  JSON.stringify(
    {
      scope:
        'Installed dependency inventory including development tooling; not a claim that every entry is bundled',
      packages: records,
      bundledAssets
    },
    null,
    2
  )
)
await Bun.write(
  join(root, 'THIRD-PARTY-NOTICES.txt'),
  'MarkText for Dopame OS · third-party dependency inventory\n\nThis inventory includes build/test dependencies. Runtime bundles include only imported modules and assets.\nOriginal MarkText and Muya licenses remain applicable. acde/acdert are provided separately by the platform.\nBundled Open Sans and DejaVu Sans Mono font notices are in third-party-licenses/assets-*.txt.\n\n' +
    records
      .map(
        (p) =>
          p.name +
          ' ' +
          p.version +
          ' — ' +
          JSON.stringify(p.license) +
          '\n' +
          (p.files.join('\n') ||
            'See package metadata; no separate top-level license file was installed.')
      )
      .join('\n\n') +
    '\n'
)
console.log('Collected ' + records.length + ' dependency license records')
