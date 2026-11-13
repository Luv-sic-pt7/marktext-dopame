import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { evidenceRoot } from './prepare-native'

const directory = resolve(process.argv[2] ?? '')
if (!process.argv[2]) throw new Error('Pass a built release directory')
const manifest = JSON.parse(await readFile(join(directory, 'release-manifest.json'), 'utf8'))
const credentials = new Set<string>()
const credentialDirectory =
  process.env.MARKTEXT_STATE_DIRECTORY ??
  join(homedir(), '.local/state/acde/marktext-workspace/marktext-agent')
try {
  for (const filename of await readdir(credentialDirectory)) {
    if (!/^(?:administrator|worker|client-.+)\.json$/.test(filename)) continue
    const path = join(credentialDirectory, filename)
    if ((await stat(path)).size > 8192) continue
    const value = JSON.parse(await readFile(path, 'utf8'))
    if (/^[a-f0-9]{64}$/.test(value.token)) credentials.add(value.token)
  }
} catch (error: any) {
  if (error.code !== 'ENOENT') throw error
}
const findings: { path: string; reason: string }[] = []
let bytes = 0
for (const file of manifest.files) {
  const content = await readFile(join(directory, file.path))
  bytes += content.length
  if (
    content.length !== file.bytes ||
    createHash('sha256').update(content).digest('hex') !== file.sha256
  )
    findings.push({ path: file.path, reason: 'digest mismatch' })
  if (/\.(?:node|so|dylib|exe|wasm)$/i.test(file.path))
    findings.push({ path: file.path, reason: 'unexpected executable binary' })
  if (/(?:^|\/)(?:administrator|worker|client-.+|endpoint)\.json$/.test(file.path))
    findings.push({ path: file.path, reason: 'service state must not be packaged' })
  if (/\.(?:js|mjs|ts|json|md|txt|html|sh|css)$/i.test(file.path)) {
    const text = content.toString('utf8')
    if ([...credentials].some((token) => text.includes(token)))
      findings.push({ path: file.path, reason: 'local pairing credential found' })
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\r\n]/.test(text))
      findings.push({ path: file.path, reason: 'private key block found' })
  }
}
const report = {
  at: new Date().toISOString(),
  directory,
  files: manifest.files.length,
  bytes,
  matchedLocalCredentialCount: credentials.size,
  credentialValuesEmitted: false,
  findings,
  passed: !findings.length
}
await writeFile(join(evidenceRoot, 'release-integrity.json'), JSON.stringify(report, null, 2))
if (findings.length) throw new Error('Release checks failed; see the sanitized integrity report')
console.log('Release integrity and credential scan passed (' + manifest.files.length + ' files)')
