import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scripts = dirname(fileURLToPath(import.meta.url))
const repository = resolve(scripts, '../../..')
const acceptance = join(repository, 'packages/dopame-system/.acde/acceptance')
const output = join(acceptance, 'core-tests')
const suites = [
  { id: 'system', directory: 'packages/dopame-system', expectedTests: 41 },
  { id: 'domain', directory: 'packages/dopame', expectedTests: 23 },
]
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const files: Array<{ path: string; bytes: number; sha256: string; role: string }> = []
const sources = new Map<string, { path: string; bytes: number; sha256: string }>()
const builds: Array<{ entry: string; bundledModules: number; externalImports: string[] }> = []

async function writePayload(path: string, data: Uint8Array | string, role: string) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
  const destination = join(output, path)
  await mkdir(dirname(destination), { recursive: true })
  await writeFile(destination, bytes)
  files.push({ path, role, bytes: bytes.byteLength, sha256: hash(bytes) })
}

async function recordSource(path: string) {
  const name = relative(repository, path)
  const bytes = await readFile(path)
  sources.set(name, { path: name, bytes: bytes.byteLength, sha256: hash(bytes) })
}

assert.equal('Bun' in globalThis, true, 'Run prepare-server-tests.ts with Bun.')
await rm(output, { recursive: true, force: true })
await mkdir(output, { recursive: true })
const entries = new Set([join(repository, 'packages/dopame-system/src/worker.ts')])
const suiteMetadata: Array<{ id: string; expectedTests: number; tests: string[] }> = []
for (const suite of suites) {
  const names = (await readdir(join(repository, suite.directory, 'test'))).filter(name => name.endsWith('.test.mjs')).sort()
  const tests: string[] = []
  for (const name of names) {
    const path = join(suite.directory, 'test', name)
    const sourcePath = join(repository, path)
    const bytes = await readFile(sourcePath)
    await writePayload(path, bytes, 'test-only-original-test')
    await recordSource(sourcePath)
    tests.push(path)
    for (const match of bytes.toString('utf8').matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)) {
      if (!match[1].startsWith('.')) continue
      const entry = resolve(dirname(sourcePath), match[1])
      assert.equal(relative(repository, entry).startsWith('..'), false, 'Tests may import only this repository.')
      assert.equal(entry.endsWith('.ts'), true, 'Review new test helper formats before packaging.')
      entries.add(entry)
    }
  }
  suiteMetadata.push({ id: suite.id, expectedTests: suite.expectedTests, tests })
}

for (const entry of [...entries].sort()) {
  const path = relative(repository, entry)
  const destination = join(output, path)
  await mkdir(dirname(destination), { recursive: true })
  const metafile = destination + '.build-meta.json'
  execFileSync(process.execPath, ['build', entry, '--target=bun', '--format=esm', '--external=bun:*', '--external=node:*',
    '--reject-unresolved', '--outfile=' + destination, '--metafile=' + metafile], { cwd: repository, stdio: 'pipe' })
  const metadata = JSON.parse(await readFile(metafile, 'utf8')) as {
    inputs: Record<string, unknown>
    outputs: Record<string, { imports?: Array<{ path: string }> }>
  }
  const externalImports = Object.values(metadata.outputs).flatMap(value => value.imports ?? []).map(value => value.path)
  assert.equal(externalImports.every(value => value.startsWith('bun:') || value.startsWith('node:')), true,
    'A portable module cannot retain an external package or host path.')
  for (const input of Object.keys(metadata.inputs)) await recordSource(resolve(repository, input))
  builds.push({ entry: path, bundledModules: Object.keys(metadata.inputs).length, externalImports })
  const bytes = await readFile(destination)
  files.push({ path, role: 'test-only-bundled-module', bytes: bytes.byteLength, sha256: hash(bytes) })
  await rm(metafile)
}

