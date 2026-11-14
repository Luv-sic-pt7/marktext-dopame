import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { arch, platform, release, tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Database } from 'bun:sqlite'

const root = dirname(fileURLToPath(import.meta.url))
const manifestBytes = readFileSync(join(root, 'manifest.json'))
const manifest = JSON.parse(manifestBytes)
assert.equal(manifest.testOnly, true)
assert.equal(manifest.kind, 'marktext-core-acceptance-test-only')

function hash (bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function inspect (directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (directory === root && entry.name === 'results') continue
    assert.equal(entry.isSymbolicLink(), false, 'Test payload must not contain development symlinks.')
    assert.notEqual(entry.name, 'node_modules')
    assert.equal(/\.(node|dylib|so|dll|exe|sqlite|db)$/i.test(entry.name), false)
    if (entry.isDirectory()) inspect(join(directory, entry.name))
  }
}

inspect(root)
for (const file of manifest.files) {
  const path = join(root, file.path)
  assert.equal(lstatSync(path).isFile(), true)
  const bytes = readFileSync(path)
  assert.equal(bytes.length, file.bytes, 'Payload size mismatch: ' + file.path)
  assert.equal(hash(bytes), file.sha256, 'Payload digest mismatch: ' + file.path)
}

const resultsDirectory = join(root, 'results')
mkdirSync(resultsDirectory, { recursive: true })
const temporary = mkdtempSync(join(tmpdir(), 'marktext-server-core-tests-'))
const home = join(temporary, 'home')
mkdirSync(home)
const env = {
  PATH: [dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter),
  HOME: home,
  TMPDIR: temporary,
  TMP: temporary,
  TEMP: temporary,
  LANG: 'C.UTF-8',
  TZ: 'UTC',
  NO_COLOR: '1',
  FORCE_COLOR: '0',
  NODE_PATH: '',
}
const sqlite = new Database(':memory:')
const sqliteVersion = sqlite.query('SELECT sqlite_version() AS version').get().version
sqlite.close()
const results = {
  testOnly: true,
  kind: manifest.kind,
  sourceCommit: manifest.sourceCommit,
  sourceHasUncommittedChanges: manifest.sourceHasUncommittedChanges,
  manifestSha256: hash(manifestBytes),
  observedAt: new Date().toISOString(),
  runtime: { bun: process.versions.bun, platform: platform(), architecture: arch(), kernel: release(), sqlite: sqliteVersion },
  scope: manifest.scope,
  suites: [],
}
try {
  for (const suite of manifest.suites) {
    const result = spawnSync(process.execPath, ['--no-install', '--no-env-file', 'test', '--timeout=20000', ...suite.tests], {
      cwd: root, env, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024,
    })
    const stdout = result.stdout ?? ''
    const stderr = result.stderr ?? ''
    writeFileSync(join(resultsDirectory, suite.id + '.stdout.log'), stdout)
    writeFileSync(join(resultsDirectory, suite.id + '.stderr.log'), stderr)
    const transcript = stdout + '\n' + stderr
    const passed = [...transcript.matchAll(/^\s*(\d+)\s+pass\s*$/gm)].at(-1)
    const failed = [...transcript.matchAll(/^\s*(\d+)\s+fail\s*$/gm)].at(-1)
    const actualPassed = passed ? Number(passed[1]) : null
    const actualFailed = failed ? Number(failed[1]) : null
    const succeeded = result.status === 0 && actualPassed === suite.expectedTests && actualFailed === 0
    results.suites.push({
      id: suite.id,
      expectedTests: suite.expectedTests,
      passed: actualPassed,
      failed: actualFailed,
      exitCode: result.status,
      signal: result.signal,
      succeeded,
      ...(result.error ? { error: result.error.message } : {}),
    })
    process.stdout.write(suite.id + ': ' + String(actualPassed) + '/' + suite.expectedTests + ' passed, ' + String(actualFailed) + ' failed\n')
    if (!succeeded) process.stderr.write(transcript.slice(-12000))
  }
} finally {
  rmSync(temporary, { recursive: true, force: true })
  results.succeeded = results.suites.length === manifest.suites.length && results.suites.every(suite => suite.succeeded)
  writeFileSync(join(resultsDirectory, 'results.json'), JSON.stringify(results, null, 2) + '\n')
}
process.stdout.write('Test-only results: ' + join(resultsDirectory, 'results.json') + '\n')
process.exitCode = results.succeeded ? 0 : 1
