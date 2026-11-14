export const PUBLIC_METHODS = [
  'describe', 'invoke', 'getTask', 'cancelTask', 'listEvents',
  'requestPairing', 'claimPairing'
] as const

export type PublicMethod = typeof PUBLIC_METHODS[number]

export interface TransportError {
  code: string
  message: string
  retryable: boolean
  details?: unknown
}

export interface WorkerRequest {
  id: string
  method: PublicMethod
  args: unknown[]
}

export type WorkerResponse =
  | { id: string; result: unknown }
  | { id: string | null; error: TransportError }

export const MAX_REQUEST_BYTES = 512 * 1024 + 16 * 1024
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024

export function transportError(error: unknown): TransportError {
  const value = error as Partial<TransportError> | null
  if (value && typeof value.code === 'string' && typeof value.message === 'string') {
    return {
      code: value.code,
      message: value.message,
      retryable: value.retryable === true,
      ...(value.details === undefined ? {} : { details: value.details })
    }
  }
  return { code: 'RESOURCE_UNAVAILABLE', message: 'Document service operation failed.', retryable: true }
}

export function failure(code: string, message: string, retryable = false) {
  return Object.assign(new Error(message), { code, retryable })
}