const runner = join(scripts, 'server-tests-runner.mjs')
await writePayload('run-tests.mjs', await readFile(runner), 'test-only-runner')
await recordSource(runner)
await recordSource(fileURLToPath(import.meta.url))
await writePayload('package.json', JSON.stringify({ name: 'marktext-core-acceptance-test-only', private: true, type: 'module' }, null, 2) + '\n', 'metadata')
await writePayload('README.md', [
  '# Test-only core acceptance bundle',
  '',
  'This directory is never an application, service, Agent adapter or approval host.',
  'It carries 41 system tests, including undo recovery regressions, and 23 editor/domain tests. Fake ApprovalPort implementations exist only in these isolated tests and prove no production human approval or real Agent identity.',
  '',
  'Run from this directory on the target with Bun 1.4.4:',
  '',
  '    bun --no-install --no-env-file run-tests.mjs',
  '',
  'The runner checks payload SHA-256 values, uses an empty temporary HOME and a restricted environment, and writes results/results.json plus one stdout/stderr log per suite. Temporary SQLite files and SIGKILL child processes belong only to this test run. No node_modules, network install, Node.js, acde, GPU or native package dependency is needed.',
  '',
  'Bundled source modules retain their original .ts filenames so unchanged tests can spawn ../src/worker.ts and import ../src/coordinator.ts after relocation. Only JavaScript and built-in bun:/node: modules are used at runtime.',
  '',
  'Results cover core behavior and process recovery. They do not establish real Agent registration, protected author UI/IME, system notifications, OS file-handle handoff, or power-loss durability on the production state filesystem.',
  '',
].join('\n'), 'metadata')
for (const [name, source] of [
  ['LICENSE', join(repository, 'LICENSE')],
  ['THIRD-PARTY-LICENSES.txt', join(repository, 'packages/desktop/build/THIRD-PARTY-LICENSES.txt')],
]) await writePayload(join('licenses', name), await readFile(source), 'license')

const manifest = {
  kind: 'marktext-core-acceptance-test-only', testOnly: true,
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim(),
  sourceHasUncommittedChanges: execFileSync('git', ['status', '--porcelain'], { cwd: repository, encoding: 'utf8' }).trim().length > 0,
  buildRuntime: execFileSync(process.execPath, ['--version'], { encoding: 'utf8' }).trim(),
  targetRuntime: 'Bun 1.4.4 with bun:sqlite; no external modules',
  scope: {
    coreTestsOnly: true, realAgentIdentity: false, protectedHumanApproval: false,
    nativeAuthorEditorOrIme: false, systemNotifications: false, osFileHandleHandoff: false, powerLossDurability: false,
  },
  suites: suiteMetadata, builds, sources: [...sources.values()].sort((a, b) => a.path.localeCompare(b.path)),
  files: files.sort((a, b) => a.path.localeCompare(b.path)),
}
await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')

const detached = await mkdtemp('/tmp/marktext-core-acceptance-')
const copy = join(detached, 'core-tests')
await cp(output, copy, { recursive: true })
execFileSync(process.execPath, ['--no-install', '--no-env-file', join(copy, 'run-tests.mjs')], {
  cwd: detached, env: { PATH: dirname(process.execPath) + ':/usr/bin:/bin', NODE_PATH: '', NO_COLOR: '1' }, stdio: 'inherit',
})
const localResult = JSON.parse(await readFile(join(copy, 'results/results.json'), 'utf8'))
await writeFile(join(acceptance, 'core-tests-local-verification.json'), JSON.stringify({
  location: 'local detached verification, not a server result', detachedDirectory: copy, ...localResult,
}, null, 2) + '\n')
process.stdout.write(JSON.stringify({
  output, manifest: join(output, 'manifest.json'), detachedVerification: copy,
  localResults: join(acceptance, 'core-tests-local-verification.json'), tests: suites.reduce((total, suite) => total + suite.expectedTests, 0), succeeded: localResult.succeeded,
}) + '\n')
