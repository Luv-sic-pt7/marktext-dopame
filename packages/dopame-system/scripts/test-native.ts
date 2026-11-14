import { execFileSync } from 'node:child_process'
import { cp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const system = resolve(dirname(fileURLToPath(import.meta.url)), '..')
execFileSync('bun', ['scripts/build.ts', '--inputs-only'], { cwd: system, stdio: 'inherit' })
const fixture = join(system, '.acde/native-fixture')
await rm(fixture, { recursive: true, force: true })
await mkdir(fixture, { recursive: true })
await cp(join(system, 'desktop'), fixture, { recursive: true })
await cp(join(system, '.acde/inputs/desktop/public'), join(fixture, 'public'), { recursive: true })
await cp(join(system, 'test/native.e2e.ts'), join(fixture, 'native.e2e.ts'))
await symlink(join(system, 'services'), join(fixture, 'services'), 'dir')
await symlink(join(system, 'node_modules'), join(fixture, 'node_modules'), 'dir')
await writeFile(join(fixture, 'package.json'), JSON.stringify({
  name: 'marktext-documents-native-test', version: '0.0.0', type: 'module', packageManager: 'bun@1.4.4'
}, null, 2) + '\n')
const config = JSON.parse(await readFile(join(fixture, 'acde.config.jsonc'), 'utf8'))
config.services.marktextdocs = 'services/marktextdocs.ts'
config.apps = [{ id: 'marktext-service-test-reader', label: 'Service test reader', entry: 'reader.html' }]
await writeFile(join(fixture, 'acde.config.jsonc'), JSON.stringify(config, null, 2) + '\n')
await writeFile(join(fixture, 'reader.html'), '<!doctype html><html><body><p>Independent reader</p></body></html>\n')
await writeFile(join(fixture, '.gitignore'), '.acde/\n')

for (const available of [true, false]) {
  execFileSync('acde', ['test', '--workers', '1'], {
    cwd: fixture,
    env: {
      ...process.env,
      MARKTEXT_BUN: available ? process.execPath : '',
      MARKTEXT_NATIVE_EXPECT_AVAILABLE: available ? '1' : '0'
    },
    stdio: 'inherit'
  })
}
