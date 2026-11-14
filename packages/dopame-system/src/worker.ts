import { resolve } from 'node:path'
import { Coordinator } from './coordinator'
import {
  failure, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, PUBLIC_METHODS,
  transportError, type WorkerRequest, type WorkerResponse
} from './transport'

function validateRequest(value: unknown): WorkerRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw failure('INVALID_ARGUMENT', 'Expected a request object.')
  }
  const request = value as Record<string, unknown>
  const keys = Object.keys(request)
  if (keys.length !== 3 || !keys.every(key => ['id', 'method', 'args'].includes(key))
    || typeof request.id !== 'string' || !request.id || request.id.length > 100
    || !PUBLIC_METHODS.includes(request.method as WorkerRequest['method'])
    || !Array.isArray(request.args)) {
    throw failure('INVALID_ARGUMENT', 'Unsupported document service request.')
  }
  return request as unknown as WorkerRequest
}

function dispatch(coordinator: Coordinator, request: WorkerRequest) {
  const args = request.args
  const strings = (count: number) => args.length === count && args.every(arg => typeof arg === 'string')
  switch (request.method) {
    case 'describe':
      if (!strings(1)) throw failure('INVALID_ARGUMENT', 'Authentication is required.')
      return coordinator.describe(args[0] as string)
    case 'invoke':
      if (args.length !== 2 || typeof args[0] !== 'string') throw failure('INVALID_ARGUMENT', 'Invalid invocation arguments.')
      return coordinator.invoke(args[0], args[1])
    case 'getTask':
      if (!strings(2)) throw failure('INVALID_ARGUMENT', 'Invalid task arguments.')
      return coordinator.getTask(args[0] as string, args[1] as string)
    case 'cancelTask':
      if (!strings(2)) throw failure('INVALID_ARGUMENT', 'Invalid task arguments.')
      return coordinator.cancelTask(args[0] as string, args[1] as string)
    case 'listEvents':
      if (args.length < 1 || args.length > 3 || typeof args[0] !== 'string'
        || (args[1] !== undefined && args[1] !== null && typeof args[1] !== 'string')
        || (args[2] !== undefined && (!Number.isInteger(args[2]) || (args[2] as number) < 1 || (args[2] as number) > 200))) {
        throw failure('INVALID_ARGUMENT', 'Invalid event page arguments.')
      }
      return coordinator.listEvents(args[0], (args[1] ?? undefined) as string | undefined, args[2] as number | undefined)
    case 'requestPairing': {
      const input = args[0]
      if (args.length !== 1 || !input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).length !== 1 || typeof (input as { name?: unknown }).name !== 'string') {
        throw failure('INVALID_ARGUMENT', 'Pairing requires a display name.')
      }
      return coordinator.requestPairing(input as { name: string })
    }
    case 'claimPairing':
      if (!strings(2)) throw failure('INVALID_ARGUMENT', 'Invalid pairing claim.')
      return coordinator.claimPairing(args[0] as string, args[1] as string)
  }
}

function reply(response: WorkerResponse) {
  const line = JSON.stringify(response)
  const output = Buffer.byteLength(line) > MAX_RESPONSE_BYTES
    ? JSON.stringify({ id: response.id, error: {
      code: 'PAYLOAD_TOO_LARGE', message: 'Read the result using smaller pages.', retryable: false
    } })
    : line
  const writable = process.stdout.write(output + '\n')
  if (!writable && !outputBlocked) {
    outputBlocked = true
    process.stdin.pause()
    process.stdout.once('drain', () => {
      outputBlocked = false
      processPendingInput()
      if (!outputBlocked) process.stdin.resume()
    })
  }
}

const state = process.argv[2]
if (!state || process.argv.length !== 3) {
  process.stderr.write('Document state directory is required.\n')
  process.exit(1)
}

let coordinator: Coordinator
try {
  coordinator = new Coordinator(resolve(state))
} catch (error) {
  process.stdout.write(JSON.stringify({ type: 'unavailable', error: transportError(error) }) + '\n')
  process.exit(1)
}

process.stdout.write(JSON.stringify({ type: 'ready' }) + '\n')
let pending = ''
let outputBlocked = false
function processPendingInput() {
  while (!outputBlocked) {
    const end = pending.indexOf('\n')
    if (end < 0) break
    const line = pending.slice(0, end)
    pending = pending.slice(end + 1)
    let id: string | null = null
    try {
      if (Buffer.byteLength(line) > MAX_REQUEST_BYTES) throw failure('PAYLOAD_TOO_LARGE', 'Request frame exceeds the limit.')
      let parsed: unknown
      try { parsed = JSON.parse(line) } catch { throw failure('INVALID_ARGUMENT', 'Malformed JSON request.') }
      const request = validateRequest(parsed)
      id = request.id
      reply({ id, result: dispatch(coordinator, request) })
    } catch (error) {
      reply({ id, error: transportError(error) })
    }
  }
  if (Buffer.byteLength(pending) > MAX_REQUEST_BYTES) {
    reply({ id: null, error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request frame exceeds the limit.', retryable: false } })
    process.stdin.destroy()
    coordinator.close()
    process.exitCode = 1
  }
}
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk: string) => {
  pending += chunk
  processPendingInput()
})

function close() {
  coordinator.close()
  process.exit()
}

process.stdin.on('end', close)
process.on('SIGTERM', close)
process.on('SIGINT', close)
