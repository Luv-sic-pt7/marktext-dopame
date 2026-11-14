import assert from 'node:assert/strict'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

async function inspectFiles(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    assert.equal(entry.isSymbolicLink(), false, 'Built packages must not reference development symlinks.')
    assert.equal(/\.(?:node|dylib|so|dll|exe|sqlite|db)$/i.test(entry.name), false,
      'Built packages contain JavaScript/resources, not native dependencies or private state.')
    if (entry.isDirectory()) await inspectFiles(path)
  }
}

export async function verifyPackages(inputs: string) {
  const appManifests = []
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
  const declarations = [
    ['LICENSE', join(repository, 'LICENSE')],
    ['THIRD-PARTY-LICENSES.txt', join(repository, 'packages/desktop/build/THIRD-PARTY-LICENSES.txt')]
  ]
  for (const variant of ['standalone', 'collaboration', 'desktop']) {
    const output = join(inputs, variant, '.acde')
    await inspectFiles(output)
    const assetDirectory = join(output, variant === 'desktop' ? 'desktop' : 'web')
    for (const [name, source] of declarations) {
      assert.deepEqual(await readFile(join(assetDirectory, name)), await readFile(source),
        'Built packages must retain the original upstream declarations verbatim.')
    }
    const manifest = JSON.parse(await readFile(join(output, 'package.json'), 'utf8'))
    if (variant === 'desktop') {
      assert.deepEqual(manifest.acde.services, [{ name: 'marktextdocs', module: 'services/marktextdocs.js' }])
      assert.equal((await lstat(join(output, 'desktop/state-worker.js'))).isFile(), true)
      const schema = JSON.parse(await readFile(join(output, 'desktop/protocol.schema.json'), 'utf8'))
      assert.equal(schema.$id, 'urn:marktext:documents:1')
      const release = JSON.parse(await readFile(join(output, 'desktop/release.json'), 'utf8'))
      assert.match(release.sourceCommit, /^[0-9a-f]{40}$/)
      assert.equal(release.approval, 'unavailable')
      assert.equal(release.multiple, false)
    } else {
      const app = manifest.acde.apps[0]
      appManifests.push(app)
      assert.equal(app.multiple, false)
      if (variant === 'collaboration') {
        assert.deepEqual(app.capabilities ?? {}, {})
        assert.deepEqual(app.services, ['marktextdocs'])
        assert.deepEqual(app.requests, ['marktext-review'])
        assert.equal(app.mimeTypes, undefined)
      } else assert.equal(app.services, undefined)
    }
  }
  assert.equal(appManifests[0].id, appManifests[1].id)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const system = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  await verifyPackages(join(system, '.acde/inputs'))
  process.stdout.write('Verified standalone, collaboration and desktop packages.\n')
}
