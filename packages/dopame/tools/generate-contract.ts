import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { CAPABILITIES, LIMITS, PROTOCOL } from '../protocol'

const directory = resolve(process.argv[2] ?? join(import.meta.dir, '../schema'))
await mkdir(directory, { recursive: true })
await Bun.write(
  join(directory, 'marktext-agent-1.json'),
  JSON.stringify(
    {
      protocol: PROTOCOL,
      ownerAppId: 'marktext-dopame',
      limits: LIMITS,
      capabilities: CAPABILITIES
    },
    null,
    2
  ) + '\n'
)
console.log('Generated protocol catalogue: ' + directory)
